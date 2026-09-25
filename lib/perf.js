/**
 * 接口耗时统计：按请求路径累计，供后台「运行指标」展示。
 *
 * 和 lib/db.js 里的 SQL 耗时统计分工不同：
 *   * `lib/db.js` 看的是"数据库慢不慢"；
 *   * 这里看的是"哪个接口慢" —— 包含 AI 调用、图片处理等非数据库开销。
 *
 * 用法（在 route 里包一层，不用改任何业务逻辑）：
 *
 *   import { withTiming } from "@/lib/perf";
 *
 *   export async function POST(request) {
 *     return withTiming("/api/chat", async () => {
 *       ...原有处理...
 *     });
 *   }
 *
 * 状态存在内存里，重启清零 —— 看的是"最近这段时间"的情况。
 */
import { sanitizeLog } from "./log-sanitize";

/** 超过这个耗时就在日志里提一句（前端能感知到的卡顿大致从这里开始） */
const SLOW_API_MS = 1500;
const MAX_PATHS = 100;

const stats = new Map(); // path -> { count, totalMs, maxMs, failures, slow, since }
let startedAt = Date.now();

export async function withTiming(path, fn) {
  const name = String(path || "unknown").slice(0, 120);
  const startedAt2 = Date.now();

  let bucket = stats.get(name);
  if (!bucket) {
    if (stats.size >= MAX_PATHS) {
      // 防止被随机路径刷爆内存：满了就不再新增，直接放行
      return fn();
    }
    bucket = { count: 0, totalMs: 0, maxMs: 0, failures: 0, slow: 0 };
    stats.set(name, bucket);
  }

  try {
    const result = await fn();
    const cost = Date.now() - startedAt2;
    bucket.count += 1;
    bucket.totalMs += cost;
    if (cost > bucket.maxMs) bucket.maxMs = cost;
    if (cost >= SLOW_API_MS) {
      bucket.slow += 1;
      console.warn(`[perf] 慢接口 ${cost}ms：${sanitizeLog(name)}`);
    }
    return result;
  } catch (err) {
    const cost = Date.now() - startedAt2;
    bucket.count += 1;
    bucket.totalMs += cost;
    bucket.failures += 1;
    if (cost > bucket.maxMs) bucket.maxMs = cost;
    throw err;
  }
}

export function getApiStats() {
  const list = [...stats.entries()]
    .map(([path, item]) => ({
      path,
      count: item.count,
      avgMs: item.count ? Math.round((item.totalMs / item.count) * 10) / 10 : 0,
      maxMs: item.maxMs,
      failures: item.failures,
      slow: item.slow,
    }))
    // 按平均耗时倒序：最慢的排在前面，一眼看到瓶颈
    .sort((a, b) => b.avgMs - a.avgMs);

  return {
    windowMinutes: Math.max(1, Math.round((Date.now() - startedAt) / 60000)),
    slowThresholdMs: SLOW_API_MS,
    paths: list,
    totalRequests: list.reduce((sum, item) => sum + item.count, 0),
  };
}

export function resetApiStats() {
  stats.clear();
  startedAt = Date.now();
}
