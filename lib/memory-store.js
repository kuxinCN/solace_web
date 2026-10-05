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
 *   * loadMemoryCandidates()      —— 一次取"事实池最近 100 条 + 日报最近 2 条"
 *   * selectMemoryRows()          —— 按当前用户消息做 bigram 相关性打分 + 分层选取
 *   * buildMemoryMessage()        —— 拼成那条 system 消息（800 字硬顶不变）
 *
 * ⚠️ daily 通道不接入 saveMemory：它有"每用户每天一条"的独立语义（日期槽去重），
 *    是阶段性快照，不应被单句事实合并；只在读取端限制它最多注入 2 条。
 */
import { execute, query } from "./db.js";

/* ============================== 写入端 ============================== */

const DEDUP_SCAN = 100; // 查重扫该用户最近 100 条事实（与读取候选池一致，走 user_id+created_at 索引）
const MIN_LEN_FOR_FUZZY = 8; // 短于 8 字只认相等/包含；极短句词面不可靠，从严防误合并
const SIMILAR_OVERLAP = 0.68; // bigram 重合占较短句比例的阈值（overlap coefficient）
const MIN_LEN_FOR_CONTAIN = 6; // 6~7 字的中等短句只允许"包含"关系，不做相似度判断
const MEMORY_MAX_CHARS = 200; // user_memories.content 是 VARCHAR(200)

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
 * @returns {{status:'created'|'reinforced', id?:number}}
 *   查库异常时不抛给调用方（记忆是锦上添花），返回 created 尝试直接插入；
 *   插入失败由调用方自己 try/catch（沿用各通道原有静默约定）。
 */
