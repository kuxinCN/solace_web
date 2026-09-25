/**
 * 数据导出：GET /api/user/export
 *
 * 把当前用户的全部个人数据打包成一个 JSON 文件直接下载
 * （《个人信息保护法》里的"可携带权"：用户有权拿到自己的数据副本）。
 *
 * 设计说明：
 *   * **不导出密码**：即使是可逆加密的密码也不放进去 ——
 *     导出文件是明文的、会被用户随手存在电脑里，带密码等于扩大泄露面。
 *   * 图片（头像是 base64 data URL）体积大，这里不导出，避免文件几百 MB；
 *     资料里只保留文字字段。
 *   * 每张表的查询都用 safeQuery 包一层：老库上某些表可能还不存在
 *     （比如 user_memories），不能因为一张表就导致整个导出失败。
 *   * 加了两道数量上限，防止超大账号把服务器内存撑爆。
 */
import { query } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/user-auth";
import { jsonError } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MESSAGES = 20000;
const MAX_DIARIES = 2000;

/** 表不存在 / 列不存在时返回空数组，不让整个导出失败 */
async function safeQuery(sql, params) {
  try {
    return await query(sql, params);
  } catch {
    return [];
  }
}

export async function GET(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  // 导出要扫全量数据，按用户限流
  const quota = rateLimit(`export-data:${user.id}`, {
    limit: 5,
    windowMs: 60 * 60 * 1000,
  });
  if (!quota.ok) {
    return jsonError(`导出太频繁，请 ${quota.retryAfterSeconds} 秒后再试`, 429);
  }

  const [profileRows, conversations, messages, diariesWithMood, memories, assessments] =
    await Promise.all([
      safeQuery(
        `SELECT id, email, account, username, gender, birthday, phone, bio, created_at, last_login_at
           FROM users WHERE id = ? LIMIT 1`,
        [user.id]
      ),
      safeQuery(
        "SELECT id, title, created_at FROM conversations WHERE user_id = ? ORDER BY id",
        [user.id]
      ),
      safeQuery(
        `SELECT id, conversation_id, role, content, created_at FROM messages
          WHERE user_id = ? ORDER BY id LIMIT ${MAX_MESSAGES}`,
        [user.id]
      ),
      safeQuery(
        `SELECT id, title, content, mood, created_at FROM diaries
          WHERE user_id = ? ORDER BY id LIMIT ${MAX_DIARIES}`,
        [user.id]
      ),
      safeQuery(
        "SELECT id, content, category, created_at FROM user_memories WHERE user_id = ? ORDER BY id",
        [user.id]
      ),
      safeQuery(
        "SELECT id, type, data, created_at FROM assessment_results WHERE user_id = ? ORDER BY id",
        [user.id]
      ),
    ]);

  // 老库可能还没有 diaries.mood 列，上面的查询会整条失败 → 退回不带 mood 的查询
  let diaries = diariesWithMood;
  if (!diaries.length) {
    diaries = await safeQuery(
      `SELECT id, title, content, created_at FROM diaries
        WHERE user_id = ? ORDER BY id LIMIT ${MAX_DIARIES}`,
      [user.id]
    );
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    note:
      "这是你在 Solace 的个人数据导出文件，包含账号资料、对话、消息、日记等。出于安全考虑，密码与图片不包含在内。",
    profile: profileRows[0] || null,
    stats: {
      conversations: conversations.length,
      messages: messages.length,
      diaries: diaries.length,
      memories: memories.length,
      assessments: assessments.length,
    },
    conversations,
    messages,
    diaries,
    memories,
    assessments,
  };

  const filename = `solace-data-${new Date().toISOString().slice(0, 10)}.json`;

  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // 让浏览器直接下载成文件，而不是在标签页里打开
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
