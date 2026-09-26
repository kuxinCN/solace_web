/**
 * 测评历史：提交（POST）与读取（GET）。
 *
 * 两种测评：
 *   type=personality → 性格倾向探索，data = { I, N, T, P }（各维度百分比 0-100）
 *   type=emotion     → 情绪状态自评，data = { phq9, gad7 }（两个分数）
 *
 * 结果用 JSON 列存储，灵活适配两种结构。
 */
import { describeDbError, execute, query } from "@/lib/db";
import { getCurrentUser } from "@/lib/user-auth";
import { cleanString, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// type 白名单
const VALID_TYPES = new Set(["personality", "emotion"]);
const MAX_RECORDS = 100; // 最多返回 100 条，避免拉太多

/** 提交一条测评结果 */
export async function POST(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const body = await readJsonBody(request);
  const type = cleanString(body.type, 16);
  if (!VALID_TYPES.has(type)) {
    return jsonError("未知的测评类型", 400);
  }

  let data = body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return jsonError("测评数据格式不正确", 400);
  }

  // 按类型校验 data 结构
  if (type === "personality") {
    // type(4字母) + I/N/T/J 四个维度的 A 选项占比，0-100 整数
    const { type: pType, I, N, T, J } = data;
    if (typeof pType !== "string" || !/^[A-Z]{4}$/.test(pType)) {
      return jsonError("性格类型格式不正确（应为 4 个大写字母）", 400);
    }
    data = { type: pType };
    for (const [k, v] of [["I", I], ["N", N], ["T", T], ["J", J]]) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return jsonError(`维度 ${k} 的值应为 0-100`, 400);
      }
      data[k] = Math.round(n);
    }
  } else {
    // emotion: phq9 / gad7 两个分数，0-27 整数
    const { phq9, gad7, phq9SelfHarm } = data;
    data = {};
    for (const [k, v] of [["phq9", phq9], ["gad7", gad7]]) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 27) {
        return jsonError(`${k} 分数应为 0-27`, 400);
      }
      data[k] = Math.round(n);
    }

    // ⚠️ PHQ-9 第 9 题（自伤念头）**单独存一份**。
    //    心理画像里它是"一票判高风险"的依据（见 lib/portrait.js）——
    //    被总分平均掉是不行的。前端不传也没关系，那就当没有这个信息。
    const selfHarm = Number(phq9SelfHarm);
    if (Number.isFinite(selfHarm) && selfHarm >= 0 && selfHarm <= 3) {
      data.phq9SelfHarm = Math.round(selfHarm);
    }
  }

  try {
    const result = await execute(
      "INSERT INTO assessment_results (user_id, type, data) VALUES (?, ?, ?)",
      [user.id, type, JSON.stringify(data)]
    );

    // ⚠️ 做完测评就重算一次画像（**纯本地规则引擎，不调用任何 AI**）。
    //    不 await 它的结果做判断：画像算不出来**不该影响"测评已保存"**这件事。
    //    用动态 import，避免这个接口的依赖链被拖长。
    try {
      const { refreshPortrait } = await import("@/lib/portrait-store");
      await refreshPortrait(user.id, { force: true });
    } catch {
      /* 画像失败静默 —— 下次做测评或压力值变化时还会再试 */
    }

    return json({ ok: true, id: result.insertId });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

/** 读取测评历史 */
export async function GET(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const url = new URL(request.url);
  const type = cleanString(url.searchParams.get("type"), 16);
  if (!VALID_TYPES.has(type)) {
    return jsonError("未知的测评类型", 400);
  }

  try {
    // MySQL 5.7+ 的 JSON 列会自动把 SELECT 出来的值转成字符串，
    // 这里用 JSON_EXTRACT 取回结构化数据更稳妥
    const rows = await query(
      `SELECT
         id,
         type,
         JSON_UNQUOTE(JSON_EXTRACT(data, '$')) AS data,
         created_at
       FROM assessment_results
       WHERE user_id = ? AND type = ?
       ORDER BY created_at DESC
       LIMIT ${MAX_RECORDS}`,
      [user.id, type]
    );

    // 解析 data 字段（JSON 字符串 → 对象）
    const records = rows.map((r) => {
      let parsed = null;
      try {
        parsed = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
      } catch {
        parsed = null;
      }
      return {
        id: r.id,
        type: r.type,
        data: parsed,
        created_at: r.created_at,
      };
    });

    return json({ ok: true, records });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

/** 批量删除测评记录（只允许删自己的） */
export async function DELETE(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const body = await readJsonBody(request);
  const raw = Array.isArray(body.ids) ? body.ids : [];
  const ids = raw
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 200); // 一次最多删 200 条，避免异常大的 IN 列表
  if (!ids.length) return jsonError("请选择要删除的记录", 400);

  try {
    // WHERE 里带上 user_id：别的用户即使猜到 id 也删不掉（防越权）
    const placeholders = ids.map(() => "?").join(", ");
    const result = await execute(
      `DELETE FROM assessment_results WHERE user_id = ? AND id IN (${placeholders})`,
      [user.id, ...ids]
    );
    return json({ ok: true, deleted: result.affectedRows || 0 });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
