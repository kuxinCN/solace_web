/**
 * 对话标题自动生成：POST /api/user/conversations/title
 * body: { conversationId, messages: [{ role, content }] }
 *
 * 前端用法：首轮对话结束、且当前标题还是默认值（"新对话"之类）时调用一次，
 * 拿到返回的 title 更新界面即可。
 *
 * 安全与成本控制：
 *   * 只允许给自己名下的对话生成；
 *   * 用户已经手动改过名字的对话**不会被覆盖**（尊重用户）；
 *   * 调 AI 要花钱，按用户限流。
 */
import { generateConversationTitle } from "@/lib/ai";
import { describeDbError, execute, query } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/user-auth";
import { json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 视为「还没起过名字」的默认标题（含兜底标题，允许被二次生成覆盖） */
const DEFAULT_TITLES = [
  "",
  "新对话",
  "新的对话",
  "新聊天",
  "无题",
  "未命名",
  "英文询问需求",
  "数字询问需求",
  "符号询问需求",
];

function parseId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return 0;
  const id = Number.parseInt(text, 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

export async function POST(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const quota = rateLimit(`gen-title:${user.id}`, {
    limit: 30,
    windowMs: 60 * 60 * 1000,
  });
  if (!quota.ok) {
    return jsonError(`操作太频繁，请 ${quota.retryAfterSeconds} 秒后再试`, 429);
  }

  const body = await readJsonBody(request);
  const conversationId = parseId(body.conversationId);
  if (!conversationId) return jsonError("缺少 conversationId", 400);

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return jsonError("缺少对话内容", 400);

  try {
    const rows = await query(
      "SELECT id, title FROM conversations WHERE id = ? AND user_id = ? LIMIT 1",
      [conversationId, user.id]
    );
    const conversation = rows[0];
    if (!conversation) return jsonError("对话不存在", 404);

    const oldTitle = String(conversation.title || "").trim();
    // 用户自己起过名字就不覆盖
    if (oldTitle && !DEFAULT_TITLES.includes(oldTitle)) {
      return json({ ok: true, title: oldTitle, skipped: true });
    }

    const result = await generateConversationTitle({ messages });
    if (!result.ok) {
      return jsonError(result.error || "暂时无法生成标题，请稍后再试", 502);
    }

    await execute("UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?", [
      result.title,
      conversationId,
      user.id,
    ]);

    return json({ ok: true, title: result.title, skipped: false });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
