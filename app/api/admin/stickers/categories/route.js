/**
 * 后台表情包分类：GET 列表 / POST 新增 / PATCH 修改 / DELETE 删除
 *
 * 分类即"情绪"：关键词、优先级、深夜放宽、是否纳入 AI 判定、是否可触发全在这一行。
 * 引擎（`lib/sticker-engine.js`）不再从模块常量读词表，改读这里（带 30 秒缓存）。
 * 所以**任何写操作都要 `invalidateStickerSpec()`** —— 否则后台改完要等最多 30 秒才生效，
 * 管理员会以为"没保存上"，然后再改一遍。
 *
 * ⚠️ 两个名字建好之后**不许改**：
 *   * `cat_key` 是程序内的情绪身份；
 *   * `sticker_key` 是磁盘目录名 = `[sticker:xxx]` 标记名（已经写进历史消息了）。
 *     真要改目录名：改磁盘目录 → 新增一个分类 → 把素材重新登记 → 停用旧的，
 *     否则历史消息里的标记会指向一个不存在的目录（用户看到的是一个空白的贴纸位）。
 *
 * ⚠️ 删除分类时**必须先清空素材**（下面有拦截）。理由：留下素材就是一堆没人引用的孤儿文件，
 *    而且下次谁新建一个同名分类会突然"继承"几张莫名其妙的图。
 */
