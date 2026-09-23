/**
 * 用户端登录：发送邮箱验证码。
 * 验证码规则（位数 / 有效期 / 发送冷却 / 每日上限）在后台「邮箱 / 验证码」页面配置，
 * 发信走后台配置的网易 SMTP。
 */
import { describeDbError } from "@/lib/db";
import { describeMailError, issueEmailCode } from "@/lib/mailer";
import { rateLimit } from "@/lib/rate-limit";
import { cleanString, clientIp, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request) {
  const body = await readJsonBody(request);
  const email = cleanString(body.email, 190).toLowerCase();

  if (!EMAIL_PATTERN.test(email)) {
    return jsonError("请填写正确的邮箱地址", 400);
  }

  // 按 IP 限流；lib/mailer.js 里还有按邮箱的冷却与每日上限，两层保护
  const quota = rateLimit(`send-code:${clientIp(request) || "direct"}`, {
    limit: 10,
    windowMs: 10 * 60 * 1000,
  });
  if (!quota.ok) {
    return jsonError(`操作太频繁，请 ${quota.retryAfterSeconds} 秒后再试`, 429);
  }

  try {
    const result = await issueEmailCode({ email, purpose: "login" });
    return json({
      ok: true,
      message: `验证码已发送到 ${email}`,
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
