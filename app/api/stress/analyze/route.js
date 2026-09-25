/**
 * `POST /api/stress/analyze` — 压力分析入口。
 *
 * 两个用途：
 *   ① **正常流程不用调它** —— 聊天接口和日记保存接口内部已经各自调了
 *      `onUserMessage` / `onDiarySave`（这样才可能有实时性）；
 *   ② 留给**前端补算 / 手动刷新 / 其它入口**用，也是规格里定义的正式接口。
 *
 * `GET` 返回"当前状态 + 档位 + 最近趋势"，一次拿全，前端不用拼好几个请求。
 */
import { getGroup } from "@/lib/settings";
import { onDiarySave, onUserMessage, normalizeLevels, stressTrend } from "@/lib/stress-trigger";
import { BASE_SCORE, resolveLevel } from "@/lib/stress-analyzer";
import { getStressState } from "@/lib/stress-state";
import { getCurrentUser } from "@/lib/user-auth";
import { cleanString, json, jsonError, readJsonBody } from "@/lib/util";

/** 取配置里的档位表（归一化过的） */
async function loadLevels() {
  const config = await getGroup("safety").catch(() => ({}));
  return {
    // ⚠️ 传**整个 config**：档位在配置里是平铺的标量（level1Max / level1Label…），
    //    normalizeLevels 负责组装成数组
    levels: normalizeLevels(config),
    config: config || {},
  };
}

export async function GET(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const { levels, config } = await loadLevels();
  const state = await getStressState(user.id);
  const history = await stressTrend(user.id);

  const score = Number(state.combined_score ?? BASE_SCORE);
  const values = history.map((item) => Number(item.smoothed_score ?? item.score ?? BASE_SCORE));

  // 简单趋势：最近 3 次均值 − 更早的均值
  const recent = values.slice(-3);
  const earlier = values.slice(0, Math.max(0, values.length - 3));
  const average = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
  const trend = recent.length && earlier.length ? Math.round(average(recent) - average(earlier)) : 0;

  return json({
    ok: true,
    score,
    chatScore: Number(state.chat_score ?? BASE_SCORE),
    diaryScore: Number(state.diary_score ?? BASE_SCORE),
    level: resolveLevel(score, levels),
    levels,
    threshold: Number(state.threshold ?? config?.stressThreshold ?? 70),
    popupEnabled: Number(state.popup_enabled) !== 0,
    diaryEnabled: Number(state.diary_enabled) !== 0,
    popupRejectCount: Number(state.popup_reject_count || 0),
    lastPopupAt: state.last_popup_at || null,
    trend,
    history: history.map((item) => ({
      score: Number(item.smoothed_score ?? item.score ?? BASE_SCORE),
      source: item.source,
      crisis: Number(item.crisis) === 1,
      at: item.created_at,
    })),
  });
}

export async function POST(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const body = await readJsonBody(request);
  const source = body.source === "diary" ? "diary" : "chat";

  /* ---- 日记：整篇分析 ---- */
  if (source === "diary") {
    const content = cleanString(body.content, 20000);
    if (!content) return jsonError("内容不能为空", 400);

    const result = await onDiarySave(user.id, content, { diaryDate: body.diaryDate || null });
    return json({ ok: true, ...result });
  }

  /* ---- 聊天：单条消息 ---- */
  const message = cleanString(body.content, 2000);
  if (!message) {
    // 也允许直接传数组（规格里的 messages 字段）
    const list = Array.isArray(body.messages) ? body.messages.filter(Boolean).map(String) : [];
    if (!list.length) return jsonError("内容不能为空", 400);

    const result = await onUserMessage(user.id, list.join("\n").slice(0, 2000));
    return json({ ok: true, ...result });
  }

  const result = await onUserMessage(user.id, message);
  return json({ ok: true, ...result });
}
