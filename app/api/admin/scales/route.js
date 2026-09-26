/**
 * 后台题库管理（`/api/admin/scales`）。
 *
 * - `GET`  → 列出**全部**题库（含计分规则 —— 后台要看得到规则，才好核对）
 * - `POST` → `action`:
 *     · `upload`   上传题库（支持一次传多个；会逐份校验，坏的拒掉、好的入库）
 *     · `toggle`   启用 / 停用
 *     · `delete`   删除（**内置题库不允许删**，只能停用）
 *     · `preview`  按给定答案试算一遍，验规则对不对
 *
 * ⚠️ 题库是**管理员上传的 JSON**，而且会被前端直接渲染 ——
 *    所以 `validateScale` 卡得很严（少一个字段、选项 value 不是数字，都直接拒绝）。
 *    宁可拒绝得啰嗦，也不要让半坏的题库进库之后把测评页搞白屏。
 */
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import { deleteScale, getScale, listScales, scoreScale, setScaleEnabled, upsertScale, validateScale } from "@/lib/scales";
import { clientIp, json, jsonError, readJsonBody } from "@/lib/util";

export async function GET(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const scales = await listScales({ onlyEnabled: false });

  return json({
    ok: true,
    scales,
    // 前端"按这个格式写"的提示直接给一份示例，省得管理员去翻文档
    formatHint:
      "JSON 必填字段：id（小写字母/数字/短横线）、name、questions[]（每项含 id、text、options[{value,label}]、reverse、dimension）、" +
      "scoring{type:\"sum\", maxScore, thresholds[{min,max,level}]}。可选：description、version、source、dimensions[]、meta。",
  });
}

export async function POST(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);
  const action = String(body.action || "");

  /* ---------------- 上传 ---------------- */

  if (action === "upload") {
    // 支持三种传法：已经解析好的对象 / 对象数组 / JSON 字符串
    let payload = body.scale ?? body.data ?? null;

    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch (err) {
        return jsonError(`JSON 解析失败：${err?.message || err}`, 400);
      }
    }

    // ⚠️ 允许带 `_comment` 之类的注释字段（示例文件里就有），
    //    但**顶层如果是数组**就是批量上传 —— 单个题库本身也是个对象，两者不冲突。
    const list = Array.isArray(payload) ? payload : [payload];

    if (!list.length || list.length > 50) {
      return jsonError("一次最多上传 50 份题库", 400);
    }

    const accepted = [];
    const rejected = [];

    for (const item of list) {
      const checked = validateScale(item);

      if (!checked.ok) {
        rejected.push({ id: item?.id || "(没有 id)", error: checked.error });
        continue;
      }

      // ⚠️ 已存在的题库默认**不允许覆盖**，除非显式传 overwrite ——
      //    传错文件把内置题库冲掉是很糟的事故，多问一次不亏。
      const existing = await getScale(checked.scale.id);
      if (existing && !body.overwrite) {
        rejected.push({
          id: checked.scale.id,
          error: `已存在同 id 的题库「${existing.name}」${existing.builtin ? "（内置）" : ""}，如需覆盖请勾选「允许覆盖」`,
        });
        continue;
      }

      try {
        await upsertScale(checked.scale);
        // 覆盖内置题库时，builtin 标记要保留 —— 否则它就能被删掉了
        if (existing?.builtin) {
          await upsertScale({ ...checked.scale, builtin: true });
        }
        accepted.push({ id: checked.scale.id, name: checked.scale.name, overwritten: Boolean(existing) });
      } catch (err) {
        rejected.push({ id: checked.scale.id, error: err?.message || String(err) });
      }
    }

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "scales_upload",
      detail: `上传题库：成功 ${accepted.length} 份，拒绝 ${rejected.length} 份${
        accepted.length ? `｜${accepted.map((item) => item.id).join(",")}` : ""
      }`,
      ip: clientIp(request),
    });

    return json({
      ok: accepted.length > 0,
      accepted,
      rejected,
      message: accepted.length
        ? `已入库 ${accepted.length} 份${rejected.length ? `，${rejected.length} 份被拒绝（见下）` : ""}`
        : `全部被拒绝（${rejected.length} 份）`,
    });
  }

  /* ---------------- 启用 / 停用 ---------------- */

  if (action === "toggle") {
    const id = String(body.id || "").trim();
    if (!id) return jsonError("缺少题库 id", 400);

    const target = await getScale(id);
    if (!target) return jsonError("题库不存在", 404);

    const enabled = body.enabled !== false;
    const changed = await setScaleEnabled(id, enabled);

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "scales_toggle",
      detail: `${enabled ? "启用" : "停用"}题库 ${id}（${target.name}）`,
      ip: clientIp(request),
    });

    return json({
      ok: changed,
      id,
      enabled,
      message: enabled ? `已启用「${target.name}」` : `已停用「${target.name}」，用户端不再显示`,
    });
  }

  /* ---------------- 删除 ---------------- */

  if (action === "delete") {
    const id = String(body.id || "").trim();
    if (!id) return jsonError("缺少题库 id", 400);

    const result = await deleteScale(id);
    if (!result.ok) return jsonError(result.error || "删除失败", 400);

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "scales_delete",
      detail: `删除题库 ${id}`,
      ip: clientIp(request),
    });

    return json({ ok: true, message: "已删除（已有的测评结果不受影响）" });
  }

  /* ---------------- 试算 ---------------- */

  if (action === "preview") {
    const id = String(body.id || "").trim();
    const scale = await getScale(id);
    if (!scale) return jsonError("题库不存在", 404);

    // 不传答案时：每题都取第一个选项，算一个"最低分"样例
    const answers = body.answers && typeof body.answers === "object" ? body.answers : null;

    const filled = {};
    if (answers) {
      Object.assign(filled, answers);
    } else {
      for (const question of scale.questions || []) {
        filled[Number(question.id)] = Number(question.options?.[0]?.value ?? 0);
      }
    }

    return json({
      ok: true,
      // ⚠️ 试算**不做"必答"校验** —— 它的用途是"看规则对不对"，
      //    允许只填几题看中间结果
      result: scoreScale(scale, filled),
      answered: Object.keys(filled).length,
      total: (scale.questions || []).length,
    });
  }

  return jsonError(`未知操作：${action || "(空)"}`, 400);
}
