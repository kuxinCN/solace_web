/**
 * TTS 朗读标签（语音情绪 / 声音事件）—— 出厂词表 + 展示侧剥离 + 生成侧提示词。
 *
 * 为什么需要它：
 *   小米 MiMo 的语音合成支持在 `role: assistant` 的文本里内嵌标签控制朗读语气。
 *   官方规定（文档「风格控制 → 音频标签控制」）是**位置 + 括号**两件事：
 *     · 风格 / 语气 → 写在**整段最开头**，用圆括号：`(温柔)你好呀`
 *       （半角 () / 全角 （） / [] 都认；但唱歌那节明确写「必须 `(唱歌)`」，所以生成侧统一圆括号）
 *     · 声音事件   → 插在**句中任意位置**，用方括号：`我没事[叹气]，真的`
 *   ⚠️ 生成侧按这套写（见 `buildTtsTagInstruction`），但**剥离侧两种括号都认、也不看位置** ——
 *      历史消息里存的是 `[温柔]` `(叹气)` 那套旧写法，改了生成规矩之后照样要剥干净。
 *   ⚠️ 别把标签和"括号动作描写"搞混：人设提示词里有「用括号写动作」的规则
 *      （`（把手搭在你肩上）`），那是**给人看的动作描写**，不是朗读标签。
 *      实测这种动作描写 MiMo 会安静吞掉、不会念出来（见 docs/TTS.md 的自测方法）。
 *   链路是：
 *     ① AI 生成（带标签）→ ② 存库（**保留原文**，TTS 要用）
 *     → ③ 用户看到的气泡**剥掉标签**（否则屏幕上会出现 `[开心]` 这种怪东西）
 *     → ④ 朗读时把原始带标签文本发给 MiMo。
 *
 * ⚠️ 为什么**不用**"任意中文 / 任意英文"那种宽松正则：
 *   `[sticker:comfort]`、`[RISK:no]`、`[1]`、`[链接](url)`、`（约 3 分钟）`、`(int)`
 *   会被它一起吃掉 —— 前两个是我们自己的控制标记，后几个是正常内容。
 *   这里改成**白名单闭合匹配**：一对括号里**正好**是词表里的词（1~4 个、逗号/顿号/空格分隔），
 *   才认定成标签。代价是"官方支持的自定义风格"会漏剥 ——
 *   漏 > 误杀（漏了在后台加个词就行，误杀了用户就会看到缺字的回复）。
 *
 * ⚠️ 本文件必须保持**零依赖**（不 import fs / db / settings）：
 *   客户端 `app/chat/page.js` 也要 import 它做展示剥离，一旦带了服务端依赖会炸构建。
 *
 * 词表默认值取自官方文档「风格控制」那两张推荐表（原样保留，别随手改）：
 *   语气 / 风格 48 个 + 声音事件 30 个。后台「语音 TTS」页可改，改完即生效。
 */

/**
 * 语气 / 风格标签的出厂词表。
 *
 * 官方分组：基础情绪 / 复合情绪 / 整体语调 / 音色定位 / 人设腔调 / 方言 / 角色扮演 / 唱歌。
 * 唱歌另有官方等效值 `sing` / `singing`，一并收进来（模型偶尔会吐英文）。
 *
 * @type {string[]}
 */
export const DEFAULT_STYLE_WORD_LIST = [
  // 基础情绪
  "开心", "悲伤", "愤怒", "恐惧", "惊讶", "兴奋", "委屈", "平静", "冷漠",
  // 复合情绪
  "怅然", "欣慰", "无奈", "愧疚", "释然", "嫉妒", "厌倦", "忐忑", "动情",
  // 整体语调
  "温柔", "高冷", "活泼", "严肃", "慵懒", "俏皮", "深沉", "干练", "凌厉",
  // 音色定位
  "磁性", "醇厚", "清亮", "空灵", "稚嫩", "苍老", "甜美", "沙哑", "醇雅",
  // 人设腔调
  "夹子音", "御姐音", "正太音", "大叔音", "台湾腔",
  // 方言
  "东北话", "四川话", "河南话", "粤语",
  // 角色扮演
  "孙悟空", "林黛玉",
  // 唱歌（含官方等效值）
  "唱歌", "sing", "singing",
];

