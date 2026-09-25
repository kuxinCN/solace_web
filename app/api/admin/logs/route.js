/** 后台操作日志 */
import { getAdminFromRequest, listAuditLogs } from "@/lib/admin-auth";
import { describeDbError } from "@/lib/db";
import { json, jsonError } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const limit = new URL(request.url).searchParams.get("limit") || "50";

  try {
    const logs = await listAuditLogs(limit);
    return json({ ok: true, logs });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
