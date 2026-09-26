/**
 * 后台「压力评估」诊断接口（`/api/admin/stress`）。
 *
 * ⚠️ 为什么单独有这个接口：
 *    "压力明明很高，为什么没弹窗？"是这个功能最容易出的疑问，而原因可能有五六种
 *    （总开关没开 / 分数没到 / 还差一次 / 在冷却 / 上次放松没结束 / 用户自己关了）。
 *    光看界面看不出来，所以把**可判断的部分**全部聚合成一份诊断返回。
 *
 * ⚠️ **口径是聚合的，不暴露个体**：压力数据比聊天记录还敏感，
 *    这里给的是"最近 24 小时有多少条、最高多少分、超阈值几次、实际提醒几次"，
 *    以及"卡住的会话有几条" —— 足够定位问题，但看不出是谁。
 */
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import { execute, query } from "@/lib/db";
import { getGroup } from "@/lib/settings";
import { resolveThreshold } from "@/lib/stress-state";
import { clientIp, json, jsonError, readJsonBody } from "@/lib/util";

/** 一条放松会话超过这么久还没点"做完了"，就认为它是卡住的 */
const STUCK_SESSION_HOURS = 2;

export async function GET(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const config = await getGroup("safety").catch(() => ({}));
  const enabled = Boolean(config?.stressEnabled);
  const configThreshold = Number(config?.stressThreshold) || 0;
  const threshold = resolveThreshold(0, configThreshold);

  const stats = {
    total: 0,
    maxScore: 0,
    aboveThreshold: 0,
    triggered: 0,
    crisis: 0,
    users: 0,
  };

  try {
    const rows = await query(
      `SELECT
         COUNT(*)                                                  AS total,
         COALESCE(MAX(smoothed_score), 0)                          AS maxScore,
         SUM(CASE WHEN smoothed_score >= ? THEN 1 ELSE 0 END)      AS aboveThreshold,
         SUM(CASE WHEN triggered = 1 THEN 1 ELSE 0 END)            AS triggered,
         SUM(CASE WHEN crisis = 1 THEN 1 ELSE 0 END)               AS crisis,
         COUNT(DISTINCT user_id)                                   AS users
       FROM stress_logs
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
      [threshold]
    );

    if (rows.length) {
      stats.total = Number(rows[0].total) || 0;
      stats.maxScore = Number(rows[0].maxScore) || 0;
      stats.aboveThreshold = Number(rows[0].aboveThreshold) || 0;
      stats.triggered = Number(rows[0].triggered) || 0;
      stats.crisis = Number(rows[0].crisis) || 0;
      stats.users = Number(rows[0].users) || 0;
    }
  } catch (err) {
    stats.error = err?.code || err?.message || String(err);
  }

  // 卡住的放松会话：接受过、但一直没点"做完了"
  let stuckSessions = 0;
  try {
    const rows = await query(
      `SELECT COUNT(*) AS n FROM relaxation_sessions
        WHERE accepted = 1 AND completed = 0
          AND created_at < DATE_SUB(NOW(), INTERVAL ${STUCK_SESSION_HOURS} HOUR)`
    );
    stuckSessions = Number(rows[0]?.n || 0);
  } catch {
    /* 表还没建出来时忽略 */
  }

  // 跟踪中的用户数
  let trackingUsers = 0;
  try {
    const rows = await query("SELECT COUNT(*) AS n FROM user_stress_state");
    trackingUsers = Number(rows[0]?.n || 0);
  } catch {
    /* 同上 */
  }

  /* ---------------- 把"为什么不弹"翻译成人话 ---------------- */

  const notes = [];

  if (!enabled) {
    notes.push({
      level: "error",
      text: "⚠️ **压力评估总开关没打开** —— 整个功能不会跑，仪表盘也不会显示。就在这一页的最上面。",
    });
  }

  if (enabled && stats.total === 0) {
    notes.push({
      level: "warn",
      text: "最近 24 小时**一条压力记录都没有** —— 说明聊天时根本没跑分析（先确认有人聊过天，再确认这一页的配置保存过）。",
    });
  }

  if (stats.aboveThreshold > 0 && stats.triggered === 0) {
    notes.push({
      level: "warn",
      text: `有 **${stats.aboveThreshold} 次**分数达到阈值，但**一次提醒都没发出去** —— 说明卡在"连续两次 / 弹窗冷却 / 上次放松没结束"这几个条件上。如果下面显示有卡住的会话，点「修复」清掉再试。`,
    });
  }

  if (stuckSessions > 0) {
    notes.push({
      level: "warn",
      text: `有 **${stuckSessions} 条**"点过放松但没点做完了"的记录 —— 它们超过 ${STUCK_SESSION_HOURS} 小时会自动失效（不会永久堵住提醒），也可以点「修复」立即清掉。`,
    });
  }

  if (stats.crisis > 0) {
    notes.push({
      level: "info",
      text: `最近 24 小时有 **${stats.crisis} 次**命中危机词（这几条会跳过所有限制直接干预）。`,
    });
  }

  if (enabled && stats.total > 0 && stats.aboveThreshold === 0) {
    notes.push({
      level: "info",
      text: `最近 24 小时最高 ${stats.maxScore} 分，还没到阈值 ${threshold} —— 属于正常情况，说明大家聊得还比较平稳。想让提醒更灵敏就把阈值调低一点。`,
    });
  }

  return json({
    ok: true,
    enabled,
    configThreshold,
    threshold,
    stuckSessionHours: STUCK_SESSION_HOURS,
    stats,
    trackingUsers,
    stuckSessions,
    notes,
  });
}

/**
 * `POST` — 修复动作。
 *
 * `action: "fix"`：把"卡住的放松会话"直接标记成已完成。
 * 平时它们超过 2 小时会自动失效（`checkPopupTrigger` 里的时间窗），
 * 这个按钮是给"不想等"的情况用的。
 */
export async function POST(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);
  const action = String(body.action || "");

  if (action !== "fix") return jsonError("未知操作", 400);

  try {
    const result = await execute(
      `UPDATE relaxation_sessions
          SET completed = 1
        WHERE accepted = 1 AND completed = 0
          AND created_at < DATE_SUB(NOW(), INTERVAL ? HOUR)`,
      [STUCK_SESSION_HOURS]
    );

    const affected = Number(result?.affectedRows || 0);

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "stress_fix_sessions",
      detail: `清理卡住的放松会话 ${affected} 条`,
      ip: clientIp(request),
    });

    return json({
      ok: true,
      affected,
      message: affected
        ? `已清理 ${affected} 条卡住的会话，之后提醒可以正常触发`
        : "没有需要清理的会话",
    });
  } catch (err) {
    return jsonError(`清理失败：${err?.message || err}`, 500);
  }
}
