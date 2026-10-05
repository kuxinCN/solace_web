/**
 * 后台「重新扫描」：POST /api/admin/stickers/scan  { category }
 *
 * 把一个分类目录里**还没登记进表**的图批量补登记。
 *
 * 为什么需要它：docs/STICKER.md §6.3 记录的老流程是"把图丢进 public/stickers/<分类>/、
 * 再把文件名加进前端资源表"。现在素材表是数据库驱动的，手工丢进目录的图不会自动出现
 * —— 这个接口就是那个流程的兜底（丢完图点一下"重新扫描"即可）。
 *
 * ⚠️ 只**新增**，不删也不改已有记录：磁盘上被手工删掉的图，记录仍然留着，
 *    由管理员在列表里自己删（自动对账容易把"临时移走想换回来"的图一起清掉）。
 */
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import { describeDbError, query } from "@/lib/db";
import { STICKER_KEY_RE, registerScannedFiles } from "@/lib/sticker-store";
import { clientIp, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);
  const category = String(body.category || "").trim().toLowerCase();
  if (!STICKER_KEY_RE.test(category)) return jsonError("分类名不合法", 400);

  try {
    const exists = await query(
      "SELECT id, label FROM sticker_categories WHERE sticker_key = ? LIMIT 1",
      [category]
    );
    if (!exists.length) return jsonError("这个素材目录还没有对应的分类，请先新增分类", 400);

    const result = await registerScannedFiles(category);

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "scan_stickers",
      detail: `${category}：扫描 ${result.scanned || 0} 张，新登记 ${result.added || 0} 张`,
      ip: clientIp(request),
    });

    return json({ ok: true, ...result });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
