/**
 * `POST /api/stress/settings` — 用户自己的压力设置。
 *
 * ⚠️ 这里**只允许改三样东西**：
 *    · `threshold`      —— 阈值（用户嫌烦就往上调）
 *    · `popupEnabled`   —— 要不要弹窗
 *    · `diaryEnabled`   —— 要不要分析日记
 *
 *    ⚠️ **不允许用户关掉"危机识别"** —— 那不是打扰，是安全网。
 *       所以这里没有 `crisisEnabled` 这种开关。
 *
 * 阈值范围卡在 40-95 之间：太低会天天弹（用户很快就反感），
 * 太高等于没有这个功能（95 分几乎不可能达到）。
 */
import { getStressState, updateStressState } from "@/lib/stress-state";
import { getCurrentUser } from "@/lib/user-auth";
import { json, jsonError, readJsonBody } from "@/lib/util";

const MIN_THRESHOLD = 40;
const MAX_THRESHOLD = 95;

export async function GET(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const state = await getStressState(user.id);

  return json({
    ok: true,
    threshold: Number(state.threshold) || 70,
    popupEnabled: Number(state.popup_enabled) !== 0,
    diaryEnabled: Number(state.diary_enabled) !== 0,
    minThreshold: MIN_THRESHOLD,
    maxThreshold: MAX_THRESHOLD,
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
    patch.threshold = Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, Math.round(value)));
  }

  if (body.popupEnabled != null) patch.popup_enabled = body.popupEnabled ? 1 : 0;
  if (body.diaryEnabled != null) patch.diary_enabled = body.diaryEnabled ? 1 : 0;

  if (!Object.keys(patch).length) return jsonError("没有要修改的内容", 400);

  // 重新打开弹窗时，把阈值拉回合理区间（否则上次"不再提醒"留的高阈值会一直压着）
  if (patch.popup_enabled === 1) {
    const state = await getStressState(user.id);
    const current = Number(state.threshold) || 70;
    if (current > MAX_THRESHOLD) patch.threshold = MAX_THRESHOLD;
  }

  const saved = await updateStressState(user.id, patch);
  if (!saved) return jsonError("保存失败，请稍后再试", 500);

  const state = await getStressState(user.id);

  return json({
    ok: true,
    threshold: Number(state.threshold) || 70,
    popupEnabled: Number(state.popup_enabled) !== 0,
    diaryEnabled: Number(state.diary_enabled) !== 0,
  });
}
