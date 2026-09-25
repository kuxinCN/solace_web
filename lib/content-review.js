/**
 * 内容安全审核（异步 / 批量）
 *
 * 背景：用户改头像、背景图、昵称、签名时**立刻生效**（不卡审核），
 * 但这些内容会被标上「未审核」，之后交给 AI 判定：
 *   合规 → 清掉标记
 *   违规 → 把对应字段改回后台配置的默认值
 *
 * 为什么是异步：审核用的是小米 MiMo 的「批量推理」—— 一次提交一批，
 * 结果**延迟返回**（不是实时）。所以流程拆成两步：
 *   ① submitPendingTasks() 把待审内容打包提交，拿到批次 id
 *   ② pollBatches() 回头查批次状态，完成了就把结果落库、执行处置
 *
 * 两种模式：
 *   batch  —— 批量推理（用户要的），提交 / 轮询两条腿走路
 *   inline —— 逐条调用对话接口，立刻出结果（批量接口不可用时兜底）
 *
 * ⚠️ 安全约定：
 *   * 所有写库的列名都来自本文件顶部的 REVIEW_FIELDS 常量，绝不拼接外部输入；
 *   * AI 返回解析不出来时**一律判合规**（宁可放过，不可误伤）；
 *   * 审核失败（网络 / 额度 / 协议不符）**绝不影响用户已经改好的资料**。
 */
import { execute, query } from "./db";
import { getGroup } from "./settings";
import { toMysqlDateTime } from "./util";

/**
 * 会被审核的字段。
 * defaultKey 指向 `settings.review` 里的默认值键 —— 判定违规时用它回填。
 */
export const REVIEW_FIELDS = [
  { field: "username", label: "昵称", column: "username", defaultKey: "defaultNickname", isImage: false },
  { field: "bio", label: "个性签名", column: "bio", defaultKey: "defaultBio", isImage: false },
  { field: "avatar_url", label: "头像", column: "avatar_url", defaultKey: "defaultAvatar", isImage: true },
  { field: "ai_avatar_url", label: "AI 头像", column: "ai_avatar_url", defaultKey: "defaultAiAvatar", isImage: true },
  {
    field: "chat_background_url",
    label: "聊天背景",
    column: "chat_background_url",
    defaultKey: "defaultChatBackground",
    isImage: true,
  },
  {
    field: "diary_background_url",
    label: "我的页背景",
    column: "diary_background_url",
    defaultKey: "defaultDiaryBackground",
    isImage: true,
  },
];

const FIELD_MAP = new Map(REVIEW_FIELDS.map((item) => [item.field, item]));

/** 单条待审内容的长度上限（图片是 data URL，给得宽一些） */
const MAX_TEXT_CHARS = 400;
const MAX_IMAGE_CHARS = 1400 * 1024;

/** 上游请求超时（上传 JSONL、创建批次这类控制面请求） */
const CONTROL_TIMEOUT_MS = 30000;

function now() {
  return toMysqlDateTime(new Date());
}

/**
 * 认证请求头。
 *
 * ⚠️ 这里是踩过坑的：小米 MiMo 的**批量推理文档**里，curl 示例用的是标准
 *    `Authorization: Bearer`；而对话 / TTS 走的是 `api-key` 头。
 *    两种写法平台都接受，所以遇到小米域名干脆**两个头一起发** ——
 *    多带一个没有副作用，但少带一个就是 401。
 */
function authHeaders(baseUrl, apiKey) {
  const base = String(baseUrl || "").toLowerCase();
  const headers = { "Content-Type": "application/json" };
  headers.Authorization = `Bearer ${apiKey}`;
  if (base.includes("xiaomimimo.com")) {
    headers["api-key"] = apiKey;
  }
  return headers;
}

/** 把后台填的地址补成 {base}/xxx（允许直接粘完整地址） */
function endpoint(baseUrl, suffix) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  const cleaned = base
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/files$/i, "")
    .replace(/\/batches$/i, "");
  return `${cleaned}${suffix}`;
}

