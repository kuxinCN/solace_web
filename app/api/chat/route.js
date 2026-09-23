/**
 * 用户端对话接口（支持流式）。
 *
 *   * 需要登录（AI 额度是按服务器上的 Key 消耗的）
 *   * 两种返回方式：
 *       - 流式：请求体带 stream: true → 返回 SSE（data: {"delta":"..."} … data: [DONE]）
 *       - 一次性：返回 { reply, fallback?, error? }
 *   * diaryContext（读日记时用）：插在 messages 最前面，只发给 AI、不落库、不返回
 *   * 配置（接口地址 / Key / 模型）从后台数据库读，数据库没配好时回退 .env.local
 */
import { requestChat } from "@/lib/ai";
import { rateLimit } from "@/lib/rate-limit";
import { getGroup } from "@/lib/settings";
import { getCurrentUser } from "@/lib/user-auth";
import { clientIp } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 按用户 + 按 IP 双层限流，防止被当成免费 AI 代理 */
const USER_RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 };
const IP_RATE_LIMIT = { limit: 120, windowMs: 60 * 1000 };

const MAX_MESSAGES = 60;
const MAX_CONTENT_CHARS = 8000;
const FALLBACK_REPLY = "我暂时无法回应，请稍后再试。";

/** .env.local 里的智谱配置，作为数据库配置缺失时的兜底 */
function envFallbackConfig() {
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) return null;
  return {
    enabled: true,
    baseUrl: process.env.ZHIPU_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
    apiKey,
    model: process.env.ZHIPU_MODEL || "glm-4-flash",
    temperature: 0.7,
    maxTokens: 1024,
    timeoutSeconds: 60,
  };
}

function normalizeMessages(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((item) => item && typeof item.content === "string" && item.content.trim())
    .slice(-MAX_MESSAGES)
    .map((item) => ({
      role: ["system", "user", "assistant"].includes(item.role) ? item.role : "user",
      content: String(item.content).slice(0, MAX_CONTENT_CHARS),
    }));
}

export async function POST(request) {
  const user = await getCurrentUser(request);
  if (!user) {
    return Response.json({ reply: FALLBACK_REPLY, error: "请先登录后再聊天" }, { status: 401 });
  }

  const ipQuota = rateLimit(`chat:ip:${clientIp(request) || "direct"}`, IP_RATE_LIMIT);
  const userQuota = rateLimit(`chat:user:${user.id}`, USER_RATE_LIMIT);
  const quota = ipQuota.ok ? userQuota : ipQuota;
  if (!quota.ok) {
    return Response.json(
      { reply: FALLBACK_REPLY, error: `请求过于频繁，请 ${quota.retryAfterSeconds} 秒后再试` },
      { status: 429 }
    );
  }

  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return Response.json({ reply: FALLBACK_REPLY, error: "请求体不是合法 JSON" });
  }

  const wantStream = payload?.stream === true;
  const messages = normalizeMessages(payload?.messages);

  if (typeof payload?.diaryContext === "string" && payload.diaryContext.trim()) {
    messages.unshift({
      role: "system",
      content:
        "以下是用户刚刚写的日记正文，仅供你理解情绪和上下文，不要在回复中复述原文：\n" +
        payload.diaryContext.slice(0, MAX_CONTENT_CHARS),
    });
  }

  if (!messages.length) {
    return Response.json({ reply: FALLBACK_REPLY, error: "没有可发送的内容" });
  }

  let config = null;
  try {
    config = await getGroup("ai");
  } catch {
    config = null;
  }
  if (!config || !config.apiKey) config = envFallbackConfig();

  if (!config) {
    return Response.json({
      reply: FALLBACK_REPLY,
      error: "对话 AI 尚未配置：请到后台「对话 AI」页面填写接口地址、API Key 和模型",
    });
  }

  // ---------------- 非流式：直接返回完整回复 ----------------
  if (!wantStream) {
    const result = await requestChat({ messages, config });
    if (!result.ok) {
      return Response.json({ reply: FALLBACK_REPLY, fallback: true, error: result.error });
    }
    return Response.json({ reply: result.reply, fallback: false });
  }

  // ---------------- 流式：把上游 SSE 逐段转发给前端 ----------------
  const baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
  const timeoutMs = Math.max(5, Number(config.timeoutSeconds) || 60) * 1000;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const send = (obj) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* 客户端可能已经断开 */
        }
      };
      const sendDone = () => {
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch {
          /* 忽略 */
        }
      };

      try {
        const upstream = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          signal:
            typeof AbortSignal?.timeout === "function"
              ? AbortSignal.timeout(timeoutMs)
              : undefined,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages,
            temperature: Number(config.temperature) || 0.7,
            max_tokens: Number(config.maxTokens) || 1024,
            stream: true,
          }),
        });

        if (!upstream.ok || !upstream.body) {
          send({ error: FALLBACK_REPLY });
          sendDone();
          return;
        }

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done: finished, value } = await reader.read();
          if (finished) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || ""; // 保留最后一段不完整的行

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;

            const data = trimmed.slice(5).trim();
            if (!data || data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed?.choices?.[0]?.delta?.content;
              if (delta) send({ delta });
            } catch {
              /* 忽略单行解析错误 */
            }
          }
        }

        sendDone();
      } catch {
        send({ error: FALLBACK_REPLY });
        sendDone();
      } finally {
        try {
          controller.close();
        } catch {
          /* 忽略 */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
