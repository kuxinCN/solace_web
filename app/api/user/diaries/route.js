/** 日记：列表 / 新增 / 编辑 / 删除 */
import { describeDbError, execute, query } from "@/lib/db";
import { ensureUserColumnsOnce } from "@/lib/schema";
import { pushToTrash } from "@/lib/trash";
import { getCurrentUser } from "@/lib/user-auth";
import { cleanString, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CONTENT_CHARS = 20000;

function parseId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return 0;
  const id = Number.parseInt(text, 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

/** 布尔语义统一成 0 / 1（兼容 true/"true"/1/"1" 等前端常见写法） */
function toFlag(value) {
  return value === true || value === 1 || value === "1" || value === "true" ? 1 : 0;
}

export async function GET(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  try {
    // 老部署升级时自动补 mood 列。
    // ⚠️ 补列失败（比如数据库账号没有 ALTER 权限）绝不能拖垮整个接口，
    // 否则用户会连自己的日记都看不到 —— 所以单独包一层，失败了继续往下走。
    try {
      await ensureUserColumnsOnce();
    } catch {
      /* 忽略：下面的查询若真的缺列，会给出更明确的错误 */
    }

    const diaries = await query(
      "SELECT id, user_id, title, content, mood, is_pinned, is_favorited, created_at FROM diaries WHERE user_id = ? ORDER BY id DESC",
      [user.id]
    );
    return json({ ok: true, diaries });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function POST(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const body = await readJsonBody(request);
  const title = cleanString(body.title, 120) || "无题";
  const content = cleanString(body.content, MAX_CONTENT_CHARS);

  if (!content) return jsonError("先写点什么吧，哪怕一句也好", 400);

  try {
    const result = await execute(
      "INSERT INTO diaries (user_id, title, content) VALUES (?, ?, ?)",
      [user.id, title, content]
    );
    return json({
      ok: true,
      diary: {
        id: result.insertId,
        user_id: user.id,
        title,
        content,
        is_pinned: 0,
        is_favorited: 0,
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

  // 入参支持两种形式：
  //   单条：{ id: 12, is_pinned: true }
  //   批量：{ ids: [12, 13], is_favorited: true }（为后续批量操作预留）
  const rawIds = Array.isArray(body.ids) ? body.ids : [body.id];
  const ids = [...new Set(rawIds.map(parseId).filter(Boolean))].slice(0, 200);
  if (!ids.length) return jsonError("缺少日记 id", 400);
  const singleId = ids[0];

  const sets = [];
  const params = [];

  if (typeof body.title === "string") {
    sets.push("title = ?");
    params.push(cleanString(body.title, 120) || "无题");
  }
  if (typeof body.content === "string") {
    const content = cleanString(body.content, MAX_CONTENT_CHARS);
    if (!content) return jsonError("正文不能为空", 400);
    sets.push("content = ?");
    params.push(content);
    // 正文改了，之前的情绪标签不再适用，清掉等重新分析（前端可再次调用 /mood）
    sets.push("mood = NULL");
  }
  // 置顶 / 收藏：只接受布尔语义，统一存成 0 / 1
  if (body.is_pinned !== undefined) {
    sets.push("is_pinned = ?");
    params.push(toFlag(body.is_pinned));
  }
  if (body.is_favorited !== undefined) {
    sets.push("is_favorited = ?");
    params.push(toFlag(body.is_favorited));
  }
  if (!sets.length) return jsonError("没有需要修改的内容", 400);

  // 标题/正文这类正文修改只对单条生效，不允许批量误伤
  const canBatch = !("title" in body) && !("content" in body);
  const targetIds = canBatch ? ids : [singleId];
  const placeholders = targetIds.map(() => "?").join(", ");

  try {
    const result = await execute(
      `UPDATE diaries SET ${sets.join(", ")} WHERE id IN (${placeholders}) AND user_id = ?`,
      [...params, ...targetIds, user.id]
    );

    if (!result.affectedRows) {
      // affectedRows 为 0 也可能只是「值没变」，再确认一次是否存在
      const exists = await query(
        `SELECT id FROM diaries WHERE id IN (${placeholders}) AND user_id = ? LIMIT 1`,
        [...targetIds, user.id]
      );
      if (!exists.length) return jsonError("日记不存在", 404);
    }
    return json({ ok: true, updated: result.affectedRows || 0 });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function DELETE(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  // 入参支持两种形式：
  //   单条：?id=12（沿用原有调用）
  //   批量：body { ids: [12, 13] }
  const url = new URL(request.url);
  const queryId = url.searchParams.get("id");
  // ⚠️ ?permanent=1 表示「彻底删除」：不进回收站，删了就没有了
  const permanent = url.searchParams.get("permanent") === "1";
  let rawIds = [];
  if (queryId) {
    rawIds = [queryId];
  } else {
    const body = await readJsonBody(request);
    rawIds = Array.isArray(body.ids) ? body.ids : [body.id];
  }
  const ids = [...new Set(rawIds.map(parseId).filter(Boolean))].slice(0, 200);
  if (!ids.length) return jsonError("缺少日记 id", 400);

  try {
    const placeholders = ids.map(() => "?").join(", ");

    // 「删除」：先取完整内容存进回收站，再删原记录 —— 用户 3 天内还能恢复
    // ⚠️ ?permanent=1（彻底删除）时跳过这一步
    try {
      if (permanent) throw new Error("skip-trash");
      const rows = await query(
        `SELECT id, title, content, mood, created_at FROM diaries
          WHERE id IN (${placeholders}) AND user_id = ?`,
        [...ids, user.id]
      );
      for (const row of rows) {
        await pushToTrash({
          userId: user.id,
          itemType: "diary",
          title: row.title || "无题",
          payload: row,
        });
      }
    } catch {
      /* 回收站写入失败不阻止删除（比如老库还没建 trash 表） */
    }

    const result = await execute(
      `DELETE FROM diaries WHERE id IN (${placeholders}) AND user_id = ?`,
      [...ids, user.id]
    );
    if (!result.affectedRows) return jsonError("日记不存在", 404);
    return json({ ok: true, deleted: result.affectedRows || 0 });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