function timeoutSignal(ms) {
  return typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

/* ------------------------------------------------------------------ 入队 */

/**
 * 把一条刚被修改的资料放进审核队列。
 *
 * ⚠️ 调用方必须用 try/catch 包住它 —— 审核系统出问题**不能**影响用户改资料。
 * 返回 true 表示已入队，false 表示跳过（内容为空 / 字段不认识 / 审核已关闭）。
 */
export async function enqueueReview({ userId, field, content }) {
  const meta = FIELD_MAP.get(String(field || ""));
  if (!meta || !userId) return false;

  const value = typeof content === "string" ? content : "";

  // 清空内容 = 恢复默认值，没什么可审的
  if (!value.trim()) return false;

  const maxChars = meta.isImage ? MAX_IMAGE_CHARS : MAX_TEXT_CHARS;
  if (value.length > maxChars) return false;

  try {
    await execute(
      `INSERT INTO content_review_tasks (user_id, field, content, is_image, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [userId, meta.field, value, meta.isImage ? 1 : 0]
    );

    // 给 users 行打上「未审核」tag —— 后台列表能一眼看出谁还有内容没过审。
    // 用 CONCAT 累加字段名，避免覆盖掉同一个用户其它字段的待审状态。
    await execute(
      `UPDATE users
          SET review_pending = TRIM(BOTH ',' FROM CONCAT(COALESCE(review_pending, ''), ?, ','))
        WHERE id = ?`,
      [`${meta.field},`, userId]
    );

    return true;
  } catch (err) {
    // 表还没建（老库首次升级）或者数据库抖动：静默跳过，别打扰用户
    console.error("[review] 入队失败：", err?.code || err?.message || err);
    return false;
  }
}

/** 去掉某个字段的待审 tag（审核完成 / 清空内容时调用） */
async function clearPendingTag(userId, field) {
  try {
    const rows = await query("SELECT review_pending FROM users WHERE id = ? LIMIT 1", [userId]);
    const current = String(rows[0]?.review_pending || "");
    if (!current) return;

    const kept = current
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item && item !== field);

    await execute("UPDATE users SET review_pending = ? WHERE id = ?", [
      kept.length ? kept.join(",") : null,
      userId,
    ]);
  } catch {
    /* 标记清理失败不影响主流程 */
  }
}

/* ------------------------------------------------------------ 提示词组装 */

/** 判断一条任务该用什么消息体（文本 / 图片） */
function buildMessages(task, config) {
  const meta = FIELD_MAP.get(String(task.field)) || { label: "资料" };
  const isImage = Number(task.is_image) === 1;

  const instruction = isImage
    ? `下面这张图片是用户设置的「${meta.label}」。请按系统提示里的规则判断它是否违规。`
    : `下面是用户设置的「${meta.label}」：\n"""\n${task.content}\n"""\n请按系统提示里的规则判断它是否违规。`;

  const content = isImage
    ? [
        { type: "text", text: instruction },
        { type: "image_url", image_url: { url: task.content } },
      ]
    : instruction;

  return [
    { role: "system", content: String(config.reviewPrompt || "") },
    { role: "user", content },
  ];
}

/* ------------------------------------------------------------ 结果解析 */

/**
 * 从模型输出里抠出判定结果。
 *
 * ⚠️ 这里的分寸很重要，改之前先读这段注释：
 *
 *   1. **尽量读懂模型的输出** —— 不同模型返回的字段名和取值五花八门
 *      （verdict / result / label / is_violation，值可能是 pass / reject /
 *       合规 / 违规 / true / false），所以做了大量兼容。
 *
 *   2. **真读不懂时返回 "unknown"，不猜**。
 *      以前这里是"一律按合规处理"，结果是：一条明明是脏话的内容，
 *      因为模型没按 JSON 格式回答，就被当成通过了 —— 审核形同虚设。
 *      现在的做法是交给**人工**：unknown 会被标成 failed 进后台待人工队列，
 *      既不会误伤用户（不动他的资料），也不会漏掉。
 */
export function parseVerdict(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) {
    return { verdict: "unknown", reason: "AI 没有返回任何内容" };
  }

  // 去掉常见的代码块包裹
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();

  // 优先取第一个 { 到最后一个 } 之间的内容
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1));
      const parsed = readVerdictFromObject(obj);
      if (parsed) return parsed;
    } catch {
      /* 不是合法 JSON，落到下面 */
    }
  }

  // 读不懂 → 交人工，绝不默认放过
  return {
    verdict: "unknown",
    reason: `AI 返回的不是约定格式，已转人工复核：${cleaned.slice(0, 120)}`,
  };
}

/** 取值时可能出现的字段名（各家模型的叫法不一样） */
const VERDICT_KEYS = [
  "verdict",
  "result",
  "judgment",
  "judgement",
  "decision",
  "label",
  "status",
  "violation",
  "is_violation",
  "isViolation",
  "violated",
];

/** 精确匹配用的词（短词放这里，避免 "no" 匹配到 "normal" 这种事故） */
const REJECT_EXACT = ["reject", "rejected", "fail", "failed", "true", "yes", "y", "1", "违规", "不合规", "违反", "否", "是"];
const PASS_EXACT = ["pass", "passed", "ok", "okay", "safe", "clean", "good", "false", "no", "n", "0", "合规", "正常", "通过", "没问题"];

/** 只在"包含"时才算数的长词（不会误伤） */
const REJECT_CONTAINS = ["violation", "violate", "inappropriate", "违规", "不合规", "违反", "违规内容"];
const PASS_CONTAINS = ["compliant", "complience", "compliance", "合规", "正常", "无违规", "clean", "safe"];

/**
 * 从一个对象里尽力读出判定。读不出来返回 null（交给上层转人工）。
 * 兼容：不同字段名、布尔值、中英文取值、以及 "not violation" 这类否定写法。
 */
function readVerdictFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;

  let rawVerdict;
  for (const key of VERDICT_KEYS) {
    if (obj[key] !== undefined && obj[key] !== null) {
      rawVerdict = obj[key];
      break;
    }
  }
  if (rawVerdict === undefined || rawVerdict === null) return null;

  const reason = String(
    obj.reason ?? obj.message ?? obj.explain ?? obj.explanation ?? obj.detail ?? ""
  ).slice(0, 220);

  // 布尔值：惯例是 true = 违规
  if (rawVerdict === true) return { verdict: "reject", reason };
  if (rawVerdict === false) return { verdict: "pass", reason };

  let value = String(rawVerdict).toLowerCase().trim();
  if (!value) return null;

  // 处理 "not violation" / "no_violation" 这类否定写法 —— 先反转再判断
  const negated = /^(not|no|non)[\s_\-]+/.test(value);
  if (negated) {
    value = value.replace(/^(not|no|non)[\s_\-]+/, "");
    // 否定 + "违规" = 合规
    if (REJECT_EXACT.includes(value) || REJECT_CONTAINS.some((w) => value.includes(w))) {
      return { verdict: "pass", reason };
    }
    if (PASS_EXACT.includes(value) || PASS_CONTAINS.some((w) => value.includes(w))) {
      return { verdict: "reject", reason };
    }
    return null;
  }

  // 先精确匹配（短词在这一步，避免 "no" 命中 "normal"）
  if (REJECT_EXACT.includes(value)) return { verdict: "reject", reason };
  if (PASS_EXACT.includes(value)) return { verdict: "pass", reason };

  // 再包含匹配（只用长词）
  if (REJECT_CONTAINS.some((w) => value.includes(w))) return { verdict: "reject", reason };
  if (PASS_CONTAINS.some((w) => value.includes(w))) return { verdict: "pass", reason };

  return null;
}

/* ------------------------------------------------------------ 违规处置 */

/**
 * 应用一条判定结果。
 * reject 时把 users 的对应列改回默认值，并在 review_flagged 里记一笔。
 */
export async function applyVerdict({ taskId, verdict, reason, provider }) {
  const rows = await query(
    "SELECT id, user_id, field, content, is_image FROM content_review_tasks WHERE id = ? LIMIT 1",
    [taskId]
  );
  if (!rows.length) return { ok: false, error: "任务不存在" };

  const task = rows[0];
  const meta = FIELD_MAP.get(String(task.field));
  if (!meta) return { ok: false, error: "字段类型未知" };

  // 三态：reject（违规）/ pass（合规）/ failed（读不懂，转人工）
  //
  // ⚠️ failed 这个中间态是必须的：
  //    模型返回格式不对时，我们**既不能当合规**（会漏掉脏话，审核形同虚设），
  //    也**不能当违规**（会误伤用户、把他的昵称重置掉）。
  //    所以只能交给人工 —— 状态标成 failed，出现在后台的「待人工」列表里。
  const finalVerdict =
    verdict === "reject" ? "reject" : verdict === "pass" ? "pass" : "failed";
  const finalReason = String(reason || "").slice(0, 250);

  await execute(
    `UPDATE content_review_tasks
        SET status = ?, reason = ?, provider = ?, reviewed_at = ?
      WHERE id = ?`,
    [finalVerdict, finalReason, String(provider || ""), now(), taskId]
  );

  if (finalVerdict === "reject") {
    // ⚠️ 先确认「被判违规的那份内容」现在还挂在用户身上：
    //    用户完全可能在被判定的这段时间里又改了一次，
    //    这时不能拿基于旧内容的判定去覆盖他刚写的新内容。
    const currentRows = await query(
      `SELECT \`${meta.column}\` AS value FROM users WHERE id = ? LIMIT 1`,
      [task.user_id]
    );
    const currentValue = String(currentRows[0]?.value ?? "");
    const judgedValue = String(task.content ?? "");

    if (currentValue !== judgedValue) {
      await execute(
        "UPDATE content_review_tasks SET reason = ?, reviewed_at = ? WHERE id = ?",
        [`${finalReason}（判定期间内容已被用户再次修改，未做处置）`.slice(0, 250), now(), taskId]
      );
      await clearPendingTag(task.user_id, meta.field);
      return { ok: true, verdict: "stale", field: meta.field, label: meta.label };
    }

    const config = await getGroup("review");
    let fallback = String(config?.[meta.defaultKey] || "").trim();

    // ⚠️ 昵称绝对不能落成 NULL：
    //    如果后台没配「默认昵称」（或配成了空），写 NULL 会让用户名变成一片空白 ——
    //    聊天列表、会话标题、「我的」页到处都在取名字，空名字看起来就像坏掉了。
    //    这里兜一个「用户」：宁可显示"用户"，也不能空着。
    if (!fallback && meta.field === "username") fallback = "用户";

    // ⚠️ meta.column 来自本文件的常量表，不是外部输入 —— 不存在注入面
    await execute(`UPDATE users SET \`${meta.column}\` = ? WHERE id = ?`, [
      fallback || null,
      task.user_id,
    ]);

    try {
      const flagRows = await query("SELECT review_flagged FROM users WHERE id = ? LIMIT 1", [
        task.user_id,
      ]);
      const kept = String(flagRows[0]?.review_flagged || "")
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item && item !== meta.field);
      kept.push(meta.field);
      await execute("UPDATE users SET review_flagged = ? WHERE id = ?", [
        kept.join(",").slice(0, 250),
        task.user_id,
      ]);
    } catch {
      /* 标记写入失败不影响主流程 */
    }
  }

  // ⚠️ 只有**审出结果**了才清掉「未审核」tag。
  //    failed 的那些还挂在「待人工」队列里，tag 必须留着 ——
  //    否则后台的用户列表里就看不出他还有内容没过审。
  if (finalVerdict !== "failed") {
    await clearPendingTag(task.user_id, meta.field);
  }

  return { ok: true, verdict: finalVerdict, field: meta.field, label: meta.label };
}

