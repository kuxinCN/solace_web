/**
 * `GET /api/stress/state` — 查当前压力状态。
 *
 * 前端用它做两件事：
 *   ① 仪表盘显示（分数 + 档位 + 趋势）；
 *   ② **复查有没有"该弹但没弹到"的弹窗** ——
 *      聊天场景的弹窗是随消息响应一起返回的，但用户如果关掉页面再回来，
 *      那次弹窗就丢了。这里会给一个 `pendingPopup` 补上。
 *
 * ⚠️ 返回里还带一份 `diagnostics`（**为什么现在没弹**）。
 *    "压力很高却没弹窗"是这个功能最容易出的问题，而原因可能有好几种
 *    （分数没到 / 还差一次 / 在冷却 / 用户关掉了 / 上次放松没结束……）。
 *    把判定理由直接回给调用方，排查时不用猜。
 *
 * ⚠️ 返回里**不包含任何"诊断性"措辞**：只有分数、档位名（后台配的中性词）、
 *    和一句描述状态的说明。这个系统不做诊断。
 */
import { getGroup } from "@/lib/settings";
import { BASE_SCORE, resolveLevel } from "@/lib/stress-analyzer";
import { getStressState } from "@/lib/stress-state";
import { buildPopupPayload, checkPopupTrigger, normalizeLevels } from "@/lib/stress-trigger";
import { getCurrentUser } from "@/lib/user-auth";
import { json, jsonError } from "@/lib/util";

export async function GET(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const config = await getGroup("safety").catch(() => ({}));

  // ⚠️ 开关关着就直接返回，不算分也不复查。
  //    原来这里漏了这个检查：功能关着，仪表盘照样显示一个从没更新过的 50 分，
  //    和聊天接口（那里检查了）的行为也不一致。
  if (!config?.stressEnabled) {
    return json({
      ok: true,
      enabled: false,
      score: null,
      level: null,
      levels: [],
      pendingPopup: null,
      methods: { breathing: false, butterfly: false },
      message: "压力评估未启用（后台「内容安全与压力」）",
    });
  }

  const levels = normalizeLevels(config);
  const state = await getStressState(user.id);

  const score = Number(state.combined_score ?? BASE_SCORE);
  const level = resolveLevel(score, levels);

  // 复查：当前分够高、条件都满足 → 给一个待弹窗
  let pendingPopup = null;
  let blockedReason = "";
  let threshold = 0;

  try {
    const decision = await checkPopupTrigger(user.id, score, "chat");
    threshold = Number(decision.threshold) || 0;
    blockedReason = decision.allow ? "" : String(decision.reason || "");

    if (decision.allow) {
      pendingPopup = buildPopupPayload({ score, source: "chat", levels, config });
    }
  } catch (err) {
    blockedReason = `复查失败：${err?.message || err}`;
  }

  return json({
    ok: true,
    enabled: true,
    score,
    chatScore: Number(state.chat_score ?? BASE_SCORE),
    diaryScore: Number(state.diary_score ?? BASE_SCORE),
    level,
    levels,
    threshold,
    popupEnabled: Number(state.popup_enabled) !== 0,
    diaryEnabled: Number(state.diary_enabled) !== 0,
    popupRejectCount: Number(state.popup_reject_count || 0),
    lastPopupAt: state.last_popup_at || null,
    methods: {
      breathing: config?.relaxOfferBreathing !== false,
      butterfly: config?.relaxOfferButterfly !== false,
    },
    pendingPopup,

    // ---- 排查用：为什么现在没弹 ----
    diagnostics: {
      score,
      threshold,
      thresholdSource: Number(state.threshold) > 0 ? "用户自定义" : "后台配置",
      configThreshold: Number(config?.stressThreshold) || 0,
      blockedReason,
      lastPopupAt: state.last_popup_at || null,
      rejectCount: Number(state.popup_reject_count || 0),
      msgCountSinceAnalyze: Number(state.msg_count_since_analyze || 0),
    },
  });
}