/**
 * 声音事件标签的出厂词表。
 *
 * 官方分组：语速与节奏 / 情绪状态 / 语音特征 / 哭笑表达。
 * ⚠️ 注意里有「笑」「沙哑」「委屈」这种本身也能当普通词用的：
 *   它们**只在括号里且整块就是一个词**时才会被剥（`（笑）` 会剥，`笑了一下` 不会），
 *   这是白名单闭合匹配的必然结果，也正是我们要的。
 *
 * @type {string[]}
 */
export const DEFAULT_EVENT_WORD_LIST = [
  // 语速与节奏
  "吸气", "深呼吸", "叹气", "长叹一口气", "喘息", "屏息",
  // 情绪状态
  "紧张", "害怕", "激动", "疲惫", "委屈", "撒娇", "心虚", "震惊", "不耐烦",
  // 语音特征
  "颤抖", "声音颤抖", "变调", "破音", "鼻音", "气声", "沙哑",
  // 哭笑表达
  "笑", "轻笑", "大笑", "冷笑", "抽泣", "呜咽", "哽咽", "嚎啕大哭",
];

/** 语气 / 风格词表的默认值（后台文本框里存的就是这个字符串） */
export const DEFAULT_STYLE_WORDS = DEFAULT_STYLE_WORD_LIST.join(",");

/** 声音事件词表的默认值（后台文本框里存的就是这个字符串） */
export const DEFAULT_EVENT_WORDS = DEFAULT_EVENT_WORD_LIST.join(",");

/** 单个词最长长度（挡住后台误粘一整段话进来） */
const MAX_WORD_LEN = 8;
/** 词表条数上限（同上，防误操作把正则撑爆） */
const MAX_WORDS = 200;

/** 词表分隔符：逗号 / 顿号 / 分号 / 竖线 / 空白 / 括号 都认（后台怎么填都能用） */
const WORD_SPLIT_RE = /[\s,，、;；|\[\]［］()（）<>〈〉【】]+/;

/** 正则元字符转义 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把后台文本框里的词表解析成数组。
 *
 * 容错：分隔符随便、前后空格忽略、顺手把误粘的括号 `[开心]` `（叹气）` 去掉、去重、限长限条数。
 *
 * ⚠️ **空值回落到出厂词表**（而不是"一个词都没有"）：
 *   后台把词表清空属于误操作 —— 真落成"剥不掉任何标签"，用户屏幕上就会冒出 `[开心]`。
 *   想彻底关掉这个功能，请用「朗读标签」开关（`styleTags`），不要清空词表。
 *   （回落由调用方传的 `fallback` 决定，见 `tagWordsFrom`；不传就是纯解析、空就是空。）
 *
 * @param {unknown} input 后台配置的字符串（或数组）
 * @param {string[]} fallback 出厂词表
 * @returns {string[]}
 */
export function parseWords(input, fallback = []) {
  const raw = Array.isArray(input) ? input.join(",") : String(input ?? "");
  const words = raw
    .split(WORD_SPLIT_RE)
    .map((word) => word.replace(/^[\[［(（<]+|[\]］)）>]+$/g, "").trim())
    .filter((word) => word && word.length <= MAX_WORD_LEN);
  const unique = [...new Set(words)];
  if (!unique.length) return [...fallback];
  return unique.slice(0, MAX_WORDS);
}

/**
 * 取一份配置下真正生效的两组词表。
 *
 * @param {object|null|undefined} ttsConfig `settings.tts` 分组
 * @returns {{ style: string[], event: string[] }}
 */
export function tagWordsFrom(ttsConfig) {
  return {
    style: parseWords(ttsConfig?.styleTagWords, DEFAULT_STYLE_WORD_LIST),
    event: parseWords(ttsConfig?.eventTagWords, DEFAULT_EVENT_WORD_LIST),
  };
}

/**
 * 「朗读标签」是否生效：需要**同时**满足「开关没关」+「接口类型是小米 MiMo」。
 *
 * ⚠️ 只有 MiMo 认这些标签；OpenAI 兼容协议会把 `[开心]` 当普通文字念出来。
 *
 * @param {object|null|undefined} ttsConfig `settings.tts` 分组
 * @returns {boolean}
 */
export function isStyleTagsEnabled(ttsConfig) {
  if (!ttsConfig || ttsConfig.styleTags === false) return false;
  return String(ttsConfig.provider || "").toLowerCase().includes("mimo");
}