/* ------------------------------------------------------------ 本地预检 */

/**
 * 本地预检词表（明确到没有讨论余地的那些）。
 *
 * 为什么要本地拦一遍：有些词根本不需要问 AI —— 本地命中既快又准，
 * 还能避免"模型今天判断得比较宽松，把 fuck 放过去了"这种不确定性。
 *
 * ⚠️ 选词原则：**只放没有歧义的**。
 *    比如"滚"在中文里既可能是骂人、也可能是"滚去睡觉"的亲昵说法，就不放。
 *    误伤用户的代价远大于漏过一条（漏过的管理员还能在后台人工看）。
 *
 * ⚠️ 英文用「词首匹配」而不是子串匹配：
 *    `\bfuck` 能盖住 fuck / fucking / fucked，但不会误伤 shiitake（香菇）。
 */
const EN_BLOCKLIST = [
  "fuck",
  "fuk",
  "fck",
  "shit",
  "bitch",
  "bastard",
  "asshole",
  "dickhead",
  "cunt",
  "whore",
  "slut",
  "nigger",
  "nigga",
  "retard",
  "porn",
  "rape",
  "nudes",
];

/**
 * 中文脏话词表。
 *
 * ⚠️ 这份表是**用真实案例补出来的**，别删这段注释：
 *    用户实测「我tm草泥马，你个废物，臭sb」这串内容，**一条都没命中** ——
 *    因为当时的词表只有"操你""傻逼"这种**规范写法**，而实际骂人用的是
 *    谐音（草泥马）、拼音缩写（tm / sb）、以及"废物"这类侮辱词。
 *
 *    教训：**骂人的写法比词典更新得快**。所以下面按「家族 + 变体」列，
 *    而不是只列规范写法。以后遇到漏的，优先往这里补。
 */
const ZH_BLOCKLIST = [
  // ---- 操你妈 / 草泥马 家族（含常见谐音）----
  "操你",
  "草你",
  "艹你",
  "曹你",
  "草泥马",
  "草尼玛",
  "曹尼玛",
  "艹泥马",
  "草原马",
  "草泥媽",
  "操他妈",
  "草他妈",
  "艹他妈",

  // ---- 妈的 / 尼玛 家族 ----
  "他妈的",
  "你妈的",
  "妈的",
  "尼玛",
  "尼马",
  "特么",

  // ---- 傻逼家族 ----
  "傻逼",
  "煞笔",
  "沙比",
  "杀笔",
  "傻批",
  "傻比",
  "傻x",
  "傻b",

  // ---- 侮辱性称呼 ----
  "贱人",
  "婊子",
  "表子",
  "杂种",
  "狗杂种",
  "畜生",
  "废物",
  "蠢货",
  "蠢猪",
  "猪脑子",
  "脑残",
  "智障",
  "弱智",
  "死胖子",
  "丑八怪",

  // ---- 恶毒诅咒 ----
  "死全家",
  "全家死",
  "你妈死了",
  "尼玛死了",
  "死妈",

  // ---- 广告引流 ----
  "加微信",
  "微信号是",
  "加qq",
  "加扣扣",
  "代刷",
  "刷单",
  "博彩",
  "赌场",
  "洗钱",
  "扫码加",
  "私聊我",
  "低价出",
];

