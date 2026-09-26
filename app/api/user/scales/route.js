/**
 * 用户端的测评题库接口。
 *
 * - `GET`  → 列出所有**启用**的题库（**不含计分规则**）
 * - `POST` → 提交答案，**服务端算分** → 存结果 → 顺手重算心理画像
 *
 * ⚠️ 为什么算分放服务端：
 *    ① 计分规则（尤其反向计分）只该有一处实现 —— 前端算一遍、后端再算一遍，
 *       迟早会不一致；
 *    ② `scoring` 不下发给前端本身就是个防篡改的边界，虽然心理测评不是考试，
 *       但"分数由客户端说了算"这种事没有理由开这个头。
 *
 * ⚠️ 也**不返回 `reverse` 字段**：前端只需要渲染题目和选项，
 *    哪题反向计分是服务端的事（返回了反而容易被误用）。
 *
 * ⚠️ 现有的人格探索 / PHQ-9 / GAD-7 **不走这个接口**（它们仍然是前端算分、
 *    走 `/api/user/assessments` 提交），这里只管"可上传的那类题库"。
 */
import { getScale, listScales, scoreScale } from "@/lib/scales";
import { refreshPortrait } from "@/lib/portrait-store";
import { execute } from "@/lib/db";
import { getCurrentUser } from "@/lib/user-auth";
import { cleanString, json, jsonError, readJsonBody } from "@/lib/util";

/** 把题库整理成前端要的样子：去掉计分规则和反向标记 */
function forClient(scale) {
  return {
    id: scale.id,
    name: scale.name,
    description: scale.description || "",
    version: scale.version || "1.0",
    source: scale.source || "",
    dimensions: Array.isArray(scale.dimensions) ? scale.dimensions : [],
    questions: (scale.questions || []).map((question) => ({
      id: question.id,
      text: question.text,
      dimension: question.dimension || "",
      options: (question.options || []).map((option) => ({
        value: Number(option.value),
        label: option.label,
      })),
    })),
  };
}

export async function GET(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const scales = await listScales({ onlyEnabled: true });

  return json({
    ok: true,
    scales: scales.map(forClient),
  });
}

export async function POST(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const body = await readJsonBody(request);
  const scaleId = cleanString(body.scaleId, 64);
  if (!scaleId) return jsonError("缺少题库 id", 400);

  const scale = await getScale(scaleId);
  if (!scale) return jsonError("题库不存在", 404);
  if (!scale.enabled) return jsonError("这个题库已停用", 400);

  const raw = body.answers && typeof body.answers === "object" ? body.answers : null;
  if (!raw || Array.isArray(raw)) return jsonError("答案格式不对", 400);

  const questions = Array.isArray(scale.questions) ? scale.questions : [];
  if (!questions.length) return jsonError("这个题库没有题目", 400);

  /* ---- 逐题校验：必答 + 取值必须在选项范围内 ---- */

  const answers = {};
  const missing = [];

  for (const question of questions) {
    const qid = Number(question.id);
    const value = raw[qid];

    if (value == null || value === "") {
      missing.push(qid);
      continue;
    }

    const num = Number(value);
    if (!Number.isFinite(num)) return jsonError(`第 ${qid} 题的答案不是数字`, 400);

    // ⚠️ 一定要卡范围：不然客户端传个 999，服务端就照着 999 算总分了
    const allowed = (question.options || []).map((option) => Number(option.value));
    if (!allowed.includes(num)) {
      return jsonError(`第 ${qid} 题的答案不在选项范围内`, 400);
    }

    answers[qid] = num;
  }

  // ⚠️ 标准量表要求**答完**才有意义（缺失题按 0 算会系统性低估分数）
  if (missing.length) {
    return jsonError(`还有 ${missing.length} 道题没答（第 ${missing.slice(0, 5).join("、")} 题…）`, 400);
  }

  /* ---- 算分 ---- */

  const result = scoreScale(scale, answers);

  /* ---- 存结果（沿用现有表结构，type 就是题库 id） ---- */

  const data = {
    scaleId: scale.id,
    scaleName: scale.name,
    scaleVersion: scale.version || "1.0",
    score: result.total,
    maxScore: result.maxScore,
    level: result.level,
    dimensions: result.dimensions,
    answers,
  };

  let insertedId = 0;
  try {
    const inserted = await execute(
      "INSERT INTO assessment_results (user_id, type, data) VALUES (?, ?, ?)",
      [user.id, scale.id, JSON.stringify(data)]
    );
    insertedId = inserted?.insertId || 0;
  } catch (err) {
    return jsonError(`保存失败：${err?.message || err}`, 500);
  }

  /* ---- 重算画像 ----
   * ⚠️ 不 await 它的结果做判断：画像算不出来**不该影响用户看测评结果**。
   *    refreshPortrait 内部自己 try/catch，这里只是不关心它的返回值。 */
  await refreshPortrait(user.id, { force: true }).catch(() => {});

  return json({
    ok: true,
    id: insertedId,
    result: {
      score: result.total,
      maxScore: result.maxScore,
      level: result.level,
      dimensions: result.dimensions,
      note: scale.scoring?.note || "",
    },
  });
}
