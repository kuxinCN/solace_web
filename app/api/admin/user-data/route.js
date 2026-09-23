/**
 * 后台「用户数据」：按用户查看与删除他的日记、会话和聊天消息。
 *
 *   GET    ?userId=1&type=profile                     → 用户基本信息 + 各表条数统计
 *   GET    ?userId=1&type=diaries                     → 该用户的日记列表
 *   GET    ?userId=1&type=conversations               → 该用户的会话列表（带消息条数）
 *   GET    ?userId=1&type=messages&conversationId=2   → 某个会话的消息
 *   DELETE ?type=diary&id=1                           → 删一条日记
 *   DELETE ?type=conversation&id=1                    → 删一个会话（消息靠外键级联一起删）
 *   DELETE ?type=message&id=1                         → 删一条消息
 *
 * 这些都是管理员操作，每一步都会写进操作日志（audit_logs）。
 */
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import { describeDbError, execute, query } from "@/lib/db";
import { cleanString, clientIp, json, jsonError } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ROWS = 300;
const MAX_MESSAGES = 1000;

function parseId(value) {
  const text = String(value ?? "").trim();
  // 必须是纯数字，避免 "1abc" 被 parseInt 当成 1
  if (!/^\d+$/.test(text)) return 0;
  const id = Number.parseInt(text, 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

async function loadUser(userId) {
  const rows = await query(
    `SELECT id, email, account, username, gender, birthday, phone, remark,
            status, source, created_at, last_login_at
       FROM users WHERE id = ? LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function loadStats(userId) {
  const [diaryRows, convRows, msgRows] = await Promise.all([
    query("SELECT COUNT(*) AS total FROM diaries WHERE user_id = ?", [userId]),
    query("SELECT COUNT(*) AS total FROM conversations WHERE user_id = ?", [userId]),
    query("SELECT COUNT(*) AS total FROM messages WHERE user_id = ?", [userId]),
  ]);

  return {
    diaries: Number(diaryRows[0]?.total || 0),
    conversations: Number(convRows[0]?.total || 0),
    messages: Number(msgRows[0]?.total || 0),
  };
}

export async function GET(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const url = new URL(request.url);
  const type = cleanString(url.searchParams.get("type"), 16) || "profile";
  const userId = parseId(url.searchParams.get("userId"));
  const conversationId = parseId(url.searchParams.get("conversationId"));

  if (!userId) return jsonError("缺少用户 id", 400);

  try {
    const user = await loadUser(userId);
    if (!user) return jsonError("用户不存在", 404);

    if (type === "profile") {
      return json({ ok: true, user, stats: await loadStats(userId) });
    }

    if (type === "diaries") {
      const diaries = await query(
        `SELECT id, title, content, created_at FROM diaries
          WHERE user_id = ? ORDER BY id DESC LIMIT ${MAX_ROWS}`,
        [userId]
      );
      return json({ ok: true, user, diaries });
    }

    if (type === "conversations") {
      const conversations = await query(
        `SELECT c.id, c.title, c.created_at,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
           FROM conversations c
          WHERE c.user_id = ?
          ORDER BY c.id DESC
          LIMIT ${MAX_ROWS}`,
        [userId]
      );
      return json({ ok: true, user, conversations });
    }

    if (type === "messages") {
      if (!conversationId) return jsonError("缺少会话 id", 400);

      const owned = await query(
        "SELECT id, title FROM conversations WHERE id = ? AND user_id = ? LIMIT 1",
        [conversationId, userId]
      );
      if (!owned.length) return jsonError("会话不存在，或不属于这个用户", 404);

      // 先按倒序取「最新的一批」，再翻转成正序返回，避免消息很多时只看到最老的
      const rows = await query(
        `SELECT id, role, content, created_at FROM messages
          WHERE conversation_id = ? AND user_id = ?
          ORDER BY id DESC LIMIT ${MAX_MESSAGES}`,
        [conversationId, userId]
      );
      return json({ ok: true, user, conversation: owned[0], messages: rows.reverse() });
    }

    return jsonError("未知的 type", 400);
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function DELETE(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const url = new URL(request.url);
  const type = cleanString(url.searchParams.get("type"), 16);
  const id = parseId(url.searchParams.get("id"));
  if (!id) return jsonError("缺少 id", 400);

  try {
    let result;
    let detail = "";

    if (type === "diary") {
      const owner = await query("SELECT user_id FROM diaries WHERE id = ? LIMIT 1", [id]);
      result = await execute("DELETE FROM diaries WHERE id = ?", [id]);
      detail = `删除日记 #${id}（属于用户 #${owner[0]?.user_id ?? "?"}）`;
    } else if (type === "conversation") {
      const owner = await query("SELECT user_id FROM conversations WHERE id = ? LIMIT 1", [id]);
      // 显式先删消息，不完全依赖外键级联（手工建表时可能没建外键）
      await execute("DELETE FROM messages WHERE conversation_id = ?", [id]);
      result = await execute("DELETE FROM conversations WHERE id = ?", [id]);
      detail = `删除会话 #${id}（属于用户 #${owner[0]?.user_id ?? "?"}，消息一并删除）`;
    } else if (type === "message") {
      const owner = await query("SELECT user_id FROM messages WHERE id = ? LIMIT 1", [id]);
      result = await execute("DELETE FROM messages WHERE id = ?", [id]);
      detail = `删除消息 #${id}（属于用户 #${owner[0]?.user_id ?? "?"}）`;
    } else {
      return jsonError("未知的 type", 400);
    }

    if (!result.affectedRows) return jsonError("记录不存在", 404);

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: `delete_user_data:${type}`,
      detail,
      ip: clientIp(request),
    });

    return json({ ok: true, message: "已删除" });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