/**
 * 拼音缩写类的脏话（两三个字母）。
 *
 * ⚠️ 这些**不能直接子串匹配** —— "asb" 里也含 "sb"，会误伤正常内容。
 *    规则是：**前后不能是英文字母**才算命中。
 *    例：「我tm草泥马」✅ 命中（前后是中文）；「ASB Bank」❌ 不命中（前面是字母）。
 */
const ZH_ABBR_BLOCKLIST = [
  "sb", // 傻逼
  "tm", // 他妈
  "tmd", // 他妈的
  "nmsl", // 你妈死了
  "cnm", // 草泥马
  "mdzz", // 妈的智障
  "wdnmd", // 我打你妈的
];

/**
 * 跑一遍本地词表，命中就返回命中的那个词，没命中返回空串。
 *
 * @param text         要检查的文本
 * @param customWords  后台「自定义违禁词」的多行文本（可选）
 */
export function matchBlocklist(text, customWords = "") {
  const raw = String(text || "");
  if (!raw) return "";

  const lower = raw.toLowerCase();

  // 英文：\b 词首匹配，避免误伤包含这些字母组合的正常单词
  for (const word of EN_BLOCKLIST) {
    try {
      if (new RegExp(`\\b${word}`, "i").test(lower)) return word;
    } catch {
      /* 词表里出现非法正则字符时跳过这个词，不影响其它 */
    }
  }

  // 中文：直接子串匹配
  for (const word of ZH_BLOCKLIST) {
    if (lower.includes(word.toLowerCase())) return word;
  }

  // 拼音缩写：前后不能是英文字母（避免 asb 这类误伤）
  for (const word of ZH_ABBR_BLOCKLIST) {
    try {
      if (new RegExp(`(?:^|[^a-z])${word}(?:[^a-z]|$)`, "i").test(lower)) return word;
    } catch {
      /* 忽略非法正则 */
    }
  }

  // 后台自己加的违禁词
  for (const word of parseCustomWords(customWords)) {
    if (!word) continue;
    // 纯英文/符号的词按词首匹配（避免误伤含这些字母的普通单词），含中文的直接子串匹配
    if (/^[\x20-\x7e]+$/.test(word)) {
      try {
        if (new RegExp(`\\b${word}`, "i").test(lower)) return word;
      } catch {
        /* 词里有非法正则字符，跳过这个词 */
      }
    } else if (lower.includes(word)) {
      return word;
    }
  }

  return "";
}

/** 把后台填的多行词表拆成数组（每行一个，# 开头忽略） */
function parseCustomWords(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.toLowerCase())
    .slice(0, 500); // 上限 500：防止有人整本词典贴进来，每条都要跑一遍
}

/**
 * 提交前先跑一遍本地预检：命中的直接判违规，不浪费 AI 调用。
 * @returns { remaining, rejected } —— 剩下要送 AI 的任务，和本地已判违规的条数
 */
async function precheckLocally(tasks, config) {
  const remaining = [];
  let rejected = 0;

  for (const task of tasks) {
    // 图片没法做本地文本匹配，直接留给 AI
    if (Number(task.is_image) === 1) {
      remaining.push(task);
      continue;
    }

    const hit = matchBlocklist(task.content, config?.customBlocklist);
    if (!hit) {
      remaining.push(task);
      continue;
    }

    try {
      await applyVerdict({
        taskId: task.id,
        verdict: "reject",
        reason: `本地词表命中「${hit}」（不用送 AI 就能判定）`,
        provider: "local",
      });
      rejected += 1;
    } catch {
      // 处置失败就退回给 AI 处理，别让这条卡住
      remaining.push(task);
    }
  }

  return { remaining, rejected };
}

/* ------------------------------------------------------------ 提交（批量） */

/**
 * 取出一批待审任务（**不做任何过滤**，图片和文本都取出来）。
 *
 * ⚠️ 为什么这里不过滤：图片和文本的"去向"不一样 ——
 *    文本能进批量，图片不能（多模态消息体会让整批创建失败）。
 *    分流放在 submitPendingTasks 里做，这里只管取。
 */
async function takePending(limit, config) {
  void config;
  return query(
    `SELECT id, user_id, field, content, is_image
       FROM content_review_tasks
      WHERE status = 'pending'
      ORDER BY id ASC
      LIMIT ?`,
    [limit]
  );
}

/**
 * 把一批任务标成「等人工」（status = manual）。
 *
 * 主要用在图片上：批量推理吃不下多模态消息体（整批创建会直接失败），
 * 所以批量模式下图片不进 AI。标成 manual 之后：
 *   · 不会再被 takePending 捞出来反复尝试（否则每次提交都白跑一遍）
 *   · 后台「待人工」筛选里能看到，管理员点一下就能通过 / 驳回
 */
async function markTasksManual(taskIds, reason) {
  if (!taskIds.length) return 0;
  try {
    const result = await execute(
      `UPDATE content_review_tasks
          SET status = 'manual', reason = ?, reviewed_at = ?
        WHERE id IN (${taskIds.map(() => "?").join(",")})`,
      [String(reason).slice(0, 250), now(), ...taskIds]
    );
    return result.affectedRows || 0;
  } catch {
    return 0;
  }
}

/**
 * 把待审内容提交上去。
 *
 * @returns { ok, provider, batchId?, taskCount, error?, fallback? }
 */
