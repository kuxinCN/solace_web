/**
 * 长期记忆 · 观测指标（按「用户 × 天」聚合）
 *
 * 为什么是聚合表而不是明细表：
 *   注入端每次聊天都会统计一次，写明细等于每轮多一行、几个月就是几十万行；
 *   我们真正想看的是"每天注入了多少条 / 平均几条 / 压缩了几次"。
 *
 * ⚠️ 全部 **fire-and-forget**：统计失败绝不能拖慢聊天首字，也不能影响记忆写入。
 */
import { execute } from "./db.js";

const TABLE = "memory_stats_daily";

/**
 * 记录一次记忆注入（每次聊天调用一次）。
 * @param {number} userId
 * @param {number} facts 实际注入的记忆条数（0 也算一次"没命中"）
 * @param {number} chars 注入内容的字符数
 */
export function recordInjection(userId, facts, chars) {
  const n = Math.max(0, Number(facts) || 0);
  const c = Math.max(0, Number(chars) || 0);
  return execute(
    `INSERT INTO ${TABLE}
       (user_id, stat_date, inject_requests, inject_facts, inject_chars)
     VALUES (?, CURDATE(), 1, ?, ?)
     ON DUPLICATE KEY UPDATE
       inject_requests = inject_requests + 1,
       inject_facts = inject_facts + VALUES(inject_facts),
       inject_chars = inject_chars + VALUES(inject_chars)`,
    [userId, n, c]
  ).catch(() => {});
}

/**
 * 记录一次压缩结果。
 * @param {number} userId
 * @param {number} rows 本次被标记失效的条数
 */
export function recordCompaction(userId, rows) {
  const n = Math.max(0, Number(rows) || 0);
  return execute(
    `INSERT INTO ${TABLE}
       (user_id, stat_date, compact_runs, compacted_rows)
     VALUES (?, CURDATE(), 1, ?)
     ON DUPLICATE KEY UPDATE
       compact_runs = compact_runs + 1,
       compacted_rows = compacted_rows + VALUES(compacted_rows)`,
    [userId, n]
  ).catch(() => {});
}
