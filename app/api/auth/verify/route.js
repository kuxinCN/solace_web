/**
 * 用户端登录：校验邮箱验证码。
 * 验证通过即登录；如果这个邮箱还没有账号，会自动创建（所以「注册」和「登录」是同一个入口）。
 */
import { verifyEmailCode } from "@/lib/mailer";
import { rateLimit } from "@/lib/rate-limit";
import {
  USER_COOKIE,
  cleanupExpiredUserSessions,
  createUserSession,
  findOrCreateUser,
  userCookieOptions,
} from "@/lib/user-auth";
import { buildCookie, cleanString, clientIp, json, jsonError, readJsonBody } from "@/lib/util";
import { describeDbError } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request) {
  const body = await readJsonBody(request);
  const email = cleanString(body.email, 190).toLowerCase();
  const code = cleanString(body.code, 12);

  if (!EMAIL_PATTERN.test(email)) {
    return jsonError("请填写正确的邮箱地址", 400);
  }
  if (!/^\d{4,8}$/.test(code)) {
    return jsonError("请输入收到的验证码", 400);
  }

  const quota = rateLimit(`verify-code:${clientIp(request) || "direct"}`, {
    limit: 30,
    windowMs: 10 * 60 * 1000,
  });
  if (!quota.ok) {
    return jsonError(`尝试过于频繁，请 ${quota.retryAfterSeconds} 秒后再试`, 429);
  }

  try {
    const check = await verifyEmailCode({ email, code, purpose: "login" });
    if (!check.ok) return jsonError(check.error, 400);

    const { user, created } = await findOrCreateUser(email);
    if (Number(user.status) !== 1) {
      return jsonError("该账号已被管理员禁用，请联系管理员", 403);
    }

    const { token } = await createUserSession(user.id, {
      ip: clientIp(request),
      userAgent: request.headers.get("user-agent") || "",
    });
    await cleanupExpiredUserSessions();

    return json(
      {
        ok: true,
        created,
        user: { id: user.id, email: user.email, username: user.username || "" },
      },
      200,
      { "Set-Cookie": buildCookie(USER_COOKIE, token, userCookieOptions(request)) }
    );
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