export async function submitPendingTasks({ limit } = {}) {
  const config = await getGroup("review");
  if (!config?.enabled) return { ok: false, error: "数据审核未启用", taskCount: 0 };
  if (!config.baseUrl || !config.apiKey || !config.model) {
    return { ok: false, error: "审核 AI 还没配置完整（接口地址 / API Key / 模型名）", taskCount: 0 };
  }

  const max = Math.min(Number(limit) || config.maxItemsPerBatch || 20, 100);
  const pending = await takePending(max, config);
  if (!pending.length) {
    return { ok: true, provider: "none", taskCount: 0, message: "没有待审核的内容" };
  }

  const useBatch = String(config.mode || "batch") === "batch";
  const imagesEnabled = config.reviewImages !== false;
  const imageHandling = String(config.imageHandling || "manual");

  const imageTasks = pending.filter((task) => Number(task.is_image) === 1);
  const textTasks = pending.filter((task) => Number(task.is_image) !== 1);

  /* ---- 图片任务分流 ----
   *   关了「连图片一起送审」           → 标人工
   *   批量模式 + imageHandling=manual  → 标人工（批量吃不下图片）
   *   批量模式 + imageHandling=inline  → 用逐条单独审
   *   逐条模式                         → 跟文本一起走逐条
   *
   * ⚠️ 为什么图片不能进批量：图片是多模态消息体（content 是数组 + base64），
   *    实测会让**整个批次在创建阶段就失败**（HTTP 500）—— 一条图片拖垮整批。
   *    但逐条是单条调用，互不牵连，所以那条路是通的。
   */
  let imagesToInline = [];
  let manualCount = 0;

  if (imageTasks.length) {
    const imageIds = imageTasks.map((task) => task.id);

    if (!imagesEnabled) {
      manualCount = await markTasksManual(
        imageIds,
        "后台关闭了「连图片一起送审」，图片转入人工队列"
      );
    } else if (useBatch && imageHandling !== "inline") {
      manualCount = await markTasksManual(
        imageIds,
        "图片不走批量（多模态消息体会让整批创建失败），已转入人工队列"
      );
    } else {
      imagesToInline = imageTasks;
    }
  }

  /* ---- 文本任务先过本地词表（图片不参与文本匹配）---- */
  const { remaining: textToSend, rejected: localRejected } = await precheckLocally(
    textTasks,
    config
  );

  const textViaBatch = useBatch ? textToSend : [];
  let inlineTasks = useBatch ? [...imagesToInline] : [...textToSend, ...imagesToInline];

  if (!textViaBatch.length && !inlineTasks.length) {
    return {
      ok: true,
      provider: "none",
      taskCount: pending.length,
      localRejected,
      manualCount,
      message:
        [
          localRejected ? `本地词表判违规 ${localRejected} 条` : "",
          manualCount ? `${manualCount} 条图片转入人工队列` : "",
        ]
          .filter(Boolean)
          .join("；") || "没有需要送 AI 的内容",
    };
  }

  /* ---- 文本走批量；失败则连同图片一起转逐条 ---- */
  let batchInfo = {};

  if (textViaBatch.length) {
    try {
      batchInfo = await submitAsBatch({ tasks: textViaBatch, config });
    } catch (err) {
      const message = err?.message || String(err);
      console.error("[review] 批量提交失败：", message);

      // 记一条失败批次，后台能看到"什么时候试过批量、报的什么错"
      try {
        await execute(
          `INSERT INTO content_review_batches
             (provider, status, task_count, failed_count, error, completed_at)
           VALUES ('mimo-batch', 'failed', ?, ?, ?, ?)`,
          [textViaBatch.length, textViaBatch.length, message.slice(0, 500), now()]
        );
      } catch {
        /* 记录失败不影响降级流程 */
      }

      if (config.autoFallback === false) {
        return { ok: false, provider: "mimo-batch", taskCount: 0, error: message };
      }

      batchInfo = { fallback: true, batchError: message };
      inlineTasks = [...textViaBatch, ...inlineTasks];
    }
  }

  /* ---- 逐条处理：图片，以及批量失败后降级过来的文本 ---- */
  let inlineResult = {};
  if (inlineTasks.length) {
    inlineResult = await submitInline({ tasks: inlineTasks, config });
  }

  const provider =
    textViaBatch.length && !batchInfo.fallback
      ? "mimo-batch"
      : inlineTasks.length
        ? "inline"
        : "none";

  return {
    ok: inlineResult.ok !== false,
    provider,
    taskCount: pending.length,
    localRejected,
    manualCount,
    ...batchInfo,
    ...inlineResult,
  };
}

