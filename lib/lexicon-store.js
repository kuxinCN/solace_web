/**
 * 统一词表：**安全词**（自伤 / 伤人 / 违法）+ **压力词**（轻 / 中 / 重三档）。
 *
 * 这份文件把原来散在两处的词表合到一起管：
 *   · `lib/stress-lexicon.js` 的 `CRISIS_PATTERNS`（危机正则）+ 内部压力词库
 *   · 后台 `safety` 分组的三张「自定义追加词」表
 *
 * ⚠️ **合并的是"管理入口"，不是"判定逻辑"** ——
 *    危机 / 安全词 / 压力词三层的匹配方式和优先级完全分开（见 `lib/content-guard.js`），
 *    不会因为放进了同一个页面就串到一起。
 *
 * ⚠️ **性能约定**（这是硬指标，改动时别破坏）：
 *    · 压力词、安全词：`includes()` + 首字索引（预编译成 Map）；
 *    · **只有危机词走正则** —— 它必须靠上下文（前缀 + 后缀同现）才不会误伤
 *      「笑死了」「累死了」这类日常表达；
 *    · 词表在**进程内存里预编译**，后台改完调一次 `refreshLexicons()`，
 *      **绝不在每条消息上读数据库**。
 */
import { execute, query } from "./db.js";
import { NEGATIVE_WORDS } from "./stress-lexicon.js";

/* ------------------------------------------------------------ 词表定义 */

/** 短路距离：前缀词和后缀词之间最多隔这么多字符 */
const MAX_PAIR_DISTANCE = 6;

/**
 * **紧迫危机**的信号词。
 *
 * ⚠️ 命中危机词之后再看一眼有没有这些词：
 *    有 → 说明已经不只是"想过"，而是**有打算了** → 直接截断、给干预页；
 *    没有 → 走"安全模式"（正常调 AI + 附加安全指令）。
 *
 * ⚠️ 这个判断是有意做"宽"的：宁可多截断一次（用户会看到热线），
 *    也不要漏掉一个已经在做计划的信号。
 */
export const URGENT_SIGNALS = [
  "今晚",
  "今天",
  "明天",
  "等下",
  "马上就",
  "现在就",
  "决定了",
  "准备好了",
  "已经买",
  "已经准备",
  "遗书",
  "告别信",
  "不用找我了",
];

/** 按分值把现有压力词分成三档（轻度 +3 / 中度 +6 / 重度 +12） */
function stressWordsByWeight(weight) {
  const list = [];
  for (const [word, value] of NEGATIVE_WORDS) {
    if (Number(value) === weight) list.push(word);
  }
  return list;
}

/**
 * 默认词表 —— **首次初始化时写进数据库**，之后以库里的为准。
 *
 * ⚠️ 自伤倾向的那几组是从 `stress-lexicon.js` 的 `CRISIS_PATTERNS`
 *    **逐条迁移**过来的，迁移后行为保持一致（见 `scripts/test-keywords.mjs` 的回归测试）。
 */
