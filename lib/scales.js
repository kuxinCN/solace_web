/**
 * 心理测评题库。
 *
 * ⚠️ 这里管的是**"可上传、可启停"的那一类题库**（PSS-10 以及以后管理员上传的）。
 *    现有的人格探索（24 题）/ PHQ-9 / GAD-7 仍然在 `components/HealingCottage.jsx`
 *    里硬编码 —— **一行都没动**，因为任务要求"不改现有题库计分逻辑"。
 *
 * 题库格式（和 `docs/assessment-scale-example.json` 一致）：
 * ```
 * {
 *   id: "pss-10",                 // 唯一 id，也是存 assessment_results.type 的值
 *   name: "知觉压力量表（PSS-10）",
 *   description: "…",
 *   version: "1.0",
 *   source: "Cohen S, …",         // 出处（学术量表建议写上）
 *   enabled: true,
 *   questions: [
 *     { id: 1, text: "…", options: [{value,label},…], reverse: false, dimension: "感知无助" },
 *   ],
 *   scoring: {
 *     type: "sum",
 *     maxScore: 40,
 *     reverseRule: "4 - value",
 *     thresholds: [{ min, max, level }, …],
 *   },
 *   dimensions: ["感知无助", "感知自我效能"],
 *   meta: { author, createdAt, updatedAt, tags },
 * }
 * ```
 */
import { execute, query } from "./db.js";

/* ------------------------------------------------------------ 内置题库 */

/**
 * 内置题库：**首次启动时播种进数据库**，之后以库里的为准。
 *
 * ⚠️ 播种用的是 `INSERT IGNORE` 语义 ——
 *    管理员改过内置题库（比如调了阈值）之后，下次部署**不会被覆盖回去**。
 */
export const BUILTIN_SCALES = [
  {
    id: "pss-10",
    name: "知觉压力量表（PSS-10）",
    description:
      "评估过去一个月内的主观压力感知。该量表衡量个体感知到的生活不可预测、不可控制和超负荷的程度。",
    version: "1.0",
    enabled: true,
    builtin: true,
    source: "Cohen S, Kamarck T, Mermelstein R. A global measure of perceived stress. J Health Soc Behav. 1983;24(4):385-396.",
    questions: [
      {
        id: 1,
        text: "在过去一个月里，你多久因为发生意外的事情而感到心烦意乱？",
        options: [
          { value: 0, label: "从不" },
          { value: 1, label: "几乎不" },
          { value: 2, label: "有时" },
          { value: 3, label: "经常" },
          { value: 4, label: "总是" },
        ],
        reverse: false,
        dimension: "感知无助",
      },
      {
        id: 2,
        text: "在过去一个月里，你多久感到无法控制生活中重要的事情？",
        options: [
          { value: 0, label: "从不" },
          { value: 1, label: "几乎不" },
          { value: 2, label: "有时" },
          { value: 3, label: "经常" },
          { value: 4, label: "总是" },
        ],
        reverse: false,
        dimension: "感知无助",
      },
      {
        id: 3,
        text: "在过去一个月里，你多久感到紧张或压力大？",
        options: [
          { value: 0, label: "从不" },
          { value: 1, label: "几乎不" },
          { value: 2, label: "有时" },
          { value: 3, label: "经常" },
          { value: 4, label: "总是" },
        ],
        reverse: false,
        dimension: "感知无助",
      },
      {
        id: 4,
        text: "在过去一个月里，你多久感到有信心处理自己的个人问题？",
        options: [
          { value: 0, label: "从不" },
          { value: 1, label: "几乎不" },
          { value: 2, label: "有时" },
          { value: 3, label: "经常" },
          { value: 4, label: "总是" },
        ],
        reverse: true,
        dimension: "感知自我效能",
      },
      {
        id: 5,
        text: "在过去一个月里，你多久感到事情按照你的意愿发展？",
        options: [
          { value: 0, label: "从不" },
          { value: 1, label: "几乎不" },
          { value: 2, label: "有时" },
          { value: 3, label: "经常" },
          { value: 4, label: "总是" },
        ],
        reverse: true,
        dimension: "感知自我效能",
      },
      {
        id: 6,
        text: "在过去一个月里，你多久发现无法应付所有你必须做的事情？",
        options: [
          { value: 0, label: "从不" },
          { value: 1, label: "几乎不" },
          { value: 2, label: "有时" },
          { value: 3, label: "经常" },
          { value: 4, label: "总是" },
        ],
        reverse: false,
        dimension: "感知无助",
      },
      {
        id: 7,
        text: "在过去一个月里，你多久能够控制生活中的烦恼？",
        options: [
          { value: 0, label: "从不" },
          { value: 1, label: "几乎不" },
          { value: 2, label: "有时" },
          { value: 3, label: "经常" },
          { value: 4, label: "总是" },
        ],
        reverse: true,
        dimension: "感知自我效能",
      },
      {
        id: 8,
        text: "在过去一个月里，你多久感到自己掌控了局面？",
        options: [
          { value: 0, label: "从不" },
          { value: 1, label: "几乎不" },
          { value: 2, label: "有时" },
          { value: 3, label: "经常" },
          { value: 4, label: "总是" },
        ],
        reverse: true,
        dimension: "感知自我效能",
      },
      {
        id: 9,
        text: "在过去一个月里，你多久因为一些无法控制的事情而生气？",
        options: [
          { value: 0, label: "从不" },
          { value: 1, label: "几乎不" },
          { value: 2, label: "有时" },
          { value: 3, label: "经常" },
          { value: 4, label: "总是" },
        ],
        reverse: false,
        dimension: "感知无助",
      },
      {
        id: 10,
        text: "在过去一个月里，你多久感到困难堆积如山，无法克服？",
        options: [
          { value: 0, label: "从不" },
          { value: 1, label: "几乎不" },
          { value: 2, label: "有时" },
          { value: 3, label: "经常" },
          { value: 4, label: "总是" },
        ],
        reverse: false,
        dimension: "感知无助",
      },
    ],
    scoring: {
      type: "sum",
      maxScore: 40,
      reverseRule: "4 - value",
      reverseItems: [4, 5, 7, 8],
      thresholds: [
        { min: 0, max: 13, level: "低" },
        { min: 14, max: 19, level: "中" },
        { min: 20, max: 40, level: "高" },
      ],
      note: "总分越高表示感知压力越大。第 4、5、7、8 题为反向计分，需先反转后再求和。",
    },
    dimensions: ["感知无助", "感知自我效能"],
    meta: {
      author: "Cohen, Kamarck & Mermelstein",
      createdAt: "2026-09-24",
      updatedAt: "2026-09-24",
      tags: ["压力", "自评"],
    },
  },
];

