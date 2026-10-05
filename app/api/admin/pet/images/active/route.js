/**
 * 设置「当前使用的桌宠形象」：POST /api/admin/pet/images/active（body：{ id }）
 *
 * 为什么单独开一个接口，而不是直接 PUT /api/admin/settings：
 *   `saveGroup` 的校验（`validateGroup`）是**同步函数**，不能查库，
 *   所以"这个形象编号是不是真的存在、是不是被停用"没法在那里校验。
 *   而保存一个不存在的编号 = 用户端一张破图，这道校验不能省 —— 单独一个接口最省事，
 *   顺带能记一条明确的审计日志（"设当前形象"比"更新配置分组"可读得多）。
 *
 * id = 0 表示回到内置默认形象（/stickers/blue_butterfly.png）。
 */
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import { describeDbError } from "@/lib/db";
import { getPetImage } from "@/lib/pet-store";
import { saveGroup } from "@/lib/settings";
import { clientIp, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);
  const raw = String(body?.id ?? "0").trim();
  if (!/^\d+$/.test(raw)) return jsonError("形象编号不合法", 400);
  const id = Number.parseInt(raw, 10);

  try {
    if (id > 0) {
      const image = await getPetImage(id);
      if (!image) return jsonError("这个形象不存在", 404);
      if (!Number(image.enabled)) {
        return jsonError("这个形象已停用，先启用再设为当前形象", 400);
      }
    }

    const saved = await saveGroup("pet", { activeImageId: id });

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "set_pet_image",
      detail: id > 0 ? `设为形象 #${id}` : "回退到内置默认形象",
      ip: clientIp(request),
    });

    return json({ ok: true, activeImageId: Number(saved?.activeImageId) || 0 });
  } catch (err) {
    if (err.code === "INVALID_SETTINGS") return jsonError(err.message, 400, { errors: err.errors });
    return jsonError(describeDbError(err), 500);
  }
}
