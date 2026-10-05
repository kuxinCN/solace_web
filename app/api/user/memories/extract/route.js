/**
 * 长期记忆（写入端）：关键词触发的轻量提炼。
 *
 * 流程：
 *   1. 校验登录，接收 { conversationId, userMessage }
 *   2. 服务端关键词匹配；未命中直接 { skipped: true }，不调用 AI
 *   3. 命中后做一次独立的轻量 AI 提炼（无 history、max_tokens 很小）
 *   4. 提炼结果写入 user_memories（category: preference/relation/emotion/event）
 *
 * 冷却：同一用户 + 同一 conversationId 3 分钟内只提炼一次。
 * 用进程内 Map 记录，重启丢失可接受。
 *
 * 红线：本接口由前端在流式回复结束后 fire-and-forget 调用，
 * 任何失败都由调用方静默处理，绝不能影响聊天主链路。
 */
import { requestChat } from "@/lib/ai";
import { getCurrentUser } from "@/lib/user-auth";
import { saveMemory } from "@/lib/memory-store";
import { json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MESSAGE_CHARS = 2000; // 提炼输入长度上限
const MAX_MEMORY_CHARS = 40; // 单条提炼结果长度
const COOLDOWN_MS = 3 * 60 * 1000;

/** 直接命中的关键词（偏好 / 关系 / 恐惧 / 事件 / 事实） */
const TRIGGER_KEYWORDS = [
  "我喜欢",
  "我讨厌",
  "我害怕",
  "我妈",
  "我爸",
  "我室友",
  "我朋友",
  "我最近",
  "我一直在",
  "我不喜欢",
  "我想要",
  // —— 事实 / 拥有类（用户说出的长期事实信息，同样值得记下）——
  "我养",
  "我叫",
  "我家有",
  "我有",
  "我住",
  "我工作",
  "我今年",
  "我在上",
];

/** 情绪词：仅当消息 ≥ 80 字且包含任一词时才触发 */
const EMOTION_KEYWORDS = ["难过", "焦虑", "累", "烦", "开心", "委屈", "孤独", "害怕"];

/** category 判定用的分组词表 */
const RELATION_KEYWORDS = ["我妈", "我爸", "我室友", "我朋友"];
const PREFERENCE_KEYWORDS = ["我喜欢", "我讨厌", "我不喜欢", "我想要"];
const EVENT_KEYWORDS = ["我最近", "我一直在", "我养", "我叫", "我家有", "我有", "我住", "我工作", "我今年", "我在上"];

/** 冷却表：`${userId}:${conversationId}` → 上次提炼时间戳 */
const lastExtractAt = new Map();

function matchKeywords(text, words) {
  return words.some((word) => text.includes(word));
}

// 偏好类核心词 + 程度副词容忍：
//   覆盖"我很喜欢 / 我特别讨厌 / 我真的害怕 / 我好想要"这类带修饰的表达 ——
//   精确词表只有"我喜欢"，"我很喜欢"不包含连续子串"我喜欢"，会漏。
const PREFERENCE_CORE_RE = /^我.{0,3}(?:喜欢|讨厌|不喜欢|害怕|想要)/;

/** 判断消息是否值得提炼：命中直接关键词；或偏好变体；或长消息 + 情绪词 */
function shouldExtract(text) {
  if (matchKeywords(text, TRIGGER_KEYWORDS)) return true;
  if (PREFERENCE_CORE_RE.test(text)) return true;
  return text.length >= 80 && matchKeywords(text, EMOTION_KEYWORDS);
}

/** 按命中关键词简单分类：关系 > 偏好 > 情绪 > 事件 */
function classifyCategory(text) {
  if (matchKeywords(text, RELATION_KEYWORDS)) return "relation";
  if (matchKeywords(text, PREFERENCE_KEYWORDS) || PREFERENCE_CORE_RE.test(text)) return "preference";
  if (matchKeywords(text, EMOTION_KEYWORDS)) return "emotion";
  if (matchKeywords(text, EVENT_KEYWORDS)) return "event";
  return "event";
}

const EXTRACT_SYSTEM_PROMPT =
  "从下面这段话里提炼一句不超过40字的用户信息，只保留事实或偏好，不要情绪渲染，直接输出那一句话。";

/** 清理模型输出：去引号 / 换行，截到 40 字 */
function cleanExtractedMemory(raw) {
  const text = String(raw || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/^[\s"'「『（(【\[]+/, "")
    .replace(/[\s"'」』）)】\]]+$/, "")
    .trim();
  if (!text) return "";
  return text.slice(0, MAX_MEMORY_CHARS);
}

export async function POST(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const body = await readJsonBody(request);
  const userMessage =
    typeof body.userMessage === "string"
      ? body.userMessage.trim().slice(0, MAX_MESSAGE_CHARS)
      : "";
  const conversationId = String(body.conversationId ?? "").trim();

  if (!userMessage || !conversationId) return json({ skipped: true });

  // 关键词不命中：不做任何 AI 调用（同步判断，零成本）
  if (!shouldExtract(userMessage)) return json({ skipped: true });

  // 冷却判断：命中关键词后才占位，避免未命中消息挤占冷却窗口。
  // 先于 AI 调用写入，防止并发重复请求打两次 AI。
  const cooldownKey = `${user.id}:${conversationId}`;
  const now = Date.now();
  if (now - (lastExtractAt.get(cooldownKey) || 0) < COOLDOWN_MS) {
    return json({ skipped: true, reason: "cooldown" });
  }
  lastExtractAt.set(cooldownKey, now);

  // 轻量提炼：独立于主聊天，无 history、max_tokens 小
  const result = await requestChat({
    messages: [
      { role: "system", content: EXTRACT_SYSTEM_PROMPT },
      { role: "user", content: `内容：${userMessage}` },
    ],
    maxTokens: 64,
  });

  if (!result.ok) return json({ skipped: true, reason: "ai-failed" });

  const content = cleanExtractedMemory(result.reply);
  if (!content) return json({ skipped: true, reason: "empty" });

  const category = classifyCategory(userMessage);

  // 统一写入口：与模型自主通道（[MEMORY:]）近似去重 ——
  // 同一件事两个通道都抓到时只保留一条；用户重复提起则刷新旧记忆的时间戳（强化浮升）。
  try {
    const saved = await saveMemory(user.id, content, category);
    return json({ saved: true, status: saved.status, content, category });
  } catch (err) {
    console.warn("[memory] 提炼结果写入失败:", err?.code || err?.message || err);
    return json({ skipped: true, reason: "db-failed" });
  }
}