/* ------------------------------------------------------------ 题库校验 */

const MAX_QUESTIONS = 200;
const MAX_OPTIONS = 12;

/**
 * 校验一份题库 JSON 是否合法。
 *
 * ⚠️ 这道关一定要严：题库是**管理员上传的 JSON**，它会被前端直接渲染。
 *    一个字段形状不对的题库，轻则渲染出错，重则让整个测评页白屏。
 *    宁可拒绝得啰嗦一点，也不要让半坏的题库进库。
 *
 * @returns {{ ok: true, scale: object } | { ok: false, error: string }}
 */
export function validateScale(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "不是合法的 JSON 对象" };
  }

  const id = String(raw.id || "").trim();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) {
    return { ok: false, error: "id 只能用小写字母、数字和短横线，长度 2-63，例如 pss-10" };
  }

  const name = String(raw.name || "").trim();
  if (!name || name.length > 120) return { ok: false, error: "name 必填，且不能超过 120 字" };

  const questions = raw.questions;
  if (!Array.isArray(questions) || !questions.length) {
    return { ok: false, error: "questions 必须是非空数组" };
  }
  if (questions.length > MAX_QUESTIONS) {
    return { ok: false, error: `题目太多了（${questions.length} 题，上限 ${MAX_QUESTIONS}）` };
  }

  const seenIds = new Set();

  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    const at = `第 ${i + 1} 题`;

    if (!q || typeof q !== "object") return { ok: false, error: `${at} 不是对象` };

    const qid = Number(q.id);
    if (!Number.isInteger(qid) || qid <= 0) return { ok: false, error: `${at} 的 id 必须是正整数` };
    if (seenIds.has(qid)) return { ok: false, error: `${at} 的 id 和前面的重复了（${qid}）` };
    seenIds.add(qid);

    if (!String(q.text || "").trim()) return { ok: false, error: `${at} 缺少 text` };

    if (!Array.isArray(q.options) || q.options.length < 2) {
      return { ok: false, error: `${at} 至少要有两个选项` };
    }
    if (q.options.length > MAX_OPTIONS) {
      return { ok: false, error: `${at} 选项太多了（${q.options.length} 个，上限 ${MAX_OPTIONS}）` };
    }

    for (const option of q.options) {
      if (!Number.isFinite(Number(option?.value))) {
        return { ok: false, error: `${at} 有个选项的 value 不是数字` };
      }
      if (!String(option?.label || "").trim()) {
        return { ok: false, error: `${at} 有个选项缺少 label` };
      }
    }
  }

  const scoring = raw.scoring;
  if (!scoring || typeof scoring !== "object") return { ok: false, error: "缺少 scoring" };
  if (String(scoring.type || "sum") !== "sum") {
    // ⚠️ 目前只支持求和计分。写明白，免得以后有人上传别的类型却不知道为什么没生效
    return { ok: false, error: `暂不支持 scoring.type = "${scoring.type}"（目前只支持 sum）` };
  }
  if (!Array.isArray(scoring.thresholds) || !scoring.thresholds.length) {
    return { ok: false, error: "scoring.thresholds 必须是非空数组" };
  }
  for (const item of scoring.thresholds) {
    if (!Number.isFinite(Number(item?.min)) || !Number.isFinite(Number(item?.max))) {
      return { ok: false, error: "thresholds 里每项都要有数字 min 和 max" };
    }
    if (!String(item?.level || "").trim()) {
      return { ok: false, error: "thresholds 里每项都要有 level" };
    }
  }

  // 归一化后返回（字段类型统一，后面不用到处 Number()）
  return {
    ok: true,
    scale: {
      id,
      name,
      description: String(raw.description || "").trim().slice(0, 2000),
      version: String(raw.version || "1.0").trim().slice(0, 16),
      source: String(raw.source || "").trim().slice(0, 500),
      enabled: raw.enabled !== false,
      builtin: false,
      questions,
      scoring: {
        type: "sum",
        maxScore: Number.isFinite(Number(scoring.maxScore))
          ? Number(scoring.maxScore)
          : questions.reduce(
              (sum, q) => sum + Math.max(...q.options.map((o) => Number(o.value) || 0)),
              0
            ),
        reverseRule: String(scoring.reverseRule || "").trim().slice(0, 40),
        thresholds: scoring.thresholds.map((item) => ({
          min: Number(item.min),
          max: Number(item.max),
          level: String(item.level).trim().slice(0, 20),
        })),
        note: String(scoring.note || "").trim().slice(0, 500),
      },
      dimensions: Array.isArray(raw.dimensions)
        ? raw.dimensions.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)
        : [],
      meta: raw.meta && typeof raw.meta === "object" ? raw.meta : {},
    },
  };
}

