/**
 * 表情包（贴纸）情绪节流引擎 —— 服务端、纯内存、按对话隔离。
 *
 * 为什么存在：
 *   旧版贴纸靠模型自己在回复末尾写 [sticker:happy]，发不发、何时发全凭模型"感觉"，
 *   容易一言不合就发图、或者在低落场景也发。新版改为**用户状态驱动 + 确定性节流**：
 *
 *   1. 判断用户这句话的情绪（关键词秒判 → 判不出来才调一次轻量 AI，超时即放弃）；
 *   2. 每个对话独立计数，**概率递增随机触发、3 句内必出 1 张**：
 *      第 1 句 0%、第 2 句 40%、第 3 句 100% 保底；
 *      深夜（23:00-06:00）勾了"深夜放宽"的分类按 第 1 句 60%、第 2 句 100% 保底；
 *   3. 一旦发出，该情绪计数立即归零重新累积 + 该情绪 15 分钟冷却；
 *      任意两张贴纸之间至少间隔 5 轮用户发言；
 *   4. 一轮里多个情绪同时"中奖"，按优先级只发一张；
 *   5. 标了"只判定不触发"的分类（daily）**永不主动发图**。
 *
 * ⚠️ 分类表在前两版是写死在下面这些常量里的（KEYWORDS / PRIORITY / STICKER_CATEGORY），
 *    于是"加一个情绪分类"要改四处代码。现在**全部改成从外部注入的 spec**：
 *    调用方（`app/api/chat/route.js`）从数据库读一张 spec 传进来，后台就能自己增删分类。
 *
 *    本文件只保留一份**出厂默认 spec**（`DEFAULT_SPEC`），用途有两个：
 *      ① 数据库读不到（表没建好 / 老库升级中）时兜底；
 *      ② 首次播种时作为种子（`lib/sticker-store.js` 直接用它，**不再抄一份词表**）。
 *    调用方不传 spec 时使用 DEFAULT_SPEC —— 行为与改造前逐字一致。
 *
 * 存储说明：
 *   计数器是"节流用的临时状态"，丢了顶多重置累积（用户无感），因此用进程内 Map，
 *   不建表、不做持久化；键为 `${userId}::${conversationId}`，从根上杜绝跨对话串计数。
 *   条目 24 小时无访问即淘汰（懒清理 + 容量硬顶），内存占用有界。
 *
 * 性能：
 *   关键词判断是纯字符串扫描（毫秒内）；AI 兜底带 2.5s 超时，调用方在主对话流**并行**
 *   发起、只在流末 await 结果，不增加首字延迟；引擎任何异常都由调用方兜底为"不发"。
 */

/* ===================== 出厂默认 spec ===================== */

/**
 * 默认分类表 —— 关键词、优先级、深夜放宽、可触发性都与改造前写死的常量逐字一致。
 *
 * ⚠️ 词表刻意"少而准"：宁可漏判（走 AI 兜底/不计数）也不要把闲聊误判成情绪。
 * ⚠️ 关键词是调了很久才收敛的，**不要顺手"优化"**。
 * ⚠️ `stickerKey` 是素材目录名 = `[sticker:xxx]` 标记名；sleepy 对应 sleep 是历史命名，
 *    已经上线过历史消息，改名会让旧消息里的标记失效。
 */
