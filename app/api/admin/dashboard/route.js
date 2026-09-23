/**
 * 后台数据看板：GET /api/admin/dashboard?days=7
 *
 * 用途：后台首页的趋势图 —— 用户增长、消息量、活跃度、日记情绪分布。
 *
 * 设计约定：
 *   * 只做只读聚合查询，全部走 COUNT / GROUP BY，不拉明细行；
 *   * 排行榜里的邮箱做掩码（`ab***@qq.com`），后台也不需要看完整邮箱；
 *   * days 参数强校验为 1~30 的整数，避免拼接出非法 SQL。
 */
import { getAdminFromRequest } from "@/lib/admin-auth";
import { describeDbError, query } from "@/lib/db";
import { ensureUserColumnsOnce } from "@/lib/schema";
import { json, jsonError } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DAYS = 30;

/** 邮箱掩码：保留前两位 + 域名 */
function maskEmail(email) {
  const text = String(email || "");
  const at = text.indexOf("@");
  if (at <= 0) return text;
  const name = text.slice(0, at);
  const domain = text.slice(at);
  if (name.length <= 2) return `${name.slice(0, 1)}***${domain}`;
  return `${name.slice(0, 2)}***${domain}`;
}

/** 把稀疏的 GROUP BY 结果补成连续日期序列，方便前端直接画图 */
function fillSeries(rows, days) {
  const map = new Map();
  for (const row of rows) {
    map.set(String(row.d).slice(0, 10), Number(row.n) || 0);
  }

  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
    out.push({ date: key, count: map.get(key) || 0 });
  }
  return out;
}

export async function GET(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const url = new URL(request.url);
  const rawDays = Number.parseInt(url.searchParams.get("days") || "7", 10);
  const days =
    Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= MAX_DAYS ? rawDays : 7;
  const since = `DATE_SUB(CURDATE(), INTERVAL ${days - 1} DAY)`;

  // 老部署升级时自动补上新列（diaries.mood 等）。
  // 看板要读 diaries.mood，如果这列还没补上会直接报 Unknown column，所以先确保一次。
  try {
    await ensureUserColumnsOnce();
  } catch {
    /* 补列失败不阻塞流程，下面的查询会把具体错误带出来 */
  }

  try {
    const [totalsRows, todayRows, activeRows, userTrend, msgTrend, moodRows, topRows] =
      await Promise.all([
        query(
          `SELECT
             (SELECT COUNT(*) FROM users)         AS users,
             (SELECT COUNT(*) FROM conversations) AS conversations,
             (SELECT COUNT(*) FROM messages)      AS messages,
             (SELECT COUNT(*) FROM diaries)       AS diaries`
        ),
        query(
          `SELECT
             (SELECT COUNT(*) FROM users    WHERE created_at >= CURDATE()) AS newUsers,
             (SELECT COUNT(*) FROM messages WHERE created_at >= CURDATE()) AS newMessages,
             (SELECT COUNT(*) FROM diaries  WHERE created_at >= CURDATE()) AS newDiaries`
        ),
        query(
          `SELECT COUNT(DISTINCT user_id) AS n FROM messages WHERE created_at >= ${since}`
        ),
        query(
          `SELECT DATE(created_at) AS d, COUNT(*) AS n
             FROM users
            WHERE created_at >= ${since}
            GROUP BY DATE(created_at)
            ORDER BY d`
        ),
        query(
          `SELECT DATE(created_at) AS d, COUNT(*) AS n
             FROM messages
            WHERE created_at >= ${since}
            GROUP BY DATE(created_at)
            ORDER BY d`
        ),
        query(
          `SELECT mood, COUNT(*) AS n
             FROM diaries
            WHERE mood IS NOT NULL AND created_at >= ${since}
            GROUP BY mood
            ORDER BY n DESC`
        ),
        query(
          `SELECT u.id, u.email, u.username, u.avatar_url, COUNT(m.id) AS messageCount
             FROM users u
             JOIN messages m ON m.user_id = u.id
            WHERE m.created_at >= ${since}
            GROUP BY u.id, u.email, u.username, u.avatar_url
            ORDER BY messageCount DESC
            LIMIT 5`
        ),
      ]);

    const totals = totalsRows[0] || {};
    const today = todayRows[0] || {};

    return json({
      ok: true,
      days,
      totals: {
        users: Number(totals.users) || 0,
        conversations: Number(totals.conversations) || 0,
        messages: Number(totals.messages) || 0,
        diaries: Number(totals.diaries) || 0,
      },
      today: {
        newUsers: Number(today.newUsers) || 0,
        newMessages: Number(today.newMessages) || 0,
        newDiaries: Number(today.newDiaries) || 0,
      },
      activeUsers: Number(activeRows[0]?.n) || 0,
      userTrend: fillSeries(userTrend, days),
      messageTrend: fillSeries(msgTrend, days),
      moodDistribution: moodRows.map((row) => ({
        mood: String(row.mood || ""),
        count: Number(row.n) || 0,
      })),
      topUsers: topRows.map((row) => ({
        id: row.id,
        email: maskEmail(row.email),
        username: row.username || "",
        avatarUrl: row.avatar_url || "",
        messageCount: Number(row.messageCount) || 0,
      })),
    });
  } catch (err) {
    return jsonError(describeDbError(err, { detailed: true }), 500);
  }
}
