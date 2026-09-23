/**
 * 用户上传图片（头像 / AI 头像 / 聊天背景）。
 *
 * 为了部署简单（不用管服务器目录权限、也不用担心文件丢失），
 * 图片不落磁盘，而是把前端压缩好的 base64 data URL 直接存进 users 表。
 * 前端流程：File -> canvas 压缩 -> FileReader.readAsDataURL -> POST 这里。
 */
import { describeDbError, execute } from "@/lib/db";
import { getCurrentUser } from "@/lib/user-auth";
import { cleanString, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 前端传的 kind -> 数据库列名（白名单，防止拼接注入） */
const KIND_COLUMN = {
  avatar: "avatar_url",
  aiAvatar: "ai_avatar_url",
  background: "chat_background_url",
};

const DATA_URL_PATTERN = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i;
const MAX_LENGTH = 900 * 1024;

export async function POST(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

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

  try {
    await execute(`UPDATE users SET ${column} = ? WHERE id = ?`, [dataUrl, user.id]);
    return json({ ok: true, kind, url: dataUrl });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
