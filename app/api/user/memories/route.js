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
import { isInvalidMemoryContent, saveMemory } from "@/lib/memory-store";
import { pushToTrash } from "@/lib/trash";
import { getCurrentUser } from "@/lib/user-auth";
import { cleanString, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CONTENT_CHARS = 200; // 单条记忆长度上限
const MAX_CATEGORY_CHARS = 32;
const MAX_RECORDS = 200; // 删除接口一次最多处理多少条
const MAX_PAGE_SIZE = 100; // 列表分页上限
const DEFAULT_PAGE_SIZE = 30; // 默认只取最近 30 条（首屏体积小、打开快）
// 图谱模式：一次最多给前端多少个节点。
// ⚠️ 硬上限 150 —— 3D 电子云（react-force-graph-3d + three）再往上会明显掉帧。
//    排序是「有效 → 核心(画像/偏好/关系/愿望) → 强度降序」，核心永远不会被挤出前 150。
const MAX_GRAPH_NODES = 150;

function parseId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return 0;
  const id = Number.parseInt(text, 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

/** 读取当前用户的记忆：支持关键词搜索 + 分页（默认 50 条/页） */
export async function GET(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const url = new URL(request.url);
  const q = cleanString(url.searchParams.get("q"), 50);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const pageSize = Math.max(
    1,
    Math.min(MAX_PAGE_SIZE, Number(url.searchParams.get("pageSize")) || DEFAULT_PAGE_SIZE)
  );
  // graph=1：一次性给「记忆图谱」用的扁平节点（不搜索、不分页）
  const wantGraph = url.searchParams.get("graph") === "1";

  try {
    // 老部署升级时自动补新表 / 新列（老库不会重跑安装向导，这里兜底一次）
    try {
      await ensureUserColumnsOnce();
    } catch {
      /* 补表失败不阻塞读取 */
    }

    if (wantGraph) {
      // 排序 = 图谱要的"谁必须出现"：
      //   ① 有效记忆在前（失效的也要给，图谱里显示成灰色，可点击恢复）；
      //   ② 核心记忆（画像 / 偏好 / 关系）再靠前 —— 哪怕超过 200 个节点上限，
      //      也绝不会被普通事件挤出图谱；
      //   ③ 同组内强度高的优先（快淡出的排在后面）。
      const countRows = await query(
        "SELECT COUNT(*) AS total FROM user_memories WHERE user_id = ?",
        [user.id]
      );
      const total = Number(countRows?.[0]?.total) || 0;

      const memories = await query(
        `SELECT id, user_id, content, category, superseded_at, strength, created_at
           FROM user_memories
          WHERE user_id = ?
          ORDER BY (superseded_at IS NULL) DESC,
                   (category IN ('profile','preference','relation','wish')) DESC,
                   strength DESC, created_at DESC, id DESC
          LIMIT ?`,
        [user.id, MAX_GRAPH_NODES]
      );

      const cleanMemories = (Array.isArray(memories) ? memories : []).filter(m => !isInvalidMemoryContent(m.content));
      return json({
        ok: true,
        graph: true,
        memories: cleanMemories,
        total: Math.min(total, cleanMemories.length),
        // 超出 150 的部分这次没有画出来（前端会提示"只渲染最强的 150 条"）
        truncated: total > cleanMemories.length,
      });
    }

    // 关键词只匹配内容（分类有筛选条，不需要在这里搜）
    const where = q ? "WHERE user_id = ? AND content LIKE ?" : "WHERE user_id = ?";
    const whereParams = q ? [user.id, `%${q}%`] : [user.id];

    const countRows = await query(
      `SELECT COUNT(*) AS total FROM user_memories ${where}`,
      whereParams
    );
    const total = Number(countRows?.[0]?.total) || 0;

    const memories = await query(
      `SELECT id, user_id, content, category, superseded_at, strength, created_at
       FROM user_memories
       ${where}
       ORDER BY (superseded_at IS NULL) DESC, created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...whereParams, pageSize, (page - 1) * pageSize]
    );

    const cleanList = (Array.isArray(memories) ? memories : []).filter(m => !isInvalidMemoryContent(m.content));
    return json({ ok: true, memories: cleanList, total: Math.min(total, cleanList.length), page, pageSize });
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
    // 走统一写入口：和自动提炼的记忆一样做近似去重 ——
    // 已存在相同/高度相似的记忆时不新增，只刷新旧记录的时间（让它重新靠前），
    // 返回 deduplicated 让前端可以提示"这条之前已经记过了"。
    const saved = await saveMemory(user.id, content, category);
    return json({
      ok: true,
      deduplicated: saved.status === "reinforced",
      memory: {
        id: saved.id || 0,
        user_id: user.id,
        content,
        category,
      },
    });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

/**
 * 修改一条记忆（内容 / 分类）。
 *
 * 为什么需要：自动提炼难免记错或记偏（"他好像在杭州"），旧版本只能删掉重加，
 * 用户既不知道会丢什么、也懒得重敲。这里只允许改**自己的**记录。
 *
 * ⚠️ 不走 saveMemory 的去重流程：编辑是"把这条改成我说的话"，
 *    和"新增一条"语义不同；如果改完和别的记忆重复，交给用户自己决定删哪条。
 */
export async function PATCH(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const body = await readJsonBody(request);
  const id = parseId(body.id);
  if (!id) return jsonError("缺少记忆 id", 400);

  const hasContent = typeof body.content === "string";
  const hasCategory = body.category !== undefined;
  const restore = body.restore === true; // 恢复一条被标记失效的记忆

  const sets = [];
  const params = [];
  if (hasContent) {
    const content = cleanString(body.content, MAX_CONTENT_CHARS);
    if (!content) return jsonError("记忆内容不能为空", 400);
    sets.push("content = ?");
    params.push(content);
  }
  if (hasCategory) {
    const category = cleanString(body.category, MAX_CATEGORY_CHARS) || null;
    sets.push("category = ?");
    params.push(category);
  }
  if (restore) {
    sets.push("superseded_at = NULL");
    // 恢复 = 用户亲手认定"这条还重要"：强度和时间一起重置。
    // ⚠️ 不重置的话，一条已经衰减到个位数的记忆第二天就会被衰减任务回收，
    //    用户点了恢复、结果第二天它自己又没了 —— 看起来像功能坏了。
    sets.push("strength = 100", "last_accessed_at = NOW()");
  }
  if (!sets.length) return jsonError("没有要修改的内容", 400);

  try {
    // WHERE 带 user_id：别人的记忆即使猜到 id 也改不了。
    // ⚠️ 不能拿 affectedRows 判存在：值没变化的 UPDATE 会返回 0（比如已恢复的记忆再点一次恢复），
    //    所以统一在执行后 SELECT 一次，查不到才算不存在。
    await execute(
      `UPDATE user_memories SET ${sets.join(", ")} WHERE user_id = ? AND id = ?`,
      [...params, user.id, id]
    );

    const rows = await query(
      `SELECT id, user_id, content, category, superseded_at, created_at
         FROM user_memories WHERE user_id = ? AND id = ? LIMIT 1`,
      [user.id, id]
    );
    if (!rows.length) return jsonError("记忆不存在", 404);
    return json({ ok: true, memory: rows[0] });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

/**
 * 删除记忆：只允许删自己的。支持单条（{ id }）与批量（{ ids: [...] }，多选删除）。
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
  // 兼容两种传参：{ id } 单条 / { ids: [...] } 批量（一次最多 MAX_RECORDS 条）
  const rawIds = Array.isArray(body.ids) ? body.ids : [body.id];
  const ids = [...new Set(rawIds.map((v) => parseId(v)).filter(Boolean))].slice(
    0,
    MAX_RECORDS
  );
  if (!ids.length) return jsonError("缺少记忆 id", 400);

  const placeholders = ids.map(() => "?").join(", ");

  try {
    // 默认「删除」：先把完整内容存进回收站，再删原记录
    if (!permanent) {
      try {
        const rows = await query(
          `SELECT id, content, category, created_at FROM user_memories WHERE user_id = ? AND id IN (${placeholders})`,
          [user.id, ...ids]
        );
        for (const row of rows) {
          try {
            await pushToTrash({
              userId: user.id,
              itemType: "memory",
              title: String(row.content || "").slice(0, 40) || "一条记忆",
              payload: row,
            });
          } catch {
            /* 单条入站失败不阻断其他条 */
          }
        }
      } catch {
        /* 回收站写入失败不阻止删除（老库可能还没建 trash 表） */
      }
    }

    const result = await execute(
      `DELETE FROM user_memories WHERE user_id = ? AND id IN (${placeholders})`,
      [user.id, ...ids]
    );
    if (!result.affectedRows) return jsonError("记忆不存在", 404);
    return json({ ok: true, deleted: result.affectedRows });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
