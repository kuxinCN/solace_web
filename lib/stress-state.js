/**
 * 压力状态：EMA 平滑、趋势、双通道融合，以及状态的读写。
 *
 * 分两半：
 *   * **上半是纯函数**（smooth / calcTrend / combine）—— 可单测、无副作用；
 *   * **下半是持久化**（getStressState / updateStressState / 日志写入）。
 *
 * ⚠️ 一个刻意的设计：**消息计数只在内存里累加**。
 *    聊天是全站最高频的写路径，"每条消息 UPDATE 一次状态表"会让
 *    每条消息都多一次数据库往返 —— 而我们只关心"够 10 条了吗"。
 *    所以：内存 +1；只有真正触发分析、或要写状态时，才把计数落库一次。
 *    代价是重启会丢计数（最多导致多分析或少分析一次），完全可接受。
 */
import { execute, query } from "./db.js";
import { BASE_SCORE } from "./stress-analyzer.js";

/** EMA 平滑系数：越大越灵敏，越小越稳 */
export const ALPHA = 0.35;

/** 趋势用的短窗口 / 长窗口 */
const SHORT_WINDOW = 3;
const LONG_WINDOW = 10;

/** 日记通道的时间衰减系数（每天衰减约 5%） */
const DIARY_DECAY = 0.05;

/** 默认阈值（用户没单独设时） */
export const DEFAULT_THRESHOLD = 70;

/** 聊天 / 日记的默认峰值下限（日记略低：写下来本身更需要被接住） */
export const DIARY_THRESHOLD_OFFSET = 5;

/* ---------------------------------------------------------- 纯算法部分 */

/**
 * 指数移动平均。
 * @param {number|null} prev 上一次的平滑值（首次传 null）
 * @param {number} next 本次原始分
 */
export function smooth(prev, next, alpha = ALPHA) {
  const value = Number(next);
  const safeNext = Number.isFinite(value) ? value : BASE_SCORE;
  if (prev == null || !Number.isFinite(Number(prev))) return safeNext;
  return alpha * safeNext + (1 - alpha) * Number(prev);
}

/**
 * 趋势 = 近 3 次均值 − 近 10 次均值。
 * 正数表示"最近比之前更紧"，负数表示"缓下来了"。
 */
export function calcTrend(history = []) {
  if (!Array.isArray(history) || history.length < SHORT_WINDOW) return 0;

  const short = history.slice(-SHORT_WINDOW);
  const long = history.slice(-LONG_WINDOW);
  const average = (list) => list.reduce((sum, item) => sum + Number(item || 0), 0) / list.length;

  return average(short) - average(long);
}

/**
 * 双通道融合：聊天 0.4 + 日记 0.6（日记权重更高）。
 *
 * ⚠️ `diaryAgeDays` **必须传真实天数**。原规格的调用处恒传 0，
 *    而 `exp(-0.05 × 0) = 1` —— 衰减项等于没有，昨天写的日记会一直满权重压着。
 *
 * @param {number} chatScore 聊天通道平滑分
 * @param {number|null} diaryScore 日记通道分（没有则返回聊天分）
 * @param {number} diaryAgeDays 日记距今天数
 */
export function combine(chatScore, diaryScore, diaryAgeDays = 0) {
  const chat = Number(chatScore);
  const safeChat = Number.isFinite(chat) ? chat : BASE_SCORE;

  if (diaryScore == null) return Math.round(safeChat);

  const diary = Number(diaryScore);
  if (!Number.isFinite(diary)) return Math.round(safeChat);

  const age = Math.max(0, Number(diaryAgeDays) || 0);
  const decay = Math.exp(-DIARY_DECAY * age);

  return Math.round(0.4 * safeChat + 0.6 * diary * decay);
}

/** 把任意分数收敛到 0-100 */
export function clampScore(value, fallback = BASE_SCORE) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(100, Math.round(num)));
}

/* ------------------------------------------------------- 内存消息计数 */

/** userId → 自上次分析以来的消息条数 */
const messageCounters = new Map();

/** 自增内存计数，返回自增后的值 */
export function bumpMessageCount(userId) {
  const key = Number(userId);
  const next = (messageCounters.get(key) || 0) + 1;
  messageCounters.set(key, next);
  return next;
}

/** 读取当前计数（不修改） */
export function peekMessageCount(userId) {
  return messageCounters.get(Number(userId)) || 0;
}

/** 计数归零（触发分析后调用） */
export function resetMessageCount(userId) {
  messageCounters.set(Number(userId), 0);
}

/* --------------------------------------------------------- 状态读写 */

