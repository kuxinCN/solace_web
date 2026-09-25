/**
 * 修改密码（用户端「我的 → 设置」）
 *
 * 安全要求（按产品要求，改之前先看）：
 *   ① 必须提供**原密码** —— 防止别人趁你没锁屏就把密码改了
 *   ② 必须通过**绑定邮箱验证码**（purpose='reset'，和找回密码共用一套规则）
 *   ③ 新密码两次输入一致、长度合规
 *   三条全满足才允许修改；任何一条不对都直接拒绝。
 *
 * 密码本身是可逆加密存的（lib/secret-box.js），所以原密码可以取出来比对 ——
 * 这也是"后台能看用户密码"能实现的原因。
 */
import { describeDbError, execute, query } from "@/lib/db";
import { verifyEmailCode } from "@/lib/mailer";
import { rateLimit } from "@/lib/rate-limit";
import { decryptText, encryptText } from "@/lib/secret-box";
import { getCurrentUser } from "@/lib/user-auth";
import { cleanString, json, jsonError, readJsonBody, safeEqualText } from "@/lib/util";

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
  const oldPassword = typeof body.oldPassword === "string" ? body.oldPassword : "";
  const email = cleanString(body.email, 190).toLowerCase();
  const code = cleanString(body.code, 12);
  const password = typeof body.password === "string" ? body.password : "";
  const confirmPassword =
    typeof body.confirmPassword === "string" ? body.confirmPassword : "";

  // ① 原密码
  if (!oldPassword) return jsonError("请输入原密码", 400);

  // ② 邮箱必须是当前账号绑定的那个
  if (!email) return jsonError("请填写绑定邮箱", 400);
  if (email !== String(user.email || "").toLowerCase()) {
    return jsonError("邮箱和当前账号不一致", 400);
  }

  // ③ 验证码
  if (!code) return jsonError("请输入验证码", 400);

  // ④ 新密码
  if (password.length < MIN_PASSWORD_LENGTH) {
    return jsonError(`新密码至少 ${MIN_PASSWORD_LENGTH} 位`, 400);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return jsonError(`密码太长了，请控制在 ${MAX_PASSWORD_LENGTH} 位以内`, 400);
  }
  if (password !== confirmPassword) {
    return jsonError("两次输入的新密码不一致", 400);
  }

  try {
    // 校验原密码：从库里取出可逆加密的明文再比对
    const rows = await query("SELECT password_enc FROM users WHERE id = ? LIMIT 1", [user.id]);
    if (!rows.length) return jsonError("账号不存在", 404);

    let currentPassword = "";
    try {
      currentPassword = decryptText(rows[0].password_enc) || "";
    } catch {
      currentPassword = "";
    }
    if (!currentPassword) {
      return jsonError("当前账号没有设置密码，请先用邮箱验证码登录后再设置", 400);
    }
    if (!safeEqualText(currentPassword, oldPassword)) {
      return jsonError("原密码不正确", 400);
    }

    // 校验邮箱验证码（和「找回密码」共用 purpose='reset'，用掉即作废）
    const verified = await verifyEmailCode({ email, code, purpose: "reset" });
    if (!verified?.ok) {
      return jsonError(verified?.error || "验证码不正确或已过期", 400);
    }

    await execute("UPDATE users SET password_enc = ? WHERE id = ?", [
      encryptText(password),
      user.id,
    ]);

    return json({ ok: true, message: "密码修改成功" });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
