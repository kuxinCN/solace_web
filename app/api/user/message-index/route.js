import { decryptContent } from "@/lib/secret-box";
import { describeDbError, query } from "@/lib/db";
import { getCurrentUser } from "@/lib/user-auth";
import { json, jsonError } from "@/lib/util";
import {
  searchMessagesByBlindIndex,
  backfillBlindIndexes,
} from "@/lib/searchable-encryption";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ROWS = 2000;

export async function GET(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") || "").trim();
  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit")) || 20));
  const convId = searchParams.get("conversationId")
    ? Number(searchParams.get("conversationId"))
    : undefined;

  // 1. 若传了关键词 q：走可搜索加密（Searchable Encryption）盲索引服务端安全检索
  if (q) {
    try {
      const result = await searchMessagesByBlindIndex(user.id, q, {
        page,
        limit,
        conversationId: convId,
      });
      return json({ ok: true, isSearch: true, ...result });
    } catch (err) {
      return jsonError(describeDbError(err), 500);
    }
  }

  // 2. 传统全量索引（最多 2000 条），保持向下兼容
  try {
    const messages = await query(
      `SELECT id, conversation_id, content
         FROM messages
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT ${MAX_ROWS}`,
      [user.id]
    );
    messages.forEach((m) => {
      m.content = decryptContent(m.content);
    });

    // 静默触发历史数据盲索引补齐（单批 50 条，平滑迁移）
    void backfillBlindIndexes(50);

    return json({ ok: true, isSearch: false, messages });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
