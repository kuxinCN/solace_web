/**
 * 后台表情包素材：GET 列表 / PATCH 修改 / DELETE 删除
 *
 * 素材的"新增"有两条路（都不在这个文件里）：
 *   * `POST /api/admin/stickers/upload` —— 后台上传一张新图；
 *   * `POST /api/admin/stickers/scan`   —— 把一个分类目录里**还没登记**的图批量补进表，
 *     给"按 docs/STICKER.md §6.3 手工往目录丢图"的老流程兜底。
 *
 * 删除会连带删掉磁盘文件（和背景音乐一样），避免留下没人引用的孤儿文件。
 */
import fs from "node:fs";
import path from "node:path";
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import { describeDbError, execute, query } from "@/lib/db";
import { STICKER_ROOT, invalidateStickerSpec } from "@/lib/sticker-store";
import { clientIp, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return 0;
  const id = Number.parseInt(text, 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

/** 从素材行反推磁盘路径，并做目录穿越防护 */
function resolveStickerFile(row) {
  const category = String(row?.category || "").trim();
  const filename = String(row?.filename || "").trim();
  if (!category || !filename) return null;
  if (category.includes("/") || category.includes("..")) return null;
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) return null;
  return path.join(STICKER_ROOT, category, filename);
}

export async function GET(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const category = String(new URL(request.url).searchParams.get("category") || "")
    .trim()
    .toLowerCase();

  try {
    const stickers = await query(
      `SELECT id, category, url, filename, enabled, sort_order, admin_note, created_at
         FROM stickers
        ${category ? "WHERE category = ?" : ""}
        ORDER BY category ASC, sort_order ASC, id ASC
        LIMIT 500`,
      category ? [category] : []
    );

    // 每个分类目录的磁盘占用：一眼看出"表里没有、磁盘上却有一堆图"（孤儿文件）
    const disk = {};
    let diskCount = 0;
    let diskBytes = 0;
    try {
      for (const entry of fs.readdirSync(STICKER_ROOT, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(STICKER_ROOT, entry.name);
        let count = 0;
        let bytes = 0;
        try {
          for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!file.isFile()) continue;
            count += 1;
            try {
              bytes += fs.statSync(path.join(dir, file.name)).size;
            } catch {
              /* 单个文件读不到就跳过 */
            }
            if (!category || category === entry.name.toLowerCase()) {
              diskCount += 1;
              diskBytes += 0;
            }
          }
        } catch {
          /* 子目录读不到就跳过 */
        }
        disk[entry.name] = { count, mb: Math.round((bytes / 1024 / 1024) * 10) / 10 };
      }
    } catch {
      /* 目录还不存在 */
    }

    return json({
      ok: true,
      stickers,
      disk,
      diskTotal: { count: diskCount, mb: Math.round((diskBytes / 1024 / 1024) * 10) / 10 },
    });
  } catch (err) {
    return json({ ok: true, stickers: [], disk: {}, diskTotal: { count: 0, mb: 0 }, note: describeDbError(err) });
  }
}

export async function PATCH(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);
  const id = parseId(body.id);
  if (!id) return jsonError("缺少素材 id", 400);

  const sets = [];
  const params = [];

  if (body.sortOrder !== undefined) {
    sets.push("sort_order = ?");
    params.push(Number.isInteger(Number(body.sortOrder)) ? Number(body.sortOrder) : 0);
  }
  if (body.enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(body.enabled === true || body.enabled === 1 || body.enabled === "1" ? 1 : 0);
  }
  if (typeof body.adminNote === "string") {
    sets.push("admin_note = ?");
    params.push(String(body.adminNote).trim().slice(0, 200) || null);
  }

  if (!sets.length) return jsonError("没有需要修改的内容", 400);

  try {
    const result = await execute(`UPDATE stickers SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
    if (!result.affectedRows) {
      const exists = await query("SELECT id FROM stickers WHERE id = ? LIMIT 1", [id]);
      if (!exists.length) return jsonError("素材不存在", 404);
    }

    // 启停素材会改变"这个分类还有没有可用图" → 引擎的 available 判定要立刻跟着变
    invalidateStickerSpec();

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "update_sticker",
      detail: `#${id} ${sets.join(", ")}`,
      ip: clientIp(request),
    });

    return json({ ok: true });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function DELETE(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const id = parseId(new URL(request.url).searchParams.get("id"));
  if (!id) return jsonError("缺少素材 id", 400);

  try {
    const rows = await query(
      "SELECT id, category, url, filename FROM stickers WHERE id = ? LIMIT 1",
      [id]
    );
    const sticker = rows[0];
    if (!sticker) return jsonError("素材不存在", 404);

    await execute("DELETE FROM stickers WHERE id = ?", [id]);

    let fileRemoved = false;
    const filePath = resolveStickerFile(sticker);
    if (filePath) {
      try {
        fs.unlinkSync(filePath);
        fileRemoved = true;
      } catch {
        /* 文件本来就不在就算了 */
      }
    }

    invalidateStickerSpec();

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "delete_sticker",
      detail: `${sticker.category}/${sticker.filename}${fileRemoved ? "（已删文件）" : ""}`,
      ip: clientIp(request),
    });

    return json({ ok: true, fileRemoved });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
