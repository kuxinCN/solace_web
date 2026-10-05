/**
 * 后台上传一张表情包素材：POST /api/admin/stickers/upload（multipart，字段 file + category）
 *
 * 存到 `public/stickers/<分类目录>/`，写一行 `stickers` 记录。
 *
 * ⚠️ 与桌面形象上传的两点不同，都是刻意的：
 *   1. **保留原文件名**（只做安全清洗），而不是重命名成一串随机字符 ——
 *      素材目录是运维和设计师直接进磁盘看的地方，全变成 `sticker-1727...-a1b2.jpg`
 *      等于把目录变成不可读的；桌宠形象只有几张、且必须防重名，才用了随机名。
 *   2. 同名文件已存在时**追加时间戳**而不是覆盖：覆盖会顺带毁掉已经发出去的历史贴纸。
 *
 * 安全同前：扩展名白名单 + **魔数嗅探**（拒收"改名成 .jpg 的 SVG/HTML"）+ 2MB 上限。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import { describeDbError, execute, query } from "@/lib/db";
import {
  STICKER_IMAGE_EXT,
  STICKER_KEY_RE,
  STICKER_MAX_BYTES,
  STICKER_ROOT,
  invalidateStickerSpec,
} from "@/lib/sticker-store";
import { clientIp, json, jsonError } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 扩展名与真实文件头必须一致 —— 光看扩展名拦不住"把 html 改名成 png" */
function sniffImage(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return ".png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  if (buffer.slice(0, 6).toString("latin1").match(/^GIF8[79]a$/)) return ".gif";
  if (buffer.slice(0, 4).toString("latin1") === "RIFF" && buffer.slice(8, 12).toString("latin1") === "WEBP") {
    return ".webp";
  }
  return null;
}

/**
 * 清洗文件名：去掉路径分隔符与控制字符（路径穿越的第一道闸），限制长度。
 * 中文照原样保留 —— 现有四张素材就是中文名，直接能用。
 */
function safeFilename(name) {
  const base = path.basename(String(name || "").trim());
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim();
  if (!cleaned) return "";
  const ext = path.extname(cleaned).toLowerCase();
  const stem = cleaned.slice(0, Math.max(1, cleaned.length - ext.length)).slice(0, 100);
  return `${stem}${ext}`;
}

export async function POST(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  let formData = null;
  try {
    formData = await request.formData();
  } catch {
    return jsonError("请求格式不正确", 400);
  }

  const file = formData.get("file");
  const category = String(formData.get("category") || "").trim().toLowerCase();

  if (!STICKER_KEY_RE.test(category)) return jsonError("请选择素材分类", 400);
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
    return jsonError("请选择要上传的图片", 400);
  }

  try {
    const exists = await query(
      "SELECT id FROM sticker_categories WHERE sticker_key = ? LIMIT 1",
      [category]
    );
    if (!exists.length) return jsonError("这个素材目录还没有对应的分类，请先新增分类", 400);
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }

  if (file.size > STICKER_MAX_BYTES) {
    return jsonError(`图片不能超过 ${Math.round(STICKER_MAX_BYTES / 1024 / 1024)}MB`, 400);
  }

  const rawName = safeFilename(file.name);
  const ext = path.extname(rawName).toLowerCase();
  if (!STICKER_IMAGE_EXT.includes(ext)) {
    return jsonError(`只支持 ${STICKER_IMAGE_EXT.join(" / ")} 格式`, 400);
  }

  let buffer = null;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return jsonError("读取文件失败", 400);
  }
  if (!buffer.length) return jsonError("文件是空的", 400);

  const sniffed = sniffImage(buffer);
  if (!sniffed) return jsonError("这不像是一张图片（内容与扩展名不符），请重新导出后再传", 400);

  const dir = path.join(STICKER_ROOT, category);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return jsonError("创建素材目录失败，请检查服务器目录权限", 500);
  }

  // 同名不覆盖：追加时间戳（覆盖会毁掉已经发出去的历史贴纸）
  let filename = rawName;
  const target = () => path.join(dir, filename);
  if (fs.existsSync(target())) {
    const stamp = Date.now().toString().slice(-6);
    filename = `${rawName.slice(0, rawName.length - ext.length)}-${stamp}${ext}`;
  }

  try {
    fs.writeFileSync(target(), buffer);
  } catch {
    return jsonError("保存文件失败，请检查服务器目录权限", 500);
  }

  try {
    const result = await execute(
      `INSERT INTO stickers (category, url, filename, enabled, sort_order)
       VALUES (?, ?, ?, 1, ?)`,
      [category, `/stickers/${category}/${filename}`, filename, Number(formData.get("sortOrder")) || 0]
    );

    invalidateStickerSpec();

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "upload_sticker",
      detail: `${category}/${filename}（${Math.round(buffer.length / 1024)}KB，嗅探 ${sniffed}）`,
      ip: clientIp(request),
    });

    return json({
      ok: true,
      id: result.insertId,
      filename,
      url: `/stickers/${category}/${filename}`,
      renamed: filename !== rawName,
    });
  } catch (err) {
    // 落库失败就把刚写的文件删掉，避免磁盘上留下"表里没有"的孤儿图
    try {
      fs.unlinkSync(target());
    } catch {
      /* 删不掉也不影响返回错误 */
    }
    return jsonError(describeDbError(err), 500);
  }
}
