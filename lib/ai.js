/**
 * 对话 AI 与文字转语音（TTS）调用。
 *
 * 两个接口都按「OpenAI 兼容」格式请求，所以智谱、阿里、字节（豆包）、
 * 兼容代理等只要端点格式一致，都能在后台改配置直接用，不必改代码。
 *   对话：POST {baseUrl}/chat/completions
 *   语音：POST {baseUrl}/audio/speech   （返回音频二进制）
 */
import { getGroup } from "./settings";

/**
 * 把后台填的「接口地址」补成完整的 Chat Completions 端点。
 * 官方文档给的是完整地址（…/v1/chat/completions），很多人会整段粘进后台，
 * 所以这里两种填法都兼容：
 *   https://api.xiaomimimo.com/v1                  → …/v1/chat/completions
 *   https://api.xiaomimimo.com/v1/chat/completions → 原样使用，不再重复拼接
 */
export function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

/** 同理：补成 OpenAI 兼容的语音端点，允许直接填完整地址 {baseUrl}/audio/speech */
function speechUrl(baseUrl) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  return /\/audio\/speech$/i.test(base) ? base : `${base}/audio/speech`;
}

// ---------------------------------------------------------------------------
// 轻量的 AI 派生任务：日记情绪标签、对话标题
// ---------------------------------------------------------------------------

/**
 * 情绪标签词表。
 * 只用「温和的描述」，不用诊断性词汇（如"抑郁""焦虑"），也不做数值评分 ——
 * 这个产品的定位是陪伴，标签的作用是让用户觉得「被看见」，不是给他的情绪打分。
 */
export const MOOD_LABELS = [
  "轻快",
  "平静",
  "安稳",
  "有点沉",
  "疲惫",
  "烦躁",
  "孤单",
  "说不清",
];

const MOOD_PROMPT = `你是一位温和的倾听者。请阅读下面这段日记，从这组词里选出最贴近作者此刻状态的一个：
轻快 / 平静 / 安稳 / 有点沉 / 疲惫 / 烦躁 / 孤单 / 说不清

规则：
- 只输出那一个词，不要标点、不要解释、不要换行。
- 只描述感受，不评价好坏，不给建议，不做任何诊断。
- 拿不准就输出「说不清」。`;

/** 从模型输出里挑出一个合法标签（白名单，防止乱输出） */
function pickMood(raw) {
  const text = String(raw || "").replace(/\s+/g, "");
  if (!text) return "说不清";
  const exact = MOOD_LABELS.find((item) => text === item);
  if (exact) return exact;
  return MOOD_LABELS.find((item) => text.includes(item)) || "说不清";
}

/**
 * 分析日记情绪，返回 { ok, mood }。
 * 注意：只返回词表里的标签，模型即使胡说也只会落到「说不清」。
 */
export async function analyzeDiaryMood({ text, config }) {
  const content = String(text || "").trim();
  if (!content) return { ok: false, error: "日记内容为空" };

  const result = await requestChat({
    messages: [
      { role: "system", content: MOOD_PROMPT },
      { role: "user", content: content.slice(0, 4000) },
    ],
    config,
    maxTokens: 12,
  });

  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, mood: pickMood(result.reply) };
}

const TITLE_PROMPT = `根据下面这段对话，用不超过 12 个字概括它的主题，像聊天列表里的会话名那样。
只输出标题本身：不要引号、不要句号、不要换行、不要解释。`;

