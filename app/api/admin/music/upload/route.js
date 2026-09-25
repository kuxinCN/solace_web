/**
 * 后台上传音频：POST /api/admin/music/upload（multipart/form-data，字段名 file）
 *
 * 文件落在 `public/music/`，Nginx 能直接 serve，不走 Node，比存数据库划算得多。
 * （头像那种小图才适合 base64 存库；一首歌几 MB，必须走磁盘。）
 *
 * 校验三层：
 *   ① 体积上限 20MB；
 *   ② 扩展名白名单 mp3 / m4a / wav / ogg；
 *   ③ **按文件头魔数确认真实格式** —— 扩展名可以随便改，字节头改不了。
 *
 * 文件名统一重命名成「时间戳-随机串.ext」，避免中文、空格、特殊字符带来的各种坑。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import { describeDbError, execute } from "@/lib/db";
import { cleanString, clientIp, json, jsonError } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MUSIC_DIR = path.join(process.cwd(), "public", "music");
const MAX_BYTES = 20 * 1024 * 1024; // 20MB
const ALLOWED_EXT = [".mp3", ".m4a", ".wav", ".ogg"];
const ALLOWED_MIME = [
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
];

/** 按文件头判断真实音频格式；不是支持的格式就返回空 */
function sniffAudio(ext, buffer) {
  if (buffer.length < 12) return "";

  // MP3：可能以 ID3 标签开头，也可能是裸帧同步字 FF Ex
  if (ext === ".mp3") {
    if (buffer.toString("ascii", 0, 3) === "ID3") return "mp3";
    if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return "mp3";
    return "";
  }
  // WAV：RIFF....WAVE
  if (ext === ".wav") {
    if (
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WAVE"
    ) {
      return "wav";
    }
    return "";
  }
  // OGG："OggS"
  if (ext === ".ogg") {
    return buffer.toString("ascii", 0, 4) === "OggS" ? "ogg" : "";
  }
  // M4A/AAC：ftyp 盒子（偏移 4 处）
  if (ext === ".m4a") {
    if (buffer.toString("ascii", 4, 8) === "ftyp") return "m4a";
    return "";
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

  const originalName = cleanString(file.name || "audio", 200);
  const ext = path.extname(originalName).toLowerCase();

  if (!ALLOWED_EXT.includes(ext)) {
    return jsonError(`只支持 ${ALLOWED_EXT.join(" / ")} 格式`, 400);
  }
  if (file.size > MAX_BYTES) {
    return jsonError(`文件太大了（${Math.round(file.size / 1024 / 1024)}MB），上限 20MB`, 400);
  }

  let buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return jsonError("读取文件失败，请重试", 400);
  }
  if (!buffer.length) return jsonError("文件是空的", 400);
  if (buffer.length > MAX_BYTES) return jsonError("文件太大了，上限 20MB", 400);

  // ③ 真实格式校验：扩展名与文件头必须对得上
  const sniffed = sniffAudio(ext, buffer);
  if (!sniffed) {
    return jsonError("这个文件不是有效的音频（扩展名与实际内容不符）", 400);
  }
  if (file.type && !ALLOWED_MIME.includes(String(file.type).toLowerCase())) {
    // MIME 只是参考，不作为拒绝依据，但记一笔方便排查
    console.warn(`[music] 上传 MIME 异常：${file.type}（${sniffed}）`);
  }

  // 统一重命名，避免中文/空格/特殊字符带来的路径问题
  const filename = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
  const url = `/music/${filename}`;
  const target = path.join(MUSIC_DIR, filename);

  try {
    fs.mkdirSync(MUSIC_DIR, { recursive: true });
    fs.writeFileSync(target, buffer);
  } catch (err) {
    return jsonError(`写入文件失败：${err?.message || err}（检查 public/music 目录权限）`, 500);
  }

  const title = cleanString(formData.get("title"), 160) || path.basename(originalName, ext);
  const artist = cleanString(formData.get("artist"), 160) || null;

  try {
    const result = await execute(
      `INSERT INTO music_tracks (title, artist, source, url, sort_order, enabled)
       VALUES (?, ?, 'local', ?, ?, 1)`,
      [title, artist, url, Number(formData.get("sortOrder")) || 0]
    );

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "upload_music",
      detail: `${title}（${Math.round(buffer.length / 1024)}KB）`,
      ip: clientIp(request),
    });

    return json({
      ok: true,
      id: result.insertId,
      title,
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
