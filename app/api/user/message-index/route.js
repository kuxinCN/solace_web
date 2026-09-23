/**
 * 搜索用的消息索引：只取 id / conversation_id / content 三个字段。
 * 原来前端是从 Supabase 全量拉取后在前端过滤，这里保持一致的做法，
 * 但限制最多 2000 条，避免消息特别多时把浏览器拖垮。
 */
import { describeDbError, query } from "@/lib/db";
import { getCurrentUser } from "@/lib/user-auth";
import { json, jsonError } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ROWS = 2000;

export async function GET(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  try {
    const messages = await query(
      `SELECT id, conversation_id, content
         FROM messages
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT ${MAX_ROWS}`,
      [user.id]
    );
    return json({ ok: true, messages });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
