/**
 * 用户端「账号 + 密码」登录（与邮箱验证码登录并存）。
 * 密码在库里是 lib/secret-box.js 的可逆加密，这里解密后做定长比较。
 * 被管理员禁用的账号（status=0）不能登录。
 */
import { describeDbError, query } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { decryptText } from "@/lib/secret-box";
import {
  USER_COOKIE,
  cleanupExpiredUserSessions,
  createUserSession,
  userCookieOptions,
} from "@/lib/user-auth";
import {
  buildCookie,
  cleanString,
  clientIp,
  json,
  jsonError,
  readJsonBody,
  safeEqualText,
} from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const body = await readJsonBody(request);
  const account = cleanString(body.account, 190);
  const password = typeof body.password === "string" ? body.password : "";

  if (!account || !password) return jsonError("请填写账号和密码", 400);

  // 防爆破：按 IP 一层 + 按账号一层（同一账号被反复试密码时能更早拦住）
  const ipQuota = rateLimit(`user-login:ip:${clientIp(request) || "direct"}`, {
    limit: 20,
    windowMs: 10 * 60 * 1000,
  });
  const accountQuota = rateLimit(`user-login:acct:${account.toLowerCase()}`, {
    limit: 8,
    windowMs: 10 * 60 * 1000,
  });
  const quota = ipQuota.ok ? accountQuota : ipQuota;
  if (!quota.ok) {
    return jsonError(`尝试过于频繁，请 ${quota.retryAfterSeconds} 秒后再试`, 429);
  }

  try {
    const rows = await query(
      "SELECT id, email, account, username, avatar_url, password_enc, status FROM users WHERE account = ? OR email = ? LIMIT 1",
      [account, account.toLowerCase()]
    );

    const user = rows[0];
    const stored = user ? decryptText(user.password_enc) : "";

    // 账号不存在、没设密码、密码不对，都走同一个提示（避免被用来探测账号是否存在）
    const passwordOk = Boolean(user) && stored !== "" && safeEqualText(password, stored);
    if (!passwordOk) {
      return jsonError("账号或密码不正确", 401);
    }

    if (Number(user.status) !== 1) {
      return jsonError("该账号已被管理员禁用", 403);
    }

    const { token } = await createUserSession(user.id, {
      ip: clientIp(request),
      userAgent: request.headers.get("user-agent") || "",
    });
    await cleanupExpiredUserSessions();

    return json(
      {
        ok: true,
        user: { id: user.id, email: user.email, username: user.username || "" },
      },
      200,
      { "Set-Cookie": buildCookie(USER_COOKIE, token, userCookieOptions(request)) }
    );
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