/* ------------------------------------------------------------ 计分 */

/**
 * 按题库的规则算分（**通用**，不针对某个量表写死）。
 *
 * ⚠️ 反向计分：`reverse: true` 的题用 `maxValue - value`，
 *    其中 `maxValue` 取**这道题自己的选项里最大的 value** ——
 *    不是全局最大值。因为不同量表的选项范围可能不一样（0-3 / 0-4），
 *    用全局值会算错。
 *
 * @param {object} scale validateScale 出来的题库
 * @param {object} answers `{ [questionId]: value }`
 * @returns {{ total: number, maxScore: number, level: string, dimensions: object, answered: number }}
 */
export function scoreScale(scale, answers = {}) {
  const questions = Array.isArray(scale?.questions) ? scale.questions : [];
  const thresholds = Array.isArray(scale?.scoring?.thresholds) ? scale.scoring.thresholds : [];

  let total = 0;
  let maxScore = 0;
  let answered = 0;
  const dimensions = {};

  for (const question of questions) {
    const qid = Number(question.id);
    const values = (question.options || []).map((option) => Number(option.value) || 0);
    const maxValue = values.length ? Math.max(...values) : 0;

    maxScore += maxValue;

    const raw = answers[qid];
    if (raw == null || raw === "") continue;

    const value = Number(raw);
    if (!Number.isFinite(value)) continue;

    answered += 1;

    const scored = question.reverse ? maxValue - value : value;
    total += scored;

    const dim = String(question.dimension || "").trim();
    if (dim) {
      if (!dimensions[dim]) dimensions[dim] = { score: 0, maxScore: 0 };
      dimensions[dim].score += scored;
      dimensions[dim].maxScore += maxValue;
    }
  }

  // 按阈值定级（阈值表可能不是按顺序给的，先排一遍）
  let level = "";
  const sorted = [...thresholds].sort((a, b) => a.min - b.min);
  for (const item of sorted) {
    if (total >= item.min && total <= item.max) {
      level = item.level;
      break;
    }
  }

  return { total, maxScore, level, dimensions, answered };
}

