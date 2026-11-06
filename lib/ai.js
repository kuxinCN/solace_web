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

/** 阿里云百炼 DashScope 多模态生成/语音端点 */
export function dashscopeSpeechUrl(baseUrl) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer";
  if (base.includes("/services/audio/tts/SpeechSynthesizer")) return base;
  if (base.includes("/services/aigc/multimodal-generation/generation")) {
    return base.replace("/services/aigc/multimodal-generation/generation", "/services/audio/tts/SpeechSynthesizer");
  }
  return `${base}/services/audio/tts/SpeechSynthesizer`;
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

const TITLE_PROMPT = `你是对话标题提炼助手。请根据用户说的话（及上下文），提炼出最核心的对话主题，生成一个 4 到 10 个汉字的简明标题。

必须遵守的规则：
1. 【核心提炼】：提炼核心话题或情感意向，严禁直接照抄用户原句。
   例如：
   - "鲸鲸，你在干嘛呀" / "你吃饭了吗" -> 闲聊近况
   - "你知道我养的小猫叫什么名字吗" / "我的猫叫TZW" -> 聊聊宠物小猫
   - "我养了一只什么小动物呀" -> 询问宠物记忆
   - "今天遇到一件事，好郁闷" -> 发生了一件事
   - "明天要考试了有点紧张" -> 考前紧张倾诉
   - "今天吃了一顿超好吃的火锅" -> 美味日常分享
2. 【长度适中】：字数控制在 4 到 10 个汉字，像聊天列表里的会话标题一样简明、生动。
3. 【输出格式】：只输出标题纯文字本身，不要加任何标点、引号、书名号、换行，不要输出"标题："等前缀，不要解释。
4. 【禁止特殊标记】：只输出普通汉字，不要带有任何 <|im_end|> 等特殊 token。`;

// ---------------------------------------------------------------------------
// 标题清洗与兜底：
//   * 标题生成拿到的可能是"模型原始输出"，会夹带特殊 token（<|im_end|>、[/INST] …）、
//     思考过程、"标题：" 前缀、多行内容 —— 这些不该落到用户的对话列表里；
//   * 全被清空、或模型直接说"无"（用户的话没实际含义）时，用首条消息切一个兜底标题，
//     **绝不原样吐裸文本**（那会用整句话去撑爆左侧列表）。
// ---------------------------------------------------------------------------

/** 特殊 token / 模板占位符：整体删掉（不是截断 —— 它常出现在标题末尾） */
const SPECIAL_TOKEN_RE =
  /<\|[^|>]{0,64}\|>|<\/?\|[^|>]{0,64}\|>|<｜[^｜>]{0,64}｜>|\[\/?INST\]|\[\/?S\]|<<\/?SYS>>|<\/?s>|<start_of_turn>|<end_of_turn>/gi;

/**
 * 被截断的特殊 token：`<|im_end`（少了收尾的 `|>`）、`<｜end▁of`。
 *
 * ⚠️ **真实场景就是这样的**：批量推理 / 网关掐 token 额度时会把
 *    `<|im_end|>` 砍成 `<|im_end`，用户看到的标题末尾就是这么一段乱码。
 *    只认完整 token 的正则抓不到它，所以这里单独兜一条"从 `<|` 起吃到结尾"。
 */
const TRUNCATED_TOKEN_RE = /[<＜][|｜][^|｜>]{0,64}(?:[|｜]>?)?\s*$/;
const TRUNCATED_TOKEN_FULL_RE = /[<＜][|｜][^|｜>]{0,64}(?:[|｜]>?)?/g;

/**
 * `...` 这类装饰符与各种括号，出现在**首尾**时都该剥掉；
 * 剥完一轮可能会露出新的首尾符号（如 `“标题”。` → 去句号 → 露引号），所以要循环。
 */
