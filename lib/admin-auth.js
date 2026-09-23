/**
 * 后台认证：账号 + 密码(bcrypt) + TOTP 动态验证码（微软/Google 验证器那种）。
 *
 * 设计要点：
 *   * 密码只存 bcrypt 哈希；
 *   * 动态验证码密钥只存服务端，前端只在「绑定」时显示一次二维码；
 *   * 浏览器只保存随机 token，数据库存 sha256(token)，被拖库也无法直接登录；
 *   * 连续 5 次失败锁定 10 分钟；
 *   * 所有敏感操作写 audit_logs。
 */
import crypto from "node:crypto";
import * as bcryptModule from "bcryptjs";
import { authenticator } from "otplib";
import { query, execute, describeDbError } from "./db";
import { clientIp, cleanString, parseMysqlDateTime, toMysqlDateTime } from "./util";

// bcryptjs v3 同时提供 ESM 与 CJS 两种产物，先包一层拿到真正的 API 对象
const bcrypt = bcryptModule?.hash
  ? bcryptModule
  : bcryptModule?.default?.hash
    ? bcryptModule.default
    : bcryptModule;

export const ADMIN_COOKIE = "solace_admin";
export const SETUP_COOKIE = "solace_admin_setup";
export const SESSION_TTL_HOURS = 8;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 10;

// 用于「账号不存在时也做一次哈希比较」，避免通过响应快慢猜出账号是否存在
const DUMMY_HASH =
  "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

// 允许前后各 30 秒的时间偏差，避免手机和服务器时间差导致验证码总是失败
authenticator.options = { window: 1 };

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function generateTotpSecret() {
  return authenticator.generateSecret();
}

export function buildOtpAuthUri(account, secret, siteName) {
  const issuer = `${siteName || "Solace"} 管理后台`;
  return authenticator.keyuri(String(account), issuer, secret);
}

export function verifyTotp(code, secret) {
  const token = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(token) || !secret) return false;
  try {
    return authenticator.check(token, secret, { window: 1 });
  } catch {
    return false;
  }
}

export function hashPassword(password) {
  return bcrypt.hash(String(password), 10);
}

export function comparePassword(password, hash) {
  return bcrypt.compare(String(password), String(hash));
}

/** 是否处于「还没初始化」状态 / 数据库是否可用 */
export async function getBootstrapState() {
  try {
    const rows = await query("SELECT COUNT(*) AS total FROM admin_users");
    const total = Number(rows[0]?.total ?? 0);
    return { dbReady: true, adminCount: total, needsSetup: total === 0, error: "" };
  } catch (err) {
    return {
      dbReady: false,
      adminCount: 0,
      needsSetup: false,
      error: describeDbError(err),
    };
  }
}

export async function createAdmin({ username, password, totpSecret }) {
  const name = cleanString(username, 64);
  const hash = await hashPassword(password);

  // 条件插入：只有「一个管理员都没有」时才能创建，避免初始化窗口被并发抢注
  const result = await execute(
    `INSERT INTO admin_users (username, password_hash, totp_secret)
     SELECT ?, ?, ? FROM DUAL
      WHERE NOT EXISTS (SELECT 1 FROM admin_users)`,
    [name, hash, totpSecret]
  );

  if (!result.affectedRows) {
    const error = new Error("管理员已存在，初始化通道已关闭");
    error.code = "ALREADY_INITIALIZED";
    throw error;
  }

  return { id: result.insertId, username: name };
}

/** 登录校验：返回 { ok, error, admin } */
export async function verifyAdminLogin({ username, password, code }) {
  const name = cleanString(username, 64);
  const rawPassword = typeof password === "string" ? password : "";
  const rawCode = cleanString(code, 12);

  if (!name || !rawPassword) return { ok: false, error: "请填写账号和密码" };
  if (!/^\d{6}$/.test(rawCode)) return { ok: false, error: "请填写 6 位动态验证码" };

  const rows = await query(
    "SELECT id, username, password_hash, totp_secret, failed_attempts, locked_until FROM admin_users WHERE username = ? LIMIT 1",
    [name]
  );
  const admin = rows[0];

  if (admin?.locked_until) {
    const lockedUntil = parseMysqlDateTime(admin.locked_until);
    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      const minutes = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 60000));
      return { ok: false, error: `连续失败次数过多，账号已锁定，请 ${minutes} 分钟后再试` };
    }
  }

  const passwordOk = await comparePassword(rawPassword, admin?.password_hash || DUMMY_HASH);
  if (!admin || !passwordOk) {
    if (admin) await recordFailure(admin);
    return { ok: false, error: "账号或密码不正确" };
  }

  if (!verifyTotp(rawCode, admin.totp_secret)) {
    await recordFailure(admin);
    return { ok: false, error: "动态验证码不正确（验证器时间需与服务器同步）" };
  }

  await execute(
    "UPDATE admin_users SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = ?",
    [admin.id]
  );

  return { ok: true, admin: { id: admin.id, username: admin.username } };
}