export const DEFAULT_SPEC = {
  normalProb: [0, 0.4, 1],
  lateNightProb: [0.6, 1],
  categories: [
    {
      catKey: "comfort", // 需要安慰：难过 / 焦虑 / 生气
      stickerKey: "comfort",
      label: "安慰",
      priority: 10,
      lateNight: false,
      aiDetect: true,
      triggerable: true,
      keywords: [
        "难过", "难受", "伤心", "心碎", "心痛", "心疼", "悲伤", "哀伤", "哀愁",
        "烦", "烦躁", "心烦", "烦闷", "烦死人", "郁闷", "焦虑", "紧张", "不安",
        "害怕", "恐惧", "惶恐", "心慌", "担心", "担忧", "痛苦", "崩溃", "崩了",
        "想哭", "哭了", "委屈", "失落", "沮丧", "失望", "绝望", "抑郁", "压抑",
        "孤单", "孤独", "心累", "不开心", "不高兴", "好难", "撑不住", "受不了",
        "压力大", "压力好大", "emo", "气死", "气死了", "气死我了", "愤怒", "生气",
        "暴躁", "受伤", "好累心",
      ],
    },
    {
      catKey: "sleepy", // 疲惫困倦
      stickerKey: "sleep",
      label: "疲惫",
      priority: 20,
      lateNight: true, // 深夜放宽
      aiDetect: true,
      triggerable: true,
      keywords: [
        "好累", "好累啊", "好累呀", "好困", "困死了", "犯困", "想睡", "瞌睡",
        "疲惫", "疲倦", "疲乏", "乏力", "没力气", "精疲力尽", "筋疲力尽",
        "打哈欠", "哈欠", "熬夜", "没睡好", "失眠", "眼皮打架", "累瘫",
        "困", "累", // 单字词放最后：误命中面大，靠否定词检查兜底
      ],
    },
    {
      catKey: "happy", // 开心 / 分享好事
      stickerKey: "happy",
      label: "开心",
      priority: 30,
      lateNight: false,
      aiDetect: true,
      triggerable: true,
      keywords: [
        "开心", "高兴", "快乐", "兴奋", "好棒", "太棒", "太好了", "超好",
        "爽", "耶", "哈哈", "嘻嘻", "嘿嘿", "笑死", "好玩", "好事", "惊喜",
        "幸福", "满足", "愉快", "中奖", "考上", "升职", "成功了", "脱单",
        "爱了", "绝了", "好耶",
      ],
    },
    {
      catKey: "daily", // 日常闲聊：只作 AI 兜底分类，永不主动触发
      stickerKey: "daily",
      label: "日常",
      priority: 999,
      lateNight: false,
      aiDetect: true,
      triggerable: false,
      keywords: [],
    },
  ],
};

/**
 * 兼容导出：情绪内部名 → 素材目录名。
 * ⚠️ 这是**默认 spec 的映射**，运行时真实映射来自数据库那份 spec
 *    （`applyTurn` 返回的是 spec 里的 `catKey`，`decideSticker` 再换成 `stickerKey`）。
 */
export const STICKER_CATEGORY = Object.fromEntries(
  DEFAULT_SPEC.categories.map((c) => [c.catKey, c.stickerKey])
);

/** 命中关键词时，若紧邻的前一个字是否定词，则这一击作废（"我不累""不困"不算 sleepy） */
const NEG_PREFIX = new Set(["不", "没", "别"]);

/**
 * 把外部传入的 spec 规范化：排序（优先级小的在前）、补齐字段、逐个过滤掉坏数据。
 * 传 null / 空数组 / 结构不对 → 直接用 DEFAULT_SPEC，保证引擎永远有东西可用。
 */
export function normalizeSpec(spec) {
  const source =
    spec && Array.isArray(spec.categories) && spec.categories.length ? spec : DEFAULT_SPEC;

  const categories = source.categories
    .filter((row) => row && String(row.catKey || "").trim())
    .map((row, index) => {
      const catKey = String(row.catKey).trim().toLowerCase();
      return {
        catKey,
        stickerKey: String(row.stickerKey || catKey).trim().toLowerCase(),
        label: String(row.label || catKey),
        keywords: (Array.isArray(row.keywords) ? row.keywords : [])
          .map((word) => String(word).trim().toLowerCase())
          .filter(Boolean),
        priority: Number.isFinite(Number(row.priority)) ? Number(row.priority) : 100 + index,
        lateNight: row.lateNight === true,
        aiDetect: row.aiDetect !== false,
        // 缺省视为"可触发"：老调用方（只给 catKey/keywords）行为不变
        triggerable: row.triggerable !== false,
        // 缺省视为"有素材"：数据库那份 spec 会算好这一项（该分类下至少一张启用素材）
        available: row.available !== false,
      };
    })
    .sort((a, b) => a.priority - b.priority);

  const probs = (list, fallback) =>
    Array.isArray(list) && list.length ? list.map((n) => Number(n) || 0) : fallback;

  return {
    categories,
    normalProb: probs(source.normalProb, DEFAULT_SPEC.normalProb),
    lateNightProb: probs(source.lateNightProb, DEFAULT_SPEC.lateNightProb),
  };
}

/** 按情绪内部名取分类定义（找不到返回 null） */
export function findCategory(spec, catKey) {
  if (!catKey) return null;
  return normalizeSpec(spec).categories.find((c) => c.catKey === catKey) || null;
}

/* ===================== 情绪关键词表 ===================== */

