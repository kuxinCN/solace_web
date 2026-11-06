/**
 * 长期记忆 · 统一读写层（写入去重 + 读取相关性选取）。
 *
 * 背景：user_memories 有三个写入通道 ——
 *   ① 关键词实时提炼（app/api/user/memories/extract，category=preference/relation/emotion/event）
 *   ② T+1 每日汇总（lib/daily-memory.js，category='daily'，每用户每天一条）
 *   ③ 模型自主决策（chat 接口的 [MEMORY:...] 标记，category='self'）
 *
 * 早期三条通道各写各的，存在两个问题：
 *   a) 同一件事被三个通道反复记（"我喜欢猫"出现 3 条），记忆库膨胀；
 *   b) 注入只取"最近 20 条"，每天一条的 daily 很快占满窗口，
 *      早期事实（名字 / 宠物 / 家人）永久沉底，且与当前话题无关的记忆也照塞，
 *      稀释模型注意力。
 *
 * 本文件的职责（纯 SQL + JS，不引入向量库、不新增任何 AI 调用）：
 *   * saveMemory()                —— ①③通道统一入口：近似查重，命中则"强化浮升"
 *                                     （把旧记忆的 created_at 刷新到现在），不命中才插入
 *   * loadMemoryCandidates()      —— 一次取"事实池最近 200 条 + 日报最近 2 条 + 画像 1 条"
 *   * selectMemoryRows()          —— 按当前用户消息做 bigram 相关性打分 + 分层选取
 *   * buildMemoryMessage()        —— 拼成那条 system 消息（500 字硬顶不变）
 *   * markMemoriesAccessed()      —— 唤醒：这轮真被注入的记忆立刻恢复强度
 *                                     （衰减与遗忘见 lib/memory-decay.js）
 *
 * ⚠️ daily 通道不接入 saveMemory：它有"每用户每天一条"的独立语义（日期槽去重），
 *    是阶段性快照，不应被单句事实合并；只在读取端限制它最多注入 2 条。
 */
import { execute, query } from "./db.js";
import { supersedeConflicts } from "./memory-conflict.js";
import { TEXT_DECAY_BELOW } from "./memory-decay.js";

/* ============================== 写入端 ============================== */

const DEDUP_SCAN = 100; // 查重扫该用户最近 100 条事实（与读取候选池一致，走 user_id+created_at 索引）
const MIN_LEN_FOR_FUZZY = 6; // 降到 6 字以覆盖"用户养了一只猫"等常见 6~7 字标准短句，配合 overlap 严密防重
const SIMILAR_OVERLAP = 0.68; // bigram 重合占较短句比例的阈值（overlap coefficient）
const MIN_LEN_FOR_CONTAIN = 6; // 6~7 字的中等短句只允许"包含"关系，不做相似度判断
const MEMORY_MAX_CHARS = 200; // user_memories.content 是 VARCHAR(200)

const STOP_CHARS = new Set([
  "的", "了", "是", "在", "有", "个", "我", "你", "他", "她", "它", "们", "么", "什", "吗", "呢", "吧", "啊", "这", "那", "就", "也", "还", "又", "到", "去", "说", "看", "想", "要", "会", "能", "好", "很", "真"
]);

/** 提取关键实体与实词（连续英文数字单词 + 单个重要汉字实词） */
function extractEntityKeywords(text) {
  const norm = normalizeMemoryText(text);
  const keywords = new Set();
  const words = norm.match(/[a-z0-9_-]{2,}/g) || [];
  for (const w of words) keywords.add(w);
  for (const char of norm) {
    if (/[\u4e00-\u9fa5]/.test(char) && !STOP_CHARS.has(char)) {
      keywords.add(char);
    }
  }
  return keywords;
}

/** 判定是否为明显非事实的疑问/反问/调侃脏文本（防止错误入库） */
export function isInvalidMemoryContent(text) {
  if (!text || typeof text !== "string") return true;
  const t = text.trim();
  if (t.length < 2) return true;
  return /[?？]|(?:什么名字|叫什么|好不好|行不行|是谁|怎么样|在哪里|是吗|对不对)/.test(t);
}