/* ------------------------------------------------------------ 读写 */

/** 把数据库行转成题库对象 */
function rowToScale(row) {
  const parse = (value, fallback) => {
    if (value == null) return fallback;
    if (typeof value === "object") return value;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  };

  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    version: row.version || "1.0",
    source: row.source || "",
    enabled: Number(row.enabled) !== 0,
    builtin: Number(row.builtin) === 1,
    questions: parse(row.questions, []),
    scoring: parse(row.scoring, {}),
    dimensions: parse(row.dimensions, []),
    meta: parse(row.meta, {}),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

/**
 * 列题库。
 * @param {{ onlyEnabled?: boolean }} options
 */
export async function listScales({ onlyEnabled = false } = {}) {
  try {
    const rows = await query(
      `SELECT * FROM assessment_scales
        ${onlyEnabled ? "WHERE enabled = 1" : ""}
        ORDER BY builtin DESC, id ASC`
    );
    return rows.map(rowToScale);
  } catch (err) {
    // ⚠️ 表还没建出来（老库首次升级）时返回内置题库，
    //    让前端至少还能测 —— 而不是白屏
    console.error("[scales] 读题库失败，回退到内置：", err?.code || err?.message || err);
    return BUILTIN_SCALES.filter((item) => !onlyEnabled || item.enabled).map((item) => ({
      ...item,
      createdAt: null,
      updatedAt: null,
    }));
  }
}

/** 取单个题库（找不到返回 null） */
export async function getScale(id) {
  const key = String(id || "").trim();
  if (!key) return null;

  try {
    const rows = await query("SELECT * FROM assessment_scales WHERE id = ? LIMIT 1", [key]);
    if (rows.length) return rowToScale(rows[0]);
  } catch {
    /* 表还没建，往下走内置 */
  }

  const fallback = BUILTIN_SCALES.find((item) => item.id === key);
  return fallback ? { ...fallback, createdAt: null, updatedAt: null } : null;
}

/** 新增或更新一份题库 */
export async function upsertScale(scale) {
  await execute(
    `INSERT INTO assessment_scales
       (id, name, description, version, source, enabled, builtin, questions, scoring, dimensions, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       description = VALUES(description),
       version = VALUES(version),
       source = VALUES(source),
       questions = VALUES(questions),
       scoring = VALUES(scoring),
       dimensions = VALUES(dimensions),
       meta = VALUES(meta)`,
    [
      scale.id,
      scale.name,
      scale.description || "",
      scale.version || "1.0",
      scale.source || "",
      scale.enabled === false ? 0 : 1,
      scale.builtin ? 1 : 0,
      JSON.stringify(scale.questions || []),
      JSON.stringify(scale.scoring || {}),
      JSON.stringify(scale.dimensions || []),
      JSON.stringify(scale.meta || {}),
    ]
  );

  return true;
}

/** 启用 / 停用 */
export async function setScaleEnabled(id, enabled) {
  const result = await execute("UPDATE assessment_scales SET enabled = ? WHERE id = ?", [
    enabled ? 1 : 0,
    String(id || "").trim(),
  ]);
  return Number(result?.affectedRows || 0) > 0;
}

/** 删除（内置题库不允许删） */
export async function deleteScale(id) {
  const key = String(id || "").trim();
  const existing = await getScale(key);
  if (!existing) return { ok: false, error: "题库不存在" };
  if (existing.builtin) return { ok: false, error: "内置题库不能删除，只能停用" };

  await execute("DELETE FROM assessment_scales WHERE id = ?", [key]);
  return { ok: true };
}

/**
 * 播种内置题库。
 *
 * ⚠️ 幂等：已存在的 id **不覆盖** ——
 *    管理员调过阈值之后，下次部署不该把它改回默认值。
 *    所以这里先查出已有的 id，只插缺的那些。
 */
export async function ensureBuiltinScales() {
  let existingIds = new Set();

  try {
    const rows = await query("SELECT id FROM assessment_scales");
    existingIds = new Set(rows.map((row) => String(row.id)));
  } catch {
    // 表还没建 —— 下面的插入也会失败，交给调用方的 safe() 兜底
    return { added: [] };
  }

  const added = [];

  for (const scale of BUILTIN_SCALES) {
    if (existingIds.has(scale.id)) continue;
    try {
      await upsertScale(scale);
      added.push(scale.id);
    } catch (err) {
      console.error(`[scales] 播种 ${scale.id} 失败：`, err?.code || err?.message || err);
    }
  }

  return { added };
}
