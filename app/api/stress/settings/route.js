/**
 * `GET / POST /api/stress/settings` — 用户自己的压力设置。
 *
 * ⚠️ 这里**只允许改三样东西**：
 *    · `threshold`      —— 阈值（用户嫌烦就往上调）
 *    · `popupEnabled`   —— 要不要提醒
 *    · `diaryEnabled`   —— 要不要分析日记
 *
 *    ⚠️ **不允许用户关掉"危机识别"** —— 那不是打扰，是安全网。
 *       所以这里没有 `crisisEnabled` 这种开关。
 *
 * ⚠️ 阈值的语义（这里踩过坑，改之前先读）：
 *    `user_stress_state.threshold = 0` 表示"**跟随后台配置**"，不是"阈值 0 分"。
 *    读取一律走 `resolveThreshold(state.threshold, config.stressThreshold)`。
 *    早期版本把默认值 70 直接落库，导致管理员在后台怎么改都不生效。
 */
import { getGroup } from "@/lib/settings";
import {
  MAX_USER_THRESHOLD,
  MIN_USER_THRESHOLD,
  getStressState,
  resolveThreshold,
  updateStressState,
} from "@/lib/stress-state";
import { getCurrentUser } from "@/lib/user-auth";
import { json, jsonError, readJsonBody } from "@/lib/util";

/** 当前生效的阈值 + 它是从哪来的（前端可以据此显示"跟随后台"还是"你自己设的"） */
async function thresholdSnapshot(state) {
  const config = await getGroup("safety").catch(() => ({}));
  const userValue = Number(state.threshold) || 0;

  return {
    threshold: resolveThreshold(state.threshold, config?.stressThreshold),
    source: userValue > 0 ? "user" : "config",
    userThreshold: userValue,
    configThreshold: Number(config?.stressThreshold) || 0,
  };
}

export async function GET(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const state = await getStressState(user.id);
  const snapshot = await thresholdSnapshot(state);

  return json({
    ok: true,
    ...snapshot,
    popupEnabled: Number(state.popup_enabled) !== 0,
    diaryEnabled: Number(state.diary_enabled) !== 0,
    minThreshold: MIN_USER_THRESHOLD,
    maxThreshold: MAX_USER_THRESHOLD,
  });
}

export async function POST(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const body = await readJsonBody(request);
  const patch = {};

  if (body.threshold != null) {
    const value = Number(body.threshold);
    if (!Number.isFinite(value)) return jsonError("阈值必须是数字", 400);

    const rounded = Math.round(value);

    // ⚠️ 传 0 = "跟随后台配置"（用户想恢复默认）
    patch.threshold =
      rounded <= 0 ? 0 : Math.max(MIN_USER_THRESHOLD, Math.min(MAX_USER_THRESHOLD, rounded));
  }

  if (body.popupEnabled != null) patch.popup_enabled = body.popupEnabled ? 1 : 0;
  if (body.diaryEnabled != null) patch.diary_enabled = body.diaryEnabled ? 1 : 0;

  if (!Object.keys(patch).length) return jsonError("没有要修改的内容", 400);

  const state = await getStressState(user.id);

  // 重新打开提醒时，把用户之前被抬高的阈值**放开**（回到跟随后台）。
  // ⚠️ 否则「不再提醒」（会把阈值往上带）之后再打开开关，用户会发现
  //    "打开了但再也不弹" —— 以为开关没生效。
  if (patch.popup_enabled === 1 && patch.threshold == null) {
    if ((Number(state.threshold) || 0) > 0) patch.threshold = 0;
  }

  const saved = await updateStressState(user.id, patch);
  if (!saved) return jsonError("保存失败，请稍后再试", 500);

  const next = await getStressState(user.id);
  const snapshot = await thresholdSnapshot(next);

  return json({
    ok: true,
    ...snapshot,
    popupEnabled: Number(next.popup_enabled) !== 0,
    diaryEnabled: Number(next.diary_enabled) !== 0,
  });
}
