/**
 * 后台「运行指标」：GET /api/admin/metrics?days=7
 *
 * 两块数据：
 *   1. **数据库层**：查询总数、慢查询数、平均/最大耗时（来自 lib/db.js 的进程内统计，
 *      所以是"本次启动以来"的数据，重启清零）；
 *   2. **AI 用量**：调用次数、token 数、平均耗时，按功能拆分（chat / tts / mood / title）。
 *      用来回答"这个月花了多少额度、哪个功能最费"。
 *
 * 说明：`ai_usage` 表在老库上可能还没建出来，这时用量部分返回空，不报错。
 */
import { getAdminFromRequest } from "@/lib/admin-auth";
import { describeDbError, getDbStats, query } from "@/lib/db";
import { getApiStats } from "@/lib/perf";
import { json, jsonError } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DAYS = 30;

export async function GET(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const rawDays = Number.parseInt(new URL(request.url).searchParams.get("days") || "7", 10);
  const days = Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= MAX_DAYS ? rawDays : 7;
  const since = `DATE_SUB(CURDATE(), INTERVAL ${days - 1} DAY)`;

  const db = getDbStats();

  let usage = null;
  let safety = null;

  try {
    const [totalRows, byKindRows, trendRows, safetyRows] = await Promise.all([
      query(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
                COALESCE(SUM(completion_tokens), 0) AS completionTokens,
                COALESCE(ROUND(AVG(latency_ms)), 0) AS avgMs,
                COALESCE(MAX(latency_ms), 0) AS maxMs,
                COALESCE(SUM(ok = 0), 0) AS failures
           FROM ai_usage
          WHERE created_at >= ${since}`
      ),
      query(
        `SELECT kind,
                COUNT(*) AS calls,
                COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens,
                COALESCE(ROUND(AVG(latency_ms)), 0) AS avgMs
           FROM ai_usage
          WHERE created_at >= ${since}
          GROUP BY kind
          ORDER BY calls DESC`
      ),
      query(
        `SELECT DATE(created_at) AS d, COUNT(*) AS calls,
                COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens
           FROM ai_usage
          WHERE created_at >= ${since}
          GROUP BY DATE(created_at)
          ORDER BY d`
      ),
      query(
        `SELECT category, COUNT(*) AS n
           FROM safety_flags
          WHERE created_at >= ${since}
          GROUP BY category
          ORDER BY n DESC`
      ),
    ]);

    const total = totalRows[0] || {};
    usage = {
      days,
      calls: Number(total.calls) || 0,
      promptTokens: Number(total.promptTokens) || 0,
      completionTokens: Number(total.completionTokens) || 0,
      totalTokens: (Number(total.promptTokens) || 0) + (Number(total.completionTokens) || 0),
      avgMs: Number(total.avgMs) || 0,
      maxMs: Number(total.maxMs) || 0,
      failures: Number(total.failures) || 0,
      byKind: byKindRows.map((row) => ({
        kind: String(row.kind || ""),
        calls: Number(row.calls) || 0,
        tokens: Number(row.tokens) || 0,
        avgMs: Number(row.avgMs) || 0,
      })),
      trend: trendRows.map((row) => ({
        date: String(row.d).slice(0, 10),
        calls: Number(row.calls) || 0,
        tokens: Number(row.tokens) || 0,
      })),
    };

    safety = safetyRows.map((row) => ({
      category: String(row.category || ""),
      count: Number(row.n) || 0,
    }));
  } catch (err) {
    // 表还没建（老库升级中）时给出提示，不影响数据库统计部分
    usage = { days, calls: 0, error: describeDbError(err), byKind: [], trend: [] };
  }

  // 长期趋势：优先用按天汇总表（明细被清理后仍能看到历史）
  let daily = [];
  try {
    const dailyRows = await query(
      `SELECT day, kind, calls, prompt_tokens, completion_tokens, total_latency_ms, failures
         FROM ai_usage_daily
        WHERE day >= DATE_SUB(CURDATE(), INTERVAL ${days - 1} DAY)
        ORDER BY day, kind`
    );
    daily = dailyRows.map((row) => ({
      date: String(row.day).slice(0, 10),
      kind: String(row.kind || ""),
      calls: Number(row.calls) || 0,
      tokens: (Number(row.prompt_tokens) || 0) + (Number(row.completion_tokens) || 0),
      avgMs: Number(row.calls)
        ? Math.round(Number(row.total_latency_ms) / Number(row.calls))
        : 0,
      failures: Number(row.failures) || 0,
    }));
  } catch {
    daily = [];
  }

  return json({
    ok: true,
    database: db,
    api: getApiStats(),
    usage,
    daily,
    safety,
    note: "database 与 api 是「本次启动以来」的进程内统计（重启清零）；usage 来自明细表，daily 是长期按天汇总。",
  });
}
