/**
 * 修改密码（用户端）。
 * 前端是在已登录状态下改的，所以这里以登录会话为准；
 * 改完保持登录状态（和前端的预期一致）。
 */
import { describeDbError, execute } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { encryptText } from "@/lib/secret-box";
import { getCurrentUser } from "@/lib/user-auth";
import { json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 64;

export async function PUT(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  // 防止被拿来做撞库/滥用：按用户限流
  const quota = rateLimit(`change-password:${user.id}`, {
    limit: 10,
    windowMs: 10 * 60 * 1000,
  });
  if (!quota.ok) {
    return jsonError(`操作太频繁，请 ${quota.retryAfterSeconds} 秒后再试`, 429);
  }

  const body = await readJsonBody(request);
  const password = typeof body.password === "string" ? body.password : "";

  if (password.length < MIN_PASSWORD_LENGTH) {
    return jsonError(`新密码至少 ${MIN_PASSWORD_LENGTH} 位`, 400);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return jsonError(`密码太长了，请控制在 ${MAX_PASSWORD_LENGTH} 位以内`, 400);
  }

  try {
    await execute("UPDATE users SET password_enc = ? WHERE id = ?", [
      encryptText(password),
      user.id,
    ]);
    return json({ ok: true, message: "密码修改成功" });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