/** 状态表的列 → 默认值（用户第一次跑时用） */
const STATE_DEFAULTS = {
  chat_score: BASE_SCORE,
  diary_score: BASE_SCORE,
  combined_score: BASE_SCORE,
  msg_count_since_analyze: 0,
  threshold: DEFAULT_THRESHOLD,
  popup_reject_count: 0,
  popup_enabled: 1,
  diary_enabled: 1,
};

/**
 * 取用户状态（没有就建一行）。
 * ⚠️ 任何异常都返回默认值而不是抛错 —— 压力评估绝不能拖垮聊天。
 */
export async function getStressState(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return { user_id: 0, ...STATE_DEFAULTS };

  try {
    const rows = await query("SELECT * FROM user_stress_state WHERE user_id = ? LIMIT 1", [id]);
    if (rows.length) {
      const row = rows[0];
      // 内存里的计数比库里的新（平时只累加在内存），走内存
      const memoryCount = peekMessageCount(id);
      if (memoryCount > Number(row.msg_count_since_analyze || 0)) {
        row.msg_count_since_analyze = memoryCount;
      }
      return row;
    }

    await execute(
      `INSERT INTO user_stress_state
         (user_id, chat_score, diary_score, combined_score, threshold, popup_enabled, diary_enabled)
       VALUES (?, ?, ?, ?, ?, 1, 1)
       ON DUPLICATE KEY UPDATE user_id = user_id`,
      [id, BASE_SCORE, BASE_SCORE, BASE_SCORE, DEFAULT_THRESHOLD]
    );

    return { user_id: id, ...STATE_DEFAULTS };
  } catch (err) {
    console.error("[stress] 读取状态失败：", err?.message || err);
    return { user_id: id, ...STATE_DEFAULTS };
  }
}

/**
 * 更新用户状态（只写传进来的字段）。
 * 用一个受控的白名单拼 SQL，避免把任意字段名塞进语句。
 */
const WRITABLE_COLUMNS = new Set([
  "chat_score",
  "diary_score",
  "combined_score",
  "msg_count_since_analyze",
  "last_analyze_at",
  "last_keyword_trigger_at",
  "keyword_cooldown_until",
  "last_popup_at",
  "popup_reject_count",
  "threshold",
  "popup_enabled",
  "diary_enabled",
]);

export async function updateStressState(userId, patch = {}) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return false;

  const columns = Object.keys(patch).filter((key) => WRITABLE_COLUMNS.has(key));
  if (!columns.length) return false;

  try {
    await execute(
      `INSERT INTO user_stress_state (user_id) VALUES (?)
       ON DUPLICATE KEY UPDATE user_id = user_id`,
      [id]
    );

    const assignments = columns.map((key) => `\`${key}\` = ?`).join(", ");
    const values = columns.map((key) => patch[key]);

    await execute(`UPDATE user_stress_state SET ${assignments} WHERE user_id = ?`, [...values, id]);
    return true;
  } catch (err) {
    console.error("[stress] 写状态失败：", err?.message || err);
    return false;
  }
}

/* ------------------------------------------------------------ 日志 */

/**
 * 记一条压力日志。
 * @param {{userId:number, source:"chat"|"diary", score:number, smoothed:number,
 *          localScore:number, llmScore?:number|null, crisis?:boolean, triggered?:boolean}} entry
 */
export async function saveStressLog(entry) {
  try {
    await execute(
      `INSERT INTO stress_logs
         (user_id, source, score, smoothed_score, local_score, llm_score, crisis, triggered)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(entry.userId),
        entry.source === "diary" ? "diary" : "chat",
        clampScore(entry.score),
        clampScore(entry.smoothed),
        clampScore(entry.localScore),
        entry.llmScore == null ? null : clampScore(entry.llmScore),
        entry.crisis ? 1 : 0,
        entry.triggered ? 1 : 0,
      ]
    );
    return true;
  } catch (err) {
    console.error("[stress] 写日志失败：", err?.message || err);
    return false;
  }
}

/** 取最近 n 条（默认 20）用于趋势展示 */
export async function recentScores(userId, limit = 20) {
  const id = Number(userId);
  const size = Math.max(1, Math.min(Number(limit) || 20, 100));

  try {
    const rows = await query(
      `SELECT score, smoothed_score, source, crisis, created_at
         FROM stress_logs
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT ${size}`,
      [id]
    );
    return rows.reverse();
  } catch {
    return [];
  }
}

/** 取最近 n 次的最终分（用于"连续 2 次都超阈值"的判断） */
export async function recentFinalScores(userId, limit = 3) {
  const rows = await recentScores(userId, limit);
  return rows.map((row) => Number(row.smoothed_score ?? row.score ?? BASE_SCORE));
}