/** 走批量推理：上传 JSONL → 创建批次 → 记录批次行 */
async function submitAsBatch({ tasks, config }) {
  // ⚠️ 批量推理用的是**独立的域名**，不是对话接口那个：
  //    https://batch-api-{region}.xiaomimimo.com/v1  （region 从控制台批量推理页看）
  //    没配 batchBaseUrl 时会退回对话地址 —— 那样提交必然失败，
  //    然后走自动降级（逐条模式），功能不受影响。
  const batchBase = String(config.batchBaseUrl || "").trim() || config.baseUrl;

  // ① 组装 JSONL。格式严格按小米文档：
  //    {"custom_id":"request-1","method":"POST","url":"/v1/chat/completions","body":{...}}
  //    —— custom_id 在文件内必须唯一，我们用任务 id，回收结果时靠它对齐。
  const lines = tasks.map((task) =>
    JSON.stringify({
      custom_id: `rev-${task.id}`,
      method: "POST",
      url: "/v1/chat/completions",
      body: {
        model: config.model,
        messages: buildMessages(task, config),
        max_tokens: 200,
        temperature: 0,
      },
    })
  );

  const form = new FormData();
  form.append("purpose", "batch");
  form.append(
    "file",
    new Blob([lines.join("\n")], { type: "application/jsonl" }),
    "solace-review.jsonl"
  );

  const headers = authHeaders(batchBase, config.apiKey);
  delete headers["Content-Type"]; // multipart 必须让 fetch 自己带 boundary

  const uploadRes = await fetch(endpoint(batchBase, "/files"), {
    method: "POST",
    headers,
    body: form,
    signal: timeoutSignal(CONTROL_TIMEOUT_MS),
  });
  const uploadText = await uploadRes.text();
  if (!uploadRes.ok) {
    throw new Error(`上传审核文件失败（HTTP ${uploadRes.status}）：${uploadText.slice(0, 200)}`);
  }

  let uploaded = null;
  try {
    uploaded = JSON.parse(uploadText);
  } catch {
    uploaded = null;
  }
  const fileId = uploaded?.id || uploaded?.file_id || "";
  if (!fileId) throw new Error("上传成功但没有拿到文件 id，说明接口协议和预期不一致");

  // ② 创建批次
  //
  // ⚠️ completion_window 是个坑，这里做了自动重试：
  //    官方文档说接口「当前固定 24h」，只有控制台建任务才能设 1–14 天。
  //    实测填 168h（7 天）这类值时，服务端直接回 **HTTP 500 internal_error**，
  //    整个提交就挂在"创建批次"这一步（上传文件那步其实是成功的）。
  //
  //    所以策略是：**先用你配的值试，失败且不是 24h 就自动退回 24h 重试一次** ——
  //    功能不该因为一个可选参数挂掉。
  const createBatch = async (windowValue) => {
    const res = await fetch(endpoint(batchBase, "/batches"), {
      method: "POST",
      headers: authHeaders(batchBase, config.apiKey),
      body: JSON.stringify({
        input_file_id: fileId,
        endpoint: "/v1/chat/completions",
        completion_window: windowValue,
      }),
      signal: timeoutSignal(CONTROL_TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  };

  const wantedWindow = String(config.completionWindow || "").trim() || "24h";
  let batchResult = await createBatch(wantedWindow);
  let windowNote = "";

  if (!batchResult.ok && wantedWindow !== "24h") {
    console.warn(
      `[review] 用 ${wantedWindow} 创建批次失败（HTTP ${batchResult.status}），自动退回 24h 重试`
    );
    const firstStatus = batchResult.status;
    batchResult = await createBatch("24h");

    windowNote = batchResult.ok
      ? `「最长等待时间」填的 ${wantedWindow} 被上游拒绝（HTTP ${firstStatus}），已自动改用 24h`
      : "";
  }

  if (!batchResult.ok) {
    // ⚠️ 把「我们发了什么」也带上：
    //    上游只回一句 internal_error 的时候，没有这些参数根本没法定位问题
    const imageCount = tasks.filter((task) => Number(task.is_image) === 1).length;
    throw new Error(
      `创建审核批次失败（HTTP ${batchResult.status}）：${batchResult.text.slice(0, 200)}` +
        `｜本次参数：endpoint=/v1/chat/completions、completion_window=${wantedWindow}、` +
        `任务数=${tasks.length}（其中图片 ${imageCount} 条）、文件 ${fileId}`
    );
  }

  const batchText = batchResult.text;

  let created = null;
  try {
    created = JSON.parse(batchText);
  } catch {
    created = null;
  }
  const remoteId = created?.id || created?.batch_id || "";
  if (!remoteId) throw new Error("创建批次成功但没有返回批次 id");

  // ③ 落库：批次记录 + 任务状态
  //
  // expires_at 是上游返回的过期时间（Unix 秒）。存下来是为了能**验证**
  // 「最长等待时间」有没有生效 —— 设了 7 天而上游仍按 24h 算的话，
  // 这个时间会把真相暴露出来（后台批次列表里能看到）。
  const expiresAt = Number(created?.expires_at) || 0;

  const insert = await execute(
    `INSERT INTO content_review_batches
       (remote_id, provider, status, file_id, task_count, expires_at)
     VALUES (?, 'mimo-batch', 'submitted', ?, ?, ?)`,
    [
      remoteId,
      fileId,
      tasks.length,
      expiresAt ? toMysqlDateTime(new Date(expiresAt * 1000)) : null,
    ]
  );

  const ids = tasks.map((task) => task.id);
  await execute(
    `UPDATE content_review_tasks
        SET status = 'submitted', batch_id = ?, provider = 'mimo-batch', submitted_at = ?
      WHERE id IN (${ids.map(() => "?").join(",")})`,
    [remoteId, now(), ...ids]
  );

  await execute(
    "UPDATE content_review_batches SET remote_id = ? WHERE id = ?",
    [remoteId, insert.insertId]
  );

  return { batchId: remoteId, localBatchId: insert.insertId, ...(windowNote ? { windowNote } : {}) };
}

/** 逐条模式：立刻调用对话接口，拿到结果当场处置 */
async function submitInline({ tasks, config }) {
  const url = endpoint(config.baseUrl, "/chat/completions");
  let passCount = 0;
  let rejectCount = 0;
  let failedCount = 0;

  for (const task of tasks) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: authHeaders(config.baseUrl, config.apiKey),
        body: JSON.stringify({
          model: config.model,
          messages: buildMessages(task, config),
          max_tokens: 200,
          temperature: 0,
        }),
        signal: timeoutSignal(Math.min(Number(config.timeoutSeconds) || 120, 600) * 1000),
      });

      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 150)}`);

      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }

      const reply = data?.choices?.[0]?.message?.content || "";
      const { verdict, reason } = parseVerdict(reply);
      await applyVerdict({ taskId: task.id, verdict, reason, provider: "inline" });

      // 三态分别计数：读不懂的算 failed（会进后台「待人工」），绝不能混进"通过"
      if (verdict === "reject") rejectCount += 1;
      else if (verdict === "pass") passCount += 1;
      else failedCount += 1;
    } catch (err) {
      failedCount += 1;
      // 单条失败不中断整批：标记 failed，后台可以人工处理
      try {
        await execute(
          "UPDATE content_review_tasks SET status = 'failed', reason = ?, reviewed_at = ? WHERE id = ?",
          [`审核请求失败：${String(err?.message || err).slice(0, 200)}`, now(), task.id]
        );
      } catch {
        /* 忽略 */
      }
      // 第一条就失败（多半是配置问题）时提前退出，别把剩下的都试一遍
      if (failedCount === 1 && passCount === 0 && rejectCount === 0) {
        const message = String(err?.message || err);
        const insert = await execute(
          `INSERT INTO content_review_batches
             (provider, status, task_count, failed_count, error, completed_at)
           VALUES ('inline', 'failed', ?, ?, ?, ?)`,
          [tasks.length, failedCount, message.slice(0, 500), now()]
        );
        void insert;
        return { ok: false, error: message, passCount, rejectCount, failedCount };
      }
    }
  }

  await execute(
    `INSERT INTO content_review_batches
       (provider, status, task_count, pass_count, reject_count, failed_count, completed_at)
     VALUES ('inline', 'completed', ?, ?, ?, ?, ?)`,
    [tasks.length, passCount, rejectCount, failedCount, now()]
  );

  return { ok: true, passCount, rejectCount, failedCount };
}

/* ------------------------------------------------------------ 轮询结果 */

/**
 * 查一遍进行中的批次。完成的就把结果落库并执行处置。
 * @returns { ok, checked, completed, detail[] }
 */
export async function pollBatches() {
  const config = await getGroup("review");
  if (!config?.baseUrl || !config?.apiKey) {
    return { ok: false, error: "审核 AI 还没配置完整", checked: 0, completed: 0 };
  }

  const batches = await query(
    `SELECT id, remote_id, file_id, task_count
       FROM content_review_batches
      WHERE status = 'submitted' AND remote_id IS NOT NULL
      ORDER BY id ASC
      LIMIT 20`
  );

  const detail = [];
  let completed = 0;

  for (const batch of batches) {
    try {
      const res = await fetch(endpoint(config.baseUrl, `/batches/${batch.remote_id}`), {
        headers: authHeaders(config.baseUrl, config.apiKey),
        signal: timeoutSignal(CONTROL_TIMEOUT_MS),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 150)}`);

      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }

      const status = String(data?.status || "").toLowerCase();

      if (status === "completed") {
        const outputFileId = data?.output_file_id || "";
        const summary = outputFileId
          ? await applyBatchResults({ batchId: batch.id, outputFileId, config })
          : { passCount: 0, rejectCount: 0, failedCount: 0, note: "批次完成但没有结果文件" };
        await execute(
          `UPDATE content_review_batches
              SET status = 'completed', output_file_id = ?, pass_count = ?, reject_count = ?,
                  failed_count = ?, completed_at = ?
            WHERE id = ?`,
          [
            outputFileId,
            summary.passCount,
            summary.rejectCount,
            summary.failedCount,
            now(),
            batch.id,
          ]
        );
        completed += 1;
        detail.push({ batchId: batch.remote_id, status, ...summary });
      } else if (status === "failed" || status === "expired" || status === "cancelled") {
        const message = String(data?.errors?.data?.[0]?.message || data?.error || status).slice(0, 400);
        await execute(
          "UPDATE content_review_batches SET status = 'failed', error = ?, completed_at = ? WHERE id = ?",
          [message, now(), batch.id]
        );
        detail.push({ batchId: batch.remote_id, status, error: message });
      } else {
        // validating / in_progress / finalizing：还在跑，下次再看
        detail.push({ batchId: batch.remote_id, status: status || "unknown" });
      }
    } catch (err) {
      detail.push({ batchId: batch.remote_id, status: "error", error: String(err?.message || err).slice(0, 200) });
    }
  }

  return { ok: true, checked: batches.length, completed, detail };
}