/** 清掉模型可能加上的引号/句号/换行，并限制长度 */
function cleanGeneratedTitle(raw) {
  return String(raw || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/^[\s"'「『（(【\[]+/, "")
    .replace(/[\s"'」』）)】\]]+$/, "")
    .replace(/[。！？!?，,、；;：:]+$/, "")
    .trim()
    .slice(0, 24);
}

/** 根据最近的几条消息生成对话标题，返回 { ok, title } */
export async function generateConversationTitle({ messages, config }) {
  const dialogue = (Array.isArray(messages) ? messages : [])
    .filter((item) => item && (item.role === "user" || item.role === "assistant"))
    .slice(-6)
    .map(
      (item) =>
        `${item.role === "user" ? "用户" : "AI"}：${String(item.content || "").slice(0, 300)}`
    )
    .join("\n");

  if (!dialogue.trim()) return { ok: false, error: "没有可用的对话内容" };

  const result = await requestChat({
    messages: [
      { role: "system", content: TITLE_PROMPT },
      { role: "user", content: dialogue },
    ],
    config,
    maxTokens: 24,
  });

  if (!result.ok) return { ok: false, error: result.error };

  const title = cleanGeneratedTitle(result.reply);
  if (!title) return { ok: false, error: "标题生成为空" };
  return { ok: true, title };
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
export async function requestChat({ messages, config, signal, maxTokens }) {
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
    const res = await fetch(chatCompletionsUrl(aiConfig.baseUrl), {
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
        max_tokens: Number(maxTokens) || Number(aiConfig.maxTokens) || 1024,
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
 *
 * 支持两种接口协议（在后台「语音 TTS」里选）：
 *   * openai-compatible：POST {baseUrl}/audio/speech，接口直接返回音频二进制
 *   * mimo-chat        ：POST {baseUrl}/chat/completions，音频是 base64 放在 JSON 里（小米 MiMo）
 */
export async function requestSpeech({ text, voice, config }) {
  const ttsConfig = config || (await getGroup("tts"));

  if (!ttsConfig.enabled) {
    return { ok: false, error: "语音合成当前处于关闭状态（可在后台开启）" };
  }

  const provider = String(ttsConfig.provider || "openai-compatible").toLowerCase();
  if (provider.includes("mimo") || provider.includes("xiaomi")) {
    return requestSpeechMimo({ text, voice, config: ttsConfig });
  }
  return requestSpeechOpenAI({ text, voice, config: ttsConfig });
}

function prepareSpeechInput({ text, config }) {
  if (!config.apiKey || !config.baseUrl || !config.model) {
    return { error: "语音合成配置不完整，请到后台「TTS」页面填写" };
  }

  const content = String(text || "").trim();
  if (!content) return { error: "要合成的文字不能为空" };
  if (content.length > 1000) return { error: "单次合成的文字不能超过 1000 字" };

  return {
    content,
    timeoutMs: Math.max(5, Number(config.timeoutSeconds) || 60) * 1000,
    baseUrl: String(config.baseUrl || "").trim().replace(/\/+$/, ""),
  };
}

function describeFetchError(err, timeoutMs, label) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return `${label}超时（${timeoutMs / 1000} 秒）`;
  }
  return `${label}请求失败：${err?.message || err}`;
}

/** OpenAI 兼容：POST {baseUrl}/audio/speech，直接返回音频二进制 */
async function requestSpeechOpenAI({ text, voice, config }) {
  const prepared = prepareSpeechInput({ text, config });
  if (prepared.error) return { ok: false, error: prepared.error };

  const { content, timeoutMs, baseUrl } = prepared;
  if (!config.voice) return { ok: false, error: "请先填写默认音色" };

  try {
    const res = await fetch(speechUrl(baseUrl), {
      method: "POST",
      signal: typeof AbortSignal?.timeout === "function"
        ? AbortSignal.timeout(timeoutMs)
        : undefined,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        input: content,
        voice: voice || config.voice,
        speed: Number(config.speed) || 1,
        response_format: config.format || "mp3",
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

    return {
      ok: true,
      buffer: Buffer.from(arrayBuffer),
      contentType: res.headers.get("content-type") || "audio/mpeg",
    };
  } catch (err) {
    return { ok: false, error: describeFetchError(err, timeoutMs, "语音接口") };
  }
}

/**
 * 小米 MiMo（走 OpenAI Chat Completions 格式）：
 *   POST {baseUrl}/chat/completions
 *   headers: api-key: xxx
 *   body:    { model, messages: [{ role: "assistant", content: 要合成的文本 }], audio: { format, voice } }
 *   响应:    choices[0].message.audio.data（base64 音频）
 */
async function requestSpeechMimo({ text, voice, config }) {
  const prepared = prepareSpeechInput({ text, config });
  if (prepared.error) return { ok: false, error: prepared.error };

  const { content, timeoutMs, baseUrl } = prepared;
  const format = ["wav", "mp3", "pcm", "pcm16"].includes(String(config.format || "").toLowerCase())
    ? String(config.format).toLowerCase()
    : "mp3";

  try {
    const res = await fetch(chatCompletionsUrl(baseUrl), {
      method: "POST",
      signal: typeof AbortSignal?.timeout === "function"
        ? AbortSignal.timeout(timeoutMs)
        : undefined,
      headers: {
        "Content-Type": "application/json",
        // 小米 MiMo 用的是 api-key 请求头，不是 Bearer
        "api-key": config.apiKey,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          // 可选：用 user 消息描述朗读风格（小米 MiMo 支持自然语言语气控制）
          ...(String(config.stylePrompt || "").trim()
            ? [{ role: "user", content: String(config.stylePrompt).trim() }]
            : []),
          { role: "assistant", content },
        ],
        audio: {
          format,
          voice: voice || config.voice || "mimo_default",
        },
        stream: false,
      }),
    });

    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = raw;
    }

    if (!res.ok) {
      return {
        ok: false,
        error: `语音接口返回 ${res.status}：${extractErrorMessage(data, "合成失败")}`,
      };
    }

    const base64 = data?.choices?.[0]?.message?.audio?.data;
    if (!base64 || typeof base64 !== "string") {
      return { ok: false, error: "语音接口没有返回音频数据（请确认模型名与音色是否正确）" };
    }

    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length) {
      return { ok: false, error: "语音接口返回的音频是空的" };
    }

    return {
      ok: true,
      buffer,
      contentType: format === "mp3" ? "audio/mpeg" : "audio/wav",
    };
  } catch (err) {
    return { ok: false, error: describeFetchError(err, timeoutMs, "语音接口") };
  }
}