/**
 * 关键词快速情绪识别。命中多个分类按优先级（`priority` 小者优先）。
 *
 * @param {string} text 用户本轮原话
 * @param {object} [spec] 分类 spec（不传 = 出厂默认）
 * @returns {string|null} 命中的 catKey
 */
export function detectEmotionByKeyword(text, spec) {
  const raw = String(text || "").toLowerCase();
  if (raw.trim().length < 1) return null;

  // 按优先级顺序扫：第一个命中的分类直接返回（等价于原来"comfort 优先"的写法）
  for (const category of normalizeSpec(spec).categories) {
    for (const word of category.keywords) {
      const idx = raw.indexOf(word, 0);
      if (idx === -1) continue;
      // 检查所有出现位置（"虽然不难过但我还是难受"里要能命中后面的"难受"）
      let from = 0;
      let realHit = false;
      while (true) {
        const at = raw.indexOf(word, from);
        if (at === -1) break;
        const prev = at > 0 ? raw[at - 1] : "";
        if (!NEG_PREFIX.has(prev)) {
          realHit = true;
          break;
        }
        from = at + 1;
      }
      if (realHit) return category.catKey;
    }
  }
  return null;
}

/* ===================== AI 兜底识别（关键词判不出时才调） ===================== */

/**
 * 拼 AI 兜底提示词：**只列勾了"纳入 AI 判定"的分类** + unknown。
 * 分类名用后台填的 `label`（所以后台把名字起清楚，模型判得也更准）。
 */
function buildAiPrompt(spec) {
  const options = normalizeSpec(spec)
    .categories.filter((c) => c.aiDetect)
    .map((c) => `${c.catKey}（${c.label}）`);
  return [
    "你是情绪识别器。只判断用户这句话最接近的状态，只回答一个英文类别名，不要输出任何其他内容。",
    `可选类别：${[...options, "unknown（语义不明）"].join("、")}。`,
  ].join("\n");
}

