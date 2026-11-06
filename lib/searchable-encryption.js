/**
 * 可搜索对称加密（Searchable Symmetric Encryption, SSE / Blind Index）
 *
 * 核心设计目标：
 *   1. 数据库存储安全：数据库中只保存 AES-256-GCM 强加密密文与单向不可逆的盲索引哈希（Blind Hash）；
 *      即使数据库泄露或脱库，外界在没有服务端密钥的情况下，既无法还原正文，也无法通过彩虹表碰撞反推用户词汇。
 *   2. 服务端毫秒级安全检索：在面对单个用户积累数万至数十万条历史聊天/日记时，
 *      无需客户端拉取全量密文至内存解密，直接由服务端利用倒排盲索引完成高效分页查询与排序。
 *   3. 零外部依赖：纯原生 Node.js crypto 模块实现 HMAC-SHA256 与 N-gram 滑窗分词，跨平台免编译。
 */
import crypto from "node:crypto";
import { execute, query } from "./db.js";
import { decryptContent } from "./secret-box.js";

function resolveBlindKey() {
  const source =
    process.env.BLIND_INDEX_KEY ||
    process.env.USER_PASSWORD_KEY ||
    process.env.CODE_SECRET ||
    "solace-blind-index-default-key";
  // 独立派生 32 字节专用于盲索引的 HMAC 密钥
  return crypto.createHash("sha256").update(`solace-blind-index|${source}`).digest();
}

/** 常用标点与空白符过滤正则 */
const PUNCT_RE = /[\s\p{P}\p{S}]+/gu;

/**
 * 轻量级多语言分词器（中文 2~3 gram 滑窗 + 英文数字整词）
 * @param {string} text 待分词文本
 * @returns {string[]} 归一化后的词元列表（去重）
 */
export function extractSearchTokens(text) {
  if (!text) return [];
  const raw = String(text).toLowerCase();
  const tokens = new Set();

  // 1. 英文与数字整词提取（>= 2 字符）
  const words = raw.match(/[a-z0-9_]{2,}/g) || [];
  for (const w of words) {
    tokens.add(w.slice(0, 32));
  }

  // 2. 清洗标点与空白后的连续中文字符串
  const clean = raw.replace(PUNCT_RE, "");
  if (!clean) return Array.from(tokens);

  // 3. 中文 N-Gram 滑窗切分（2-gram 与 3-gram）
  const len = clean.length;
  // 短句（1~2字）直接收录
  if (len <= 2) {
    tokens.add(clean);
  } else {
    // 2-gram 切分
    for (let i = 0; i < len - 1; i++) {
      tokens.add(clean.slice(i, i + 2));
    }
    // 3-gram 切分（提供更精准的多字词匹配）
    for (let i = 0; i < len - 2; i++) {
      tokens.add(clean.slice(i, i + 3));
    }
  }

  // 单条记录词元上限 120 个，避免超长文本膨胀
  return Array.from(tokens).slice(0, 120);
}

/**
 * 计算不可逆盲哈希（HMAC-SHA256，截取 16 字节十六进制，共 32 字符）
 * @param {string} token 归一化词元
 * @returns {string} 定长十六进制哈希
 */
export function computeBlindHash(token) {
  if (!token) return "";
  const key = resolveBlindKey();
  return crypto
    .createHmac("sha256", key)
    .update(String(token).toLowerCase())
    .digest("hex")
    .slice(0, 32);
}

/**
 * 为单条聊天消息构建不可逆盲索引
 */
export async function indexMessage(userId, messageId, conversationId, plainText) {
  if (!userId || !messageId || !plainText) return 0;
  const tokens = extractSearchTokens(plainText);
  if (!tokens.length) return 0;

  try {
    // 先清理此消息可能存在的旧索引（防止编辑或重试时重复）
    await execute("DELETE FROM message_search_index WHERE message_id = ?", [messageId]);

    const values = [];
    const params = [];
    for (const token of tokens) {
      const hash = computeBlindHash(token);
      if (!hash) continue;
      values.push("(?, ?, ?, ?)");
      params.push(userId, messageId, conversationId, hash);
    }

    if (!values.length) return 0;

    const sql = `INSERT INTO message_search_index (user_id, message_id, conversation_id, blind_hash) VALUES ${values.join(", ")}`;
    const res = await execute(sql, params);
    return Number(res?.affectedRows || 0);
  } catch (err) {
    console.warn("[searchable-encryption] indexMessage failed:", err?.message || err);
    return 0;
  }
}

