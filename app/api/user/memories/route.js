/**
 * 长期记忆（读取端）：列表 / 新增 / 删除。
 *
 * 表 user_memories 由用户手动创建，字段：
 *   id / user_id / content / category / created_at
 * 本接口只负责读写，不做自动提炼（提炼逻辑后续再接）。
 *
 * 所有查询都带 user_id 条件，保证只能操作自己的记忆。
 */
import { describeDbError, execute, query } from "@/lib/db";
import { ensureUserColumnsOnce } from "@/lib/schema";
import { pushToTrash } from "@/lib/trash";
import { getCurrentUser } from "@/lib/user-auth";
import { cleanString, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CONTENT_CHARS = 200; // 单条记忆长度上限
const MAX_CATEGORY_CHARS = 32;
const MAX_RECORDS = 200; // 列表一次最多返回

function parseId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return 0;
  const id = Number.parseInt(text, 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

/** 读取当前用户的全部记忆，按时间倒序 */
export async function GET(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  try {
    // 老部署升级时自动补新表 / 新列（老库不会重跑安装向导，这里兜底一次）
    try {
      await ensureUserColumnsOnce();
    } catch {
      /* 补表失败不阻塞读取 */
    }

    const memories = await query(
      `SELECT id, user_id, content, category, created_at
       FROM user_memories
       WHERE user_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ${MAX_RECORDS}`,
      [user.id]
    );
    return json({ ok: true, memories });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

/** 手动新增一条记忆 */
export async function POST(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const body = await readJsonBody(request);
  const content = cleanString(body.content, MAX_CONTENT_CHARS);
  if (!content) return jsonError("记忆内容不能为空", 400);

  const category = cleanString(body.category, MAX_CATEGORY_CHARS) || null;

  try {
    // created_at 不指定，由数据库 DEFAULT CURRENT_TIMESTAMP 按北京时间生成
    const result = await execute(
      "INSERT INTO user_memories (user_id, content, category) VALUES (?, ?, ?)",
      [user.id, content, category]
    );
    return json({
      ok: true,
      memory: { id: result.insertId, user_id: user.id, content, category },
    });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

/**
 * 删除一条记忆：只允许删自己的。
 *
 * 和日记 / 对话一样，默认**先进回收站**（保留 3 天，可在「我的 → 回收站 → 记忆」里恢复）；
 * 带 `?permanent=1` 表示彻底删除，不经过回收站。
 */
export async function DELETE(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const url = new URL(request.url);
  const permanent = url.searchParams.get("permanent") === "1";

  const body = await readJsonBody(request);
  const id = parseId(body.id);
  if (!id) return jsonError("缺少记忆 id", 400);

  try {
    // 默认「删除」：先把完整内容存进回收站，再删原记录
    if (!permanent) {
      try {
        const rows = await query(
          "SELECT id, content, category, created_at FROM user_memories WHERE id = ? AND user_id = ? LIMIT 1",
          [id, user.id]
        );
        if (rows.length) {
          await pushToTrash({
            userId: user.id,
            itemType: "memory",
            title: String(rows[0].content || "").slice(0, 40) || "一条记忆",
            payload: rows[0],
          });
        }
      } catch {
        /* 回收站写入失败不阻止删除（老库可能还没建 trash 表） */
      }
    }

    const result = await execute(
      "DELETE FROM user_memories WHERE id = ? AND user_id = ?",
      [id, user.id]
    );
    if (!result.affectedRows) return jsonError("记忆不存在", 404);
    return json({ ok: true });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