const EDGE_NOISE = /^[\s"'“”‘’「『（(【\[《…·\-—–_=+*~]+|[\s"'“”‘’」』）)】\]》…·\-—–_=+*~]+$/g;

/** 行首标记（"标题：" 之类），以及"助手："这类角色前缀 */
const TITLE_LABEL_RE = /^[#*\-•\s]*(?:标题|题目|title|助手|assistant|回答)\s*[:：]\s*/i;

/** 收尾的句末标点（标题不需要句号） */
const TRAILING_PUNCT_RE = /[。！？!?，,、；;：:.]+$/;

/**
 * 清洗模型返回的标题。
 *
 * ⚠️ 顺序很重要：**先删特殊 token，再做首尾剥离，最后才按长度截断** ——
 *    反过来会把 `你好<|im_end|>` 截成 `你好<|im_en`，反而制造出新的乱码。
 */
export function cleanGeneratedTitle(raw) {
  let title = String(raw ?? "");
  // 1) 完整 token 直接删；被掐断的 token 从标记符起整段删（只会出现在末尾）
  title = title.replace(SPECIAL_TOKEN_RE, "").replace(TRUNCATED_TOKEN_RE, "");
  // 2) 换行 / 制表符统一成普通空格
  title = title.replace(/[\r\n\t]+/g, " ");
  // 3) 去掉行首的"标题："这类标记
  title = title.replace(TITLE_LABEL_RE, "");
  // 4) 首尾剥离：引号 / 括号 / 句末标点，反复剥到稳定为止
  for (let i = 0; i < 4; i++) {
    const before = title;
    title = title.replace(EDGE_NOISE, "").replace(TRAILING_PUNCT_RE, "");
    if (title === before) break;
  }
  title = title.trim();
  // 5) 一行放不下就切断
  if (title.length > 20) title = title.slice(0, 20);
  return title;
}

/** 从 `cleanGeneratedTitle` 的产物里挑一个可用的标题（丢掉"无"、无意义字符） */
function pickGeneratedTitle(raw) {
  const title = cleanGeneratedTitle(raw);
  if (!title) return "";
  if (/^[-_=+*~·。.\s]+$/.test(title)) return ""; // 只剩标点/装饰符
  if (/^(无|暂无|没有|无标题|none|null|n\/a)$/i.test(title)) return "";
  return title;
}

/**
 * 兜底标题：把首条消息切成一句短的。
 *
 * ⚠️ **这是"绝不给用户看裸文本"的最后一道闸**：
 *    历史版本在这里是 `text.slice(0, 15)`，长消息会把左侧对话列表撑爆；
 *    而且整句话原样搬进标题，等于没总结。这里按标点切成**第一个分句、最多 16 字**。
 */
export function fallbackTitleFromMessage(text) {
  let flat = String(text ?? "")
    .replace(SPECIAL_TOKEN_RE, "")
    .replace(TRUNCATED_TOKEN_FULL_RE, "")
    .replace(/\[(?:RISK|MEMORY|sticker)[^\]]*\]/gi, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "新对话";

  // 常见打招呼/问候直接映射为温暖的短标题
  if (/^(你好|您好|哈喽|hello|hi|在吗|在么|鲸鲸|小鲸)/i.test(flat)) {
    return "日常问候";
  }
  if (/猫|狗|宠物|动物/.test(flat)) {
    return "聊聊宠物";
  }
  if (/累|难过|开心|烦|伤心|焦虑|压力|抑郁|难受/.test(flat)) {
    return "心情倾诉";
  }
  if (/几点|时间|星期|日期|今天周/.test(flat)) {
    return "时间与作息";
  }

  // 先剥首尾的引号/装饰符
  flat = flat.replace(EDGE_NOISE, "").replace(TRAILING_PUNCT_RE, "").trim();
  if (!flat) return "新对话";
  // 中文标点优先断句；太短的碎句就退回整条消息硬切
  const firstSentence = flat.split(/[。！？!?；;，,、~]/)[0]?.trim() || flat;
  let title = firstSentence.length >= 4 ? firstSentence : flat;
  title = title.replace(EDGE_NOISE, "").replace(TRAILING_PUNCT_RE, "").trim();
  if (title.length > 12) title = title.slice(0, 12);
  return title || "新对话";
}

/** 根据上下文生成对话标题，返回 { ok, title }。优先综合首轮问答进行提炼。 */
export async function generateConversationTitle({ messages, config }) {
  const list = Array.isArray(messages) ? messages : [];
  // 提取用户和助手消息（最多近 4 条），去掉控制标签
  const filtered = list
    .filter((item) => item && (item.role === "user" || item.role === "assistant"))
    .slice(-4);

  let dialogue = "";
  if (filtered.some((m) => m.role === "assistant")) {
    dialogue = filtered
      .map(
        (m) =>
          `${m.role === "user" ? "用户" : "助手"}：${String(m.content || "")
            .replace(/\[(?:RISK|MEMORY|sticker)[^\]]*\]/gi, "")
            .slice(0, 300)}`
      )
      .join("\n");
  } else {
    dialogue = filtered
      .filter((m) => m.role === "user")
      .map((m) => String(m.content || "").replace(/\[(?:RISK|MEMORY|sticker)[^\]]*\]/gi, "").slice(0, 500))
      .join("\n");
  }

  if (!dialogue.trim()) return { ok: false, error: "没有可用的消息内容" };

  const result = await requestChat({
    messages: [
      { role: "system", content: TITLE_PROMPT },
      { role: "user", content: dialogue },
    ],
    config,
    maxTokens: 160,
  });

  if (!result.ok) return { ok: false, error: result.error };

  const title = pickGeneratedTitle(result.reply);
  if (!title) return { ok: false, error: "标题生成为空", empty: true };
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

    let reply = String(data?.choices?.[0]?.message?.content || "").trim();
    if (reply.includes("<think>")) {
      reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*/gi, "").trim();
    }
    if (!reply) {
      return { ok: false, error: "AI 接口没有返回内容" };
    }
    // 把 token 用量一起返回，调用方可以记进 ai_usage 做统计
    return { ok: true, reply, usage: data?.usage || null };
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
export async function requestSpeech({ text, voice, dialect, config }) {
  const ttsConfig = config || (await getGroup("tts"));

  if (!ttsConfig.enabled) {
    return { ok: false, error: "语音合成当前处于关闭状态（可在后台开启）" };
  }

  const provider = String(ttsConfig.provider || "openai-compatible").toLowerCase();
  if (provider.includes("mimo") || provider.includes("xiaomi")) {
    return requestSpeechMimo({ text, voice, config: ttsConfig });
  }
  if (provider.includes("dashscope") || provider.includes("qwen") || provider.includes("aliyun")) {
    return requestSpeechDashScope({ text, voice, dialect, config: ttsConfig });
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

/**
 * 阿里云百炼 DashScope（Qwen-Audio-3.1-TTS / CosyVoice）：
 *   POST {baseUrl}/services/aigc/multimodal-generation/generation
 *   headers: Authorization: Bearer {apiKey}
 *   body:    {
 *     model: "qwen-audio-3.1-tts-flash",
 *     input: { text },
 *     parameters: { voice, format, rate, instruction }
 *   }
 *   响应: output.audio_url（需下载音频文件）或 output.audio（base64）或直接音频流
 */
async function requestSpeechDashScope({ text, voice, dialect, config }) {
  const prepared = prepareSpeechInput({ text, config });
  if (prepared.error) return { ok: false, error: prepared.error };

  const { content, timeoutMs, baseUrl } = prepared;
  const modelStr = String(config.model || "").trim().toLowerCase();
  const isCosyVoice = modelStr.includes("cosyvoice");
  const isCosyVoiceV1 = modelStr.includes("cosyvoice-v1");

  // 默认音色：cosyvoice-v1 仅支持 longwan 等早期音色，不支持 longanhuan_v3.1
  const defaultVoice = isCosyVoiceV1 ? "longwan" : "longanhuan_v3.1";
  const targetVoice = voice || config.voice || defaultVoice;
  const format = ["wav", "mp3", "pcm", "opus"].includes(String(config.format || "").toLowerCase())
    ? String(config.format).toLowerCase()
    : "mp3";

  // 纯文本净化：剥掉残留的括号标签，防止 CosyVoice 等引擎解析非文字报错（[cosyvoice:] Engine error [411]）
  let cleanContent = String(content || "")
    .replace(/[\[\(（［<【][^\]\)）］>】]*[\]\)）］>】]/g, "")
    .trim();
  if (!cleanContent) cleanContent = content;

  const url = dashscopeSpeechUrl(baseUrl);
  const parameters = {
    voice: targetVoice,
    format,
    sample_rate: 24000,
    rate: Number(config.speed) || 1.0,
    volume: 50,
  };

  let instruction = config.stylePrompt && String(config.stylePrompt).trim()
    ? String(config.stylePrompt).trim()
    : "";
  if (dialect && String(dialect).trim()) {
    const d = String(dialect).trim();
    instruction = instruction
      ? `${instruction}（请用${d}表达）`
      : `请用${d}表达。`;
  }
  // ⚠️ cosyvoice-v1 官方不支持 instruction 参数，传入会引发 [cosyvoice:instruction] 错误
  if (instruction && !isCosyVoiceV1) {
    parameters.instruction = instruction;
  }

  const payload = {
    model: config.model || "qwen-audio-3.1-tts-flash",
    input: {
      text: cleanContent,
    },
    parameters,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      signal: typeof AbortSignal?.timeout === "function"
        ? AbortSignal.timeout(timeoutMs)
        : undefined,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "X-DashScope-SSE": "enable",
      },
      body: JSON.stringify(payload),
    });

    const contentType = res.headers.get("content-type") || "";

    // 1. 如果上游直接返回音频二进制流（直通网关）
    if (contentType.includes("audio/") || contentType.includes("octet-stream")) {
      const arrayBuffer = await res.arrayBuffer();
      if (!arrayBuffer || arrayBuffer.byteLength === 0) {
        return { ok: false, error: "DashScope 语音接口返回的音频是空的" };
      }
      return {
        ok: true,
        buffer: Buffer.from(arrayBuffer),
        contentType: format === "wav" ? "audio/wav" : "audio/mpeg",
      };
    }

    // 2. 方案 A 极速低延迟：处理 Server-Sent Events (SSE) 增量实时音频流
    //    带上 X-DashScope-SSE 后，百炼无需等待整句合成完上传 OSS，
    //    而是将每一小段合成音频以 output.audio.data 实时推回，首帧延迟 100~300ms！
    if (contentType.includes("event-stream")) {
      const audioChunks = [];
      let streamErr = "";
      let fallbackUrl = "";

      const reader = res.body?.getReader ? res.body.getReader() : null;
      if (reader) {
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr || jsonStr === "[DONE]") continue;
            try {
              const parsed = JSON.parse(jsonStr);
              if (parsed.code && parsed.code !== "200" && parsed.code !== "Success") {
                streamErr = parsed.message || parsed.code;
              }
              const chunkBase64 =
                parsed?.output?.audio?.data ||
                (typeof parsed?.output?.audio === "string" ? parsed?.output?.audio : "");
              if (chunkBase64 && typeof chunkBase64 === "string" && chunkBase64.trim()) {
                audioChunks.push(Buffer.from(chunkBase64, "base64"));
              }
              const possibleUrl = parsed?.output?.audio?.url || parsed?.output?.url;
              if (possibleUrl) fallbackUrl = possibleUrl;
            } catch {}
          }
        }
      } else {
        const fullText = await res.text();
        const lines = fullText.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.code && parsed.code !== "200" && parsed.code !== "Success") {
              streamErr = parsed.message || parsed.code;
            }
            const chunkBase64 =
              parsed?.output?.audio?.data ||
              (typeof parsed?.output?.audio === "string" ? parsed?.output?.audio : "");
            if (chunkBase64 && typeof chunkBase64 === "string" && chunkBase64.trim()) {
              audioChunks.push(Buffer.from(chunkBase64, "base64"));
            }
            const possibleUrl = parsed?.output?.audio?.url || parsed?.output?.url;
            if (possibleUrl) fallbackUrl = possibleUrl;
          } catch {}
        }
      }

      if (audioChunks.length > 0) {
        return {
          ok: true,
          buffer: Buffer.concat(audioChunks),
          contentType: format === "wav" ? "audio/wav" : "audio/mpeg",
        };
      }

      if (streamErr) {
        let friendlyErr = streamErr;
        if (streamErr.includes("418") || streamErr.toLowerCase().includes("voice")) {
          friendlyErr = `音色「${targetVoice}」不受当前模型支持，请在后台更换音色（如 longwan）`;
        } else if (streamErr.toLowerCase().includes("instruction")) {
          friendlyErr = "当前模型不支持情感/方言指令，请在后台清空指令或使用 qwen-audio-3.1-tts-flash";
        } else if (streamErr.includes("411")) {
          friendlyErr = "语音合成引擎解析文本失败（可能含特殊字符或不支持的标签）";
        }
        return {
          ok: false,
          error: `DashScope 语音流式生成报错：${friendlyErr}`,
        };
      }

      if (fallbackUrl) {
        const audioRes = await fetch(fallbackUrl, {
          signal: typeof AbortSignal?.timeout === "function"
            ? AbortSignal.timeout(Math.max(15000, timeoutMs))
            : undefined,
        });
        if (audioRes.ok) {
          const arrayBuffer = await audioRes.arrayBuffer();
          return {
            ok: true,
            buffer: Buffer.from(arrayBuffer),
            contentType: format === "wav" ? "audio/wav" : "audio/mpeg",
          };
        }
      }
    }

    // 3. 非 SSE 响应（如普通 JSON 格式）回退处理
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
        error: `DashScope 语音接口返回 ${res.status}：${extractErrorMessage(data, "合成失败")}`,
      };
    }

    // 提取 output.audio.url 或 output.url
    const audioUrl =
      data?.output?.audio?.url ||
      data?.output?.url ||
      data?.output?.audio_url;
    if (audioUrl) {
      const audioRes = await fetch(audioUrl, {
        signal: typeof AbortSignal?.timeout === "function"
          ? AbortSignal.timeout(Math.max(15000, timeoutMs))
          : undefined,
      });
      if (!audioRes.ok) {
        return { ok: false, error: `下载 DashScope 生成的音频失败（HTTP ${audioRes.status}）` };
      }
      const arrayBuffer = await audioRes.arrayBuffer();
      return {
        ok: true,
        buffer: Buffer.from(arrayBuffer),
        contentType: format === "wav" ? "audio/wav" : "audio/mpeg",
      };
    }

    // 兼容普通返回 base64 的变体
    const rawAudio = data?.output?.audio;
    const base64 =
      (typeof rawAudio === "string" ? rawAudio : rawAudio?.data) ||
      data?.choices?.[0]?.message?.audio?.data;
    if (base64 && typeof base64 === "string" && base64.trim()) {
      const buffer = Buffer.from(base64, "base64");
      return {
        ok: true,
        buffer,
        contentType: format === "wav" ? "audio/wav" : "audio/mpeg",
      };
    }

    return {
      ok: false,
      error: `DashScope 未返回有效音频地址（响应内容：${typeof data === "object" ? JSON.stringify(data).slice(0, 200) : String(data).slice(0, 200)}）`,
    };
  } catch (err) {
    return { ok: false, error: describeFetchError(err, timeoutMs, "DashScope 语音接口") };
  }
}