/**
 * 为单条日记构建不可逆盲索引
 */
export async function indexDiary(userId, diaryId, plainText) {
  if (!userId || !diaryId || !plainText) return 0;
  const tokens = extractSearchTokens(plainText);
  if (!tokens.length) return 0;

  try {
    await execute("DELETE FROM diary_search_index WHERE diary_id = ?", [diaryId]);

    const values = [];
    const params = [];
    for (const token of tokens) {
      const hash = computeBlindHash(token);
      if (!hash) continue;
      values.push("(?, ?, ?)");
      params.push(userId, diaryId, hash);
    }

    if (!values.length) return 0;

    const sql = `INSERT INTO diary_search_index (user_id, diary_id, blind_hash) VALUES ${values.join(", ")}`;
    const res = await execute(sql, params);
    return Number(res?.affectedRows || 0);
  } catch (err) {
    console.warn("[searchable-encryption] indexDiary failed:", err?.message || err);
    return 0;
  }
}

/**
 * 服务端密文安全分页检索（聊天记录）
 * @param {number} userId 用户ID
 * @param {string} keyword 搜索关键词
 * @param {object} [options]
 * @param {number} [options.conversationId] 指定对话
 * @param {number} [options.page=1] 页码
 * @param {number} [options.limit=20] 每页条数
 */
export async function searchMessagesByBlindIndex(userId, keyword, options = {}) {
  const qText = String(keyword || "").trim();
  if (!userId || !qText) return { total: 0, items: [], page: 1, limit: 20 };

  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 20));
  const offset = (page - 1) * limit;

  const queryTokens = extractSearchTokens(qText);
  if (!queryTokens.length) return { total: 0, items: [], page, limit };

  const hashes = queryTokens.map((t) => computeBlindHash(t)).filter(Boolean);
  if (!hashes.length) return { total: 0, items: [], page, limit };

  try {
    const placeholders = hashes.map(() => "?").join(", ");
    const params = [userId, ...hashes];
    let convFilter = "";
    if (options.conversationId) {
      convFilter = " AND conversation_id = ? ";
      params.push(options.conversationId);
    }

    // 统计命中的总消息数
    const countSql = `
      SELECT COUNT(DISTINCT message_id) as total
        FROM message_search_index
       WHERE user_id = ? AND blind_hash IN (${placeholders})
       ${convFilter}
    `;
    const countRows = await query(countSql, params);
    const total = Number(countRows?.[0]?.total || 0);
    if (total === 0) return { total: 0, items: [], page, limit };

    // 分页检索命中的消息详情
    const listParams = [...params, limit, offset];
    const listSql = `
      SELECT m.id, m.conversation_id, m.role, m.content, m.created_at,
             COUNT(s.blind_hash) as hit_score
        FROM message_search_index s
        JOIN messages m ON s.message_id = m.id
       WHERE s.user_id = ? AND s.blind_hash IN (${placeholders})
       ${convFilter}
       GROUP BY m.id, m.conversation_id, m.role, m.content, m.created_at
       ORDER BY hit_score DESC, m.id DESC
       LIMIT ? OFFSET ?
    `;
    const rows = await query(listSql, listParams);

    // 解密正文并截取关键词高亮上下文片段
    const items = (rows || []).map((row) => {
      const plain = decryptContent(row.content);
      const snippet = buildSearchSnippet(plain, qText);
      return {
        id: row.id,
        conversationId: row.conversation_id,
        role: row.role,
        content: plain,
        snippet,
        createdAt: row.created_at,
        hitScore: Number(row.hit_score || 1),
      };
    });

    return { total, items, page, limit };
  } catch (err) {
    console.error("[searchable-encryption] searchMessages error:", err);
    return { total: 0, items: [], page, limit, error: err?.message };
  }
}

/**
 * 服务端密文安全分页检索（日记）
 */