export async function saveMemory(userId, content, category) {
  const text = cleanMemoryContent(content);
  if (!text) return { status: "reinforced" };

  // 只跟"事实类"记忆判重；daily 是当日全貌快照，不参与单句合并
  let candidates = [];
  try {
    candidates = await query(
      `SELECT id, content FROM user_memories
        WHERE user_id = ? AND (category IS NULL OR category <> 'daily')
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      [userId, DEDUP_SCAN]
    );
  } catch {
    /* 查不了就退化成直接插入，重复了也只是一条，不致命 */
  }

  for (const row of candidates) {
    if (isSameMemory(text, row.content)) {
      try {
        await execute(
          "UPDATE user_memories SET created_at = NOW() WHERE id = ? AND user_id = ?",
          [row.id, userId]
        );
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
  return { status: "created", id: Number(result?.insertId) || 0 };
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

const FACT_POOL = 100; // 事实候选池：从"最近 20 条"扩大到 100 条，再由相关性精选
const DAILY_KEEP = 2; // daily 最多注入几条 —— 日报每条 200 字，多了必挤占事实
const FACT_MAX = 14; // 相关事实最多几条
const FACT_FALLBACK = 6; // 当前消息与所有记忆都不相关时，至少保留几条最近事实
const MEMORY_TOTAL_CHARS = 800; // 注入总字数硬顶（与历史行为一致）

const MEMORY_HEADER =
  "以下是用户之前提过的重要信息，作为背景参考，不要每次都主动提起，只在相关时自然引用：";

/** 类别基础分：稳定事实 > 自主记忆 > 瞬时情绪 */
const CATEGORY_WEIGHT = {
  preference: 3,
  relation: 3,
  event: 2,
  self: 2,
  emotion: 0,
};

/**
 * 加载注入候选（与 AI 配置查询并行发出，互不等待）。
 * 表不存在 / 查询异常都静默 —— 记忆绝不能拖垮聊天首字延迟。
 * @returns {Promise<{facts:Array, daily:Array}>}
 */
export async function loadMemoryCandidates(userId) {
  const empty = { facts: [], daily: [] };
  try {
    const [facts, daily] = await Promise.all([
      query(
        `SELECT content, category FROM user_memories
          WHERE user_id = ? AND (category IS NULL OR category <> 'daily')
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
        [userId, FACT_POOL]
      ),
      query(
        `SELECT content, category FROM user_memories
          WHERE user_id = ? AND category = 'daily'
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
        [userId, DAILY_KEEP]
      ),
    ]);
    return { facts: Array.isArray(facts) ? facts : [], daily: Array.isArray(daily) ? daily : [] };
  } catch {
    return empty;
  }
}

/**
 * 相关性精选（纯函数，便于推理与时序解耦：查询可以提前并行发，
 * 等拿到本轮用户消息后再做选取，零额外网络往返）。
 *
 * 排序：bigram 命中数 ×3 + 类别权重（不取时间衰减 ——
 * 相关但久远的事实正是长期记忆最该找回的东西）。
 *
 * @param {{facts:Array, daily:Array}} candidates loadMemoryCandidates 的结果
 * @param {string} currentText 本轮最后一条用户消息
 * @returns {Array<{content:string}>} 已排好注入顺序的行
 */
export function selectMemoryRows(candidates, currentText) {
  const facts = candidates?.facts || [];
  const daily = candidates?.daily || [];
  if (!facts.length && !daily.length) return [];

  const query = normalizeMemoryText(currentText);
  const queryGrams = query ? bigrams(query) : null;

  // —— 事实池：相关性打分 ——
  const scored = facts.map((row, idx) => {
    let hits = 0;
    if (queryGrams) {
      const grams = bigrams(normalizeMemoryText(row.content));
      for (const g of grams) if (queryGrams.has(g)) hits += 1;
    }
    // idx 越小越新；同分时新近者优先（除以候选池大小，权重远小于一个命中）
    const recency = (FACT_POOL - Math.min(idx, FACT_POOL)) / FACT_POOL;
    return {
      content: row.content,
      score: hits * 3 + (CATEGORY_WEIGHT[row.category] ?? 1) + recency,
      hits,
    };
  });

  const relevant = scored
    .filter((r) => r.hits > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, FACT_MAX);

  // 当前话题与所有记忆都不沾边：不硬塞无关内容抢注意力，只留最近几条当背景
  let pickedFacts;
  if (relevant.length === 0) {
    pickedFacts = scored.slice(0, FACT_FALLBACK);
  } else if (relevant.length < FACT_FALLBACK) {
    const exist = new Set(relevant.map((r) => r.content));
    const fill = scored.filter((r) => !exist.has(r.content)).slice(0, FACT_FALLBACK - relevant.length);
    pickedFacts = [...relevant, ...fill];
  } else {
    pickedFacts = relevant;
  }

  // —— 注入顺序 ——
  // daily（近况全貌，旧的在前新的在后）→ 事实按相关度升序，
  // 让最相关的事实落在记忆块最后、紧贴用户消息：
  // GLM-4-flash 对靠前的 system 内容注意力弱，越靠近对话越读得进去。
  const dailyAsc = daily.slice().reverse();
  const factsAsc = pickedFacts.slice().sort((a, b) => a.score - b.score);
  return [...dailyAsc, ...factsAsc];
}

/** 把选中的行拼成一条 system 消息；没有可用内容返回 null（不插入） */
export function buildMemoryMessage(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const lines = [];
  let used = MEMORY_HEADER.length;
  for (const row of rows) {
    const text = String(row?.content ?? "").trim();
    if (!text) continue;
    const line = `- ${text}`;
    if (used + line.length + 1 > MEMORY_TOTAL_CHARS) break; // 800 字硬顶
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return null;
  return { role: "system", content: `${MEMORY_HEADER}\n${lines.join("\n")}` };
}

/* ===================== 历史数据一次性合并（老库迁移） ===================== */

const DEDUPE_TOTAL_CAP = 5000; // 一次最多扫多少条（全表有界，防远端库/内存打爆）
const DEDUPE_PER_USER_CAP = 500; // 单用户最多参与比对多少条
const DEDUPE_DELETE_BATCH = 200; // 删除分批，单条 SQL 别太长

/**
 * 合并 user_memories 里**已经存在**的重复行（去重逻辑上线前攒下的）。
 *
 * 规则：
 *   * 按用户分组，事实类（非 daily）与日报类（daily）各自组内比对，不跨类合并
 *     —— 单句事实与当日全貌是两种东西；
 *   * 每组按 id 倒序（新→旧）贪心扫描，命中已保留行的近似重复 → 标记删除，
 *     始终**保留最新一条**（内容+最新时间都在它身上）；
 *   * 删除为物理删除（重复行没有信息增量，不进回收站）。
 *
 * 幂等：清完后表内已无近似重复，重跑 affectedRows=0。
 * 由 lib/schema.js 的 ensureUserColumnsOnce() 懒启动时执行一次（safe 包裹，失败不阻塞）。
 *
 * @returns {Promise<{scanned:number, removed:number}>}
 */
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