/**
 * 要不要让对话 AI 去产出朗读标签（= 提示词注入的判定）。
 *
 * ⚠️ 比 `isStyleTagsEnabled` 多一个 `enabled` 条件，这不是重复 —— 两者用途不同：
 *   * 剥离用 `isStyleTagsEnabled`：**只要配置还是 MiMo 就得继续剥**。
 *     否则出现这个场景：管理员把 TTS 整个关掉 → 历史消息里的 `[开心]` 立刻在屏幕上现形。
 *   * 注入用本函数：TTS 没启用就别让模型白花 token 生成标签（存到库里也没人念）。
 *
 * @param {object|null|undefined} ttsConfig `settings.tts` 分组
 * @returns {boolean}
 */
export function shouldInjectTagInstruction(ttsConfig) {
  if (!isStyleTagsEnabled(ttsConfig)) return false;
  return ttsConfig?.enabled !== false;
}

/**
 * 生成标签匹配正则（白名单闭合结构）。
 *
 * 结构：`开括号 [ \t]* 词 (分隔符 词){0,3} [ \t]* 闭括号`
 *   - 开括号：`[` `［` `(` `（` `<`
 *   - 闭括号：`]` `］` `)` `）` `>`
 *   - ⚠️ **故意不含 `【】` 与 `〈〉`**：那是中文正文里的强调/引用括号，误杀代价太高
 *   - ⚠️ 括号内外只允许空格与制表符（不允许换行）：否则跨行的 `[` 和 `]` 会被连成标签
 *   - 词与词之间：逗号 / 顿号 / 至少一个空格都行（官方："分隔符不限"）
 *
 * @param {{style?: string[], event?: string[]}} words 两组词表
 * @returns {RegExp|null} 词表为空时返回 null（= 什么都不剥）
 */
export function buildTagRegex(words) {
  const list = [...new Set([...(words?.style || []), ...(words?.event || [])])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length) // 长词优先：叹气 / 长叹一口气、颤抖 / 声音颤抖
    .map(escapeRegExp);
  if (!list.length) return null;
  const alt = list.join("|");
  const GAP = `(?:[ \\t]*[，,、][ \\t]*|[ \\t]+)`; // 词与词之间的分隔：标点或空格（至少一个字符）
  return new RegExp(
    `[\\[［(（<][ \\t]*(?:${alt})(?:${GAP}(?:${alt})){0,3}[ \\t]*[\\]］)）>]`,
    "g"
  );
}

/**
 * 流式专用：尾部"开了口还没闭合"的标签先不显示，等它闭合（或超出窗口）自己恢复。
 *
 * 为什么需要：文字是一个字一个字到的，`[开心]` 会先到 `[开` —— 不挡住的话
 * 屏幕上会闪一下 `[开`。窗口取 20 字符（够装下最长的"长叹一口气"这种多词标签）。
 *
 * ⚠️ 副作用：流式过程中，正文里**真的没写完**的半边括号也会暂时不显示；
 *   等它闭合（或流结束后的最终渲染）就正常了 —— 只影响"正在打字"的那一瞬间。
 */
const PARTIAL_TAG_RE = /[\[［(（<][^\]］)）>\n]{0,20}$/;