export async function searchDiariesByBlindIndex(userId, keyword, options = {}) {
  const qText = String(keyword || "").trim();
  if (!userId || !qText) return { total: 0, items: [], page: 1, limit: 20 };

  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 20));
  const offset = (page - 1) * limit;

  const queryTokens = extractSearchTokens(qText);
  if (!queryTokens.length) return { total: 0, items: [], page, limit };

  const hashes = queryTokens.map((t) => computeBlindHash(t)).filter(Boolean);
  if (!hashes.length) return { total: 0, items: [], page, limit };

  try {
    const placeholders = hashes.map(() => "?").join(", ");
    const params = [userId, ...hashes];

    const countSql = `
      SELECT COUNT(DISTINCT diary_id) as total
        FROM diary_search_index
       WHERE user_id = ? AND blind_hash IN (${placeholders})
    `;
    const countRows = await query(countSql, params);
    const total = Number(countRows?.[0]?.total || 0);
    if (total === 0) return { total: 0, items: [], page, limit };

    const listParams = [...params, limit, offset];
    const listSql = `
      SELECT d.id, d.title, d.content, d.mood, d.user_mood, d.created_at,
             COUNT(s.blind_hash) as hit_score
        FROM diary_search_index s
        JOIN diaries d ON s.diary_id = d.id
       WHERE s.user_id = ? AND s.blind_hash IN (${placeholders})
       GROUP BY d.id, d.title, d.content, d.mood, d.user_mood, d.created_at
       ORDER BY hit_score DESC, d.id DESC
       LIMIT ? OFFSET ?
    `;
    const rows = await query(listSql, listParams);

    const items = (rows || []).map((row) => {
      const plain = decryptContent(row.content);
      const snippet = buildSearchSnippet(plain, qText);
      return {
        id: row.id,
        title: row.title,
        content: plain,
        snippet,
        mood: row.mood,
        userMood: row.user_mood,
        createdAt: row.created_at,
        hitScore: Number(row.hit_score || 1),
      };
    });

    return { total, items, page, limit };
  } catch (err) {
    console.error("[searchable-encryption] searchDiaries error:", err);
    return { total: 0, items: [], page, limit, error: err?.message };
  }
}

/**
 * 提取搜索结果高亮摘要片段（前后 35 字上下文）
 */
function buildSearchSnippet(fullText, keyword) {
  if (!fullText) return "";
  const text = String(fullText);
  const kw = String(keyword || "").trim().toLowerCase();
  if (!kw) return text.slice(0, 70);

  const idx = text.toLowerCase().indexOf(kw);
  if (idx === -1) return text.slice(0, 70);

  const start = Math.max(0, idx - 20);
  const end = Math.min(text.length, idx + kw.length + 35);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = `...${snippet}`;
  if (end < text.length) snippet = `${snippet}...`;
  return snippet;
}

/**
 * 增量为未建盲索引的历史数据补全（平滑迁移老库数据，单批 100 条）
 */
export async function backfillBlindIndexes(limit = 100) {
  let msgCount = 0;
  let diaryCount = 0;
  try {
    // 1. 查找没有在 message_search_index 中的消息
    const unindexedMsgs = await query(
      `SELECT m.id, m.user_id, m.conversation_id, m.content
         FROM messages m
    LEFT JOIN message_search_index s ON m.id = s.message_id
        WHERE s.message_id IS NULL
        ORDER BY m.id DESC
        LIMIT ?`,
      [limit]
    );

    for (const m of unindexedMsgs || []) {
      const plain = decryptContent(m.content);
      if (plain) {
        await indexMessage(m.user_id, m.id, m.conversation_id, plain);
        msgCount++;
      }
    }

    // 2. 查找没有在 diary_search_index 中的日记
    const unindexedDiaries = await query(
      `SELECT d.id, d.user_id, d.content, d.title
         FROM diaries d
    LEFT JOIN diary_search_index s ON d.id = s.diary_id
        WHERE s.diary_id IS NULL
        ORDER BY d.id DESC
        LIMIT ?`,
      [limit]
    );

    for (const d of unindexedDiaries || []) {
      const plain = `${d.title || ""} ${decryptContent(d.content)}`.trim();
      if (plain) {
        await indexDiary(d.user_id, d.id, plain);
        diaryCount++;
      }
    }
  } catch (err) {
    console.warn("[searchable-encryption] backfillBlindIndexes error:", err?.message || err);
  }
  return { indexedMessages: msgCount, indexedDiaries: diaryCount };
}

