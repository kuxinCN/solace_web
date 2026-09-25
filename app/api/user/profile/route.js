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
import { enqueueReview } from "@/lib/content-review";
import { ensureUserColumnsOnce } from "@/lib/schema";
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
  "diary_background_url",
  "gender",
  "birthday",
  "bio",
  "ai_persona",
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

  // ⚠️ 老部署升级兜底：确保 content_review_tasks 这些新表已经建好。
  //    否则下面的「入队打标」会因为表不存在而静默跳过 —— 表现出来就是
  //    「我改了昵称，但后台的待审核条数一点没变」。
  //    幂等 + 进程内只跑一次，第二次以后几乎零成本。
  try {
    await ensureUserColumnsOnce();
  } catch {
    /* 补表失败不影响改资料 */
  }

  const body = await readJsonBody(request);

  const sets = [];
  const params = [];
  // 本次改动里**需要送审**的字段（昵称 / 签名 / 各类图片）。
  // 注意：送审是「事后打标」，绝不影响资料本身的保存。
  const reviewItems = [];

  const assign = (column, value) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };

  if (typeof body.username === "string") {
    const username = cleanString(body.username, 64);
    if (!username) return jsonError("名字不能为空", 400);
    assign("username", username);
    reviewItems.push({ field: "username", content: username });
  }

  if (typeof body.bio === "string") {
    const bio = cleanString(body.bio, 100);
    assign("bio", bio || null);
    reviewItems.push({ field: "bio", content: bio });
  }

  if (typeof body.gender === "string") {
    assign("gender", cleanString(body.gender, 16) || null);
  }

  // AI 人格偏好：male / female。空字符串表示"还没选"，前端据此弹窗提醒。
  if (typeof body.aiPersona === "string") {
    const persona = cleanString(body.aiPersona, 16).toLowerCase();
    if (persona && persona !== "male" && persona !== "female") {
      return jsonError("AI 人格只能是 male 或 female", 400);
    }
    assign("ai_persona", persona || null);
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
    ["diaryBackgroundUrl", "diary_background_url"],
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
    reviewItems.push({ field: column, content: value || "" });
  }

  if (!sets.length) return jsonError("没有需要修改的内容", 400);

  try {
    await execute(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, [...params, user.id]);
    const profile = await loadProfile(user.id);

    // 资料**上面已经生效**了。下面只是把改动过的内容标成「未审核」并放进审核队列，
    // 之后由后台「数据审核」页或定时任务批量交给 AI 判定。
    //
    // ⚠️ 这一整段都不能影响接口结果 —— 审核系统坏了，用户也得能正常改资料。
    for (const item of reviewItems) {
      try {
        await enqueueReview({ userId: user.id, field: item.field, content: item.content });
      } catch {
        /* 单条入队失败就跳过，不打扰用户 */
      }
    }

    return json({ ok: true, profile });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