/** 写入前统一清理：换行压成空格、去首尾引号/括号、截到 200 字 */
function cleanMemoryContent(raw) {
  return String(raw || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/^[\s"'「『（(【\[]+/, "")
    .replace(/[\s"'」』）)】\]]+$/, "")
    .trim()
    .slice(0, MEMORY_MAX_CHARS);
}

/** 归一化：小写 + 去掉所有空白和标点符号（中日韩标点也覆盖） */
export function normalizeMemoryText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** 字符二元组集合：中文天然按"字对"切分，英文/数字会连成更长的公共片段 */
function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** bigram 交集占**较短集合**的比例（overlap coefficient）0~1。
 *  比 Jaccard 更适合本场景：两次 AI 提炼同一件事，常见差异是
 *  "她在北京互联网公司做产品经理" vs "他在北京一家互联网公司当产品经理"
 *  —— 只是中间多插了两三个字，Jaccard 会被惩罚到 0.47，而 overlap≈0.69。 */
function bigramOverlap(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  // 遍历较短的集合
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter += 1;
  return inter / small.size;
}

/**
 * 两条短文本是否"说的是同一件事"，按长度分三档从严处理：
 *   1) 归一化后完全相等；
 *   2) ≥6 字：较短一方被另一方包含
 *      （"我养了一只叫团子的猫" vs "养了一只叫团子的猫"）；
 *   3) ≥8 字：bigram overlap ≥ 0.68 —— 阈值经过校准：
 *      "同句换措辞"（北京做产品经理 ≈0.69）能合并，
 *      而"同句式换关键实体"（猫叫团子 vs 叫年糕 ≈0.67）不会误合并。
 * 极短句（<6 字，如"我累了/我笑了"）只认完全相等，避免情绪短句互相吞掉。
 * 导出仅供测试/调试，业务侧一般直接用 saveMemory。
 */
export function isSameMemory(a, b) {
  const na = normalizeMemoryText(a);
  const nb = normalizeMemoryText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const min = Math.min(na.length, nb.length);
  if (min < MIN_LEN_FOR_CONTAIN) return false;
  if (na.length >= nb.length ? na.includes(nb) : nb.includes(na)) return true;
  if (min < MIN_LEN_FOR_FUZZY) return false;
  return bigramOverlap(bigrams(na), bigrams(nb)) >= SIMILAR_OVERLAP;
}

/**
 * 统一写入口（关键词通道 / 模型自主通道共用）。
 *
 * 命中近似旧记忆 → 不新增，只把旧记录 created_at 刷成当前时间（**强化浮升**）：
 *   同一件事被用户反复提起，恰恰说明它重要、且当下仍然成立 ——
 *   刷新时间戳让它同时在"最近窗口"和"相关选取"里重新靠前，不占重复行。
 *
 * @param {object} [options]
 * @param {boolean} [options.skipConflict] 跳过"状态变更失效"判定（压缩总结专用：
 *   总结里会复述历史事件，用它去触发规则等于拿旧事去失效新记忆）
 * @returns {{status:'created'|'reinforced', id?:number}}
 *   查库异常时不抛给调用方（记忆是锦上添花），返回 created 尝试直接插入；
 *   插入失败由调用方自己 try/catch（沿用各通道原有静默约定）。
 */
export async function saveMemory(userId, content, category, options = {}) {
  const text = cleanMemoryContent(content);
  if (!text || isInvalidMemoryContent(text)) return { status: "rejected" };

  // 只跟"事实类"记忆判重；daily 是当日全貌快照，不参与单句合并
  let candidates = [];
  try {
    candidates = await query(
      `SELECT id, content FROM user_memories
        WHERE user_id = ? AND superseded_at IS NULL
          AND (category IS NULL OR category <> 'daily')
          AND strength >= ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      [userId, TEXT_DECAY_BELOW, DEDUP_SCAN]
    );
  } catch {
    /* 查不了就退化成直接插入，重复了也只是一条，不致命 */
  }

  for (const row of candidates) {
    if (isSameMemory(text, row.content)) {
      try {
        // 再次被提起 = 一次强唤醒：时间刷新（浮升）+ 强度恢复满格
        // 若新内容更详尽（如新记忆包含宠物名字TZW，旧记录仅有'用户养了一只小猫'），同步升华更新 content
        if (text.length > row.content.length) {
          await execute(
            "UPDATE user_memories SET content = ?, created_at = NOW(), strength = 100, last_accessed_at = NOW() WHERE id = ? AND user_id = ?",
            [text, row.id, userId]
          );
        } else {
          await execute(
            "UPDATE user_memories SET created_at = NOW(), strength = 100, last_accessed_at = NOW() WHERE id = ? AND user_id = ?",
            [row.id, userId]
          );
        }
      } catch {
        /* 强化失败不影响聊天 */
      }
      return { status: "reinforced", id: row.id };
    }
  }

  // created_at 不指定，由数据库 DEFAULT CURRENT_TIMESTAMP 按北京时间生成
  const result = await execute(
    "INSERT INTO user_memories (user_id, content, category) VALUES (?, ?, ?)",
    [userId, text, category || null]
  );
  const newId = Number(result?.insertId) || 0;

  // 状态变了（分手 / 换工作 / 搬家…）→ 把相关旧记忆标记失效。
  // ⚠️ 只标记不删除：记忆库里能看到并恢复；标记失败也不影响本次写入。
  if (!options.skipConflict) {
    try {
      await supersedeConflicts(userId, newId, text);
    } catch {
      /* 冲突处理失败静默 —— 记忆本身已经写进去了 */
    }
  }

  return { status: "created", id: newId };
}

/**
 * T+1 日报专用查重：新一天的汇总与最近几天的日报是否说的是同一件事。
 *
 * 日报有"每用户每天一条"的独立语义，不与事实类记忆互相合并；
 * 但连续几天聊得差不多时，AI 会反复生成几乎一样的句子（"状态平稳，工作较忙"），
 * 这种重复同样不该进记忆库。返回 true 表示"已经记过了，今天跳过"。
 *
 * @param {number} userId
 * @param {string} content 本次日报内容（会先做统一清理）
 * @param {number} days 向回看几天（默认 7）
 */
export async function hasSameDailyMemory(userId, content, days = 7) {
  const text = cleanMemoryContent(content);
  if (!text) return true;
  // INTERVAL 的天数位置不能用占位符（部分驱动会报语法错），
  // 强制成正整数后内联，调用方只有本项目内部、天数是写死的常量。
  const dayInt = Math.max(1, Math.min(60, Number(days) | 0));
  let rows = [];
  try {
    rows = await query(
      `SELECT content FROM user_memories
        WHERE user_id = ? AND category = 'daily'
          AND created_at >= NOW() - INTERVAL ${dayInt} DAY
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      [userId, dayInt]
    );
  } catch {
    return false; // 查不了就不拦，宁可多一条也不丢记忆
  }
  return rows.some((row) => isSameMemory(text, row.content));
}

/* ============================== 读取端 ============================== */

const FACT_POOL = 200; // 事实候选池：跨对话检索要从更多历史里找，100 → 200（走 user_id+created_at 索引）
const DAILY_KEEP = 2; // daily 最多注入几条 —— 日报每条 200 字，多了必挤占事实
const FACT_MAX = 14; // 相关事实最多几条
const FACT_FALLBACK = 6; // 当前消息与所有记忆都不相关时，至少保留几条最近事实
const PINNED_MAX = 4; // 关系 / 偏好 / 愿望 类核心事实**常驻**注入条数（不依赖字面命中）
const PINNED_WISH_MAX = 2; // 愿望再常驻也不能挤光关系/偏好：单独限 2 条
const PINNED_CATEGORIES = new Set(["relation", "preference", "wish"]);
const MEMORY_TOTAL_CHARS = 500; // 注入总字数硬顶（800 → 500：记忆块越长 TTFT 越慢）

const MEMORY_HEADER =
  "以下是用户之前提过的重要信息，作为背景参考，不要每次都主动提起，只在相关时自然引用：";

/** 类别基础分：稳定事实 > 自主记忆 > 瞬时情绪 */
const CATEGORY_WEIGHT = {
  preference: 3,
  relation: 3,
  wish: 3, // 愿望和偏好同级：都是 AI 该主动关心的长期信息
  event: 2,
  self: 2,
  emotion: 0,
};

/**
 * 加载注入候选（与 AI 配置查询并行发出，互不等待）。
 * 表不存在 / 查询异常都静默 —— 记忆绝不能拖垮聊天首字延迟。
 * @returns {Promise<{facts:Array, daily:Array}>}
 */
/**
 * 计算记忆距今的天数（天为单位，带小数）
 */
function getMemoryAgeDays(createdAt) {
  if (!createdAt) return 0;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (Date.now() - t) / (24 * 3600 * 1000));
}

/** 短期时效事件关键词（感冒、发烧、考试、出差等随时间流逝而结束的状态） */
const SHORT_TERM_REGEX = /(感冒|发烧|头疼|生病|看病|打针|吃药|挂号|医院|考试|面试|出差|赶工|赶项目|加班|答辩)/i;

/**
 * 判断是否为短期时效事件：
 * 命中短期关键词，或者类别为 event 的短期事件。
 */
function isShortTermEvent(content, category) {
  const text = String(content || "");
  if (category === "event") return true;
  return SHORT_TERM_REGEX.test(text);
}

export async function loadMemoryCandidates(userId) {
  const empty = { facts: [], daily: [], profile: [] };
  try {
    // ⚠️ strength < 10 的"正在消亡"记忆不参与注入：
    //    它们的正文已经被衰减任务截成第一个字，塞进提示词只会是噪声。
    //    （强度门槛与 lib/memory-decay.js 的文字消亡阈值是同一个数）
    const [facts, daily, profile] = await Promise.all([
      query(
        `SELECT id, content, category, created_at FROM user_memories
          WHERE user_id = ? AND superseded_at IS NULL
            AND (category IS NULL OR category NOT IN ('daily', 'profile'))
            AND strength >= ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
        [userId, TEXT_DECAY_BELOW, FACT_POOL]
      ),
      query(
        `SELECT id, content, category, created_at FROM user_memories
          WHERE user_id = ? AND superseded_at IS NULL AND category = 'daily'
            AND strength >= ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
        [userId, TEXT_DECAY_BELOW, DAILY_KEEP]
      ),
      // 画像级总结（自动压缩产物）：只留最新一条，作为最上层的背景
      query(
        `SELECT id, content, category, created_at FROM user_memories
          WHERE user_id = ? AND superseded_at IS NULL AND category = 'profile'
            AND strength >= ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [userId, TEXT_DECAY_BELOW]
      ),
    ]);
    return {
      facts: Array.isArray(facts) ? facts.filter(r => !isInvalidMemoryContent(r.content)) : [],
      daily: Array.isArray(daily) ? daily.filter(r => !isInvalidMemoryContent(r.content)) : [],
      profile: Array.isArray(profile) ? profile.filter(r => !isInvalidMemoryContent(r.content)) : [],
    };
  } catch {
    return empty;
  }
}

/**
 * 唤醒：这一轮**真的被注入给模型**的记忆，强度立刻恢复到 100、时间刷成现在。
 *
 * 由 chat 接口 fire-and-forget 调用 —— 一条 UPDATE 就能完成，绝不 await，
 * 不能为了记一笔"被想起来了"而拖慢首字。
 *
 * @param {number} userId
 * @param {number[]} ids 本轮选中的记忆 id（selectMemoryRows 返回行里的 id）
 * @returns {Promise<number>} 被唤醒的条数
 */
export async function markMemoriesAccessed(userId, ids) {
  const list = (Array.isArray(ids) ? ids : [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!list.length) return 0;

  const placeholders = list.map(() => "?").join(", ");
  const result = await execute(
    `UPDATE user_memories
        SET strength = 100, last_accessed_at = NOW()
      WHERE user_id = ? AND id IN (${placeholders})`,
    [userId, ...list]
  );
  return Number(result?.affectedRows || 0);
}

/**
 * 相关性精选（纯函数，便于推理与时序解耦：查询可以提前并行发，
 * 等拿到本轮用户消息后再做选取，零额外网络往返）。
 *
 * 排序：bigram 命中数 ×3 + 类别权重（不取时间衰减 ——
 * 相关但久远的事实正是长期记忆最该找回的东西）。
 *
 * @param {{facts:Array, daily:Array}} candidates loadMemoryCandidates 的结果
 * @param {string} currentText 本轮最近几条用户消息（跨对话检索，chat 接口拼好后传入）
 * @returns {Array<{content:string}>} 已排好注入顺序的行
 */
export function selectMemoryRows(candidates, currentText) {
  const facts = candidates?.facts || [];
  const daily = candidates?.daily || [];
  const profile = candidates?.profile || [];
  if (!facts.length && !daily.length && !profile.length) return [];

  const query = normalizeMemoryText(currentText);
  const queryGrams = query ? bigrams(query) : null;
  const queryKeywords = query ? extractEntityKeywords(currentText) : null;

  // —— 事实池：时效衰减与动态激活打分 ——
  const scored = facts.map((row, idx) => {
    let hits = 0;
    const normRow = normalizeMemoryText(row.content);
    if (queryGrams) {
      const grams = bigrams(normRow);
      for (const g of grams) if (queryGrams.has(g)) hits += 1;
    }
    // 关键实体词命中（单字实词如猫/狗/住/车/工作，或英文单词如tzw）
    if (queryKeywords && queryKeywords.size) {
      for (const kw of queryKeywords) {
        if (normRow.includes(kw)) {
          hits += (kw.length >= 2 ? 2 : 1);
        }
      }
    }
    // idx 越小越新；同分时新近者优先（除以候选池大小，权重远小于一个命中）
    const recency = (FACT_POOL - Math.min(idx, FACT_POOL)) / FACT_POOL;
    const isShortTerm = isShortTermEvent(row.content, row.category);
    const ageDays = getMemoryAgeDays(row.created_at);

    // 短期事件时间衰减与动态激活逻辑：
    // 1) 3~4天内（ageDays <= 4）：如果hits=0，可适度赋以近期关切权重；
    // 2) 超过4天（ageDays > 4）：如果当前用户未提及（hits === 0），不再无端主动提及，避免突兀；
    //    仅当hits > 0（用户主动提起时）动态重新激活！
    let timeDecayPenalty = 0;
    if (isShortTerm && ageDays > 4 && hits === 0) {
      timeDecayPenalty = -999; // 标记过期短期事件：不进入未命中时的兜底注入
    }

    return {
      id: row.id,
      content: row.content,
      category: row.category || null,
      created_at: row.created_at,
      score: hits * 3 + (CATEGORY_WEIGHT[row.category] ?? 1) + recency + timeDecayPenalty,
      hits,
      isShortTerm,
      ageDays,
    };
  });

  // 命中关键词的记忆（动态激活）
  const relevant = scored
    .filter((r) => r.hits > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, FACT_MAX);

  // 安全兜底池：过滤掉"超过4天且未命中的短期过期事件"
  const safeFallbackPool = scored.filter(
    (r) => !r.isShortTerm || r.ageDays <= 4 || r.hits > 0
  );

  // 当前话题与记忆都不沾边时：从安全兜底池中挑选最近的背景
  let pickedFacts;
  if (relevant.length === 0) {
    pickedFacts = safeFallbackPool.slice(0, FACT_FALLBACK);
  } else if (relevant.length < FACT_FALLBACK) {
    const exist = new Set(relevant.map((r) => r.content));
    const fill = safeFallbackPool
      .filter((r) => !exist.has(r.content))
      .slice(0, FACT_FALLBACK - relevant.length);
    pickedFacts = [...relevant, ...fill];
  } else {
    pickedFacts = relevant;
  }

  // 核心事实常驻：生活习惯、人际圈子、核心压力源、安慰偏好（四维分层）
  // 不受偶发对话字面影响，保持懂你的老朋友画像
  const pickedKeys = new Set(pickedFacts.map((r) => r.content));
  const pinned = [];
  let wishPinned = 0;
  for (const row of scored) {
    if (pinned.length >= PINNED_MAX) break;
    if (!PINNED_CATEGORIES.has(row.category)) continue;
    if (row.category === "wish" && wishPinned >= PINNED_WISH_MAX) continue;
    if (pickedKeys.has(row.content)) continue;
    // 同样避免过期短期事件常驻
    if (row.isShortTerm && row.ageDays > 4 && row.hits === 0) continue;
    pinned.push(row);
    pickedKeys.add(row.content);
    if (row.category === "wish") wishPinned += 1;
  }

  // —— 注入顺序 ——
  // daily（近况全貌，旧的在前新的在后）→ 常驻核心事实 → 事实按相关度升序，
  // 让最相关的事实落在记忆块最后、紧贴用户消息
  const dailyAsc = daily.slice().reverse();
  const factsAsc = pickedFacts.slice().sort((a, b) => a.score - b.score);
  return [...profile, ...dailyAsc, ...pinned, ...factsAsc];
}

/** 记忆标签分类中文映射 */
const CATEGORY_NAMES = {
  habit: "生活习惯与偏好",
  preference: "生活习惯与偏好",
  relation: "人际与社交圈",
  stress_source: "核心压力源",
  stress: "核心压力源",
  comfort_style: "偏好的慰藉方式",
  comfort: "偏好的慰藉方式",
  wish: "愿望与期待",
  event: "近期生活动态",
  daily: "近期生活概貌",
  profile: "用户画像与长期特质",
};

/** 把选中的行按四维标签分层拼成结构化的 system 消息（500字硬顶限制不变） */
export function buildMemoryMessage(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;

  // 按类别分组，保持结构清晰
  const grouped = new Map();
  for (const row of rows) {
    const cat = row?.category || "event";
    const groupName = CATEGORY_NAMES[cat] || "重要背景";
    if (!grouped.has(groupName)) grouped.set(groupName, []);
    const text = String(row?.content ?? "").trim();
    if (text) grouped.get(groupName).push(text);
  }

  const sections = [];
  let used = MEMORY_HEADER.length + 60; // 预留底部交流原则的字数空间

  for (const [groupName, items] of grouped.entries()) {
    const sectionHeader = `【${groupName}】`;
    const lines = [];
    for (const item of items) {
      const line = `- ${item}`;
      if (used + line.length + sectionHeader.length + 4 > MEMORY_TOTAL_CHARS) continue;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length) {
      sections.push(`${sectionHeader}\n${lines.join("\n")}`);
      used += sectionHeader.length + 1;
    }
  }

  if (!sections.length) return null;

  const content = [
    MEMORY_HEADER,
    sections.join("\n"),
    "[交流原则] 优先体察用户当下的感受与偏好的安慰方式；对于过去已结束的短暂小事，若用户未主动提起切勿机械追问。",
  ].join("\n");

  return { role: "system", content };
}

/* ===================== 历史数据一次性合并（老库迁移） ===================== */
export async function dedupeExistingMemories() {
  let rows = [];
  try {
    rows = await query(
      `SELECT id, user_id, content, category
         FROM user_memories
        ORDER BY id DESC
        LIMIT ?`,
      [DEDUPE_TOTAL_CAP]
    );
  } catch {
    return { scanned: 0, removed: 0 }; // 表还没建 / 查不了：安静跳过
  }
  if (!rows.length) return { scanned: 0, removed: 0 };

  // 按用户分组（保持 id 倒序：新的在前）
  const byUser = new Map();
  for (const row of rows) {
    const uid = Number(row.user_id);
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(row);
  }

  const toDelete = [];
  let scanned = 0;
  for (const list of byUser.values()) {
    const picked = list.slice(0, DEDUPE_PER_USER_CAP);
    scanned += picked.length;
    // 事实桶 / 日报桶分开：每条已保留的记录作为桶内的"代表行"
    const keptFact = [];
    const keptDaily = [];
    for (const row of picked) {
      const bucket = row.category === "daily" ? keptDaily : keptFact;
      if (bucket.some((kept) => isSameMemory(row.content, kept.content))) {
        toDelete.push(row.id);
      } else {
        bucket.push(row);
      }
    }
  }

  let removed = 0;
  for (let i = 0; i < toDelete.length; i += DEDUPE_DELETE_BATCH) {
    const batch = toDelete.slice(i, i + DEDUPE_DELETE_BATCH);
    const placeholders = batch.map(() => "?").join(", ");
    try {
      const result = await execute(
        `DELETE FROM user_memories WHERE id IN (${placeholders})`,
        batch
      );
      removed += Number(result?.affectedRows || 0);
    } catch {
      /* 一批失败不拖其它批 */
    }
  }
  return { scanned, removed };
}
