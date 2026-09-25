/**
 * 压力评估的 LLM 精算 —— **只在本地规则触发时**才调用。
 *
 * ⚠️ **走对话接口，不走批量**：
 *    批量推理是异步的（提交后要轮询几分钟），而压力评估要求"这一条消息发完就能判断"，
 *    所以这里必须走 `/chat/completions`。也因此要**严格控制调用频次** ——
 *    本地规则负责把 90% 的消息挡在外面（见 stress-trigger.js）。
 *
 * ⚠️ **配置复用「对话 AI」那一套**（接口地址 / API Key / 模型名），
 *    但**提示词放在「内容安全与压力」页**（用户要求：压力相关的都归在那儿）。
 *
 * ⚠️ **永远不要 throw**：调用失败返回 null，上层降级用本地分数继续跑。
 *    压力评估挂掉绝不能影响用户发消息。
 */
import { getGroup } from "./settings.js";

/** 输入截断（规格要求：最近 3 条，每条 50 字） */
const MAX_INPUT_CHARS = 300;

/** 输出上限：只要一个极短的 JSON */
const MAX_OUTPUT_TOKENS = 30;

/** 单次调用超时 */
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * 鉴权头。
 *
 * ⚠️ 和 content-review.js 保持一致的策略：
 *    小米平台接受 `Authorization: Bearer` **和** `api-key` 两种写法，
 *    遇到小米域名就**两个都发** —— 多带一个没副作用，少带一个就是 401。
 */
function authHeaders(baseUrl, apiKey) {
  const base = String(baseUrl || "").toLowerCase();
  const headers = { "Content-Type": "application/json" };
  headers.Authorization = `Bearer ${apiKey}`;
  if (base.includes("xiaomimimo.com")) {
    headers["api-key"] = apiKey;
  }
  return headers;
}

/** 把后台填的地址补成 `{base}/chat/completions`（允许直接粘完整地址） */
function endpoint(baseUrl, suffix) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  const cleaned = base.replace(/\/chat\/completions$/i, "");
  return `${cleaned}${suffix}`;
}

function timeoutSignal(ms) {
  return typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

/** 内置兜底提示词（后台没配时用） */
const FALLBACK_PROMPT_CHAT = `你是心理压力评估助手。根据以下对话片段评估说话者**当前的心理压力水平**，输出 0-100 的整数（50 表示中性）。

只输出一行 JSON，不要解释、不要建议、不要任何多余文字、不要代码块。
格式：{"score":0-100,"confidence":0-1}

对话片段：`;

const FALLBACK_PROMPT_DIARY = `你是心理压力评估助手。根据以下日记片段评估作者**当前的心理压力水平**，输出 0-100 的整数（50 表示中性）。

只输出一行 JSON，不要解释、不要建议、不要任何多余文字、不要代码块。
格式：{"score":0-100,"confidence":0-1}

日记片段：`;

/**
 * 读取 LLM 配置。
 * @returns {Promise<{baseUrl:string, apiKey:string, model:string, promptChat:string, promptDiary:string, timeoutMs:number}>}
 */
async function getLlmConfig() {
  const [ai, safety] = await Promise.all([
    getGroup("ai").catch(() => ({})),
    getGroup("safety").catch(() => ({})),
  ]);

  return {
    baseUrl: String(ai?.baseUrl || "").trim(),
    apiKey: String(ai?.apiKey || "").trim(),
    model: String(ai?.model || "").trim(),
    promptChat: String(safety?.stressPromptChat || "").trim() || FALLBACK_PROMPT_CHAT,
    promptDiary: String(safety?.stressPromptDiary || "").trim() || FALLBACK_PROMPT_DIARY,
    timeoutMs: Math.min(Math.max(Number(safety?.stressTimeoutSeconds) || 20, 5), 60) * 1000,
  };
}

/**
 * 从模型回复里抠出分数。
 *
 * ⚠️ 三层容错（模型不一定老实）：
 *   ① 标准 JSON → ② 去掉 ```json 围栏再解析 → ③ 直接在文本里找第一个 0-100 的数字
 * 都拿不到就返回 null，上层降级。
 */
function extractScore(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  // ① / ② JSON
  const candidates = [text, text.replace(/```json/gi, "").replace(/```/g, "").trim()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const score = Number(parsed?.score);
      if (Number.isFinite(score)) {
        return {
          score: Math.max(0, Math.min(100, Math.round(score))),
          confidence: Number.isFinite(Number(parsed?.confidence)) ? Number(parsed.confidence) : 0.5,
        };
      }
    } catch {
      /* 继续下一种 */
    }
  }

  // ③ 兜底：文本里第一个 0-100 的整数
  const matched = text.match(/\b(\d{1,3})\b/);
  if (matched) {
    const score = Number(matched[1]);
    if (Number.isFinite(score) && score >= 0 && score <= 100) {
      return { score, confidence: 0.4 };
    }
  }

  return null;
}

