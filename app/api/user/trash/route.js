/**
 * 回收站接口（用户端「我的」页面用）
 *
 *   GET    /api/user/trash                          列表（按分类分组）
 *   POST   /api/user/trash                          恢复：{ ids: [1,2] } 或 { all: true, category?: "diary" }
 *   DELETE /api/user/trash?ids=1,2                  批量彻底删除
 *   DELETE /api/user/trash?all=1[&category=diary]   整类清空 / 全部清空
 *
 * 设计要点：
 *   * **不返回 payload 正文**：payload 可能几百 KB，列表接口只给元信息，恢复时由服务端自己读；
 *   * 恢复/删除**都限定在 `user_id = 当前用户`**，防止越权操作别人的回收站；
 *   * 恢复失败（比如所属对话也没了）会逐条返回原因，不整体失败。
 */
import { getCurrentUser } from "@/lib/user-auth";
import { execute, query } from "@/lib/db";
import { json, jsonError } from "@/lib/util";
import {
  MAX_PAYLOAD_BYTES,
  TRASH_CATEGORIES,
  TRASH_DAYS,
  purgeExpiredTrash,
  restoreTrashItem,
  typesOfCategory,
} from "@/lib/trash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 单次批量操作的条数上限，防止一次点"全部恢复"卡死 */
const MAX_BATCH = 200;

/** 从 query string 里解析出 id 列表 */
function parseIds(request, body) {
  const url = new URL(request.url);

  const fromBody = Array.isArray(body?.ids) ? body.ids : [];
  const fromQuery = String(url.searchParams.get("ids") || "")
    .split(",")
    .filter(Boolean)
    .map((value) => Number(value));

  const merged = [...fromBody, ...fromQuery]
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);

  return [...new Set(merged)].slice(0, MAX_BATCH);
}

// ---------------- 列表 ----------------
export async function GET(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  // 顺手清掉过期的，保证用户看到的都是还能恢复的
  try {
    await purgeExpiredTrash();
  } catch {
    /* 清理失败不影响列表 */
  }

  const url = new URL(request.url);
  const category = url.searchParams.get("category");
  const wantedTypes = typesOfCategory(category);

  const params = [user.id];
  let where = "WHERE user_id = ?";
  if (wantedTypes) {
    where += ` AND item_type IN (${wantedTypes.map(() => "?").join(", ")})`;
    params.push(...wantedTypes);
  }

  // ?id=X 时返回单条详情（给"点开看内容"的预览弹窗用）
  const singleId = Number(url.searchParams.get("id") || 0);
  if (singleId > 0) {
    const one = await query(
      `SELECT id, item_type, title, payload, deleted_at, expire_at
         FROM trash
        WHERE id = ? AND user_id = ?
        LIMIT 1`,
      [singleId, user.id]
    );
    if (!one.length) return jsonError("这条内容已经被清理或彻底删除了", 404);

    const row = one[0];
    let payload = row.payload;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = {};
      }
    }
    const at = Date.now();
    const expireMs = row.expire_at ? new Date(row.expire_at).getTime() : at;

    return json({
      ok: true,
      item: {
        id: row.id,
        itemType: row.item_type,
        category: TRASH_CATEGORIES.find((c) => c.types.includes(row.item_type))?.id || "chat",
        title: row.title || "（无标题）",
        deletedAt: row.deleted_at,
        expireAt: row.expire_at,
        remainMs: Math.max(0, expireMs - at),
        payload,
      },
    });
  }

  const rows = await query(
    `SELECT id, item_type, title, deleted_at, expire_at,
            CHAR_LENGTH(payload) AS payload_chars
       FROM trash
       ${where}
      ORDER BY deleted_at DESC, id DESC
      LIMIT 300`,
    params
  );

  const now = Date.now();

  const items = rows.map((row) => {
    const expireAt = row.expire_at ? new Date(row.expire_at).getTime() : now;
    // payload 是 JSON 字符串，MySQL 里按 utf8mb4 存，这里用字符数估算字节数
    const approxBytes = Number(row.payload_chars || 0) * 3;

    return {
      id: row.id,
      itemType: row.item_type,
      category: TRASH_CATEGORIES.find((c) => c.types.includes(row.item_type))?.id || "chat",
      title: row.title || "（无标题）",
      deletedAt: row.deleted_at,
      expireAt: row.expire_at,
      remainMs: Math.max(0, expireAt - now),
      sizeKb: Math.round(approxBytes / 1024),
    };
  });

  // 每个分类的条数（不管当前筛选的是什么，都给全，方便 tab 上显示角标）
  const counts = {};
  for (const item of items) {
    if (wantedTypes) break;
    counts[item.category] = (counts[item.category] || 0) + 1;
  }

  return json({
    ok: true,
    days: TRASH_DAYS,
    maxPayloadKb: Math.round(MAX_PAYLOAD_BYTES / 1024),
    categories: TRASH_CATEGORIES.map((item) => ({
      id: item.id,
      label: item.label,
      count: wantedTypes ? undefined : counts[item.id] || 0,
    })),
    items,
    total: items.length,
  });
}