export const DEFAULT_GROUPS = [
  {
    id: "selfHarm",
    label: "自伤倾向",
    kind: "safety",
    type: "contextPairs",
    enabled: true,
    hint: "编辑的是「上下文短语对」，不是普通关键词：前缀词和后缀词要在 6 个字以内同时出现才算命中。",
    warning: "⚠️ 单个字（如「死」「亡」）不能作为独立的短语词条，否则会误伤「笑死了」「累死了」。放在前缀-后缀对里是安全的。",
    content: [
      {
        comment: "意愿动词 + 危机结果词（原来 CRISIS_PATTERNS 的第 1 组）",
        prefix: ["想", "要", "准备", "打算", "决定", "不如", "干脆", "宁可", "索性", "考虑过"],
        suffix: ["死", "自杀", "自残", "轻生", "了结", "结束生命", "离开这个世界", "不活了"],
      },
      {
        phrase: [
          "不想活",
          "活不下去",
          "不想活了",
          "活着没意思",
          "活着没劲",
          "没意思活着",
          "死了算了",
          "不如死了",
          "死了更好",
          "谁也別救我",
        ],
      },
      {
        phrase: ["自杀", "自残", "割腕", "割手", "跳楼", "跳桥", "上吊", "安眠药", "烧炭", "吞药"],
      },
      {
        phrase: [
          "遗书",
          "告别信",
          "最后一条消息",
          "把我的东西都",
          "告别这个世界",
          "不用找我了",
          "谢谢你们一直",
        ],
      },
    ],
  },
  {
    id: "harmOthers",
    label: "伤害他人",
    kind: "safety",
    type: "list",
    enabled: true,
    hint: "一行一个词。命中后走「安全模式」（正常回复 + 安全指令），不截断。",
    warning: "⚠️ 别放「打」「杀」这类单字 —— 会误伤「打游戏」「杀虫剂」。",
    content: [],
  },
  {
    id: "illegal",
    label: "违法行为",
    kind: "safety",
    type: "list",
    enabled: true,
    hint: "一行一个词。命中后走「安全模式」。",
    warning: "⚠️ 只放「明显违法」的表达，别把「想辞职」「逃课」这类放进来。",
    content: [],
  },
  {
    id: "mild",
    label: "压力词 · 轻度（+3）",
    kind: "stress",
    type: "list",
    enabled: true,
    weight: 3,
    hint: "一行一个词。命中的词会给压力值加 3 分（带程度副词会 ×1.5）。",
    content: stressWordsByWeight(3),
  },
  {
    id: "moderate",
    label: "压力词 · 中度（+6）",
    kind: "stress",
    type: "list",
    enabled: true,
    weight: 6,
    hint: "一行一个词。命中的词会给压力值加 6 分。",
    content: stressWordsByWeight(6),
  },
  {
    id: "severe",
    label: "压力词 · 重度（+12）",
    kind: "stress",
    type: "list",
    enabled: true,
    weight: 12,
    hint: "一行一个词。命中的词会给压力值加 12 分。",
    content: stressWordsByWeight(12),
  },
];

/** 安全类词表（这三张不允许被全部删空） */
export const SAFETY_GROUP_IDS = ["selfHarm", "harmOthers", "illegal"];

/* ------------------------------------------------------------ 校验 */

/** 正则里的元字符要转义 —— 词是管理员手打的，可能带括号、加号之类 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 校验一段词表内容。
 *
 * ⚠️ 这里最要紧的一条是**禁止单字**：
 *    `phrase: ["死"]` 会让「笑死了」「累死了」「热死了」全部触发危机 —— 这是灾难。
 *    `suffix: ["亡"]` 同理。
 *    （前缀里出现单字是允许的：「想」「要」这类意愿动词本来就单字最常见。）
 *
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateContent(group, content) {
  if (!Array.isArray(content)) return { ok: false, error: "内容必须是数组" };

  if (group.type === "contextPairs") {
    for (const [index, item] of content.entries()) {
      const at = `第 ${index + 1} 组`;

      if (Array.isArray(item?.phrase)) {
        for (const phrase of item.phrase) {
          const text = String(phrase || "").trim();
          if (!text) continue;
          if (text.length < 2) {
            return {
              ok: false,
              error: `${at} 的短语「${text}」只有一个字 —— 会误伤「笑死${text}了」这类日常表达，请改成完整的词`,
            };
          }
        }
        continue;
      }

      if (Array.isArray(item?.prefix) || Array.isArray(item?.suffix)) {
        if (!Array.isArray(item.prefix) || !item.prefix.length) {
          return { ok: false, error: `${at} 缺少前缀词（prefix）—— 前后缀必须成对才有意义` };
        }
        if (!Array.isArray(item.suffix) || !item.suffix.length) {
          return { ok: false, error: `${at} 缺少后缀词（suffix）` };
        }
        for (const suffix of item.suffix) {
          const text = String(suffix || "").trim();
          if (!text) continue;
          // ⚠️ 故意的：后缀不能是单字。见函数开头的说明。
          if (text.length < 2 && text !== "死") {
            return { ok: false, error: `${at} 的后缀「${text}」只有一个字，会误伤日常表达` };
          }
        }
        continue;
      }

      return { ok: false, error: `${at} 既不是 phrase 也不是 prefix/suffix 对` };
    }

    return { ok: true };
  }

  // list 型：一组词，每个至少两个字（除非是英文缩写，那些交给词边界匹配）
  for (const word of content) {
    const text = String(word || "").trim();
    if (!text) continue;
    if (text.length < 2 && !/^[a-z]{2,}$/i.test(text)) {
      return { ok: false, error: `词条「${text}」太短了 —— 单个字会大面积误伤，请用完整的词` };
    }
  }

  return { ok: true };
}

/* ------------------------------------------------------------ 编译 */

