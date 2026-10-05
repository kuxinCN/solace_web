/**
 * 后台上传桌宠形象：POST /api/admin/pet/images/upload（multipart/form-data，字段名 file）
 *
 * 文件落在 `public/pets/`，Nginx 直接 serve，不走 Node。
 *
 * ⚠️ 上传校验三层（和音频上传同一套思路，但这里是图片）：
 *   ① 体积上限 2MB —— 桌宠显示边长只有 40-160px，1.26MB 的 1269×1239 原图纯属浪费
 *      （现在的蓝蝴蝶就是这个问题，见 docs/PET.md 已知问题）；
 *   ② 扩展名白名单 png / jpg / jpeg / webp / gif；
 *   ③ **按文件头魔数确认真实格式** —— 扩展名可以随便改，字节头改不了。
 *      ⚠️ 还挡住了改名成 .png 的 SVG：SVG 能带脚本，是个 XSS 面，绝对不能收。
 *
 * 文件名统一重命名成 `pet-时间戳-随机串.ext`，避免中文/空格/特殊字符带来的坑。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import { describeDbError, execute } from "@/lib/db";
import { cleanString, clientIp, json, jsonError } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PETS_DIR = path.join(process.cwd(), "public", "pets");
const MAX_BYTES = 2 * 1024 * 1024; // 2MB
const ALLOWED_EXT = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const ALLOWED_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** 按文件头判断真实图片格式；不是支持的格式就返回空 */
function sniffImage(ext, buffer) {
  if (buffer.length < 12) return "";

  // PNG：89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "png";
  }
  // JPEG：FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  // GIF：GIF87a / GIF89a
  if (buffer.toString("ascii", 0, 6) === "GIF87a" || buffer.toString("ascii", 0, 6) === "GIF89a") {
    return "gif";
  }
  // WEBP：RIFF....WEBP
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return "";
}

export async function POST(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  let formData = null;
  try {
    formData = await request.formData();
  } catch {
    return jsonError("请求格式不对，应使用 multipart/form-data 上传", 400);
  }

  const file = formData.get("file");
  if (!file || typeof file === "string") return jsonError("没有收到文件", 400);

  const originalName = cleanString(file.name || "image", 200);
  const ext = path.extname(originalName).toLowerCase();

  if (!ALLOWED_EXT.includes(ext)) {
    return jsonError(`只支持 ${ALLOWED_EXT.join(" / ")} 格式`, 400);
  }
  if (file.size > MAX_BYTES) {
    return jsonError(
      `图片太大了（${Math.round(file.size / 1024)}KB），上限 2MB —— 桌宠显示边长最大 160px，压缩一下再传`,
      400
    );
  }

  let buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return jsonError("读取文件失败，请重试", 400);
  }
  if (!buffer.length) return jsonError("文件是空的", 400);
  if (buffer.length > MAX_BYTES) return jsonError("图片太大了，上限 2MB", 400);

  // ③ 真实格式校验：扩展名与文件头必须对得上
  const sniffed = sniffImage(ext, buffer);
  if (!sniffed) {
    return jsonError("这不是有效的图片（扩展名与实际内容不符；SVG 不支持）", 400);
  }
  if (file.type && !ALLOWED_MIME.includes(String(file.type).toLowerCase())) {
    // MIME 只作为参考，不作为拒绝依据，但记一笔方便排查
    console.warn(`[pet] 上传 MIME 异常：${file.type}（${sniffed}）`);
  }

  const filename = `pet-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
  const url = `/pets/${filename}`;
  const target = path.join(PETS_DIR, filename);

  try {
    fs.mkdirSync(PETS_DIR, { recursive: true });
    fs.writeFileSync(target, buffer);
  } catch (err) {
    return jsonError(`写入文件失败：${err?.message || err}（检查 public/pets 目录权限）`, 500);
  }

  const name =
    cleanString(formData.get("name"), 64) || path.basename(originalName, ext).slice(0, 64);
  const note = cleanString(formData.get("adminNote"), 200) || null;

  try {
    const result = await execute(
      `INSERT INTO pet_images (name, url, filename, enabled, sort_order, admin_note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name, url, filename, 1, Number(formData.get("sortOrder")) || 0, note]
    );

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "upload_pet_image",
      detail: `${name}（${Math.round(buffer.length / 1024)}KB，${sniffed}）`,
      ip: clientIp(request),
    });

    return json({
      ok: true,
      id: result.insertId,
      name,
      url,
      bytes: buffer.length,
      format: sniffed,
    });
  } catch (err) {
    // 入库失败就把刚写的文件删掉，避免留下没人引用的孤儿文件
    try {
      fs.unlinkSync(target);
    } catch {
      /* 忽略 */
    }
    return jsonError(describeDbError(err), 500);
  }
}