// ---------------- 恢复 ----------------
export async function POST(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const userId = user.id;
  const restoreAll = body?.all === true;
  const category = body?.category ? String(body.category) : null;
  const ids = restoreAll ? [] : parseIds(request, body);

  if (!restoreAll && !ids.length) return jsonError("请选择要恢复的条目", 400);

  const params = [userId];
  let where = "WHERE user_id = ?";
  if (restoreAll) {
    const wantedTypes = typesOfCategory(category);
    if (wantedTypes) {
      where += ` AND item_type IN (${wantedTypes.map(() => "?").join(", ")})`;
      params.push(...wantedTypes);
    }
  } else {
    where += ` AND id IN (${ids.map(() => "?").join(", ")})`;
    params.push(...ids);
  }

  const rows = await query(
    `SELECT id, item_type, title, payload FROM trash ${where} ORDER BY deleted_at ASC LIMIT ${MAX_BATCH}`,
    params
  );

  if (!rows.length) return jsonError("没有找到可恢复的条目", 404);

  const restored = [];
  const failed = [];

  for (const row of rows) {
    try {
      const result = await restoreTrashItem(userId, row);
      if (result.ok) {
        await execute("DELETE FROM trash WHERE id = ? AND user_id = ?", [row.id, userId]);
        restored.push({ id: row.id, title: row.title || "（无标题）" });
      } else {
        failed.push({ id: row.id, title: row.title || "（无标题）", reason: result.reason });
      }
    } catch (err) {
      failed.push({
        id: row.id,
        title: row.title || "（无标题）",
        reason: "恢复失败：" + String(err?.message || err).slice(0, 120),
      });
    }
  }

  return json({
    ok: true,
    restoredCount: restored.length,
    failedCount: failed.length,
    restored: restored.slice(0, 20),
    failed: failed.slice(0, 20),
  });
}

// ---------------- 彻底删除 ----------------
export async function DELETE(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const userId = user.id;
  const url = new URL(request.url);
  const deleteAll = url.searchParams.get("all") === "1";
  const category = url.searchParams.get("category");
  const ids = deleteAll ? [] : parseIds(request, null);

  if (!deleteAll && !ids.length) return jsonError("请选择要删除的条目", 400);

  let result;
  if (deleteAll) {
    const wantedTypes = typesOfCategory(category);
    if (wantedTypes) {
      result = await execute(
        `DELETE FROM trash WHERE user_id = ? AND item_type IN (${wantedTypes
          .map(() => "?")
          .join(", ")})`,
        [userId, ...wantedTypes]
      );
    } else {
      result = await execute("DELETE FROM trash WHERE user_id = ?", [userId]);
    }
  } else {
    result = await execute(
      `DELETE FROM trash WHERE user_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
      [userId, ...ids]
    );
  }

  return json({
    ok: true,
    deletedCount: result?.affectedRows || 0,
  });
}
