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

  return { token, expiresAt };
}

export async function findUserSession(token) {
  if (!token) return null;

  const rows = await query(
    `SELECT s.user_id, s.expires_at, u.email, u.username, u.avatar_url, u.status
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
      LIMIT 1`,
    [hashToken(token)]
  );
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

  return {
    id: row.user_id,
    email: row.email,
    username: row.username || "",
    avatarUrl: row.avatar_url || "",
  };
}

export async function deleteUserSession(token) {
  if (!token) return;
  await execute("DELETE FROM user_sessions WHERE token_hash = ?", [hashToken(token)]);
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
