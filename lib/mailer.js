/**
 * 邮件发送（网易 163 / 126 邮箱 SMTP）与邮箱验证码。
 *
 * 网易邮箱要点（后台「邮箱」页面里也有提示）：
 *   * 密码要填「SMTP 授权码」，不是邮箱登录密码；在
 *     163 邮箱 → 设置 → POP3/SMTP/IMAP 里开启服务后获取；
 *   * 发信服务器 smtp.163.com / smtp.126.com，SSL 端口 465；
 *   * 发件人邮箱必须和登录邮箱一致，否则会报 553。
 *
 * 本轮后台「发送测试邮件」直接用这里的代码；下一轮用户端
 * 「邮箱验证码登录」也复用 issueEmailCode / verifyEmailCode。
 */
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { query, execute } from "./db";
import { getGroup } from "./settings";
import { safeEqualHex, toMysqlDateTime } from "./util";

const CODE_SECRET = process.env.CODE_SECRET || "solace-email-code-secret";
const MAX_CODE_ATTEMPTS = 5;

export function describeMailError(err) {
  const code = err?.code ? String(err.code) : "";
  const message = err?.message ? String(err.message) : String(err);
  const hints = {
    EAUTH: "认证失败：网易邮箱这里要填 SMTP 授权码，不是登录密码",
    ECONNECTION: "无法连接 SMTP 服务器：检查端口（SSL 用 465）和服务器防火墙",
    ETIMEDOUT: "连接 SMTP 超时：检查服务器出网是否被限制 465 端口",
    ESOCKET: "SMTP 连接被中断：确认端口与加密方式匹配（465=SSL，587=STARTTLS）",
    EENVELOPE: "发件人或收件人被拒绝：网易要求发件人与登录账号一致",
  };
  const hint = hints[code];
  return hint ? `${message}（${hint}）` : message;
}