/** 下载结果 JSONL 并逐行应用 */
async function applyBatchResults({ batchId, outputFileId, config }) {
  const res = await fetch(endpoint(config.baseUrl, `/files/${outputFileId}/content`), {
    headers: authHeaders(config.baseUrl, config.apiKey),
    signal: timeoutSignal(CONTROL_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`下载审核结果失败（HTTP ${res.status}）：${text.slice(0, 150)}`);

  let passCount = 0;
  let rejectCount = 0;
  let failedCount = 0;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let item = null;
    try {
      item = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const customId = String(item?.custom_id || "");
    const taskId = Number(customId.replace(/^rev-/, ""));
    if (!Number.isInteger(taskId) || taskId <= 0) continue;

    const reply = item?.response?.body?.choices?.[0]?.message?.content || "";
    const statusCode = Number(item?.response?.status_code) || 0;

    // ⚠️ 失败行有两种形态，**必须都认出来**，否则会被当成"模型没说话"而判成合规：
    //    ① 请求级失败（错误文件里的行）：response 是 null，错误在 item.error
    //       {"custom_id":"...","response":null,"error":{"code":"inference_failed","message":"400 Bad Request"}}
    //    ② 调用级失败：response 存在但 status_code >= 400
    const itemError = item?.error || null;

    try {
      if (itemError || !item?.response) {
        failedCount += 1;
        await execute(
          "UPDATE content_review_tasks SET status = 'failed', reason = ?, reviewed_at = ? WHERE id = ?",
          [
            `上游未返回结果：${String(itemError?.message || itemError?.code || "response 为空").slice(
              0,
              180
            )}`,
            now(),
            taskId,
          ]
        );
        continue;
      }

      if (statusCode && statusCode >= 400) {
        failedCount += 1;
        await execute(
          "UPDATE content_review_tasks SET status = 'failed', reason = ?, reviewed_at = ? WHERE id = ?",
          [
            `AI 返回 HTTP ${statusCode}：${String(item?.response?.body?.error?.message || "").slice(
              0,
              180
            )}`,
            now(),
            taskId,
          ]
        );
        continue;
      }

      const { verdict, reason } = parseVerdict(reply);
      const applied = await applyVerdict({ taskId, verdict, reason, provider: "mimo-batch" });
      if (!applied.ok) {
        failedCount += 1;
        continue;
      }
      // 三态分别计数：读不懂的算 failed（进后台「待人工」），不能混进"通过"
      if (verdict === "reject") rejectCount += 1;
      else if (verdict === "pass") passCount += 1;
      else failedCount += 1;
    } catch (err) {
      failedCount += 1;
      console.error("[review] 应用审核结果失败：", err?.message || err);
    }
  }

  void batchId;
  return { passCount, rejectCount, failedCount };
}

/* ------------------------------------------------------------ 人工判定 */

/**
 * 人工判定（后台点「通过 / 驳回」用）。
 * 主要用于：AI 审核失败的任务、以及关掉 AI 审图后积压的图片。
 */
export async function applyManualVerdict({ taskId, approve, adminName }) {
  try {
    if (!approve) {
      // 驳回 = 走和 AI 判定相同的处置逻辑
      const result = await applyVerdict({
        taskId,
        verdict: "reject",
        reason: `管理员 ${adminName || ""} 人工判定为不合规`.trim(),
        provider: "manual",
      });
      return result;
    }

    const rows = await query(
      "SELECT id, user_id, field FROM content_review_tasks WHERE id = ? LIMIT 1",
      [taskId]
    );
    if (!rows.length) return { ok: false, error: "任务不存在" };

    const meta = FIELD_MAP.get(String(rows[0].field));
    await execute(
      "UPDATE content_review_tasks SET status = 'pass', reason = ?, provider = 'manual', reviewed_at = ? WHERE id = ?",
      [`管理员 ${adminName || ""} 人工通过`.trim(), now(), taskId]
    );
    if (meta) await clearPendingTag(rows[0].user_id, meta.field);
    return { ok: true, verdict: "pass" };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/* ------------------------------------------------------------ 存量补审 */

/** 读出这批用户在审核表里的最新记录，用来判断"这份内容是不是已经审过" */
async function loadLatestMap(users) {
  const map = new Map();
  if (!users.length) return map;

  try {
    const ids = users.map((user) => user.id);
    const rows = await query(
      `SELECT user_id, field, content
         FROM content_review_tasks
        WHERE user_id IN (${ids.map(() => "?").join(",")})
        ORDER BY id DESC`,
      ids
    );
    // 按 id 倒序取的，所以每个 (用户, 字段) 遇到的第一条就是最新的
    for (const row of rows) {
      const key = `${row.user_id}:${row.field}`;
      if (!map.has(key)) map.set(key, String(row.content ?? ""));
    }
  } catch {
    /* 表还不存在时按"没有任何记录"处理，后面入队会自然失败并跳过 */
  }

  return map;
}

/**
 * 扫描存量数据：把「已经有内容、但还没审过」的字段补进审核队列。
 *
 * 为什么需要它：审核是后加的功能，老用户早就填好了昵称、头像 ——
 * 这些内容从来没进过队列，后台的「待提交」永远是 0。
 * 点一次「扫描存量数据」就能把它们补齐。
 *
 * 判定规则：
 *   * 值非空的字段才入队（空的没什么可审）
 *   * 该字段**最新一条审核记录的正文和当前值完全一样** → 这份内容审过了，跳过
 *   * 其余一律入队（含"改过但还没提交过审核"的情况）
 *
 * ⚠️ 一次最多入队 limit 条（默认 100）。内部会自动翻页跳过已审过的用户，
 *    所以不会出现"点一次什么都没干、再点还是同一批"的死循环。
 */
export async function scanExistingContent({ limit = 100 } = {}) {
  const max = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const PAGE = 100;

  let cursor = 0;
  let scannedUsers = 0;
  let scannedFields = 0;
  let queued = 0;
  let skipped = 0;
  const tooLarge = [];
  let reachedEnd = false;

  while (queued < max) {
    const users = await query(
      `SELECT id, username, bio, avatar_url, ai_avatar_url, chat_background_url, diary_background_url
         FROM users
        WHERE status = 1
          AND id > ?
          AND (
            (username IS NOT NULL AND TRIM(username) <> '')
            OR (bio IS NOT NULL AND TRIM(bio) <> '')
            OR (avatar_url IS NOT NULL AND avatar_url <> '')
            OR (ai_avatar_url IS NOT NULL AND ai_avatar_url <> '')
            OR (chat_background_url IS NOT NULL AND chat_background_url <> '')
            OR (diary_background_url IS NOT NULL AND diary_background_url <> '')
          )
        ORDER BY id ASC
        LIMIT ?`,
      [cursor, PAGE]
    );

    if (!users.length) {
      reachedEnd = true;
      break;
    }

    cursor = users[users.length - 1].id;
    scannedUsers += users.length;

    const latest = await loadLatestMap(users);

    for (const user of users) {
      for (const meta of REVIEW_FIELDS) {
        if (queued >= max) break;

        const raw = String(user[meta.column] ?? "");
        if (!raw.trim()) continue;
        scannedFields += 1;

        if (latest.get(`${user.id}:${meta.field}`) === raw) {
          skipped += 1;
          continue;
        }

        const accepted = await enqueueReview({
          userId: user.id,
          field: meta.field,
          content: raw,
        });

        if (accepted) {
          queued += 1;
        } else if (raw.length > (meta.isImage ? MAX_IMAGE_CHARS : MAX_TEXT_CHARS)) {
          // 图片太大（超过 1.4MB）的个例，列出来让管理员知道
          tooLarge.push(`${meta.label}#${user.id}`);
          skipped += 1;
        } else {
          skipped += 1;
        }
      }
      if (queued >= max) break;
    }
  }

  // 还剩多少用户没扫（不是精确值，用来提示"可以再点一次"）
  let remainder = 0;
  try {
    const rest = await query(
      `SELECT COUNT(*) AS n FROM users WHERE status = 1 AND id > ?`,
      [cursor]
    );
    remainder = Number(rest[0]?.n) || 0;
  } catch {
    remainder = 0;
  }

  const parts = [`扫描 ${scannedUsers} 个用户`];
  parts.push(`新入队 ${queued} 条`);
  if (skipped) parts.push(`跳过 ${skipped} 条（内容没变过或为空）`);
  if (tooLarge.length) parts.push(`其中 ${tooLarge.length} 条图片过大未入队`);
  if (remainder && !reachedEnd && queued >= max) {
    parts.push(`还剩约 ${remainder} 个用户，可以再点一次`);
  } else if (reachedEnd || !remainder) {
    parts.push("已经扫到最后一个用户");
  }

  return {
    ok: true,
    scannedUsers,
    scannedFields,
    queued,
    skipped,
    tooLarge: tooLarge.slice(0, 5),
    remainder,
    reachedEnd,
    message: parts.join("，"),
  };
}
