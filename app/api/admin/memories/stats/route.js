/**
 * 长期记忆观测指标（后台）：GET /api/admin/memories/stats?days=7
 *
 * 返回按天的注入 / 压缩聚合 + 窗口总计：
 *   requests     发生记忆注入的聊天次数
 *   facts        累计注入条数（平均 facts/requests 即"每次聊天带了几条记忆"）
 *   chars        累计注入字符数
 *   compactRuns  压缩成功次数
 *   compactedRows 被标记失效的条数
 */
import { getAdminFromRequest } from "@/lib/admin-auth";
import { query, describeDbError } from "@/lib/db";
import { json, jsonError } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const url = new URL(request.url);
  const days = Math.max(1, Math.min(90, Number(url.searchParams.get("days")) || 7));

  try {
    const series = await query(
      `SELECT
         DATE_FORMAT(stat_date, '%Y-%m-%d') AS date,
         SUM(inject_requests) AS requests,
         SUM(inject_facts)    AS facts,
         SUM(inject_chars)    AS chars,
         SUM(compact_runs)    AS compactRuns,
         SUM(compacted_rows)  AS compactedRows
       FROM memory_stats_daily
       WHERE stat_date >= DATE_SUB(CURDATE(), INTERVAL ${days} DAY)
       GROUP BY stat_date
       ORDER BY stat_date ASC`
    );

    const totals = series.reduce(
      (acc, row) => ({
        requests: acc.requests + Number(row.requests || 0),
        facts: acc.facts + Number(row.facts || 0),
        chars: acc.chars + Number(row.chars || 0),
        compactRuns: acc.compactRuns + Number(row.compactRuns || 0),
        compactedRows: acc.compactedRows + Number(row.compactedRows || 0),
      }),
      { requests: 0, facts: 0, chars: 0, compactRuns: 0, compactedRows: 0 }
    );

    return json({
      ok: true,
      days,
      series,
      totals: {
        ...totals,
        // 每次聊天平均带几条记忆；没有注入记录时为 0
        avgFacts: totals.requests ? Math.round((totals.facts / totals.requests) * 10) / 10 : 0,
      },
    });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