export function createTransport(smtpConfig) {
  return nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure === true,
    auth: {
      user: smtpConfig.user,
      pass: smtpConfig.password,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

function fromAddress(smtpConfig) {
  const email = smtpConfig.fromEmail || smtpConfig.user;
  const name = smtpConfig.fromName || "Solace";
  return name ? `"${name}" <${email}>` : email;
}

/** 底层发信：调用方保证 smtpConfig 已填齐 */
export async function sendMail(smtpConfig, { to, subject, text, html }) {
  if (smtpConfig.enabled !== true) {
    throw new Error("邮件发送未启用，请先在后台「邮箱」页面开启并保存");
  }
  if (!smtpConfig.host || !smtpConfig.user || !smtpConfig.password) {
    throw new Error("SMTP 配置不完整，请先在后台「邮箱」页面填写服务器、发信邮箱和授权码");
  }

  const transport = createTransport(smtpConfig);
  try {
    const info = await transport.sendMail({
      from: fromAddress(smtpConfig),
      to,
      subject,
      text,
      html,
    });
    return { messageId: info.messageId, accepted: info.accepted || [] };
  } finally {
    transport.close();
  }
}

/** 后台「发送测试邮件」用的内容 */
export async function sendTestMail(to) {
  const smtpConfig = await getGroup("smtp");
  const siteConfig = await getGroup("site");
  const now = new Date();
  const text =
    `这是一封来自 ${siteConfig.siteName || "Solace"} 的测试邮件。\n\n` +
    `如果你收到了它，说明后台的 SMTP 配置已经可用，可以用于发送登录验证码。\n` +
    `服务器时间：${toMysqlDateTime(now)}\n` +
    `发信服务器：${smtpConfig.host}:${smtpConfig.port}（${smtpConfig.secure ? "SSL" : "STARTTLS/明文"}）\n`;

  const html = `
    <div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-size:14px;line-height:1.8;color:#334155">
      <p>这是一封来自 <strong>${escapeHtml(siteConfig.siteName || "Solace")}</strong> 的测试邮件。</p>
      <p>如果你收到了它，说明后台的 SMTP 配置已经可用，可以用于发送登录验证码。</p>
      <ul style="color:#64748b">
        <li>服务器时间：${escapeHtml(toMysqlDateTime(now))}</li>
        <li>发信服务器：${escapeHtml(smtpConfig.host)}:${smtpConfig.port}（${smtpConfig.secure ? "SSL" : "STARTTLS/明文"}）</li>
      </ul>
    </div>`;

  return sendMail(smtpConfig, {
    to,
    subject: `【${siteConfig.siteName || "Solace"}】SMTP 配置测试`,
    text,
    html,
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function generateCode(length = 6) {
  const size = Math.min(8, Math.max(4, Number(length) || 6));
  let code = "";
  for (let i = 0; i < size; i += 1) {
    code += String(crypto.randomInt(0, 10));
  }
  return code;
}

export function hashCode(email, code, purpose) {
  return crypto
    .createHash("sha256")
    .update(`${String(email).toLowerCase()}|${purpose}|${code}|${CODE_SECRET}`)
    .digest("hex");
}

/** 邮件正文模板：{code} {minutes} {siteName} 会被替换 */
export function buildCodeMail(code, loginConfig, siteConfig) {
  const minutes = Math.max(1, Math.round((Number(loginConfig.codeTtlSeconds) || 300) / 60));
  const siteName = siteConfig?.siteName || "Solace";
  const fill = (template) =>
    String(template || "")
      .replace(/\{code\}/g, code)
      .replace(/\{minutes\}/g, String(minutes))
      .replace(/\{siteName\}/g, siteName);

  const subject = fill(loginConfig.emailSubject || `【${siteName}】你的登录验证码`);
  const intro = fill(loginConfig.emailIntro || `你正在登录 ${siteName}，验证码 {minutes} 分钟内有效。`);

  const text = `${intro}\n\n验证码：${code}\n\n如果这不是你本人的操作，请忽略这封邮件。\n—— ${siteName}`;
  const html = `
    <div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-size:14px;line-height:1.8;color:#334155">
      <p>${escapeHtml(intro)}</p>
      <p style="font-size:28px;letter-spacing:6px;font-weight:700;color:#0f172a">${escapeHtml(code)}</p>
      <p style="color:#64748b">如果这不是你本人的操作，请忽略这封邮件。</p>
      <p style="color:#94a3b8">—— ${escapeHtml(siteName)}</p>
    </div>`;

  return { subject, text, html };
}

/**
 * 生成验证码、入库、发信。
 * 带发送冷却与单邮箱每日上限，避免被当成短信轰炸机。
 */
export async function issueEmailCode({ email, purpose = "login" }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const loginConfig = await getGroup("login");
  const smtpConfig = await getGroup("smtp");
  const siteConfig = await getGroup("site");

  const recent = await query(
    "SELECT created_at FROM email_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1",
    [normalizedEmail, purpose]
  );
  if (recent.length) {
    const lastSent = new Date(String(recent[0].created_at).replace(" ", "T"));
    const elapsed = (Date.now() - lastSent.getTime()) / 1000;
    const cooldown = Number(loginConfig.sendCooldownSeconds) || 0;
    if (elapsed < cooldown) {
      const wait = Math.ceil(cooldown - elapsed);
      const error = new Error(`发送太频繁，请 ${wait} 秒后再试`);
      error.code = "COOLDOWN";
      throw error;
    }
  }

  const todayRows = await query(
    "SELECT COUNT(*) AS total FROM email_codes WHERE email = ? AND purpose = ? AND created_at >= ?",
    [
      normalizedEmail,
      purpose,
      // 统一用 Node 时间，与写入 created_at 的口径保持一致
      toMysqlDateTime(new Date(Date.now() - 24 * 3600 * 1000)),
    ]
  );
  const dailyLimit = Number(loginConfig.dailyLimitPerEmail) || 10;
  if (Number(todayRows[0]?.total || 0) >= dailyLimit) {
    const error = new Error("该邮箱今日验证码发送次数已达上限");
    error.code = "DAILY_LIMIT";
    throw error;
  }

  const code = generateCode(loginConfig.codeLength);
  const ttl = Number(loginConfig.codeTtlSeconds) || 300;
  const expiresAt = new Date(Date.now() + ttl * 1000);

  // 先把邮件发出去，成功之后再入库：
  // 否则发信失败（比如 SMTP 没配好）也会留下一条记录，占掉每日额度、并把用户卡在冷却里
  const mail = buildCodeMail(code, loginConfig, siteConfig);
  await sendMail(smtpConfig, { to: normalizedEmail, ...mail });

  await execute(
    "INSERT INTO email_codes (email, code_hash, purpose, expires_at) VALUES (?, ?, ?, ?)",
    [normalizedEmail, hashCode(normalizedEmail, code, purpose), purpose, toMysqlDateTime(expiresAt)]
  );

  return {
    expiresInSeconds: ttl,
    cooldownSeconds: Number(loginConfig.sendCooldownSeconds) || 0,
  };
}

/** 校验验证码：用掉即作废，最多允许 5 次尝试 */
export async function verifyEmailCode({ email, code, purpose = "login" }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const rows = await query(
    "SELECT id, code_hash, attempts, expires_at FROM email_codes WHERE email = ? AND purpose = ? AND used = 0 ORDER BY id DESC LIMIT 1",
    [normalizedEmail, purpose]
  );
  if (!rows.length) return { ok: false, error: "验证码不存在或已使用，请重新获取" };

  const row = rows[0];
  const expiresAt = new Date(String(row.expires_at).replace(" ", "T"));
  if (expiresAt.getTime() < Date.now()) {
    return { ok: false, error: "验证码已过期，请重新获取" };
  }
  if (Number(row.attempts) >= MAX_CODE_ATTEMPTS) {
    return { ok: false, error: "尝试次数过多，请重新获取验证码" };
  }

  if (!safeEqualHex(row.code_hash, hashCode(normalizedEmail, code, purpose))) {
    await execute("UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?", [row.id]);
    return { ok: false, error: "验证码不正确" };
  }

  await execute("UPDATE email_codes SET used = 1 WHERE id = ?", [row.id]);
  return { ok: true };
}

/** 顺手清理过期验证码（可被定时任务调用） */
export async function cleanupExpiredCodes() {
  const result = await execute("DELETE FROM email_codes WHERE expires_at < ?", [
    toMysqlDateTime(new Date(Date.now() - 24 * 3600 * 1000)),
  ]);
  return result.affectedRows || 0;
}
