/**
 * 用户端（聊天页）的登录会话，替代原来的 Supabase Auth。
 *
 * 登录方式：邮箱验证码（验证码的生成与校验在 lib/mailer.js，后台「邮箱」页面里配置 SMTP）。
 * 首次验证通过会自动创建账号，所以「注册」和「登录」是同一个流程。
 *
 * 设计要点：
 *   * 浏览器只存随机 token，数据库存它的 sha256；
 *   * 会话默认 30 天，过期自动失效；
 *   * 所有 user_* 数据接口都必须通过 getCurrentUser() 拿到当前用户，
 *     并在 SQL 里带上 user_id 条件（这是替代 Supabase RLS 的关键）。
 */
import crypto from "node:crypto";
import { execute, query } from "./db";
import { cleanString, parseMysqlDateTime, toMysqlDateTime } from "./util";

export const USER_COOKIE = "solace_user";
export const USER_SESSION_DAYS = 30;

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase().slice(0, 190);
}

/** 按邮箱查用户，没有就创建一个（首次登录即注册） */
export async function findOrCreateUser(email) {
  const normalized = normalizeEmail(email);
  const now = toMysqlDateTime(new Date());

  const rows = await query(
    "SELECT id, email, username, avatar_url, status FROM users WHERE email = ? LIMIT 1",
    [normalized]
  );

  if (rows.length) {
    await execute("UPDATE users SET last_login_at = ? WHERE id = ?", [now, rows[0].id]);
    return { user: rows[0], created: false };
  }

  try {
    const result = await execute(
      "INSERT INTO users (email, last_login_at) VALUES (?, ?)",
      [normalized, now]
    );

    return {
      user: { id: result.insertId, email: normalized, username: null, avatar_url: null, status: 1 },
      created: true,
    };
  } catch (err) {
    // 同一邮箱并发首次登录时，可能两个请求同时走到 INSERT，
    // 后一个会撞唯一索引；此时回头查一次即可，不算错误
    if (err?.code === "ER_DUP_ENTRY") {
      const again = await query(
        "SELECT id, email, username, avatar_url, status FROM users WHERE email = ? LIMIT 1",
        [normalized]
      );
      if (again.length) return { user: again[0], created: false };
    }
    throw err;
  }
}

export async function createUserSession(userId, { ip = "", userAgent = "" } = {}) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + USER_SESSION_DAYS * 24 * 3600 * 1000);

  await execute(
    "INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)",
    [
      hashToken(token),
      userId,
      cleanString(ip, 45),
      cleanString(userAgent, 255),
      toMysqlDateTime(expiresAt),
    ]
  );

  // 登录生成新会话时无条件同步更新最后登录时间（覆盖密码登录、验证码登录等所有途径）
  try {
    await execute("UPDATE users SET last_login_at = ? WHERE id = ?", [
      toMysqlDateTime(new Date()),
      userId,
    ]);
  } catch {
    /* 忽略更新失败，不阻断登录流程 */
  }

  return { token, expiresAt };
}

// 上次记录时间记录（内存节流）：userId -> 上次写库时间戳
const lastLoginTouchMap = new Map();
const LOGIN_TOUCH_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟节流

/**
 * 活跃会话触碰：在用户访问 session 接口或聊天时，定期刷新最后登录时间
 */
export async function touchUserLastLogin(userId) {
  if (!userId) return;
  const uid = Number(userId);
  if (!uid) return;
  const now = Date.now();
  const last = lastLoginTouchMap.get(uid) || 0;
  if (now - last < LOGIN_TOUCH_INTERVAL_MS) return;

  lastLoginTouchMap.set(uid, now);
  if (lastLoginTouchMap.size > 2000) {
    const oldestKey = lastLoginTouchMap.keys().next().value;
    lastLoginTouchMap.delete(oldestKey);
  }

  try {
    await execute("UPDATE users SET last_login_at = ? WHERE id = ?", [
      toMysqlDateTime(new Date(now)),
      uid,
    ]);
  } catch {
    /* 静默失败，不影响主流程 */
  }

}

// ---------------------------------------------------------------------------
// 会话短缓存
//
// 为什么需要：getCurrentUser() 是几乎所有 user_* 接口的第一句话，而线上库在
// 远端（单次往返 500~900ms）。聊天页一次加载会并发 5~6 个接口 —— 同一个 token
// 会被查 5~6 次，全都串行地等远端库。这里按 token_hash 缓存 30 秒，
// 把这块往返直接省掉（实测这是那批慢查询里出现次数最多的那条）。
//
// ⚠️ 过期时间特意很短（30 秒），因为「退出登录 / 禁用账号 / 改邮箱」必须尽快生效。
//    能主动失效的地方都要显式调用 invalidateUserSessionCache()，
//    不要把正确性全押在这 30 秒上。
// ---------------------------------------------------------------------------
const SESSION_CACHE_TTL_MS = 30 * 1000;
const SESSION_CACHE_LIMIT = 500;
const sessionCache = new Map(); // token_hash -> { user, userId, expiresAtMs, cachedAt }

