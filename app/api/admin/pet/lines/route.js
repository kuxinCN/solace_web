/**
 * 后台桌宠回复话术：GET 列表 / POST 新增 / PATCH 修改 / DELETE 删除
 *
 * 一条情绪可以挂**多条**回复，用户点了那个情绪时随机挑一条说出来
 * （真的随机，不是"永远第一句"——所以同一次点击不会永远得到同一句话）。
 *
 * ⚠️ 单句长度上限 60 字（`PET_LINE_MAX_CHARS`）：那句话是浮在蝴蝶边上的小气泡，
 *    不是聊天消息。写长了气泡会变成一大块，把蝴蝶挡住。
 *
 * ⚠️ 一条都不剩的情绪会变成"只动不说话"（不报错、不崩）。
 *    如果某条情绪的回复被全部删掉，用户点它只会看到动画 —— 这是有意为之，
 *    但后台面板会提示"这条情绪还没有回复"。
 */
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import { describeDbError, execute, query } from "@/lib/db";
import { PET_LINE_LIMIT, normalizeLineInput } from "@/lib/pet-store";
import { clientIp, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return 0;
  const id = Number.parseInt(text, 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

export async function GET(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const moodId = parseId(new URL(request.url).searchParams.get("moodId"));

  try {
    const lines = await query(
      `SELECT id, mood_id, text, sort_order, enabled, created_at
         FROM pet_lines
        ${moodId ? "WHERE mood_id = ?" : ""}
        ORDER BY mood_id ASC, sort_order ASC, id ASC
        LIMIT 500`,
      moodId ? [moodId] : []
    );
    return json({ ok: true, lines, limit: PET_LINE_LIMIT });
  } catch (err) {
    return json({ ok: true, lines: [], limit: PET_LINE_LIMIT, note: describeDbError(err) });
  }
}

export async function POST(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);
  const moodId = parseId(body.moodId ?? body.mood_id);
  if (!moodId) return jsonError("缺少所属情绪 id", 400);

  const checked = normalizeLineInput(body);
  if (!checked.ok) return jsonError(checked.error, 400);

  try {
    const moodRows = await query("SELECT id, label FROM pet_moods WHERE id = ? LIMIT 1", [moodId]);
    const mood = moodRows[0];
    if (!mood) return jsonError("所属情绪不存在", 404);

    const rows = await query("SELECT COUNT(*) AS total FROM pet_lines WHERE mood_id = ?", [moodId]);
    if (Number(rows[0]?.total || 0) >= PET_LINE_LIMIT) {
      return jsonError(`一条情绪最多挂 ${PET_LINE_LIMIT} 句回复`, 400);
    }

    const result = await execute(
      `INSERT INTO pet_lines (mood_id, text, sort_order, enabled) VALUES (?, ?, ?, ?)`,
      [moodId, checked.value.text, checked.value.sort_order, body.enabled === false ? 0 : 1]
    );

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "add_pet_line",
      detail: `${mood.label}：${checked.value.text}`,
      ip: clientIp(request),
    });

    return json({ ok: true, id: result.insertId });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function PATCH(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);
  const id = parseId(body.id);
  if (!id) return jsonError("缺少话术 id", 400);

  const sets = [];
  const params = [];

  if (typeof body.text === "string") {
    const checked = normalizeLineInput({ text: body.text });
    if (!checked.ok) return jsonError(checked.error, 400);
    sets.push("text = ?");
    params.push(checked.value.text);
  }
  if (body.sortOrder !== undefined) {
    sets.push("sort_order = ?");
    params.push(Number.isInteger(Number(body.sortOrder)) ? Number(body.sortOrder) : 0);
  }
  if (body.enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(body.enabled === true || body.enabled === 1 || body.enabled === "1" ? 1 : 0);
  }

  if (!sets.length) return jsonError("没有需要修改的内容", 400);

  try {
    const result = await execute(`UPDATE pet_lines SET ${sets.join(", ")} WHERE id = ?`, [
      ...params,
      id,
    ]);
    if (!result.affectedRows) {
      const exists = await query("SELECT id FROM pet_lines WHERE id = ? LIMIT 1", [id]);
      if (!exists.length) return jsonError("话术不存在", 404);
    }

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "update_pet_line",
      detail: `#${id} ${sets.join(", ")}`,
      ip: clientIp(request),
    });

    return json({ ok: true });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function DELETE(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const id = parseId(new URL(request.url).searchParams.get("id"));
  if (!id) return jsonError("缺少话术 id", 400);

  try {
    const rows = await query("SELECT id, text FROM pet_lines WHERE id = ? LIMIT 1", [id]);
    const line = rows[0];
    if (!line) return jsonError("话术不存在", 404);

    await execute("DELETE FROM pet_lines WHERE id = ?", [id]);

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "delete_pet_line",
      detail: line.text,
      ip: clientIp(request),
    });

    return json({ ok: true });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
