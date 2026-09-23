/** 聊天消息：按会话读取 / 追加一条 / 删除一条（「重新生成」会用到删除） */
import { describeDbError, execute, query } from "@/lib/db";
import { getCurrentUser } from "@/lib/user-auth";
import { cleanString, json, jsonError, readJsonBody, toMysqlDateTime } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CONTENT_CHARS = 20000;
const ALLOWED_ROLES = ["user", "assistant"];
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;

function parseId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return 0;
  const id = Number.parseInt(text, 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

async function ownsConversation(conversationId, userId) {
  const rows = await query(
    "SELECT id FROM conversations WHERE id = ? AND user_id = ? LIMIT 1",
    [conversationId, userId]
  );
  return rows.length > 0;
}

export async function GET(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const conversationId = parseId(new URL(request.url).searchParams.get("conversationId"));
  if (!conversationId) return jsonError("缺少会话 id", 400);

  try {
    if (!(await ownsConversation(conversationId, user.id))) {
      return jsonError("会话不存在", 404);
    }

    const messages = await query(
      `SELECT id, conversation_id, user_id, role, content, created_at
         FROM messages
        WHERE conversation_id = ? AND user_id = ?
        ORDER BY id ASC`,
      [conversationId, user.id]
    );
    return json({ ok: true, messages });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function POST(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const body = await readJsonBody(request);
  const conversationId = parseId(body.conversationId);
  const role = cleanString(body.role, 16);
  const content = cleanString(body.content, MAX_CONTENT_CHARS);

  if (!conversationId) return jsonError("缺少会话 id", 400);
  if (!ALLOWED_ROLES.includes(role)) return jsonError("role 只能是 user 或 assistant", 400);
  if (!content) return jsonError("消息内容不能为空", 400);

  // 「重新生成」时前端希望新回复占回原来那条的时间位置，所以允许指定 created_at
  const createdAt =
    typeof body.created_at === "string" && DATETIME_PATTERN.test(body.created_at)
      ? body.created_at.replace("T", " ")
      : toMysqlDateTime(new Date());

  try {
    if (!(await ownsConversation(conversationId, user.id))) {
      return jsonError("会话不存在", 404);
    }

    const result = await execute(
      `INSERT INTO messages (conversation_id, user_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [conversationId, user.id, role, content, createdAt]
    );

    return json({
      ok: true,
      message: {
        id: result.insertId,
        conversation_id: conversationId,
        user_id: user.id,
        role,
        content,
        created_at: createdAt,
      },
    });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function DELETE(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const id = parseId(new URL(request.url).searchParams.get("id"));
  if (!id) return jsonError("缺少消息 id", 400);

  try {
    const result = await execute("DELETE FROM messages WHERE id = ? AND user_id = ?", [
      id,
      user.id,
    ]);
    if (!result.affectedRows) return jsonError("消息不存在", 404);
    return json({ ok: true });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