// ---------------------------------------------------------------------------
// 连接预热：用极小的请求提前建好到上游 AI / TTS 的 TCP+TLS 连接，
// 让后续真正的请求复用连接池，省去首次 DNS+TLS 握手（约 100-300ms）。
// 采用 fire-and-forget，失败也不影响主流程。
// ---------------------------------------------------------------------------
let aiWarmed = false;
let ttsWarmed = false;

export function prewarmConnections({ ai = false, tts = false } = {}) {
  if (ai && !aiWarmed) {
    aiWarmed = true;
    (async () => {
      try {
        const cfg = await getGroup("ai");
        if (!cfg?.enabled || !cfg?.apiKey || !cfg?.baseUrl) return;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        await fetch(chatCompletionsUrl(cfg.baseUrl), {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({
            model: cfg.model,
            messages: [{ role: "user", content: "嗯" }],
            max_tokens: 1,
            stream: false,
          }),
        }).catch(() => {});
        clearTimeout(timer);
      } catch {
        /* 预热失败忽略 */
      }
    })();
  }

  if (tts && !ttsWarmed) {
    ttsWarmed = true;
    (async () => {
      try {
        const cfg = await getGroup("tts");
        if (!cfg?.enabled || !cfg?.apiKey || !cfg?.baseUrl || !cfg?.model) return;
        const provider = String(cfg.provider || "").toLowerCase();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const url = provider.includes("mimo")
          ? chatCompletionsUrl(cfg.baseUrl)
          : provider.includes("dashscope") || provider.includes("qwen")
            ? dashscopeSpeechUrl(cfg.baseUrl)
            : speechUrl(cfg.baseUrl);
        const isDashScope = provider.includes("dashscope") || provider.includes("qwen");
        await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            ...(provider.includes("mimo")
              ? { "api-key": cfg.apiKey }
              : { Authorization: `Bearer ${cfg.apiKey}` }),
          },
          body: JSON.stringify(
            provider.includes("mimo")
              ? {
                  model: cfg.model,
                  messages: [{ role: "assistant", content: "嗯" }],
                  audio: { format: "mp3", voice: cfg.voice || "mimo_default" },
                  stream: false,
                }
              : isDashScope
                ? {
                    model: cfg.model || "qwen-audio-3.1-tts-flash",
                    input: { text: "嗯" },
                    parameters: { voice: cfg.voice || "longanhuan_v3.1" },
                  }
                : {
                    model: cfg.model,
                    input: "嗯",
                    voice: cfg.voice,
                    response_format: "mp3",
                  }
          ),
        }).catch(() => {});
        clearTimeout(timer);
      } catch {
        /* 预热失败忽略 */
      }
    })();
  }
}

/** 重置预热标记（配置变更后调用，让下次请求重新建连） */
export function resetPrewarmFlags() {
  aiWarmed = false;
  ttsWarmed = false;
}