/** 有没有任何"开括号"（快路径判定用；不带 g，所以没有 lastIndex 状态） */
const OPEN_BRACKET_RE = /[\[［(（<]/;

/**
 * 从文本里剥掉朗读标签（只剥标签，不碰其它任何内容）。
 *
 * @param {unknown} text 原始文本（允许 undefined / null / 非字符串）
 * @param {{style?: string[], event?: string[]}} words 两组词表
 * @param {{holdPartial?: boolean}} [options] `holdPartial` 仅流式渲染时传 true
 * @returns {string}
 */
export function stripTtsTags(text, words, { holdPartial = false } = {}) {
  if (typeof text !== "string" || !text) return "";
  // 快路径：一个开括号都没有的文本不可能含标签 —— 渲染时每条消息都会调到这里，
  // 这条能挡掉绝大部分消息，省下"每次构造一个几十分支的正则"的开销。
  if (!OPEN_BRACKET_RE.test(text)) return text;
  const re = buildTagRegex(words);
  if (!re) return text;
  let out = text.replace(re, "");
  if (holdPartial) out = out.replace(PARTIAL_TAG_RE, "");
  // 标签常常紧贴句首、也会单独占一行/整句，剥完顺手收拾残留空白
  // （与 lib/util.js 的 stripEmoji 同一套做法）。前后空行一并清掉：
  // 不然后面按 \n 切段渲染时，会凭空多出一个空气泡。
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/**
 * 朗读前：把**不是朗读标签**的括号内容整块去掉（人设的"括号动作描写"、颜文字说明等）。
 *
 * 为什么必须做（下面三条都是拿真接口实测出来的，别再退回去）：
 *   · `(把手搭在你肩上)\n\n嗯，我在听呢。` → 念成"**把手搭在你肩上**，嗯，我在听呢"（被读出来）；
 *   · `（没说话，就坐在你旁边）\n嗯，那就难过一会儿吧` → **整句合成崩成乱码**
 *     （听成"没做我调便宜呀，你想我可能设计彻底的吧？"）——
 *     开头那对全角括号被 MiMo 当成了"风格标签"，可里面写的不是风格，语气控制整个跑飞；
 *   · `(￣▽￣)ノ 来一个` → 念成"侬来一个"（颜文字被一个符号一个符号拼读）。
 *   人设提示词里本来就写着"用括号写动作"，所以这类内容几乎每条回复都有。
 *
 * ⚠️ 这里的取舍和展示侧剥离**不一样**：展示侧讲"漏 > 误杀"，
 *   因为漏了只是屏幕上多几个字；而朗读侧漏了是**听到乱码**，代价大得多 ——
 *   所以规则反过来：**白名单之外一律去掉**。代价是 `（约 3 分钟）` 这种括号补充说明
 *   不会被念出来（用户在屏幕上照样看得到），这个代价可以接受。
 *
 * ⚠️ 词表里的标签（`(温柔)` / `[叹气]`）先被占位保护起来，处理完原样还回去 ——
 *   标签是念给 MiMo 听的语气指令，缺了它这次朗读就没有语气。
 *
 * @param {string} text 原始文本
 * @param {{style?: string[], event?: string[]}} words 两组词表
 * @returns {string}
 */
export function stripNonTagBrackets(text, words) {
  if (typeof text !== "string" || !text) return "";
  const tagRe = buildTagRegex(words);
  const kept = [];
  let out = tagRe
    ? text.replace(tagRe, (mark) => {
        kept.push(mark);
        return `\u0001${kept.length - 1}\u0001`; // \u0001 不会出现在正常文本里
      })
    : text;
  out = out
    .replace(/[（(][^（()）\n]{0,80}[)）]/g, "")
    .replace(/[［\[][^［\[\]］\n]{0,80}[\]］]/g, "")
    .replace(/[<＜][^<>＞\n]{0,40}[>＞]/g, "");
  if (kept.length) {
    out = out.replace(/\u0001(\d+)\u0001/g, (_, i) => kept[Number(i)] ?? "");
  }
  // 一整行动作描写被拿掉后会留下空行：折叠掉，免得切句时切出一个空句子
  return out.replace(/\n{2,}/g, "\n").replace(/^[ \t]+|[ \t]+$/gm, "");
}

/**
 * 文本是不是"停在了一个没闭合的括号里" —— 也就是标签被打断（`[紧张，`、`(温柔`）。
 *
 * 为什么单独拎出来：**流式朗读是逐句切、逐句合成的**，切句只认 `。！？\n` 和逗号，
 * 它不知道括号是什么，而多词标签自带逗号（官方写法 `[紧张，深呼吸]`），
 * 正好落在"逗号处切"的刀口上。切出半截标签的后果是**整句合成崩成乱码** ——
 * 实测 `[温柔我好累啊，今天真的一点力气都没有。` 听成
 * 「不可一定要提了，打上些观点，案外手是他，脸上接着训叙…」。
 * 所以切句那边要用它兜底：宁可这一句多等一个字，也不能把半截标签发出去。
 *
 * ⚠️ 故意只看末尾：中间出现的 `（……）` 是正常的动作描写，不算"没闭合"。
 *
 * @type {RegExp}
 */
export const OPEN_BRACKET_TAIL_RE = /[\[［(（<][^\]］)）>]*$/;

/**
 * 结尾是否停在没闭合的括号里（见 `OPEN_BRACKET_TAIL_RE`）。
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function hasOpenBracketTail(text) {
  return typeof text === "string" && OPEN_BRACKET_TAIL_RE.test(text);
}

/**
 * 把结尾那截没闭合的括号（含）整段丢掉。文本流已经结束时用它收尾，
 * 免得最后一句因为半截标签被念成乱码。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function dropOpenBracketTail(text) {
  return typeof text === "string" ? text.replace(OPEN_BRACKET_TAIL_RE, "") : "";
}

/**
 * 文本里有没有朗读标签（给排查 / 统计出现率用，不做剥离）。
 *
 * @param {unknown} text
 * @param {{style?: string[], event?: string[]}} words
 * @returns {boolean}
 */
export function hasTtsTag(text, words) {
  if (typeof text !== "string" || !text) return false;
  const re = buildTagRegex(words); // 每次新建实例，避免全局正则的 lastIndex 陷阱
  return re ? re.test(text) : false;
}

/**
 * 批量剥掉一组对话消息里的朗读标签 —— 用于"把历史回喂给别的 AI"的场景
 * （对话历史、生成标题、日报汇总）。
 *
 * ⚠️ 只动 `assistant` 的消息：**用户自己打的括号是内容，不是标签**，
 *   用户发过的 `（叹气）` 必须原样留在上下文里。
 * ⚠️ 为什么要把历史里的标签也剥掉：模型看到自己上一轮的 `[温柔]` 会越贴越多，
 *   而且标签是给 TTS 念的、对"读上下文"没有信息量。
 *
 * @param {Array<{role?:string, content?:unknown}>} messages
 * @param {{style?: string[], event?: string[]}|null} words 词表（null / 空 = 原样返回）
 * @returns {Array} 新数组（不改入参）
 */
export function stripTagsFromMessages(messages, words) {
  if (!Array.isArray(messages) || !words) return messages;
  return messages.map((item) =>
    item?.role === "assistant" && typeof item.content === "string"
      ? { ...item, content: stripTtsTags(item.content, words) }
      : item
  );
}

/**
 * 组装给对话 AI 的「朗读标签」指令。
 *
 * ⚠️ **必须请求时拼接，绝不能写进后台的人格提示词**：
 *   人格提示词是存在数据库里的、所有部署共用一份 —— 一旦把标签指令写进去，
 *   OpenAI 兼容 TTS 的部署也会让 AI 输出 `[开心]`，然后被 TTS 一字一顿念出来。
 *
 * @param {object|null|undefined} ttsConfig `settings.tts` 分组
 * @returns {string} 不生效时返回空字符串（调用方判断空则不要 push）
 */
export function buildTtsTagInstruction(ttsConfig) {
  if (!shouldInjectTagInstruction(ttsConfig)) return "";
  const { style, event } = tagWordsFrom(ttsConfig);
  if (!style.length && !event.length) return "";

  // ⚠️ 给模型看的词表**只留中文词**：`sing` / `singing` 这类官方英文等效值
  //    留着做剥离兜底没问题，但别让模型看见 —— 模型对英文词特别敏感，会直接吐 `sing`，
  //    而且容易忘掉括号。实测后果：光秃秃一个 `sing` 会被念出来（听成「信，我好累啊…」），
  //    少个右括号的 `[sing` 更是把整句合成变成乱码（听成「缝好了呀，今天真的一点力气都没有」）。
  //    词表里如果全是英文（用户自己这么配的），就保持原样，至少别给个空词表。
  const zh = (list) => {
    const only = list.filter((w) => /^[\u4e00-\u9fa5]+$/.test(w));
    return only.length ? only : list;
  };

  return [
    "【朗读标签】你的这句话会先被读成语音，你可以用标签控制朗读的语气。",
    "",
    "用法（括号与位置按小米官方的规定写，写错了会被一字一顿念出来）：",
    "1. 语气标签写在**整段话最开头**，用**圆括号**，最多 1 个，例如 (温柔)。",
    "2. 声音事件写在**句子中间**，用**方括号**，最多 2 个，例如 [叹气]。",
    "3. 两个都可以不用。不确定就不贴，宁可不贴。",
    "",
    `语气标签只能用下面这些词：${zh(style).join(" ")}`,
    `声音事件只能用下面这些词：${zh(event).join(" ")}`,
    "",
    "注意事项：",
    "① 标签只表示「这句话该怎么念」，不是你对用户情绪的评判 —— "
      + "不要用它来表达关心，也不要每句都贴。",
    "② 别自己造词，别用别的括号（比如【】）。"
      + "表情包标记 [sticker:xxx] 和括号动作描写都不是朗读标签，按它们本来的规矩写。",
    "③ 用户看不到这些标签（显示前会被去掉），所以不要在正文里解释或提到它们。",
  ].join("\n");
}
