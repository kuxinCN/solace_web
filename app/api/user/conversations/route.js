/**
 * 聊天会话：列表 / 新建 / 改名 / 置顶 / 删除。
 * 所有 SQL 都带 user_id 条件——这是替代 Supabase RLS 的关键。
 * 列表按「置顶优先 + 新建时间倒序」返回。
 */
import { describeDbError, execute, query } from "@/lib/db";
import { getCurrentUser } from "@/lib/user-auth";
import { cleanString, json, jsonError, readJsonBody, toMysqlDateTime } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return 0;
  const id = Number.parseInt(text, 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

export async function GET(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  try {
    const conversations = await query(
      `SELECT id, user_id, title, pinned, pinned_at, created_at
         FROM conversations
        WHERE user_id = ?
        ORDER BY pinned DESC, id DESC`,
      [user.id]
    );
    return json({ ok: true, conversations });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function POST(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const body = await readJsonBody(request);
  const title = cleanString(body.title, 120) || "新对话";

  try {
    const result = await execute("INSERT INTO conversations (user_id, title) VALUES (?, ?)", [
      user.id,
      title,
    ]);
    return json({
      ok: true,
      conversation: {
        id: result.insertId,
        user_id: user.id,
        title,
        pinned: 0,
        pinned_at: null,
        created_at: toMysqlDateTime(new Date()),
      },
    });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function PATCH(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const body = await readJsonBody(request);
  const id = parseId(body.id);
  if (!id) return jsonError("缺少会话 id", 400);

  const sets = [];
  const params = [];

  if (typeof body.title === "string") {
    const title = cleanString(body.title, 120);
    if (!title) return jsonError("标题不能为空", 400);
    sets.push("title = ?");
    params.push(title);
  }

  // 置顶 / 取消置顶（前端只传布尔值，置顶时间由后端写）
  if (body.pinned !== undefined) {
    const pinned = body.pinned === true || body.pinned === 1 || body.pinned === "1" ? 1 : 0;
    sets.push("pinned = ?", "pinned_at = ?");
    params.push(pinned, pinned ? toMysqlDateTime(new Date()) : null);
  }

  if (!sets.length) return jsonError("没有需要修改的内容", 400);

  try {
    // 先确认归属；不能只靠 affectedRows 判断（改成同一个标题时它是 0）
    const owned = await query("SELECT id FROM conversations WHERE id = ? AND user_id = ? LIMIT 1", [
      id,
      user.id,
    ]);
    if (!owned.length) return jsonError("会话不存在", 404);

    await execute(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, [
      ...params,
      id,
      user.id,
    ]);
    return json({ ok: true });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function DELETE(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const id = parseId(new URL(request.url).searchParams.get("id"));
  if (!id) return jsonError("缺少会话 id", 400);

  try {
    // 显式先删消息，不完全依赖外键级联（手工建表时可能没建外键）
    await execute("DELETE FROM messages WHERE conversation_id = ? AND user_id = ?", [id, user.id]);

    const result = await execute("DELETE FROM conversations WHERE id = ? AND user_id = ?", [
      id,
      user.id,
    ]);
    if (!result.affectedRows) return jsonError("会话不存在", 404);
    return json({ ok: true });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
