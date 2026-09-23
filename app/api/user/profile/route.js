/**
 * 用户资料：读取 / 修改。
 *
 * 返回值用数据库的 snake_case 原名（avatar_url / bio / gender / birthday 等），
 * 这样前端的 ProfileView、NicknameEditor 等组件不用改字段名。
 *
 * PUT 是「部分更新」：只更新请求里带了的字段，其余保持原样
 * （前端各个设置是分开保存的，整体覆盖会把别的字段清空）。
 */
import { describeDbError, execute, query } from "@/lib/db";
import { getCurrentUser } from "@/lib/user-auth";
import { cleanString, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BIRTHDAY_PATTERN = /^\d{4}(-\d{2}){0,2}$/;
const MAX_IMAGE_LENGTH = 900 * 1024; // 图片是 base64，限制约 900KB

// 不返回 password_enc / remark / phone 等敏感或后台专用字段
const PROFILE_FIELDS = [
  "id",
  "email",
  "account",
  "username",
  "avatar_url",
  "ai_avatar_url",
  "chat_background_url",
  "gender",
  "birthday",
  "bio",
  "status",
  "created_at",
  "last_login_at",
].join(", ");

async function loadProfile(userId) {
  const rows = await query(`SELECT ${PROFILE_FIELDS} FROM users WHERE id = ? LIMIT 1`, [userId]);
  return rows[0] || null;
}

export async function GET(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  try {
    const profile = await loadProfile(user.id);
    if (!profile) return jsonError("账号不存在，请重新登录", 404);
    return json({ ok: true, profile });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function PUT(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const body = await readJsonBody(request);

  const sets = [];
  const params = [];
  const assign = (column, value) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };

  if (typeof body.username === "string") {
    const username = cleanString(body.username, 64);
    if (!username) return jsonError("名字不能为空", 400);
    assign("username", username);
  }

  if (typeof body.bio === "string") {
    assign("bio", cleanString(body.bio, 100) || null);
  }

  if (typeof body.gender === "string") {
    assign("gender", cleanString(body.gender, 16) || null);
  }

  if (typeof body.birthday === "string") {
    const birthday = cleanString(body.birthday, 10);
    if (birthday && !BIRTHDAY_PATTERN.test(birthday)) {
      return jsonError("出生年月格式应为 2003-05 或 2003-05-20", 400);
    }
    assign("birthday", birthday || null);
  }

  // 图片字段是 base64，不做 trim；空字符串表示恢复默认（置空）
  for (const [key, column] of [
    ["avatarUrl", "avatar_url"],
    ["aiAvatarUrl", "ai_avatar_url"],
    ["chatBackgroundUrl", "chat_background_url"],
  ]) {
    if (typeof body[key] !== "string") continue;
    const value = body[key];
    if (value && !/^data:image\//i.test(value) && !/^https?:\/\//i.test(value)) {
      return jsonError("图片格式不正确", 400);
    }
    if (value.length > MAX_IMAGE_LENGTH) {
      return jsonError("图片太大，请换一张更小的", 400);
    }
    assign(column, value || null);
  }

  if (!sets.length) return jsonError("没有需要修改的内容", 400);

  try {
    await execute(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, [...params, user.id]);
    const profile = await loadProfile(user.id);
    return json({ ok: true, profile });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