/** 把「短语对 / 短语」编译成正则 + 提取出便于后台展示的标签 */
function compileContextPairs(content) {
  const regexParts = [];
  const labels = [];

  // ⚠️ **高置信度**的部分单独编译一份：只有「完整短语」算。
  //    因为短语是"整段匹配"（遗书 / 割腕 / 不想活），语义明确；
  //    而「前缀 + 后缀」组合（想 + 死）会撞上「死磕」这类构词 —— 那是**疑似**，不是结论。
  //    只有疑似命中才值得交给 AI 去判语义（见 `app/api/chat/route.js`）。
  const highParts = [];

  for (const item of content) {
    if (Array.isArray(item?.phrase)) {
      const phrases = item.phrase.map((p) => String(p || "").trim()).filter(Boolean);
      if (!phrases.length) continue;
      const part = `(?:${phrases.map(escapeRegExp).join("|")})`;
      regexParts.push(part);
      highParts.push(part);
      labels.push(phrases.join(" / "));
      continue;
    }

    const prefix = (item?.prefix || []).map((p) => String(p || "").trim()).filter(Boolean);
    const suffix = (item?.suffix || []).map((s) => String(s || "").trim()).filter(Boolean);
    if (!prefix.length || !suffix.length) continue;

    regexParts.push(
      `(?:${prefix.map(escapeRegExp).join("|")})[\\s\\S]{0,${MAX_PAIR_DISTANCE}}(?:${suffix
        .map(escapeRegExp)
        .join("|")})`
    );
    labels.push(`${prefix.slice(0, 4).join("/")} + ${suffix.slice(0, 4).join("/")}`);
  }

  if (!regexParts.length) return { regex: null, highRegex: null, labels: [] };

  return {
    // 一次编译、长期复用 —— 每条消息只跑这两个正则
    regex: new RegExp(regexParts.join("|")),
    highRegex: highParts.length ? new RegExp(highParts.join("|")) : null,
    labels,
  };
}

/** 把一组词编译成「首字索引」（匹配时先看文本里有没有这个字，再逐个 includes） */
function compileList(content) {
  const index = new Map();
  const words = [];

  for (const raw of content) {
    const word = String(raw || "").trim();
    if (!word) continue;
    words.push(word);

    const first = word[0].toLowerCase();
    if (!index.has(first)) index.set(first, []);
    index.get(first).push(word);
  }

  return { index, words };
}

/** 单个字符的集合（用来给首字索引做预筛） */
function collectChars(text) {
  const set = new Set();
  for (const char of text.toLowerCase()) set.add(char);
  return set;
}

/* ------------------------------------------------------------ 内存缓存 */

/**
 * 编译后的词表缓存。
 * ⚠️ 进程级单例 —— 首次用时构建，后台改完调 `refreshLexicons()` 重建。
 */
let cache = null;
let loading = null;

function buildCache(rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));

  const selfHarm = byId.get("selfHarm");
  const compiledCrisis = selfHarm?.enabled
    ? compileContextPairs(selfHarm.content || [])
    : { regex: null, labels: [] };

  const safetyLists = [];
  const stressLists = [];

  for (const row of rows) {
    if (!row.enabled) continue;
    if (row.kind === "safety" && row.id !== "selfHarm") {
      safetyLists.push({ ...row, ...compileList(row.content || []) });
    }
    if (row.kind === "stress") {
      stressLists.push({ ...row, ...compileList(row.content || []) });
    }
  }

  return {
    rows,
    crisisRegex: compiledCrisis.regex,
    // ⚠️ 只匹配"完整短语"的那一份 —— 命中它才算**高置信度**（见 matchCrisis）
    crisisHighRegex: compiledCrisis.highRegex,
    crisisLabels: compiledCrisis.labels,
    safetyLists,
    stressLists,
    builtAt: Date.now(),
  };
}

/** 数据库行 → 词表对象 */
function rowToGroup(row) {
  const parse = (value, fallback) => {
    if (value == null) return fallback;
    if (typeof value === "object") return value;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  };

  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    type: row.type,
    enabled: Number(row.enabled) !== 0,
    weight: Number(row.weight) || 0,
    hint: row.hint || "",
    warning: row.warning || "",
    content: parse(row.content, []),
    builtin: Number(row.builtin) === 1,
    updatedAt: row.updated_at || null,
  };
}

