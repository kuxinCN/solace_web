/**
 * 后台桌宠情绪选项：GET 列表 / POST 新增 / PATCH 修改 / DELETE 删除
 *
 * 这些就是用户点开蝴蝶后看到的那排按钮（"我今天不开心""我心里很烦"…）。
 * 每条选项自带 `anim`（用哪种动画）与 `droop`（选过之后是否进入低垂状态）。
 *
 * ⚠️ `mood_key` 不允许改：它是程序内的身份（前端用它记"哪些情绪进过低垂"、
 *    以及以后要按情绪做统计时用它），改名等于换了一个情绪。
 *    要"换一个情绪"就新增一条、把旧的停用。
 *
 * ⚠️ 删除一条情绪会**连带删掉它挂的所有回复话术**（`pet_lines`）——
 *    留着的话就是一堆谁也不会用、还占着话术上限的记录。
 */
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import { describeDbError, execute, query } from "@/lib/db";
import {
  PET_LINE_LIMIT,
  PET_MOOD_LIMIT,
  listPetMoods,
  normalizeMoodInput,
} from "@/lib/pet-store";
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

  try {
    const moods = await listPetMoods();
    return json({
      ok: true,
      moods,
      limits: { moods: PET_MOOD_LIMIT, linesPerMood: PET_LINE_LIMIT },
    });
  } catch (err) {
    return json({
      ok: true,
      moods: [],
      limits: { moods: PET_MOOD_LIMIT, linesPerMood: PET_LINE_LIMIT },
      note: describeDbError(err),
    });
  }
}

export async function POST(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);
  const checked = normalizeMoodInput(body);
  if (!checked.ok) return jsonError(checked.error, 400);

  try {
    const rows = await query("SELECT COUNT(*) AS total FROM pet_moods");
    if (Number(rows[0]?.total || 0) >= PET_MOOD_LIMIT) {
      return jsonError(`情绪选项最多 ${PET_MOOD_LIMIT} 条，气泡放不下更多了`, 400);
    }

    const dup = await query("SELECT id FROM pet_moods WHERE mood_key = ? LIMIT 1", [
      checked.value.mood_key,
    ]);
    if (dup.length) return jsonError(`情绪键 ${checked.value.mood_key} 已经存在`, 400);

    const result = await execute(
      `INSERT INTO pet_moods (mood_key, label, anim, stay_ms, droop, sort_order, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        checked.value.mood_key,
        checked.value.label,
        checked.value.anim,
        checked.value.stay_ms,
        checked.value.droop,
        checked.value.sort_order,
        body.enabled === false ? 0 : 1,
      ]
    );

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "add_pet_mood",
      detail: `${checked.value.label}（${checked.value.mood_key} / ${checked.value.anim}）`,
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
  if (!id) return jsonError("缺少情绪 id", 400);

  try {
    const rows = await query(
      "SELECT id, mood_key, label, anim, stay_ms, droop, sort_order FROM pet_moods WHERE id = ? LIMIT 1",
      [id]
    );
    const current = rows[0];
    if (!current) return jsonError("情绪不存在", 404);

    // 把"改后的值"和"没改的值"合成一份完整输入再走同一套校验：
    // 这样 anim 从 goto 改成 droop 时，stay_ms / droop 会自动跟着变合理
    // （而不是留着 goto 时代的 0，让后台看着像"填了不生效"）
    const checked = normalizeMoodInput({
      key: current.mood_key,
      label: body.label !== undefined ? body.label : current.label,
      anim: body.anim !== undefined ? body.anim : current.anim,
      stay: body.stay !== undefined ? body.stay : current.stay_ms,
      droop: body.droop !== undefined ? body.droop : Number(current.droop) === 1,
      sortOrder: body.sortOrder !== undefined ? body.sortOrder : current.sort_order,
    });
    if (!checked.ok) return jsonError(checked.error, 400);

    const sets = ["label = ?", "anim = ?", "stay_ms = ?", "droop = ?", "sort_order = ?"];
    const params = [
      checked.value.label,
      checked.value.anim,
      checked.value.stay_ms,
      checked.value.droop,
      checked.value.sort_order,
    ];

    if (body.enabled !== undefined) {
      sets.push("enabled = ?");
      params.push(body.enabled === true || body.enabled === 1 || body.enabled === "1" ? 1 : 0);
    }

    await execute(`UPDATE pet_moods SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "update_pet_mood",
      detail: `#${id} ${checked.value.label}（${checked.value.anim}）`,
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
  if (!id) return jsonError("缺少情绪 id", 400);

  try {
    const rows = await query("SELECT id, mood_key, label FROM pet_moods WHERE id = ? LIMIT 1", [id]);
    const mood = rows[0];
    if (!mood) return jsonError("情绪不存在", 404);

    const removed = await execute("DELETE FROM pet_lines WHERE mood_id = ?", [id]);
    await execute("DELETE FROM pet_moods WHERE id = ?", [id]);

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "delete_pet_mood",
      detail: `${mood.label}（连带删掉 ${Number(removed?.affectedRows || 0)} 句回复）`,
      ip: clientIp(request),
    });

    return json({ ok: true, linesRemoved: Number(removed?.affectedRows || 0) });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
