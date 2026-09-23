/**
 * 后台系统配置：
 *   GET → 读取所有分组（密钥只回传「是否已配置」，不回传明文）
 *   PUT → 保存某个分组，{ group, values }
 */
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import { describeDbError } from "@/lib/db";
import { GROUPS, readAllPublic, saveGroup, toPublicGroup } from "@/lib/settings";
import { cleanString, clientIp, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  try {
    return json({ ok: true, groups: GROUPS, settings: await readAllPublic() });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function PUT(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);
  const group = cleanString(body.group, 32);
  const values =
    body.values && typeof body.values === "object" && !Array.isArray(body.values)
      ? body.values
      : null;

  if (!GROUPS.includes(group)) return jsonError("未知的配置分组", 400);
  if (!values) return jsonError("缺少配置内容", 400);

  try {
    const saved = await saveGroup(group, values);
    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: `save_settings:${group}`,
      // 只记录「改了哪个分组」，不记录任何密钥明文
      detail: `更新配置分组 ${group}`,
      ip: clientIp(request),
    });
    return json({ ok: true, group, settings: toPublicGroup(group, saved) });
  } catch (err) {
    if (err.code === "INVALID_SETTINGS") {
      return jsonError(err.message, 400, { errors: err.errors });
    }
    return jsonError(describeDbError(err), 500);
  }
}