/* ------------------------------------------------------------ 对外接口 */

/**
 * ⚠️ **一次性迁移**：把老的「自定义追加词」并进统一词表。
 *
 * 背景：早期只有 `safety` 分组里那三个文本框（`extraSelfHarm` / `extraViolence` /
 * `extraIllegal`）是管理员加词的入口。统一词表上线后它们从界面上撤掉了 ——
 * **但库里的值不会自己消失**。不迁的话，管理员以前填过的词就静默失效了
 * （表现是"我加的词怎么不拦了"，而且很难查）。
 *
 * ⚠️ **只加不删**：并进词表后原文不从 `settings` 里清掉，留着能回溯。
 * ⚠️ **幂等**：已经在词表里的词会跳过，跑多少次结果都一样。
 */
async function migrateLegacyExtraWords() {
  let config = null;

  try {
    const { getGroup: getSettings } = await import("./settings.js");
    config = await getSettings("safety");
  } catch {
    return { migrated: 0 };
  }

  if (!config) return { migrated: 0 };

  const MAP = [
    { id: "selfHarm", field: "extraSelfHarm" },
    { id: "harmOthers", field: "extraViolence" },
    { id: "illegal", field: "extraIllegal" },
  ];

  let migrated = 0;

  for (const { id, field } of MAP) {
    const words = String(config[field] || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));

    if (!words.length) continue;

    const group = await getGroup(id);
    if (!group) continue;

    // 已有的词（短语和前缀都要算）—— 用来去重
    const existing = new Set();
    for (const item of group.content || []) {
      if (Array.isArray(item?.phrase)) item.phrase.forEach((word) => existing.add(word));
      else (item?.prefix || []).forEach((word) => existing.add(word));
    }

    const added = words.filter((word) => !existing.has(word));
    if (!added.length) continue;

    // ⚠️ 自伤倾向是「短语对」结构，追加词只能作为"完整短语"塞进去 ——
    //    这正好也是安全的：完整短语要求整段匹配，不像单字那样会乱命中。
    const content =
      group.type === "contextPairs"
        ? [...(group.content || []), { phrase: added }]
        : [...(group.content || []), ...added];

    try {
      await upsertGroup({ ...group, content });
      migrated += added.length;
    } catch (err) {
      console.error(`[lexicon] 迁移 ${field} 失败：`, err?.code || err?.message || err);
    }
  }

  if (migrated) console.log(`[lexicon] 已把 ${migrated} 个旧的「自定义追加词」并进统一词表`);

  return { migrated };
}

/**
 * 播种默认词表（**只插缺的 id，不覆盖已有的**）。
 *
 * ⚠️ 这条策略很重要：管理员调过词表之后，下次部署不该被改回默认值。
 */
export async function ensureKeywordGroups() {
  let existing = new Set();

  try {
    const rows = await query("SELECT id FROM keyword_groups");
    existing = new Set(rows.map((row) => String(row.id)));
  } catch {
    return { added: [] };
  }

  const added = [];

  for (const group of DEFAULT_GROUPS) {
    if (existing.has(group.id)) continue;
    try {
      await upsertGroup(group);
      added.push(group.id);
    } catch (err) {
      console.error(`[lexicon] 播种 ${group.id} 失败：`, err?.code || err?.message || err);
    }
  }

  // ⚠️ 顺手把老的「自定义追加词」并进来（幂等，跑多少次结果都一样）。
  //    放在播种之后：这样并进来的词一定能在已经存在的表里找到位置。
  try {
    await migrateLegacyExtraWords();
  } catch (err) {
    console.error("[lexicon] 迁移旧追加词失败：", err?.message || err);
  }

  return { added };
}

/** 写入 / 更新一份词表 */
export async function upsertGroup(group) {
  await execute(
    `INSERT INTO keyword_groups
       (id, label, kind, type, enabled, weight, hint, warning, content, builtin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       label = VALUES(label),
       kind = VALUES(kind),
       type = VALUES(type),
       weight = VALUES(weight),
       hint = VALUES(hint),
       warning = VALUES(warning),
       content = VALUES(content)`,
    [
      group.id,
      group.label,
      group.kind,
      group.type,
      group.enabled === false ? 0 : 1,
      Number(group.weight) || 0,
      group.hint || "",
      group.warning || "",
      JSON.stringify(group.content || []),
      group.builtin ? 1 : 0,
    ]
  );
  return true;
}