async function recordFailure(admin) {
  const failed = Number(admin.failed_attempts || 0) + 1;
  if (failed >= MAX_FAILED_ATTEMPTS) {
    await execute(
      "UPDATE admin_users SET failed_attempts = 0, locked_until = ? WHERE id = ?",
      [toMysqlDateTime(new Date(Date.now() + LOCK_MINUTES * 60 * 1000)), admin.id]
    );
  } else {
    await execute("UPDATE admin_users SET failed_attempts = ? WHERE id = ?", [failed, admin.id]);
  }
}

export async function createSession(adminId, { ip = "", userAgent = "" } = {}) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);
  await execute(
    "INSERT INTO admin_sessions (token_hash, admin_id, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)",
    [hashToken(token), adminId, cleanString(ip, 45), cleanString(userAgent, 255), toMysqlDateTime(expiresAt)]
  );
  return { token, expiresAt };
}

export async function findSession(token) {
  if (!token) return null;
  const rows = await query(
    `SELECT s.admin_id, s.expires_at, a.username
       FROM admin_sessions s
       JOIN admin_users a ON a.id = s.admin_id
      WHERE s.token_hash = ?
      LIMIT 1`,
    [hashToken(token)]
  );
  if (!rows.length) return null;

  const row = rows[0];
  const expiresAt = parseMysqlDateTime(row.expires_at);
  if (!expiresAt || expiresAt.getTime() <= Date.now()) {
    await deleteSession(token);
    return null;
  }
  return { adminId: row.admin_id, username: row.username, expiresAt };
}

export async function deleteSession(token) {
  if (!token) return;
  await execute("DELETE FROM admin_sessions WHERE token_hash = ?", [hashToken(token)]);
}

export async function cleanupExpiredSessions() {
  try {
    // 统一用 Node 的时间做比较：写入会话过期时间时用的也是 Node 时间，
    // 避免 Node 与 MySQL 时区不同导致会话"莫名失效"
    await execute("DELETE FROM admin_sessions WHERE expires_at < ?", [
      toMysqlDateTime(new Date()),
    ]);
  } catch {
    /* 清理失败不影响登录 */
  }
}

/** 根据请求里的 cookie 取出当前登录管理员；未登录返回 null */
export async function getAdminFromRequest(request) {
  const token = request?.cookies?.get?.(ADMIN_COOKIE)?.value;
  if (!token) return null;
  try {
    return await findSession(token);
  } catch {
    return null;
  }
}

/** cookie 选项：跟着实际协议走，纯 HTTP 访问（如 http://IP:3000）也能登录 */
export function adminCookieOptions(request) {
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
    maxAge: SESSION_TTL_HOURS * 3600,
  };
}

export async function logAudit({ adminId = null, username = "", action, detail = "", ip = "" }) {
  try {
    await execute(
      "INSERT INTO audit_logs (admin_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)",
      [
        adminId,
        cleanString(username, 64),
        cleanString(action, 48),
        cleanString(detail, 2000),
        cleanString(ip || "", 45),
      ]
    );
  } catch {
    /* 写日志失败不影响业务 */
  }
}

export async function listAuditLogs(limit = 50) {
  // limit 已被强制成整数，直接拼接；避免 mysql2 预处理语句对 LIMIT ? 的兼容问题
  const size = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)));
  return query(
    `SELECT id, admin_id, username, action, detail, ip, created_at
       FROM audit_logs ORDER BY id DESC LIMIT ${size}`
  );
}

export { clientIp };
