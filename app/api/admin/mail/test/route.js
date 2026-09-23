/**
 * 后台「发送测试邮件」：验证 SMTP（网易 163/126）配置是否真的能发信。
 */
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import { describeMailError, sendTestMail } from "@/lib/mailer";
import { cleanString, clientIp, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);
  const to = cleanString(body.to, 190);

  if (!EMAIL_PATTERN.test(to)) return jsonError("请填写正确的收件邮箱", 400);

  try {
    const info = await sendTestMail(to);
    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "test_mail",
      detail: `向 ${to} 发送测试邮件成功`,
      ip: clientIp(request),
    });
    return json({ ok: true, message: `测试邮件已发送到 ${to}`, messageId: info.messageId });
  } catch (err) {
    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "test_mail_failed",
      detail: `${to}：${err?.message || err}`,
      ip: clientIp(request),
    });
    return jsonError(describeMailError(err), 400);
  }
}