/**
 * 评估一段内容的压力分。
 *
 * ⚠️ **调用方请不要 await 它去阻塞用户响应** ——
 *    它的定位是 fire-and-forget：算完了自己落库、自己决定要不要弹窗。
 *
 * @param {string[]} pieces 文本片段（聊天场景传最近 3 条消息；日记场景传情绪句）
 * @param {{kind?: "chat"|"diary"}} options
 * @returns {Promise<{score:number, confidence:number}|null>} 失败返回 null
 */
export async function scoreByLLM(pieces, { kind = "chat" } = {}) {
  try {
    const config = await getLlmConfig();

    if (!config.baseUrl || !config.apiKey || !config.model) {
      console.warn("[stress] LLM 未配置（接口地址 / Key / 模型名），跳过深度识别");
      return null;
    }

    const text = (Array.isArray(pieces) ? pieces : [pieces])
      .filter(Boolean)
      .join("\n")
      .slice(0, MAX_INPUT_CHARS);

    if (!text.trim()) return null;

    const prompt = kind === "diary" ? config.promptDiary : config.promptChat;
    const url = endpoint(config.baseUrl, "/chat/completions");

    const res = await fetch(url, {
      method: "POST",
      headers: authHeaders(config.baseUrl, config.apiKey),
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: `${prompt}\n"""\n${text}\n"""` }],
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: timeoutSignal(config.timeoutMs || DEFAULT_TIMEOUT_MS),
    });

    const body = await res.text();
    if (!res.ok) {
      console.warn(`[stress] LLM 返回 HTTP ${res.status}：${body.slice(0, 150)}`);
      return null;
    }

    let data = null;
    try {
      data = JSON.parse(body);
    } catch {
      return null;
    }

    return extractScore(data?.choices?.[0]?.message?.content);
  } catch (err) {
    // ⚠️ 绝不往上抛：压力评估失败不该影响任何主流程
    console.warn("[stress] LLM 调用失败：", err?.message || err);
    return null;
  }
}

/**
 * 后台「测试连接」用：真实跑一次极简调用，把过程原样返回（便于定位问题）。
 */
export async function testStressConnection() {
  const config = await getLlmConfig();

  if (!config.baseUrl || !config.apiKey || !config.model) {
    return {
      ok: false,
      error: "还没配好：接口地址 / API Key / 模型名（在「对话 AI」页配）",
    };
  }

  try {
    const url = endpoint(config.baseUrl, "/chat/completions");
    const res = await fetch(url, {
      method: "POST",
      headers: authHeaders(config.baseUrl, config.apiKey),
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: "user",
            content: `${config.promptChat}\n"""\n今天有点累，但还是把事做完了。\n"""`,
          },
        ],
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: timeoutSignal(config.timeoutMs || DEFAULT_TIMEOUT_MS),
    });

    const body = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}：${body.slice(0, 200)}` };
    }

    let content = "";
    try {
      content = JSON.parse(body)?.choices?.[0]?.message?.content || "";
    } catch {
      content = "";
    }

    const parsed = extractScore(content);

    return {
      ok: Boolean(parsed),
      model: config.model,
      raw: String(content).slice(0, 200),
      parsed,
      error: parsed ? "" : "能连通，但没能从回复里解析出分数（可以看看原文）",
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
