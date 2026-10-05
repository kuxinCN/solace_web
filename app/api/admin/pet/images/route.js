/**
 * 后台桌宠形象库：GET 列表 / POST 新增 / PATCH 修改 / DELETE 删除
 *
 * 「形象库」是可以放多张形象的：后台选一张作为**当前形象**（`settings.pet.activeImageId`），
 * 用户端只读展示、不能自己挑。
 *
 * 两点约定：
 *   * 上传图片走 `/api/admin/pet/images/upload`（会写文件到 `public/pets/`）；
 *     这个接口收的是"已经存在的地址"（外链，或手工放进 public/pets 的图）；
 *   * **删除当前正在用的形象**：自动把 `activeImageId` 归 0 回退到内置默认图，
 *     而不是拦住管理员 —— 拦住会变成一个死胡同（想删还得先切，切完还得回来删）。
 */
import fs from "node:fs";
import path from "node:path";
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import { describeDbError, execute, query } from "@/lib/db";
import { normalizeImageInput } from "@/lib/pet-store";
import { getGroup, saveGroup } from "@/lib/settings";
import { clientIp, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PETS_DIR = path.join(process.cwd(), "public", "pets");

function parseId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return 0;
  const id = Number.parseInt(text, 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

/** 从 /pets/xxx.png 反推磁盘路径，并做目录穿越防护 */
function resolvePetFile(url) {
  const relative = String(url || "").trim();
  if (!relative.startsWith("/pets/")) return null;
  const filename = relative.slice("/pets/".length);
  if (!filename || filename.includes("/") || filename.includes("..")) return null;
  return path.join(PETS_DIR, filename);
}

export async function GET(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  try {
    const images = await query(
      `SELECT id, name, url, filename, enabled, sort_order, admin_note, created_at
         FROM pet_images
        ORDER BY sort_order ASC, id ASC
        LIMIT 200`
    );

    let activeImageId = 0;
    try {
      activeImageId = Number((await getGroup("pet"))?.activeImageId) || 0;
    } catch {
      activeImageId = 0;
    }

    // 磁盘占用：让后台一眼看到 public/pets 里有没有"表里没有、也没人引用"的孤儿文件
    let diskCount = 0;
    let diskBytes = 0;
    try {
      for (const item of fs.readdirSync(PETS_DIR, { withFileTypes: true })) {
        if (!item.isFile()) continue;
        diskCount += 1;
        try {
          diskBytes += fs.statSync(path.join(PETS_DIR, item.name)).size;
        } catch {
          /* 单个文件读不到就跳过 */
        }
      }
    } catch {
      /* 目录还不存在 */
    }

    return json({
      ok: true,
      images,
      activeImageId,
      disk: { count: diskCount, mb: Math.round((diskBytes / 1024 / 1024) * 10) / 10 },
    });
  } catch (err) {
    // 表还没建出来时按空列表返回，后台页面照样能打开
    return json({
      ok: true,
      images: [],
      activeImageId: 0,
      disk: { count: 0, mb: 0 },
      note: describeDbError(err),
    });
  }
}

export async function POST(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);
  const checked = normalizeImageInput(body);
  if (!checked.ok) return jsonError(checked.error, 400);

  try {
    const result = await execute(
      `INSERT INTO pet_images (name, url, filename, enabled, sort_order, admin_note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        checked.value.name,
        checked.value.url,
        path.basename(checked.value.url),
        body.enabled === false ? 0 : 1,
        checked.value.sort_order,
        checked.value.admin_note,
      ]
    );

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "add_pet_image",
      detail: `${checked.value.name}（${checked.value.url}）`,
      ip: clientIp(request),
    });

    return json({ ok: true, id: result.insertId });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function PATCH(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);
  const id = parseId(body.id);
  if (!id) return jsonError("缺少形象 id", 400);

  const sets = [];
  const params = [];

  if (typeof body.name === "string") {
    const name = String(body.name).trim();
    if (!name) return jsonError("形象名称不能为空", 400);
    sets.push("name = ?");
    params.push(name.slice(0, 64));
  }
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
    const result = await execute(`UPDATE pet_images SET ${sets.join(", ")} WHERE id = ?`, [
      ...params,
      id,
    ]);
    if (!result.affectedRows) {
      const exists = await query("SELECT id FROM pet_images WHERE id = ? LIMIT 1", [id]);
      if (!exists.length) return jsonError("形象不存在", 404);
    }

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "update_pet_image",
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
  if (!id) return jsonError("缺少形象 id", 400);

  try {
    const rows = await query(
      "SELECT id, name, url, filename FROM pet_images WHERE id = ? LIMIT 1",
      [id]
    );
    const image = rows[0];
    if (!image) return jsonError("形象不存在", 404);

    await execute("DELETE FROM pet_images WHERE id = ?", [id]);

    // 删的正好是当前形象 → 回退到内置默认图（否则用户端就是一张破图）
    let revertedToDefault = false;
    try {
      const config = await getGroup("pet");
      if (Number(config?.activeImageId) === id) {
        await saveGroup("pet", { activeImageId: 0 });
        revertedToDefault = true;
      }
    } catch {
      /* 读配置失败就算了，不能因为回退失败就不让人删 */
    }

    // 上传的图连带删掉磁盘文件；内置图 / 外链不动
    let fileRemoved = false;
    const filePath = resolvePetFile(image.url);
    if (filePath) {
      try {
        fs.unlinkSync(filePath);
        fileRemoved = true;
      } catch {
        /* 文件本来就不在就算了 */
      }
    }

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "delete_pet_image",
      detail: `${image.name}${fileRemoved ? "（已删文件）" : ""}${
        revertedToDefault ? "（原本是当前形象，已回退默认）" : ""
      }`,
      ip: clientIp(request),
    });

    return json({ ok: true, fileRemoved, revertedToDefault });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
