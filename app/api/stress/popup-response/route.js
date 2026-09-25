/**
 * `POST /api/stress/popup-response` — 用户对弹窗的回应。
 *
 * 四种回应，对应三种处置：
 *
 * | action    | 含义           | 处置 |
 * |-----------|----------------|------|
 * | `accept`  | 现在做         | 开一次放松会话，**拒绝计数归零** |
 * | `later`   | 等一下         | 记一次拒绝，**阈值 +5**（最高 90） |
 * | `decline` | 不用了，谢谢   | 同上（语义上更彻底，但机制一致） |
 * | `never`   | 不再提醒       | 关掉弹窗开关，之后不再弹 |
 *
 * ⚠️ **拒绝就抬高阈值**是这个功能的核心礼貌：
 *    用户说"不用"之后，系统要**真的变得更含蓄**，而不是过一会儿又来问。
 *    阈值最高抬到 90 —— 留一点余地，因为危机情况仍然要能弹出来
 *    （危机弹窗走的是另一条路，不受阈值影响）。
 */
import { execute } from "@/lib/db";
import { clampScore, getStressState, updateStressState } from "@/lib/stress-state";
import { getCurrentUser } from "@/lib/user-auth";
import { json, jsonError, readJsonBody } from "@/lib/util";

/** 拒绝后的阈值上限 */
const MAX_THRESHOLD = 90;

/** 每次拒绝抬多少 */
const THRESHOLD_STEP = 5;

const ACTIONS = new Set(["accept", "later", "decline", "never"]);

export async function POST(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const body = await readJsonBody(request);
  const action = ACTIONS.has(String(body.action)) ? String(body.action) : "decline";
  const source = body.source === "diary" ? "diary" : "chat";
  const method = String(body.method || "").slice(0, 24);
  const scoreBefore = clampScore(body.score);

  const state = await getStressState(user.id);
  const threshold = Number(state.threshold) || 70;

  try {
    /* ---- 接受：开一次放松会话 ---- */
    if (action === "accept") {
      const result = await execute(
        `INSERT INTO relaxation_sessions
           (user_id, trigger_source, trigger_score, method, accepted, completed, score_before)
         VALUES (?, ?, ?, ?, 1, 0, ?)`,
        [user.id, source, scoreBefore, method || null, scoreBefore]
      );

      await updateStressState(user.id, {
        popup_reject_count: 0,
        last_popup_at: new Date(),
      });

      return json({ ok: true, action, sessionId: result.insertId });
    }

    /* ---- 不再提醒：直接关掉弹窗 ---- */
    if (action === "never") {
      await execute(
        `INSERT INTO relaxation_sessions
           (user_id, trigger_source, trigger_score, accepted, completed)
         VALUES (?, ?, ?, 0, 0)`,
        [user.id, source, scoreBefore]
      );

      await updateStressState(user.id, {
        popup_enabled: 0,
        popup_reject_count: Number(state.popup_reject_count || 0) + 1,
        last_popup_at: new Date(),
      });

      return json({
        ok: true,
        action,
        popupEnabled: false,
        message: "好的，之后不再自动提醒。想重新打开可以在「我的 → 压力设置」里改回来。",
      });
    }

    /* ---- 拒绝 / 等一下：抬阈值 ---- */
    const nextThreshold = Math.min(MAX_THRESHOLD, threshold + THRESHOLD_STEP);

    await execute(
      `INSERT INTO relaxation_sessions
         (user_id, trigger_source, trigger_score, accepted, completed)
       VALUES (?, ?, ?, 0, 0)`,
      [user.id, source, scoreBefore]
    );

    await updateStressState(user.id, {
      popup_reject_count: Number(state.popup_reject_count || 0) + 1,
      threshold: nextThreshold,
      last_popup_at: new Date(),
    });

    return json({
      ok: true,
      action,
      threshold: nextThreshold,
      message: "好，那先不打扰你。",
    });
  } catch (err) {
    return jsonError(`记录失败：${err?.message || err}`, 500);
  }
}

/**
 * `PATCH` — 放松做完了，补一次"完成"回执。
 *
 * 有这个记录之后，后台才能回答"放松到底有没有用"
 * （对比 `score_before` 和 `score_after`）。
 */
export async function PATCH(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const body = await readJsonBody(request);
  const sessionId = Number.parseInt(String(body.sessionId ?? ""), 10);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return jsonError("缺少会话 id", 400);

  const after = body.scoreAfter == null ? null : clampScore(body.scoreAfter);

  try {
    await execute(
      `UPDATE relaxation_sessions
          SET completed = 1, score_after = ?
        WHERE id = ? AND user_id = ?`,
      [after, sessionId, user.id]
    );

    // 做完放松，把拒绝计数清掉 —— 用户是愿意接受的
    await updateStressState(user.id, { popup_reject_count: 0 });

    return json({ ok: true });
  } catch (err) {
    return jsonError(`记录失败：${err?.message || err}`, 500);
  }
}
