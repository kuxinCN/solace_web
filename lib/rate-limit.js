/**
 * 进程内限流（够用、零依赖）。
 *
 * 用途：/api/chat 和 /api/tts 目前还没有登录鉴权，加一层按 IP 的限流，
 * 避免被别人当成免费代理刷爆 API 额度。下一轮接入用户登录后会再加按用户限流。
 *
 * 注意：状态存在进程内存里，所以后台只应单实例运行（见 DEPLOY.md）。
 */
const buckets = new Map();

const MAX_BUCKETS = 5000;
let lastSweepAt = 0;

function sweep(now) {
  if (now - lastSweepAt < 60 * 1000 && buckets.size < MAX_BUCKETS) return;
  lastSweepAt = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  // 极端情况下仍然过多时，丢掉最早的一批，防止内存无限增长
  if (buckets.size > MAX_BUCKETS) {
    const overflow = buckets.size - MAX_BUCKETS;
    let removed = 0;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (++removed >= overflow) break;
    }
  }
}

/**
 * @returns {{ ok: boolean, remaining: number, retryAfterSeconds: number }}
 */
export function rateLimit(key, { limit = 30, windowMs = 60 * 1000 } = {}) {
  const now = Date.now();
  sweep(now);

  const name = String(key || "unknown").slice(0, 100);
  const bucket = buckets.get(name);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(name, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  if (bucket.count >= limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  bucket.count += 1;
  return { ok: true, remaining: limit - bucket.count, retryAfterSeconds: 0 };
}