/** 读全部词表（含停用的）—— 后台用 */
export async function listGroups() {
  // ⚠️ 表还没建出来时返回默认词表，让后台至少能显示内容，而不是报错
  try {
    const rows = await query("SELECT * FROM keyword_groups ORDER BY kind DESC, id ASC");
    if (rows.length) return rows.map(rowToGroup);
  } catch (err) {
    console.error("[lexicon] 读词表失败，回退到默认：", err?.code || err?.message || err);
  }
  return DEFAULT_GROUPS.map((group) => ({ ...group, builtin: true, updatedAt: null }));
}

/** 取一份词表 */
export async function getGroup(id) {
  try {
    const rows = await query("SELECT * FROM keyword_groups WHERE id = ? LIMIT 1", [String(id)]);
    if (rows.length) return rowToGroup(rows[0]);
  } catch {
    /* 表还没建 */
  }
  const fallback = DEFAULT_GROUPS.find((group) => group.id === id);
  return fallback ? { ...fallback, builtin: true, updatedAt: null } : null;
}

/**
 * 加载（或重新加载）词表并编译进内存。
 *
 * ⚠️ 后台改完词表**必须调它**，否则改动不会生效（缓存不会自己失效）。
 * ⚠️ 并发调用会被合并成一次（`loading` 那个 promise）——
 *    应用启动时可能有好几个请求同时到达。
 */
export async function refreshLexicons() {
  if (loading) return loading;

  loading = (async () => {
    try {
      const rows = await listGroups();
      cache = buildCache(rows);
      return cache;
    } catch (err) {
      console.error("[lexicon] 编译失败：", err?.message || err);
      // 编译失败也要留一份可用的缓存 —— 用默认词表兜底，
      // 否则危机检测会整个失效（那比用旧词表严重得多）
      if (!cache) cache = buildCache(DEFAULT_GROUPS.map((g) => ({ ...g, builtin: true })));
      return cache;
    } finally {
      loading = null;
    }
  })();

  return loading;
}

/** 同步取编译结果（没有就现编一份默认的） */
export function getLexicons() {
  if (!cache) cache = buildCache(DEFAULT_GROUPS.map((g) => ({ ...g, builtin: true })));
  return cache;
}

/** 清空缓存（测试用） */
export function resetLexiconCache() {
  cache = null;
}

/* ------------------------------------------------------------ 匹配 */

/**
 * ⚠️ **「死」作为构词前缀时的搭配字**。
 *
 * 为什么必须有这张表：前缀里有「想」「要」「准备」这种**高频字**，于是
 * 「我**想死**磕这对 cp」「我这周**要死**线了」「他**要死**记硬背」都会命中危机规则 ——
 * 这是**误报**。而误报的代价很实在：一次误报就足以让用户觉得"这 AI 有病"，
 * 之后真出事时他也不会再说真话了。
 *
 * **判据是"位置"**：
 *   · 真正的危机表达 —— 「死」后面跟的是标点、语气词或者句子结束（我想死 / 我想死了）；
 *   · 「死磕」「死党」「死忠」这类词 —— 「死」**后面紧跟**一个构词字。
 * 所以只要命中片段后面跟着这些字，就说明那个「死」是构词前缀，不是危机信号。
 *
 * ⚠️ 这张表是**故意做窄**的：只收"死+字"能构成一个常用词的情况。
 *    拿不准的就不加 —— 宁可再误报一次（再往这里补一个字），也不能把真危机漏掉。
 *
 * ⚠️ 现在它是代码里的常量。**如果以后误报越来越多，就把它提升成后台可编辑的
 *    「例外词」列表**（和词表一样热更新）—— 到那时候再说，现在还不需要那一层。
 */
const DEATH_COMPOUND = [
  "磕", // 死磕（死磕 CP、死磕到底）
  "党", // 死党
  "忠", // 死忠
  "板", // 死板
  "机", // 死机
  "角", // 死角
  "线", // 死线（deadline）
  "水", // 死水
  "路", // 死路
  "账", // 死账
  "缠", // 死缠
  "扛", // 死扛
  "守", // 死守
  "撑", // 死撑
  "咬", // 死咬
  "盯", // 死盯
  "记", // 死记
  "循环", // 死循环
];

