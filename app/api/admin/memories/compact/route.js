/**
 * 手动触发长期记忆压缩（后台专用，本地联调也用它）。
 *
 * POST /api/admin/memories/compact
 *   { userId?: number, force?: boolean, batch?: number }
 *   * 带 userId：只压该用户；默认 force=true（跳过 150 条阈值，方便本地验证）
 *   * 不带 userId：跑一轮"超标用户"扫描，和调度器每天那次完全同一逻辑
 *
 * 安全边界与 lib/memory-compact.js 一致：
 *   AI 失败 / 返回 NONE / 总结没落库 / 总结没查到 → **一条旧记忆都不标记**。
 */
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import { compactAllUsersMemories, compactUserMemories } from "@/lib/memory-compact";
import { describeDbError } from "@/lib/db";
import { clientIp, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);
  const userId = Number(body.userId) || 0;
  const force = body.force !== false; // 手动触发默认跳过阈值
  const batch = Number(body.batch) || 0;

  try {
    const result =
      userId > 0
        ? await compactUserMemories(userId, { force, batch: batch || undefined })
        : await compactAllUsersMemories();

    try {
      await logAudit({
        adminId: admin.adminId,
        username: admin.username,
        action: "memory_compact",
        detail: userId ? `手动压缩用户 ${userId}` : "手动触发超标用户压缩",
        ip: clientIp(request),
      });
    } catch {
      /* 审计失败不影响结果 */
    }

    return json({ ok: true, result });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
