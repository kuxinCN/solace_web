/**
 * `GET /api/stress/state` — 查当前压力状态。
 *
 * 前端用它做两件事：
 *   ① 仪表盘显示（分数 + 档位 + 趋势）；
 *   ② **复查有没有"该弹但没弹到"的弹窗** ——
 *      聊天场景的弹窗是随消息响应一起返回的，但用户如果关掉页面再回来，
 *      那次弹窗就丢了。这里会给一个 `pendingPopup` 补上。
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
  // ⚠️ 传整个 config：档位是平铺标量，由 normalizeLevels 组装
  const levels = normalizeLevels(config);
  const state = await getStressState(user.id);

  const score = Number(state.combined_score ?? BASE_SCORE);
  const level = resolveLevel(score, levels);

  // 复查：当前分够高、还没被弹过 → 给一个待弹窗
  let pendingPopup = null;
  try {
    const decision = await checkPopupTrigger(user.id, score, "chat");
    if (decision.allow) {
      pendingPopup = buildPopupPayload({ score, source: "chat", levels, config });
    }
  } catch {
    /* 复查失败不影响状态返回 */
  }

  return json({
    ok: true,
    score,
    chatScore: Number(state.chat_score ?? BASE_SCORE),
    diaryScore: Number(state.diary_score ?? BASE_SCORE),
    level,
    levels,
    threshold: Number(state.threshold ?? config?.stressThreshold ?? 70),
    popupEnabled: Number(state.popup_enabled) !== 0,
    diaryEnabled: Number(state.diary_enabled) !== 0,
    popupRejectCount: Number(state.popup_reject_count || 0),
    lastPopupAt: state.last_popup_at || null,
    methods: {
      breathing: config?.relaxOfferBreathing !== false,
      butterfly: config?.relaxOfferButterfly !== false,
    },
    pendingPopup,
  });
}
