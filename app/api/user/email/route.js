/**
 * 修改登录邮箱。
 * 邮箱是唯一登录凭据，改完之后会把该用户的所有登录会话清掉，
 * 前端会引导他用新邮箱重新登录（与原前端的体验一致）。
 */
import { describeDbError, execute } from "@/lib/db";
import { getCurrentUser } from "@/lib/user-auth";
import { cleanString, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function PUT(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const body = await readJsonBody(request);
  const email = cleanString(body.email, 190).toLowerCase();

  if (!EMAIL_PATTERN.test(email)) {
    return jsonError("请填写正确的邮箱地址", 400);
  }
  if (email === String(user.email).toLowerCase()) {
    return jsonError("新邮箱和当前邮箱一样", 400);
  }

  try {
    await execute("UPDATE users SET email = ? WHERE id = ?", [email, user.id]);
    // 邮箱变了，旧的登录凭据作废
    await execute("DELETE FROM user_sessions WHERE user_id = ?", [user.id]);

    return json({ ok: true, message: "邮箱已修改，请用新邮箱重新登录" });
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") {
      return jsonError("这个邮箱已经被其他账号使用了", 400);
    }
    return jsonError(describeDbError(err), 500);
  }
}
