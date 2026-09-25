/**
 * 用户上传图片（头像 / AI 头像 / 聊天背景）。
 *
 * 为了部署简单（不用管服务器目录权限、也不用担心文件丢失），
 * 图片不落磁盘，而是把前端压缩好的 base64 data URL 直接存进 users 表。
 * 前端流程：File -> canvas 压缩 -> FileReader.readAsDataURL -> POST 这里。
 *
 * 安全校验分三层：
 *   ① kind 白名单（决定写哪一列，避免 SQL 拼接注入）；
 *   ② data URL 前缀 + 长度限制；
 *   ③ **按文件头魔数确认真实格式**——前缀可以伪造（任意文件 base64 后加上
 *      `data:image/png;base64,` 就能骗过正则），所以要解出字节再核对一次。
 */
import { describeDbError, execute } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/user-auth";
import { cleanString, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 前端传的 kind -> 数据库列名（白名单，防止拼接注入） */
const KIND_COLUMN = {
  avatar: "avatar_url",
  aiAvatar: "ai_avatar_url",
  background: "chat_background_url",
  diaryBackground: "diary_background_url",
};

const DATA_URL_PATTERN = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i;
const MAX_LENGTH = 900 * 1024; // data URL 字符串长度上限
const MAX_BYTES = 700 * 1024; // 解码后的实际字节数上限

/** 按文件头魔数识别真实图片格式；不是图片就返回空字符串 */
function sniffImageMime(buffer) {
  if (buffer.length < 12) return "";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF: "GIF8"
  if (buffer.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  // WebP: "RIFF" + 4 字节长度 + "WEBP"
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return "";
}

export async function POST(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  // 上传是重操作（解 base64 + 写大字段），按用户限流
  const quota = rateLimit(`upload:${user.id}`, { limit: 30, windowMs: 10 * 60 * 1000 });
  if (!quota.ok) {
    return jsonError(`上传太频繁，请 ${quota.retryAfterSeconds} 秒后再试`, 429);
  }

  const body = await readJsonBody(request);
  const kind = cleanString(body.kind, 16);
  const dataUrl = typeof body.dataUrl === "string" ? body.dataUrl : "";

  const column = KIND_COLUMN[kind];
  if (!column) {
    return jsonError("未知的图片类型（只能是 avatar / aiAvatar / background）", 400);
  }
  if (!DATA_URL_PATTERN.test(dataUrl)) {
    return jsonError("只支持 png / jpg / webp / gif 图片", 400);
  }
  if (dataUrl.length > MAX_LENGTH) {
    return jsonError("图片太大了，请换一张更小的（建议压缩到 1MB 以内）", 400);
  }

  // 解出真实字节，核对格式（前缀可能被伪造）
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  let buffer;
  try {
    buffer = Buffer.from(base64, "base64");
  } catch {
    return jsonError("图片数据无法解析，请重新选择图片", 400);
  }
  if (!buffer.length) {
    return jsonError("图片数据为空，请重新选择图片", 400);
  }
  if (buffer.length > MAX_BYTES) {
    return jsonError("图片太大了，请换一张更小的（建议压缩到 1MB 以内）", 400);
  }

  const sniffed = sniffImageMime(buffer);
  if (!sniffed) {
    return jsonError("这个文件不是有效的图片（png / jpg / webp / gif）", 400);
  }

  const declared = dataUrl.slice(5, dataUrl.indexOf(";")).toLowerCase().replace(/^image\/jpg$/, "image/jpeg");
  if (declared !== sniffed) {
    return jsonError("图片内容与声明的格式不一致，请重新选择", 400);
  }

  try {
    await execute(`UPDATE users SET ${column} = ? WHERE id = ?`, [dataUrl, user.id]);
    return json({ ok: true, kind, url: dataUrl, contentType: sniffed, bytes: buffer.length });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
