/**
 * 聊天会话：列表 / 新建 / 改名 / 置顶 / 删除。
 * 所有 SQL 都带 user_id 条件——这是替代 Supabase RLS 的关键。
 * 列表按「置顶优先 + 最后一条消息时间倒序」返回（MySQL DESC 时 NULL 自动排最后）。
 */
import { describeDbError, execute, query } from "@/lib/db";
import { ensureUserColumnsOnce } from "@/lib/schema";
import { pushToTrash } from "@/lib/trash";
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
    // 老部署升级时自动补列（pinned / pinned_at / last_message_at）。
    // 补列失败不能拖垮接口，否则连会话列表都打不开。
    try {
      await ensureUserColumnsOnce();
    } catch {
      /* 忽略 */
    }

    const conversations = await query(
      `SELECT id, user_id, title, pinned, pinned_at, created_at, last_message_at
         FROM conversations
        WHERE user_id = ?
        ORDER BY pinned DESC, last_message_at DESC, id DESC`,
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
    // 新建即把活动时间初始化为当前时间（列表排序/日期显示统一用该字段）
    const now = toMysqlDateTime(new Date());
    const result = await execute(
      "INSERT INTO conversations (user_id, title, last_message_at) VALUES (?, ?, ?)",
      [user.id, title, now]
    );
    return json({
      ok: true,
      conversation: {
        id: result.insertId,
        user_id: user.id,
        title,
        pinned: 0,
        pinned_at: null,
        created_at: now,
        last_message_at: now,
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

  const url = new URL(request.url);
  const id = parseId(url.searchParams.get("id"));
  // ⚠️ ?permanent=1 表示「彻底删除」：不进回收站
  const permanent = url.searchParams.get("permanent") === "1";
  if (!id) return jsonError("缺少会话 id", 400);

  try {
    // 「删除」：先把对话连同它的消息一起存进回收站（恢复时能整体还原）
    // ⚠️ ?permanent=1（彻底删除）时跳过这一步
    try {
      if (permanent) throw new Error("skip-trash");
      const convRows = await query(
        `SELECT id, title, created_at, last_message_at FROM conversations
          WHERE id = ? AND user_id = ? LIMIT 1`,
        [id, user.id]
      );
      if (convRows.length) {
        const msgRows = await query(
          `SELECT id, role, content, created_at FROM messages
            WHERE conversation_id = ? AND user_id = ? ORDER BY id LIMIT 2000`,
          [id, user.id]
        );
        await pushToTrash({
          userId: user.id,
          itemType: "conversation",
          title: convRows[0].title || "新对话",
          payload: { ...convRows[0], messages: msgRows },
        });
      }
    } catch {
      /* 回收站写入失败不阻止删除 */
    }

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