/**
 * 危机（自伤倾向）—— **走正则，因为必须看上下文**。
 *
 * ⚠️ 只判**第一个**匹配：`"我想死磕，但也真的想死"` 这种一句里两种语义混着的极端情况，
 *    第一个匹配被排除后就不会再往后找。这是**有意的取舍** —— 要让正则支持多轮匹配
 *    就得加 `g` 标志，而带 `g` 的正则会有 `lastIndex` 状态、多个请求共享同一个编译结果时
 *    会互相干扰（这类 bug 极难查）。真遇到那种句子，用户下一句还会说，
 *    而"用户下一句"本来就是这个场景里更可靠的信号。
 *
 * @returns {{ hit: boolean, label: string, urgent: boolean }}
 */
export function matchCrisis(text) {
  const content = String(text || "").slice(0, 500);
  if (!content) return { hit: false, label: "", urgent: false, confidence: "", matched: "" };

  const { crisisRegex } = getLexicons();
  if (!crisisRegex) return { hit: false, label: "", urgent: false, confidence: "", matched: "" };

  // ⚠️ 用 exec 拿**匹配位置** —— 光看"有没有匹配"不够，
  //    还得看那个「死」后面紧跟的是什么字（见 DEATH_COMPOUND）。
  const match = crisisRegex.exec(content);
  if (!match) return { hit: false, label: "", urgent: false, confidence: "", matched: "" };

  const tailStart = match.index + match[0].length;
  const after = content.slice(tailStart, tailStart + 2);

  if (after && DEATH_COMPOUND.some((word) => after.startsWith(word))) {
    return { hit: false, label: "", urgent: false, confidence: "", matched: "" };
  }

  // ⚠️ **判置信度**：命中的片段如果**也是**"完整短语"那份正则可以匹配的，
  //    说明语义明确（遗书 / 割腕 / 不想活）→ `high`，直接进安全模式，不给 AI 翻案的机会。
  //    否则就是「前缀+后缀」组合出来的疑似命中（想 + 死）→ `suspect`，
  //    **交给对话 AI 判语义**（见 chat route 的 `[RISK:*]` 机制）。
  const { crisisHighRegex } = getLexicons();
  const confidence = crisisHighRegex && crisisHighRegex.test(match[0]) ? "high" : "suspect";

  // 命中之后再判紧迫性：有"今晚""明天""已经买了"这类计划性表达 → 紧迫
  const urgent = URGENT_SIGNALS.some((signal) => content.includes(signal));

  return { hit: true, label: "自伤倾向", urgent, confidence, matched: match[0] };
}

/**
 * 安全词（伤害他人 / 违法行为）—— `includes()` + 首字索引。
 */
export function matchSafety(text) {
  const content = String(text || "").slice(0, 500);
  if (!content) return { hit: false, groupId: "", label: "" };

  const chars = collectChars(content);

  for (const group of getLexicons().safetyLists) {
    for (const [first, words] of group.index) {
      if (!chars.has(first)) continue;
      for (const word of words) {
        if (content.includes(word)) {
          return { hit: true, groupId: group.id, label: group.label };
        }
      }
    }
  }

  return { hit: false, groupId: "", label: "" };
}

/**
 * 压力词 —— 三档权重，`includes()` + 首字索引。
 *
 * ⚠️ 只返回"命中了哪些词、各加多少分"，**不在这里算压力值** ——
 *    那是 `lib/stress-analyzer.js` 的事（它还要管程度副词、否定词、标点……）。
 *
 * @returns {{ delta: number, words: string[] }}
 */
export function matchStress(text) {
  const content = String(text || "").slice(0, 500);
  if (!content) return { delta: 0, words: [] };

  const chars = collectChars(content);
  let delta = 0;
  const words = [];

  for (const group of getLexicons().stressLists) {
    for (const [first, list] of group.index) {
      if (!chars.has(first)) continue;
      for (const word of list) {
        if (content.includes(word)) {
          words.push(word);
          delta += Number(group.weight) || 0;
        }
      }
    }
  }

  return { delta, words };
}

/** 这条消息要不要走"安全模式"（危机非紧迫 / 伤人 / 违法） */
export function needsSafeMode(text) {
  const crisis = matchCrisis(text);
  if (crisis.hit) return { safeMode: !crisis.urgent, crisis, urgent: crisis.urgent };

  const safety = matchSafety(text);
  if (safety.hit) return { safeMode: true, crisis: { hit: false }, urgent: false, safety };

  return { safeMode: false, crisis: { hit: false }, urgent: false };
}