import fs from "node:fs";
import path from "node:path";
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import { describeDbError, execute, query } from "@/lib/db";
import {
  STICKER_CATEGORY_LIMIT,
  STICKER_KEYWORD_LIMIT,
  STICKER_ROOT,
  invalidateStickerSpec,
  listCategories,
  normalizeCategoryInput,
  parseKeywords,
} from "@/lib/sticker-store";
import { cleanString, clientIp, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return 0;
  const id = Number.parseInt(text, 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

/**
 * 找出与其它分类重复的关键词 —— **只提示，不拦**。
 * 一句话同时命中两个分类时，最终发哪张由优先级决定；管理员看不到这个提示就会很困惑
 * （"我明明把词加进去了，怎么发的是另一张图"）。
 */
function findKeywordConflicts(categories, targetId, keywords) {
  const mine = new Set(parseKeywords(keywords));
  const conflicts = [];
  for (const row of categories) {
    if (Number(row.id) === Number(targetId)) continue;
    for (const word of parseKeywords(row.keywords)) {
      if (mine.has(word)) conflicts.push({ word, with: row.cat_key, label: row.label });
    }
  }
  return conflicts;
}

export async function GET(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  try {
    const categories = await listCategories();
    const counts = await query(
      "SELECT category, COUNT(*) AS total, SUM(enabled = 1) AS enabled FROM stickers GROUP BY category"
    );
    const countMap = Object.fromEntries(
      counts.map((row) => [String(row.category), { total: Number(row.total), enabled: Number(row.enabled) }])
    );
    return json({
      ok: true,
      categories: categories.map((row) => ({
        ...row,
        keywords: row.keywords || "",
        stickerCount: countMap[String(row.sticker_key)] || { total: 0, enabled: 0 },
      })),
      limit: STICKER_CATEGORY_LIMIT,
      keywordLimit: STICKER_KEYWORD_LIMIT,
    });
  } catch (err) {
    return json({ ok: true, categories: [], limit: STICKER_CATEGORY_LIMIT, note: describeDbError(err) });
  }
}

export async function POST(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);
  const checked = normalizeCategoryInput(body);
  if (!checked.ok) return jsonError(checked.error, 400);

  try {
    const rows = await query("SELECT COUNT(*) AS total FROM sticker_categories");
    if (Number(rows[0]?.total || 0) >= STICKER_CATEGORY_LIMIT) {
      return jsonError(`表情包分类最多 ${STICKER_CATEGORY_LIMIT} 个`, 400);
    }

    const dup = await query(
      "SELECT cat_key, sticker_key FROM sticker_categories WHERE cat_key = ? OR sticker_key = ? LIMIT 2",
      [checked.value.cat_key, checked.value.sticker_key]
    );
    if (dup.length) {
      const hit = dup.find((row) => row.cat_key === checked.value.cat_key);
      return jsonError(
        hit ? `情绪键 ${checked.value.cat_key} 已经存在` : `素材目录名 ${checked.value.sticker_key} 已经被占用`,
        400
      );
    }

    // 顺手把素材目录建出来：否则管理员新增完分类、点上传会因为目录不存在而失败
    let dirCreated = false;
    try {
      fs.mkdirSync(path.join(STICKER_ROOT, checked.value.sticker_key), { recursive: true });
      dirCreated = true;
    } catch {
      /* 建不出来也能继续：上传接口自己会 mkdir */
    }

    const result = await execute(
      `INSERT INTO sticker_categories
         (cat_key, sticker_key, label, keywords, priority, late_night, ai_detect,
          triggerable, enabled, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        checked.value.cat_key,
        checked.value.sticker_key,
        checked.value.label,
        checked.value.keywords,
        checked.value.priority,
        checked.value.late_night,
        checked.value.ai_detect,
        checked.value.triggerable,
        body.enabled === false ? 0 : 1,
        checked.value.sort_order,
      ]
    );

    invalidateStickerSpec();

    const categories = await listCategories();
    const conflicts = findKeywordConflicts(categories, result.insertId, checked.value.keywords);

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "add_sticker_category",
      detail: `${checked.value.label}（${checked.value.cat_key} → ${checked.value.sticker_key}）`,
      ip: clientIp(request),
    });

    return json({ ok: true, id: result.insertId, dirCreated, conflicts });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function PATCH(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);
  const id = parseId(body.id);
  if (!id) return jsonError("缺少分类 id", 400);

  try {
    const rows = await query(
      `SELECT id, cat_key, sticker_key, label, keywords, priority, late_night, ai_detect,
              triggerable, enabled, sort_order
         FROM sticker_categories WHERE id = ? LIMIT 1`,
      [id]
    );
    const current = rows[0];
    if (!current) return jsonError("分类不存在", 404);

    // 两个名字不可改：只把"可改的字段"合成一份完整输入再走同一套校验
    const checked = normalizeCategoryInput({
      catKey: current.cat_key,
      stickerKey: current.sticker_key,
      label: body.label !== undefined ? body.label : current.label,
      keywords: body.keywords !== undefined ? body.keywords : current.keywords,
      priority: body.priority !== undefined ? body.priority : current.priority,
      lateNight: body.lateNight !== undefined ? body.lateNight : Number(current.late_night) === 1,
      aiDetect: body.aiDetect !== undefined ? body.aiDetect : Number(current.ai_detect) === 1,
      triggerable:
        body.triggerable !== undefined ? body.triggerable : Number(current.triggerable) === 1,
      sortOrder: body.sortOrder !== undefined ? body.sortOrder : current.sort_order,
    });
    if (!checked.ok) return jsonError(checked.error, 400);

    const sets = [
      "label = ?",
      "keywords = ?",
      "priority = ?",
      "late_night = ?",
      "ai_detect = ?",
      "triggerable = ?",
      "sort_order = ?",
    ];
    const params = [
      checked.value.label,
      checked.value.keywords,
      checked.value.priority,
      checked.value.late_night,
      checked.value.ai_detect,
      checked.value.triggerable,
      checked.value.sort_order,
    ];

    if (body.enabled !== undefined) {
      sets.push("enabled = ?");
      params.push(body.enabled === true || body.enabled === 1 || body.enabled === "1" ? 1 : 0);
    }

    await execute(`UPDATE sticker_categories SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
    invalidateStickerSpec();

    const categories = await listCategories();
    const conflicts = findKeywordConflicts(categories, id, checked.value.keywords);

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "update_sticker_category",
      detail: `#${id} ${checked.value.label}`,
      ip: clientIp(request),
    });

    return json({ ok: true, conflicts });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function DELETE(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const id = parseId(new URL(request.url).searchParams.get("id"));
  if (!id) return jsonError("缺少分类 id", 400);

  try {
    const rows = await query(
      "SELECT id, cat_key, sticker_key, label FROM sticker_categories WHERE id = ? LIMIT 1",
      [id]
    );
    const category = rows[0];
    if (!category) return jsonError("分类不存在", 404);

    // ⚠️ 有素材就拦住：否则会留下没人引用的孤儿素材，
    //    而且下次新建同名分类会突然"继承"几张莫名其妙的图
    const used = await query("SELECT COUNT(*) AS total FROM stickers WHERE category = ?", [
      category.sticker_key,
    ]);
    const total = Number(used[0]?.total || 0);
    if (total > 0) {
      return jsonError(
        `这个分类下还有 ${total} 张素材，先删掉或转走素材再删分类（素材在 public/stickers/${category.sticker_key}/）`,
        400
      );
    }

    await execute("DELETE FROM sticker_categories WHERE id = ?", [id]);

    // 顺手删掉空的素材目录（有残留文件就不动它 —— 那是有人手动放的东西）
    let dirRemoved = false;
    try {
      const dir = path.join(STICKER_ROOT, category.sticker_key);
      const files = fs.readdirSync(dir);
      if (!files.length) {
        fs.rmdirSync(dir);
        dirRemoved = true;
      }
    } catch {
      /* 目录不存在 / 删不掉都不算错 */
    }

    invalidateStickerSpec();

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "delete_sticker_category",
      detail: `${category.label}（${category.sticker_key}${dirRemoved ? "，空目录已删" : ""}）`,
      ip: clientIp(request),
    });

    return json({ ok: true, dirRemoved });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
