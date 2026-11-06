/**
 * 长期记忆（写入端）：批量上下文的 AI 提炼。
 *
 * 流程：
 *   1. 校验登录，接收 { conversationId, recentMessages }（最近 8 条对话）
 *   2. 空数组直接 { skipped: true } —— 不再做关键词门槛（前端闸门已经保证频率与信息量）
 *   3. 按「五大类」分行提炼 0~3 条 → 逐条 saveMemory（去重逻辑在 memory-store 里统一）
 *   4. 返回 { saved, savedCount, items } / 全部失败时 { saved:false, reason:"db-failed" }
 *
 * 冷却：按 **userId**（不含 conversationId）3 分钟内只提炼一次，
 * 且**在 AI 成功 + 至少写进一条之后才占位** —— AI 报错 / 写库失败不消耗冷却窗口。
 * 用进程内 Map 记录，重启丢失可接受。
 *
 * 红线：本接口由前端在流式回复结束后 fire-and-forget 调用，
 * 任何失败都由调用方静默处理（只 console.warn），绝不能影响聊天主链路。
 */
import { requestChat } from "@/lib/ai";
import { getCurrentUser } from "@/lib/user-auth";
import { saveMemory } from "@/lib/memory-store";
import { json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TRANSCRIPT_CHARS = 4000; // 8 条对话拼起来的总长度上限（防止超长消息吃 token）
const MAX_MESSAGE_CHARS = 800; // 单条消息截断（长文只保留开头，够判断事实即可）
const MAX_MEMORY_CHARS = 80; // 单条提炼结果长度（提示词要求 60~80 字，这里只做兜底上限）
const MAX_MEMORY_ITEMS = 3; // 一次最多写入几条（提示词要求 0~3 条）
const COOLDOWN_MS = 60 * 1000;

/** 情绪词（只用于无类别前缀时的兜底分类） */
const EMOTION_KEYWORDS = ["难过", "焦虑", "累", "烦", "开心", "委屈", "孤独", "害怕"];

/** category 判定用的分组词表 */
const RELATION_KEYWORDS = ["我妈", "我爸", "我室友", "我朋友"];
const PREFERENCE_KEYWORDS = ["我喜欢", "我讨厌", "我不喜欢", "我想要"];
const EVENT_KEYWORDS = ["我最近", "我一直在", "我养", "我叫", "我家有", "我有", "我住", "我工作", "我今年", "我在上"];

/** 冷却表：userId → 上次**成功写入**的时间戳（不含 conversationId，切对话不重置） */
const lastExtractAt = new Map();

function matchKeywords(text, words) {
  return words.some((word) => text.includes(word));
}

// 偏好类核心词 + 程度副词容忍：
//   覆盖"我很喜欢 / 我特别讨厌 / 我真的害怕 / 我好想要"这类带修饰的表达 ——
//   精确词表只有"我喜欢"，"我很喜欢"不包含连续子串"我喜欢"，会漏。
const PREFERENCE_CORE_RE = /^我.{0,3}(?:喜欢|讨厌|不喜欢|害怕|想要)/;

/** 按命中关键词简单分类：关系 > 偏好 > 情绪 > 事件 */
function classifyCategory(text) {
  if (matchKeywords(text, RELATION_KEYWORDS)) return "relation";
  if (matchKeywords(text, PREFERENCE_KEYWORDS) || PREFERENCE_CORE_RE.test(text)) return "preference";
  if (matchKeywords(text, EMOTION_KEYWORDS)) return "emotion";
  if (matchKeywords(text, EVENT_KEYWORDS)) return "event";
  return "event";
}

const EXTRACT_SYSTEM_PROMPT = `你是一个高度敏锐的心理陪伴记录员。请从下方的对话中，提取 0~3 条关于该用户的重要信息。
要求：
1. 分为六大类：【事实】（如名字、住址）、【偏好】（喜欢/讨厌的事物）、【关系】（家人、朋友、宠物）、【近况】（最近发生的事、考试、工作）、【情绪主题】（反复出现的情绪，如‘最近一直睡不好’）、【愿望】（期望、想做的事、未完成的心愿，如‘希望以后去日本看烟火’‘我想学吉他’）。
2. 每条信息简短精炼，一句话陈述客观事实，务必保留关键专有名词、宠物名字、姓名与称呼（通常 10~30 字以内，最长不超过 60 字，例如：关系：用户养了一只叫TZW的小猫。关系：用户的小狗叫旺财。）。
3. 如果有多条，请分行输出，每行以对应的类别开头，例如：偏好：用户喜欢在深夜喝热牛奶。
4. 除了过去的偏好和事实，请敏锐捕捉用户的**期望与愿望**——即使只是随口一提，也归类为「愿望」。
5. 绝对不要编造，如果没有提取到，请直接输出 NONE。`;

/** 提示词里的六大类 → 库里的 category（保持读取端的类别权重不变） */
const CATEGORY_BY_LABEL = {
  事实: "event",
  偏好: "preference",
  关系: "relation",
  近况: "event",
  情绪主题: "emotion",
  愿望: "wish",
};

/** 清理模型输出：去引号 / 换行，截到 80 字 */
function cleanExtractedMemory(raw) {
  const text = String(raw || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/^[\s"'「『（(【\[]+/, "")
    .replace(/[\s"'」』）)】\]]+$/, "")
    .trim();
  if (!text) return "";
  return text.slice(0, MAX_MEMORY_CHARS);
}

/**
 * 解析多行提炼结果 → [{ content, category }]
 *
 * ⚠️ 用「行首标记」而不是 JSON：批量/小模型下 JSON 太容易坏（项目红线）。
 * ⚠️ NONE 判定放在最前面：模型偶尔会先写一句解释再输出 NONE，
 *    这时整批都按"没提取到"处理，避免把解释当成记忆写进库。
 */
function parseExtractedMemories(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  if (/NONE/i.test(text)) return [];

  const items = [];
  for (const line of text.split(/\r?\n/)) {
    // 模型有时会把要求里的序号照抄成 "1. 偏好：xxx"，先剥掉行首序号再认类别
    const trimmed = line.trim().replace(/^\d+[.、)）]\s*/, "");
    if (!trimmed) continue;
    // 兼容「偏好：xxx」「【偏好】：xxx」「偏好: xxx」三种写法
    const match = /^【?(生活习惯|偏好|人际圈子|关系|核心压力源|压力源|喜欢的慰藉方式|慰藉方式|愿望|近况|事实|情绪主题)】?\s*[：:]\s*(.+)$/.exec(trimmed);
    const label = match?.[1];
    const content = cleanExtractedMemory(match ? match[2] : trimmed);
    if (!content) continue;
    items.push({
      content,
      // 没带类别前缀的行：退回原来的关键词分类
      category: label ? CATEGORY_BY_LABEL[label] : classifyCategory(trimmed),
    });
    if (items.length >= MAX_MEMORY_ITEMS) break;
  }
  return items;
}

export async function POST(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const body = await readJsonBody(request);
  // 批量上下文：前端每次带最近 8 条对话（{role, content}）
  const recentMessages = (Array.isArray(body.recentMessages) ? body.recentMessages : [])
    .map((m) => ({
      role: m?.role === "assistant" ? "assistant" : "user",
      content: typeof m?.content === "string" ? m.content.trim() : "",
    }))
    .filter((m) => m.content)
    .slice(-8)
    .map((m) => ({ ...m, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));

  if (!recentMessages.length) return json({ skipped: true, reason: "empty" });

  // 冷却判断：只"读"不占位 —— 占位必须等到真正写库成功之后（见文件末尾），
  // 否则 AI 报错 / 写库失败也会白白锁住用户 3 分钟。
  // key 只用 userId：切对话不重置、单条长对话也不会被锁死。
  const now = Date.now();
  if (now - (lastExtractAt.get(user.id) || 0) < COOLDOWN_MS) {
    return json({ skipped: true, reason: "cooldown" });
  }

  // 拼成一段"对话"：只取最近的部分（超长从前面截掉），标签用产品里的称呼
  let transcript = recentMessages
    .map((m) => `${m.role === "user" ? "用户" : "暖言"}：${m.content}`)
    .join("\n");
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = transcript.slice(-MAX_TRANSCRIPT_CHARS);
  }

  // 独立提炼：无 history；多行结构化输出需要更大一点的空间，maxTokens 从 64 提到 250
  const result = await requestChat({
    messages: [
      { role: "system", content: EXTRACT_SYSTEM_PROMPT },
      { role: "user", content: `对话：\n${transcript}` },
    ],
    maxTokens: 250,
  });

  if (!result.ok) return json({ skipped: true, reason: "ai-failed" });

  const items = parseExtractedMemories(result.reply);
  if (!items.length) return json({ skipped: true, reason: "empty" });

  // 逐条写入：统一走 saveMemory（近似去重 / 重复提及只刷新时间戳）
  const savedItems = [];
  for (const item of items) {
    try {
      const saved = await saveMemory(user.id, item.content, item.category);
      savedItems.push({ ...item, status: saved.status, id: saved.id });
    } catch (err) {
      // 单条失败不拖累其它条；全部失败时在响应里明确报出来（前端不再只能靠猜）
      console.warn("[memory] 提炼结果写入失败:", err?.code || err?.message || err);
    }
  }

  if (!savedItems.length) return json({ saved: false, reason: "db-failed" });

  // ⚠️ 冷却占位放在这里（AI 成功 + 至少写进一条之后）：
  //    失败不该消耗冷却窗口，用户下一轮应当还能再试。
  lastExtractAt.set(user.id, Date.now());

  return json({ saved: true, savedCount: savedItems.length, items: savedItems });
}
