/**
 * 找回密码：校验重置验证码并设置新密码。
 * 用户密码沿用 lib/secret-box.js 的 AES 可逆加密写入 password_enc，
 * 与「账号密码登录」路由的解密逻辑保持一致（bcrypt 仅用于管理员）。
 */
import { describeDbError, execute, query } from "@/lib/db";
import { verifyEmailCode } from "@/lib/mailer";
import { rateLimit } from "@/lib/rate-limit";
import { encryptText } from "@/lib/secret-box";
import { cleanString, clientIp, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request) {
  const body = await readJsonBody(request);
  const email = cleanString(body.email, 190).toLowerCase();
  const code = cleanString(body.code, 12);
  const password = typeof body.password === "string" ? body.password : "";

  if (!EMAIL_PATTERN.test(email)) {
    return jsonError("请填写正确的邮箱地址", 400);
  }
  if (!/^\d{4,8}$/.test(code)) {
    return jsonError("请输入收到的验证码", 400);
  }
  if (password.length < 6) {
    return jsonError("新密码至少需要 6 位", 400);
  }
  if (password.length > 100) {
    return jsonError("密码过长，请重新设置", 400);
  }

  const quota = rateLimit(`reset-pw:${clientIp(request) || "direct"}`, {
    limit: 20,
    windowMs: 10 * 60 * 1000,
  });
  if (!quota.ok) {
    return jsonError(`尝试过于频繁，请 ${quota.retryAfterSeconds} 秒后再试`, 429);
  }

  try {
    // 验证码校验：通过即作废，错误次数过多会被 mailer 拦住
    const check = await verifyEmailCode({ email, code, purpose: "reset" });
    if (!check.ok) {
      return jsonError(check.error, 400);
    }

    const rows = await query("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
    if (!rows.length) {
      return jsonError("该邮箱尚未注册", 404);
    }

    // AES 加密后写 password_enc，密码登录路由可直接解密比对
    const encrypted = encryptText(password);
    await execute("UPDATE users SET password_enc = ? WHERE id = ?", [
      encrypted,
      rows[0].id,
    ]);

    return json({ ok: true, message: "密码已重置，请用新密码登录" });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