/** 只接受 spec 里真实存在的类别名（外加 unknown），其余一律当"没判出来" */
function buildAiValid(spec) {
  const keys = normalizeSpec(spec)
    .categories.filter((c) => c.aiDetect)
    .map((c) => c.catKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(${[...keys, "unknown"].join("|")})\\b`);
}

/**
 * 综合情绪识别：关键词优先（零成本、毫秒级），判不出才走一次轻量 AI。
 * AI 调用或等待设定上限 —— 超时即返回 null（本轮不计数），绝不拖累发图以外的任何东西。
 *
 * ⚠️ 上限 5 秒（原 2.5 秒太紧）：2026-10-03 实测线上模型答完要 **2.8~10.3 秒**，
 *    2.5 秒几乎必然超时 → 情绪永远判不出来 → 表情包几乎不出图。
 *
 * @param {string} text
 * @param {object|null} config 后台 AI 配置（与主对话同一份，不额外查库）
 * @param {number} timeoutMs 默认 5000
 * @param {object} [spec] 分类 spec
 * @returns {Promise<string|null>} 命中的 catKey
 */
export async function detectEmotion(text, config, timeoutMs = 5000, spec) {
  const byKeyword = detectEmotionByKeyword(text, spec);
  if (byKeyword) return byKeyword;

  const content = String(text || "").trim();
  if (content.length < 2 || !config?.apiKey) return null;

  let timer = null;
  try {
    const aiPromise = import("./ai.js").then(({ requestChat }) =>
      requestChat({
        messages: [
          { role: "system", content: buildAiPrompt(spec) },
          { role: "user", content: content.slice(0, 500) },
        ],
        config,
        // ⚠️ 别把上限压到十几：推理型模型（如 mimo-v2.6-flash-free）会先把 token
        //    花在 reasoning 上，结果 finish_reason=length 而 content 是**空字符串** ——
        //    实测 16 / 64 全空、300 起才稳定答出类别名。这里给足冗余
        //    （答完即停，不会因为上限高就多花钱），配 5 秒超时。
        maxTokens: 512,
      })
    );
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const result = await Promise.race([aiPromise, timeout]);
    if (!result?.ok) return null;
    const m = String(result.reply || "").toLowerCase().match(buildAiValid(spec));
    if (!m) return null;
    const label = m[1];
    // unknown 只是"语义不明"，不是情绪 → 返回 null（本轮不计数）
    return label === "unknown" ? null : label;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ===================== 每对话计数与节流（纯内存状态机） ===================== */

const EMOTION_COOLDOWN_MS = 15 * 60 * 1000; // 发出后该情绪冷却 15 分钟
const GLOBAL_TURN_GAP = 5; // 任意两张贴纸之间至少隔 5 轮用户发言
const STATE_TTL_MS = 24 * 60 * 60 * 1000; // 一个对话 24h 无消息即淘汰
const MAX_STATES = 5000; // 条目硬顶，防止异常多对话把内存撑爆

/**
 * 按累计句数取触发概率。
 *
 * 常规（白天所有分类通用，不针对谁写死）：第 1 句 0%（绝不一发就图）→
 * 第 2 句 40%（随机惊喜）→ 第 3 句 100%（保底必出）。
 * 深夜 + 勾了"深夜放宽"的分类：第 1 句 60% → 第 2 句 100%，不用熬到第 3 句。
 *
 * @param {string} cat 情绪内部名
 * @param {number} count 该情绪当前累计句数（≥1）
 * @param {boolean} lateNight
 * @param {object} [spec]
 * @returns {number} 0..1
 */
export function triggerProbability(cat, count, lateNight, spec) {
  const normalized = normalizeSpec(spec);
  const category = normalized.categories.find((c) => c.catKey === cat);
  const table = category?.lateNight && lateNight ? normalized.lateNightProb : normalized.normalProb;
  if (count <= 0) return 0;
  // 超出表长（第 3 句以后还没发：被冷却/全局间隔挡住的极端情况）→ 末档 100%，放行即发
  return table[Math.min(count, table.length) - 1];
}

/**
 * @typedef {Object} StickerState
 * @property {number} turn 该对话用户发言轮次（只增）
 * @property {Record<string, number>} counts 各情绪累积次数
 * @property {Record<string, number>} cooldownUntil 各情绪冷却截止时间戳
 * @property {number|null} lastStickerTurn 上一次发贴纸是第几轮
 * @property {number} lastSeen 最近访问时间戳（懒淘汰用）
 */

/** @type {Map<string, StickerState>} */
const states = new Map();

/** 淘汰过期/超量状态（每次写入前轻量执行，不做全表扫描式清理） */
function touchState(key, now) {
  const existing = states.get(key);
  if (existing) {
    existing.lastSeen = now;
    return existing;
  }
  if (states.size >= MAX_STATES) {
    // 超容量：删掉最久没访问的一条（Map 保持插入/更新顺序，删最早的）
    const oldestKey = states.keys().next().value;
    states.delete(oldestKey);
  }
  // ⚠️ 计数与冷却用**空对象**懒建：分类是后台可增删的，写死三个 key 会在
  //    后台新增分类后变成"计数永远是 undefined"（虽然 `|| 0` 能兜住，但读起来更容易误解）
  const fresh = {
    turn: 0,
    counts: {},
    cooldownUntil: {},
    lastStickerTurn: null,
    lastSeen: now,
  };
  states.set(key, fresh);
  return fresh;
}

/** 23:00-06:00 视为深夜 */
export function isLateNight(date = new Date()) {
  const h = date.getHours();
  return h >= 23 || h < 6;
}

/**
 * 纯状态机推演（不做情绪识别、不碰时间以外的副作用），便于单测覆盖全部节流规则。
 *
 * 每轮：轮次 +1 → 本轮情绪计数 +1 → 按优先级顺序，对每个"可触发、有素材、
 * 有累积、未冷却、全局间隔已满足"的情绪掷一次骰：
 *   rand() < triggerProbability(累计句数) 才发；没摇中就继续看低优先级情绪。
 * 一旦发出：**该情绪计数立即归零**（下一句从第 1 句的 0% 重新算），
 * 置该情绪 15 分钟冷却，并记录全局轮次。
 *
 * @param {StickerState} state
 * @param {string|null} emotion 本轮判定结果（catKey）
 * @param {{now?:number, lateNight?:boolean, rand?:() => number}} [env]
 *        rand 可注入（单测做确定性验证），生产默认 Math.random
 * @param {object} [spec] 分类 spec
 * @returns {{state:StickerState, fired: string|null}}
 */
export function applyTurn(state, emotion, env = {}, spec) {
  const normalized = normalizeSpec(spec);
  const now = env.now ?? Date.now();
  const lateNight = env.lateNight ?? isLateNight();
  const rand = env.rand ?? Math.random;

  state.turn += 1;
  state.lastSeen = now;

  if (emotion) state.counts[emotion] = (state.counts[emotion] || 0) + 1;

  // 全局间隔：两张贴纸至少隔 5 轮。上一次在第 3 轮发 → 最早第 8 轮才能再发
  const globalReady =
    state.lastStickerTurn === null || state.turn - state.lastStickerTurn >= GLOBAL_TURN_GAP;

  for (const category of normalized.categories) {
    // ⚠️ 两道过滤：标了"只判定不触发"（daily）的不参与；**没有可用素材的也不参与** ——
    //    否则引擎会发出一个前端根本找不到图的标记（静默失效，最难查）。
    if (!category.triggerable || !category.available) continue;

    const cat = category.catKey;
    const count = state.counts[cat] || 0;
    if (count <= 0) continue; // 这个情绪还没开始累积
    // 冷却中 / 全局间隔未满都是硬门槛：不掷骰、不清零，计数继续累积，
    // 门槛解除后下一轮按末档 100% 立即补发
    const inCooldown = now < (state.cooldownUntil[cat] || 0);
    if (inCooldown || !globalReady) continue;

    const probability = triggerProbability(cat, count, lateNight, normalized);
    if (rand() < probability) {
      // 中奖：只清这一种情绪的计数（其它情绪继续累积），下一句从第 1 句 0% 重新开始
      state.counts[cat] = 0;
      state.cooldownUntil[cat] = now + EMOTION_COOLDOWN_MS;
      state.lastStickerTurn = state.turn;
      return { state, fired: cat };
    }
    // 本情绪这轮没摇中（典型：第 2 句落在 40% 之外）→ 交给下一轮，
    // 同时继续检查优先级更低的情绪，它们的计数与掷骰相互独立
  }
  return { state, fired: null };
}

/**
 * 一轮完整决策：识别情绪 → 更新计数/冷却 → 决定本轮发不发贴纸。
 * 供 chat 路由并行发起、流末 await。
 *
 * @param {Object} p
 * @param {number} p.userId
 * @param {string|number|null|undefined} p.conversationId
 * @param {string} p.text 本轮用户消息
 * @param {object|null} [p.config] 后台 AI 配置
 * @param {Date} [p.date] 注入时间（测试用）
 * @param {object} [p.spec] 分类 spec（来自数据库；不传 = 出厂默认）
 * @returns {Promise<{category:string, emotion:string}|null>} category=前端标记名
 */
export async function decideSticker({
  userId,
  conversationId,
  text,
  config = null,
  date = new Date(),
  spec,
}) {
  try {
    const normalized = normalizeSpec(spec);
    const now = date.getTime();
    // conversationId 缺失（异常客户端）时降级为该用户的单桶，功能不崩，
    // 正常客户端在创建对话后才发消息，这个键一定是"用户+对话"维度。
    const key = `${userId}::${conversationId ?? "__noconv__"}`;
    const state = touchState(key, now);

    // 顺手做懒淘汰：把明显过期的其它对话清掉（每次请求最多删几条，零成本感）
    if (states.size > 100) {
      for (const [k, s] of states) {
        if (now - s.lastSeen > STATE_TTL_MS) states.delete(k);
      }
    }

    // 5 秒上限：原 2.5 秒对推理型模型必然超时，见 detectEmotion 的注释
    const emotion = await detectEmotion(text, config, 5000, normalized);
    // 判出来的情绪必须"可触发且有素材"才计数 —— 否则一个没有素材的分类会把计数
    // 悄悄吃掉，等素材补上来时用户已经等了很久，还看不出为什么
    const category = emotion ? normalized.categories.find((c) => c.catKey === emotion) : null;
    const countable = category && category.triggerable && category.available ? emotion : null;

    const { fired } = applyTurn(state, countable, { now, lateNight: isLateNight(date) }, normalized);
    if (!fired) return null;

    const firedCategory = normalized.categories.find((c) => c.catKey === fired);
    return { category: firedCategory?.stickerKey || fired, emotion: fired };
  } catch {
    // 贴纸是锦上添花：任何异常都退回"不发"，绝不影响聊天
    return null;
  }
}

/**
 * 剥掉模型可能私自写在回复里的贴纸标记（新旧提示词交替期 / 后台自定义人格里
 * 仍写着"可以发 [sticker:xxx]"时也能兜住）。贴纸唯一合法来源是本引擎的节流决策。
 * @param {string} text
 */
export function stripStickerMarkers(text) {
  return String(text || "").replace(/[ \t]*\[sticker:[a-z0-9_]+\]\s*/gi, "");
}
