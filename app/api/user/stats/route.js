/**
 * 用户端「我的」页面需要的统计数字（原前端是从 Supabase 分别查三次）。
 *   days          陪伴天数（注册当天算第 1 天）
 *   diaryCount    日记篇数
 *   todayMessages 今天的对话条数
 */
import { describeDbError, query } from "@/lib/db";
import { getCurrentUser } from "@/lib/user-auth";
import { json, jsonError, toMysqlDateTime } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  // 与写入时间口径一致：都按服务器本地时间的「今天 0 点」
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  try {
    const rows = await query(
      `SELECT
         (SELECT created_at FROM users WHERE id = ?) AS created_at,
         (SELECT COUNT(*) FROM diaries WHERE user_id = ?) AS diary_count,
         (SELECT COUNT(*) FROM messages WHERE user_id = ? AND created_at >= ?) AS today_messages`,
      [user.id, user.id, user.id, toMysqlDateTime(todayStart)]
    );

    const row = rows[0] || {};
    const createdAt = row.created_at
      ? new Date(String(row.created_at).replace(" ", "T"))
      : null;

    const days = createdAt
      ? Math.max(1, Math.floor((Date.now() - createdAt.getTime()) / 86400000) + 1)
      : 1;

    return json({
      ok: true,
      stats: {
        days,
        diaryCount: Number(row.diary_count || 0),
        todayMessages: Number(row.today_messages || 0),
        createdAt: row.created_at || null,
      },
    });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
