/**
 * 首屏数据缓存层：把接口数据持久化到 localStorage，刷新后先渲染旧数据再静默换新。
 *
 * 为什么需要它：
 *   远端 MySQL 单次跨公网往返 150~350ms，而每个接口都要先查 user_sessions
 *   再查业务表（两次往返），所以首屏几个接口合计要 1~3 秒。缓存让刷新和切 tab
 *   的"感知延迟"接近 0，网络只是后台把数据刷新一下。
 *
 * 设计取舍：
 *   * 不设过期时间 —— 永远先用旧数据渲染，拉到新的再覆盖。数据陈旧只是"短暂看到旧的"，
 *     比"白屏等 1 秒"体验好；真实数据始终以服务端返回为准。
 *   * 读失败一律静默返回 null（JSON 损坏、隐私模式禁用 localStorage、配额满），
 *     缓存只是加速手段，任何异常都不应影响功能。
 *   * 超过 SIZE_LIMIT 的数据不写（消息索引最多 2000 条，重用户可能很大），
 *     避免把 localStorage 撑爆导致后续所有写入失败。
 *
 * key 规范：solace_cache_{userId}_{dataType}
 *   dataType: profile | conversations | diaries | message-index | memories
 * 带 userId 是为了同一浏览器切换账号时不串数据。
 */

const PREFIX = "solace_cache_";
/** 记录"上次登录的是谁"，让刷新时能在 session 返回前就知道该读哪份缓存 */
const ACTIVE_USER_KEY = "solace_cache_active_user";
/** 单条缓存体积上限（约 1MB）：超过就不写，避免撑爆 localStorage 配额 */
const SIZE_LIMIT = 1024 * 1024;

/** 拼缓存 key。dataType 见文件头注释 */
export function cacheKeyOf(userId, dataType) {
  return `${PREFIX}${userId}_${dataType}`;
}

/**
 * 读缓存。命中返回当初写入的 data，未命中/解析失败/存储不可用都返回 null。
 * 同步函数 —— 首屏要在第一次渲染前就把旧数据拿出来，不能有 await。
 */
export function readCache(key) {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed.data ?? null;
  } catch {
    return null;
  }
}

/** 写缓存：存 { data, ts }。失败静默忽略（配额满、隐私模式等） */
export function writeCache(key, data) {
  if (typeof window === "undefined") return;
  try {
    const raw = JSON.stringify({ data, ts: Date.now() });
    if (raw.length > SIZE_LIMIT) return;
    localStorage.setItem(key, raw);
  } catch {
    // 写不进去只影响加速效果，不影响功能
  }
}

/** 清掉某个用户的全部缓存（退出登录时调用），不动别人的 */
export function clearUserCache(userId) {
  if (typeof window === "undefined" || userId == null) return;
  const prefix = `${PREFIX}${userId}_`;
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    // 存储不可用时无需清理
  }
}

/** 清掉所有用户的缓存（仅用于排障，正常流程请用 clearUserCache） */
export function clearAllCache() {
  if (typeof window === "undefined") return;
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    // 同上
  }
}

/**
 * 记住"当前登录用户"，刷新时靠它在 session 请求返回前就知道该读谁的缓存 ——
 * 否则首屏要等 session（约 450ms）才知道 userId，缓存就失去了"零等待"的意义。
 */
export function rememberActiveUser(userId) {
  if (typeof window === "undefined" || userId == null) return;
  try {
    localStorage.setItem(ACTIVE_USER_KEY, String(userId));
  } catch {
    // 忽略
  }
}

/** 读上次登录的用户 id，没有返回 null */
export function readActiveUser() {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(ACTIVE_USER_KEY);
  } catch {
    return null;
  }
}

/** 清掉"上次登录用户"标记（退出登录时调用） */
export function forgetActiveUser() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(ACTIVE_USER_KEY);
  } catch {
    // 忽略
  }
}