function readSessionCache(hash) {
  const hit = sessionCache.get(hash);
  if (!hit) return null;
  // 两重过期：缓存自身的 TTL + 会话本身的过期时间
  if (hit.cachedAt + SESSION_CACHE_TTL_MS <= Date.now() || hit.expiresAtMs <= Date.now()) {
    sessionCache.delete(hash);
    return null;
  }
  return hit;
}

function writeSessionCache(hash, user, expiresAtMs) {
  // 容量兜底：满了先丢最早插入的那条（Map 保持插入顺序）
  if (sessionCache.size >= SESSION_CACHE_LIMIT) {
    const oldest = sessionCache.keys().next().value;
    sessionCache.delete(oldest);
  }
  sessionCache.set(hash, { user, userId: user.id, expiresAtMs, cachedAt: Date.now() });
}

/** 让某个用户的会话缓存全部失效（退出登录 / 改邮箱 / 后台禁用时调用） */
export function invalidateUserSessionCache(userId) {
  const target = Number(userId);
  for (const [hash, hit] of sessionCache) {
    if (hit.userId === target) sessionCache.delete(hash);
  }
}

export async function findUserSession(token) {
  if (!token) return null;
  const hash = hashToken(token);

  const cached = readSessionCache(hash);
  if (cached) return { ...cached.user };

  // 一次把会话、基本资料和 AI 人格偏好都取回来：
  // /api/chat 每次都要用到 ai_persona，单独再查一次等于白白多一次数据库往返。
  // ⚠️ 老库可能还没补上 ai_persona 列，那种情况退回不带它的查询 ——
  //    否则一次查询失败会让所有用户被判定为"未登录"。
  let rows;
  try {
    rows = await query(
      `SELECT s.user_id, s.expires_at,
              u.email, u.username, u.avatar_url, u.status, u.ai_persona, u.tts_dialect
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?
        LIMIT 1`,
      [hash]
    );
  } catch {
    rows = await query(
      `SELECT s.user_id, s.expires_at, u.email, u.username, u.avatar_url, u.status
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?
        LIMIT 1`,
      [hash]
    );
  }
  if (!rows.length) return null;

  const row = rows[0];
  const expiresAt = parseMysqlDateTime(row.expires_at);
  if (!expiresAt || expiresAt.getTime() <= Date.now()) {
    await deleteUserSession(token);
    return null;
  }

  // 被管理员禁用的账号立刻失效（顺手把这条会话删掉，别让它白占位置）
  if (Number(row.status) !== 1) {
    await deleteUserSession(token);
    return null;
  }

  const user = {
    id: row.user_id,
    email: row.email,
    username: row.username || "",
    avatarUrl: row.avatar_url || "",
    aiPersona: String(row.ai_persona || "").trim().toLowerCase(),
    ttsDialect: String(row.tts_dialect || "").trim(),
  };
  writeSessionCache(hash, user, expiresAt.getTime());
  // 返回副本，防止调用方改到缓存里的对象
  return { ...user };
}

export async function deleteUserSession(token) {
  if (!token) return;
  const hash = hashToken(token);
  sessionCache.delete(hash);
  await execute("DELETE FROM user_sessions WHERE token_hash = ?", [hash]);
}

export async function cleanupExpiredUserSessions() {
  try {
    await execute("DELETE FROM user_sessions WHERE expires_at < ?", [
      toMysqlDateTime(new Date()),
    ]);
  } catch {
    /* 清理失败不影响登录 */
  }
}

/** 当前登录用户；未登录返回 null */
export async function getCurrentUser(request) {
  const token = request?.cookies?.get?.(USER_COOKIE)?.value;
  if (!token) return null;
  try {
    return await findUserSession(token);
  } catch {
    return null;
  }
}

/** cookie 选项：跟随实际协议，纯 HTTP 访问（如 http://IP:3000）也能登录 */
export function userCookieOptions(request) {
  const forwardedProto = request?.headers?.get?.("x-forwarded-proto") || "";
  const protocol = forwardedProto
    ? forwardedProto.split(",")[0].trim()
    : String(request?.url || "").startsWith("https://")
      ? "https"
      : "http";

  return {
    httpOnly: true,
    sameSite: "lax",
    secure: protocol === "https",
    path: "/",
    maxAge: USER_SESSION_DAYS * 24 * 3600,
  };
}
