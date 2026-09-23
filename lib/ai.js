/**
 * 对话 AI 与文字转语音（TTS）调用。
 *
 * 两个接口都按「OpenAI 兼容」格式请求，所以智谱、阿里、字节（豆包）、
 * 兼容代理等只要端点格式一致，都能在后台改配置直接用，不必改代码。
 *   对话：POST {baseUrl}/chat/completions
 *   语音：POST {baseUrl}/audio/speech   （返回音频二进制）
 */
import { getGroup } from "./settings";

function joinUrl(baseUrl, path) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  return `${base}${path}`;
}

function extractErrorMessage(data, fallback) {
  if (!data) return fallback;
  if (typeof data === "string") return data.slice(0, 500);
  return (
    data?.error?.message ||
    data?.error?.code ||
    data?.message ||
    data?.msg ||
    fallback
  );
}

/**
 * 发起一次对话补全。
 * 返回 { ok, reply, error }——永远不抛异常，方便上层兜底。
 */
export async function requestChat({ messages, config, signal }) {
  const aiConfig = config || (await getGroup("ai"));

  if (!aiConfig.enabled) {
    return { ok: false, error: "对话 AI 当前处于关闭状态（可在后台开启）" };
  }
  if (!aiConfig.apiKey || !aiConfig.baseUrl || !aiConfig.model) {
    return { ok: false, error: "对话 AI 尚未配置完成，请到后台「AI」页面填写" };
  }

  const timeoutMs = Math.max(5, Number(aiConfig.timeoutSeconds) || 60) * 1000;
  const timeoutSignal = typeof AbortSignal?.timeout === "function"
    ? AbortSignal.timeout(timeoutMs)
    : null;

  try {
    const res = await fetch(joinUrl(aiConfig.baseUrl, "/chat/completions"), {
      method: "POST",
      signal: signal || timeoutSignal || undefined,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aiConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: aiConfig.model,
        messages,
        temperature: Number(aiConfig.temperature) || 0.7,
        max_tokens: Number(aiConfig.maxTokens) || 1024,
      }),
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!res.ok) {
      return {
        ok: false,
        error: `AI 接口返回 ${res.status}：${extractErrorMessage(data, "调用失败")}`,
      };
    }

    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) {
      return { ok: false, error: "AI 接口没有返回内容" };
    }
    return { ok: true, reply: String(reply).trim() };
  } catch (err) {
    const message =
      err?.name === "TimeoutError" || err?.name === "AbortError"
        ? `AI 接口超时（${timeoutMs / 1000} 秒）`
        : `AI 接口请求失败：${err?.message || err}`;
    return { ok: false, error: message };
  }
}

/**
 * 文字转语音。返回 { ok, buffer, contentType, error }
 */
export async function requestSpeech({ text, voice, config }) {
  const ttsConfig = config || (await getGroup("tts"));

  if (!ttsConfig.enabled) {
    return { ok: false, error: "语音合成当前处于关闭状态（可在后台开启）" };
  }
  if (!ttsConfig.apiKey || !ttsConfig.baseUrl || !ttsConfig.model || !ttsConfig.voice) {
    return { ok: false, error: "语音合成配置不完整，请到后台「TTS」页面填写" };
  }
  const content = String(text || "").trim();
  if (!content) return { ok: false, error: "要合成的文字不能为空" };
  if (content.length > 1000) return { ok: false, error: "单次合成的文字不能超过 1000 字" };

  const timeoutMs = Math.max(5, Number(ttsConfig.timeoutSeconds) || 60) * 1000;

  try {
    const res = await fetch(joinUrl(ttsConfig.baseUrl, "/audio/speech"), {
      method: "POST",
      signal: typeof AbortSignal?.timeout === "function"
        ? AbortSignal.timeout(timeoutMs)
        : undefined,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ttsConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: ttsConfig.model,
        input: content,
        voice: voice || ttsConfig.voice,
        speed: Number(ttsConfig.speed) || 1,
        response_format: ttsConfig.format || "mp3",
      }),
    });

    if (!res.ok) {
      const raw = await res.text();
      let data = null;
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
      return {
        ok: false,
        error: `语音接口返回 ${res.status}：${extractErrorMessage(data, "合成失败")}`,
      };
    }

    const arrayBuffer = await res.arrayBuffer();
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      return { ok: false, error: "语音接口没有返回音频数据" };
    }

    const contentType = res.headers.get("content-type") || "audio/mpeg";
    return {
      ok: true,
      buffer: Buffer.from(arrayBuffer),
      contentType,
    };
  } catch (err) {
    const message =
      err?.name === "TimeoutError" || err?.name === "AbortError"
        ? `语音接口超时（${timeoutMs / 1000} 秒）`
        : `语音接口请求失败：${err?.message || err}`;
    return { ok: false, error: message };
  }
}
