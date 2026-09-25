/**
 * AI 调用量统计：把每次调用记进 `ai_usage` 表。
 *
 * 为什么要单独一张表：AI 是按 token 计费的，月底想回答"这个月花了多少、
 * 哪个功能最费"就得有明细。表里只记数字（token 数、耗时、成功与否），
 * **不记任何对话内容**。
 *
 * ⚠️ 写入失败一律吞掉 —— 统计是锦上添花，绝不能因为它让聊天报错。
 */
import { execute } from "./db";
import { cleanString } from "./util";

const ALLOWED_KINDS = ["chat", "tts", "mood", "title"];

export async function recordAiUsage({
  userId = null,
  kind = "chat",
  model = "",
  usage = null,
  latencyMs = 0,
  ok = true,
} = {}) {
  try {
    const promptTokens = Number(usage?.prompt_tokens ?? usage?.promptTokens ?? 0) || 0;
    const completionTokens =
      Number(usage?.completion_tokens ?? usage?.completionTokens ?? 0) || 0;

    await execute(
      `INSERT INTO ai_usage
         (user_id, kind, model, prompt_tokens, completion_tokens, latency_ms, ok)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        ALLOWED_KINDS.includes(kind) ? kind : "chat",
        cleanString(model, 120) || null,
        Math.max(0, promptTokens),
        Math.max(0, completionTokens),
        Math.max(0, Math.round(Number(latencyMs) || 0)),
        ok ? 1 : 0,
      ]
    );
  } catch {
    /* 统计失败不影响主流程 */
  }
}
