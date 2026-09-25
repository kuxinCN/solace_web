/**
 * 账号注销：DELETE /api/user/account
 * body: { confirm: "注销我的账号" }
 *
 * 设计说明：
 *   * 这是用户对自己数据行使删除权（《个人信息保护法》要求"可删除"）。
 *   * 必须用请求体里的一句确认语来防误触 —— 前端应在二次确认弹窗里让用户照抄。
 *   * 逐表按顺序删除，不完全依赖外键级联：手工建的表可能没有外键约束，
 *     只靠 ON DELETE CASCADE 会留下孤儿数据。
 *   * 只删用户自己的数据，管理员账号与后台配置不受影响。
 */
import { describeDbError, execute } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { USER_COOKIE, getCurrentUser, userCookieOptions } from "@/lib/user-auth";
import {
  buildCookie,
  cleanString,
  json,
  jsonError,
  readJsonBody,
} from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 前端二次确认时要用户照抄的文字 */
const CONFIRM_TEXT = "注销我的账号";

export async function DELETE(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  // 注销是破坏性操作，限流兜一层，避免被脚本反复调用
  const quota = rateLimit(`delete-account:${user.id}`, {
    limit: 3,
    windowMs: 60 * 60 * 1000,
  });
  if (!quota.ok) {
    return jsonError(`操作太频繁，请 ${quota.retryAfterSeconds} 秒后再试`, 429);
  }

  const body = await readJsonBody(request);
  const confirm = cleanString(body.confirm, 32);
  if (confirm !== CONFIRM_TEXT) {
    return jsonError(`请准确输入「${CONFIRM_TEXT}」以确认注销`, 400);
  }

  try {
    // 顺序：先删从表，最后删主表（这样即使没有外键也不会留下孤儿数据）
    await execute("DELETE FROM messages WHERE user_id = ?", [user.id]);
    await execute("DELETE FROM conversations WHERE user_id = ?", [user.id]);
    await execute("DELETE FROM diaries WHERE user_id = ?", [user.id]);

    // 下面这几张表在老库上可能还不存在，删失败就跳过，不影响主流程
    for (const table of ["user_memories", "assessment_results", "user_sessions"]) {
      try {
        await execute(`DELETE FROM ${table} WHERE user_id = ?`, [user.id]);
      } catch {
        /* 表不存在时忽略 */
      }
    }

    const result = await execute("DELETE FROM users WHERE id = ?", [user.id]);
    if (!result.affectedRows) return jsonError("账号不存在或已被删除", 404);

    return json(
      { ok: true, message: "账号与全部数据已删除，感谢你曾经来过。" },
      200,
      // 顺手把登录 Cookie 清掉（userCookieOptions 只收 request，这里覆盖 maxAge 为 0）
      {
        "Set-Cookie": buildCookie(USER_COOKIE, "", {
          ...userCookieOptions(request),
          maxAge: 0,
        }),
      }
    );
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
