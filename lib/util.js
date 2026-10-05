/** 通用小工具 */

import crypto from "node:crypto";

const pad = (value) => String(value).padStart(2, "0");

/** Date → 'YYYY-MM-DD HH:mm:ss'（按服务器本地时间写入 MySQL） */
export function toMysqlDateTime(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** MySQL DATETIME 字符串（本地时间）→ Date */
export function parseMysqlDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const text = String(value).trim().replace(" ", "T");
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 取访客 IP：宝塔 Nginx 反代会带上 X-Real-IP / X-Forwarded-For */
export function clientIp(request) {
  const headers = request?.headers;
  if (!headers) return "";
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first.slice(0, 45);
  }
  const real = headers.get("x-real-ip");
  if (real) return real.trim().slice(0, 45);
  return "";
}

/** 统一的 JSON 返回 */
export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

export function jsonError(message, status = 400, extra = {}) {
  return json({ ok: false, error: message, ...extra }, status);
}

/** 安全读取 JSON 请求体，永不抛异常 */
export async function readJsonBody(request) {
  try {
    const data = await request.json();
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

/** 去掉首尾空白并限制长度，防超长输入 */
export function cleanString(value, maxLength = 200) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

/**
 * Emoji 净化正则（全局 + Unicode 模式）。
 *
 * 覆盖范围：
 *   - \p{Extended_Pictographic}：全部图形 emoji —— 表情 / 动植物 / 食物 /
 *     活动 / 旅行交通 / 物品 / 符号，以及 1FA00+ 新表情（肤色修饰符见下，单独处理）
 *   - \p{Regional_Indicator}：旗帜所用的区域指示符（U+1F1E6-1F1FF）
 *   - U+E0000-E007F：细分旗帜（如英格兰旗）的标签字符
 *   - U+1F3FB-1F3FF：肤色修饰符 Emoji_Modifier（不在 Extended_Pictographic 内）
 *   - U+FE00-FE0F：变体选择符 VS1-VS16；U+200D：零宽连接符 ZWJ；
 *     U+20E3：键帽包围符（连同 # * 0-9 组成的键帽序列一起移除）
 *   - 其余“属于 emoji 但不在 Extended_Pictographic 内”的符号：
 *     ™ ℹ ⌚ ⌫ Ⓜ ▪ ▫ ▶ ◀ ◻-◿ ⬅-⬇ ⬛ ⬜ ⭐ ⭕ 〰 〽 ㊗ ㊙
 *
 * 不使用 emoji-regex 依赖，靠 ES2018 Unicode 属性转义实现
 * （Node 12+ / 现代浏览器均支持）。
 *
 * @type {RegExp}
 */
const EMOJI_REGEX =
  /(?:[#*0-9]\uFE0F?\u20E3|[\u{2122}\u{2139}\u{231A}\u{231B}\u{2328}\u{23CF}\u{24C2}\u{25AA}\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2B05}-\u{2B07}\u{2B1B}\u{2B1C}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}\u{FE00}-\u{FE0F}\u{E0000}-\u{E007F}]|\p{Extended_Pictographic}|\p{Regional_Indicator})/gu;

/**
 * 移除文本中的 emoji，保留正常文字、标点、中英文、数字与换行。
 * 主要用于 TTS 朗读前净化文本，避免 MiMo 把 😊 读成“笑脸”、把 👍 读成“赞”。
 *
 * 注意：只处理并返回副本，不修改入参；移除后产生的多余空格会折叠，
 * 换行保持原样。纯 emoji 文本将得到空字符串（调用方应判空）。
 *
 * @param {string} text 原始文本
 * @returns {string} 净化后的文本
 */
export function stripEmoji(text) {
  if (typeof text !== "string" || !text) return "";
  return text
    .replace(EMOJI_REGEX, "")
    .replace(/[ \t]{2,}/g, " ") // 移除 emoji 后残留的连续空格折叠为一个
    .replace(/^[ \t]+|[ \t]+$/gm, ""); // 逐行清首尾空格，保留换行
}

/**
 * 朗读前净化：去掉"不是话"的符号串（颜文字 / ASCII 画 / 装饰线 / 网址）。
 *
 * 为什么需要：**实测**把 `(￣▽￣)ノ今晚吃啥` 交给 MiMo，会被念成「金国寒去啥？」——
 *   颜文字里的 `￣ ▽ ノ` 被当成字读了。而人设本来就鼓励 AI 用颜文字卖萌
 *   （库里就有一条 `┬─┬ノ( º _ ºノ)放下电脑，歇会儿`），所以这不是偶发：
 *   用户听到的"一串听不懂的怪音"就是它。
 *
 * ⚠️ 只清"念不出人话"的东西，**不碰**汉字 / 字母 / 数字 / 常规标点：
 *   - 制表符与方块（`─ ┬ │ ░ █`）、箭头（`→ ←`）、几何图形（`● ○ ◆`）、杂项符号（`★ ♪`）
 *   - 全角长音符 / 全角下划线（`￣ ＿`）、半角片假名与日文浊点（`ﾉ ｱ ・ ゛ ゜`）
 *   - **连续 2 个以上**的装饰字符（`___` `***` `##` `~~` `<<` `||`）
 *   - 网址（`https://…` 只会被念成一串字母加"冒号斜杠斜杠"）
 *   ⚠️ **故意不动** `～`、`……`、`——`、`？！` 这些中文里正常用的标点，
 *      也**不动** `()` `[]` —— 朗读标签（`(温柔)` / `[叹气]`）就靠它们，动了标签就废了。
 *   ⚠️ 清完可能剩下空括号对（`()`），一并抹掉 —— 空的会被 MiMo 当空标签，无害但没必要留着。
 *
 * @param {string} text 原始文本
 * @returns {string} 净化后的文本
 */
const SYMBOL_NOISE_REGEX =
  /[\u2500-\u257F\u2580-\u259F\u2190-\u21FF\u25A0-\u25FF\u2600-\u27BF\uFFE3\uFF3F\uFF61-\uFF9F\u30FB\u30CE\u30FD\u30FE\u00A8\u00AF\u00B0\u00B4\u00B8\u00BA\u02C6\u02C7\u02D8-\u02DD_`]|[_=*#^~|<>+]{2,}/gu;

export function stripSymbolNoise(text) {
  if (typeof text !== "string" || !text) return "";
  return text
    .replace(/https?:\/\/\S+/gi, "") // 网址：念出来只是噪音
    .replace(SYMBOL_NOISE_REGEX, "") // 颜文字 / ASCII 画 / 装饰线
    .replace(/[（(]\s*[)）]/g, "") // 净化后变空的括号对
    .replace(/[\[［]\s*[\]］]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "");
}

/** 定长比较，避免时序差异 */
export function safeEqualHex(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 比较两个口令/密钥，先哈希再定长比较，避免通过响应时间逐字节猜出内容
 * （直接 !== 比较会因为提前返回而泄露长度与相同前缀的长度）。
 */
export function safeEqualText(a, b) {
  const left = crypto.createHash("sha256").update(String(a ?? "")).digest("hex");
  const right = crypto.createHash("sha256").update(String(b ?? "")).digest("hex");
  return safeEqualHex(left, right);
}

/**
 * 手动拼 Set-Cookie 字符串。
 * 不依赖框架的 cookies().set()，行为更可控（多个 Set-Cookie 必须分开传数组）。
 */
export function buildCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value ?? "")}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join("; ");
}
