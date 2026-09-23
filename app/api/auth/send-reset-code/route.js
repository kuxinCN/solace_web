/**
 * 找回密码：发送重置验证码。
 * 与登录验证码隔离：purpose='reset'，固定 10 分钟有效、60 秒发送冷却，
 * 不读取/修改登录验证码的配置。发信仍走后台配置的 SMTP。
 */
import { describeDbError, query } from "@/lib/db";
import { describeMailError, issueEmailCode } from "@/lib/mailer";
import { rateLimit } from "@/lib/rate-limit";
import { cleanString, clientIp, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_TTL_SECONDS = 10 * 60; // 验证码 10 分钟内有效
const RESET_COOLDOWN_SECONDS = 60; // 同一邮箱 60 秒内只能发一次

export async function POST(request) {
  const body = await readJsonBody(request);
  const email = cleanString(body.email, 190).toLowerCase();

  if (!EMAIL_PATTERN.test(email)) {
    return jsonError("请填写正确的邮箱地址", 400);
  }

  // 按 IP 限流；lib/mailer.js 里还有按邮箱的冷却与每日上限，两层保护
  const quota = rateLimit(`send-reset:${clientIp(request) || "direct"}`, {
    limit: 10,
    windowMs: 10 * 60 * 1000,
  });
  if (!quota.ok) {
    return jsonError(`操作太频繁，请 ${quota.retryAfterSeconds} 秒后再试`, 429);
  }

  try {
    // 先确认邮箱已注册，避免给不存在的账号发信
    const rows = await query("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
    if (!rows.length) {
      return jsonError("该邮箱尚未注册，请确认后重试", 404);
    }

    const result = await issueEmailCode({
      email,
      purpose: "reset",
      ttlSeconds: RESET_TTL_SECONDS,
      cooldownSeconds: RESET_COOLDOWN_SECONDS,
      emailIntro:
        "你正在重置 {siteName} 的登录密码，验证码 {minutes} 分钟内有效。\n如果这不是你本人的操作，请忽略本邮件，你的密码不会被改变。",
      emailSubject: "【{siteName}】找回密码验证码",
    });

    return json({
      ok: true,
      message: `重置验证码已发送到 ${email}`,
      expiresInSeconds: result.expiresInSeconds,
      cooldownSeconds: result.cooldownSeconds,
    });
  } catch (err) {
    if (err?.code === "COOLDOWN" || err?.code === "DAILY_LIMIT") {
      return jsonError(err.message, 429);
    }
    if (err?.code && String(err.code).startsWith("ER_")) {
      return jsonError(describeDbError(err), 500);
    }
    return jsonError(describeMailError(err), 400);
  }
}
