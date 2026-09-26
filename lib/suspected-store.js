/**
 * 「疑似命中」的处理 —— 给 AI 一次翻案的机会，并把结果攒下来。
 *
 * ## 要解决什么
 *
 * 词表是**本地规则**，快、可解释、离线，但它不懂语义。所以会有这种误报：
 *
 * ```
 * 我想死磕这对 cp        ←「想」+「死」相邻，命中；但这里是"死磕"
 * 我这周要死线了          ←「要」+「死」相邻，命中；但这里是"死线"
 * ```
 *
 * `DEATH_COMPOUND` 那张表已经挡住最常见的一批，但**挡不完** —— 中文里
 * 「死 X」的构词太多了，靠枚举永远追不上。
 *
 * ## 怎么解决
 *
 * 命中里分两档（见 `lexicon-store.js` 的 `matchCrisis`）：
 *
 * | 置信度 | 来源 | 例 | 处理 |
 * |---|---|---|---|
 * | `high` | **完整短语**命中 | 遗书 / 割腕 / 不想活 | **直接安全模式，不给 AI 翻案的机会** |
 * | `suspect` | 前缀+后缀组合出来的 | 想+死 / 要+死 | **让对话 AI 判一下语义** |
 *
 * ## ⚠️ 安全边界（这段设计里最要紧的部分）
 *
 * **只有 AI 明确写了 `[RISK:no]` 才算"不是风险"。**
 *
 * 模型没写、写错、写了一半、被截断了 —— **一律按"有风险"处理**，热线照给。
 * 理由很直接：误报的代价是用户觉得"这 AI 有点神经质"，
 * 而漏判的代价是**一个说"我想死"的人没拿到热线**。两个代价不对等，所以永远往保守那边倒。
 *
 * ⚠️ 另外：**`high` 置信度的命中根本不给 AI 翻案的机会** —— 说"我写了遗书"的人，
 * 不需要模型来判断这是不是日常表达。
 */
import { execute, query } from "./db.js";

/**
 * 给对话 AI 的判定指令。
 *
 * ⚠️ 三个刻意的写法：
 *   1. **先说"更可能只是日常表达"** —— 不然模型会倾向于"保险起见判有风险"，
 *      那这个机制就白设计了（永远不翻案）。
 *   2. **要求标记单独成行、且明确说"用户看不到"** —— 免得模型把它当正文写进去。
 *   3. **给了具体例子**（死磕 / 死线）—— 模型对"疑似词"这种抽象说法理解不稳，
 *      给例子它才知道该判什么。
 */
export const SUSPECT_INSTRUCTION = [
  "⚠️ 额外任务（用户看不到这段）：这条消息里有一个词**可能**是风险信号，",
  "但**更可能只是日常表达** —— 比如「死磕」「死线」里的那个「死」。",
  "",
  "请你判断它到底是哪种，然后：",
  "",
  "· **只是日常用法**（调侃、比喻、网络用语、构词，没有真实的自伤意图）：",
  "  正常陪他聊，并在回复的**最后单独一行**写：[RISK:no]",
  "",
  "· **确实涉及真实风险**：",
  "  按上面的安全指令回应，并在回复的**最后单独一行**写：[RISK:yes]",
  "",
  "这一行只是给系统的信号，不会展示给用户。**不要把它写进正文，也不要向用户解释它。**",
].join("\n");

/**
 * 从回复里摘掉 `[RISK:*]` 标记。
 *
 * @returns {{ text: string, noRisk: boolean }}
 *   `noRisk === true` **只有**在明确看到 `[RISK:no]` 时才会是 true。
 */
export function takeRiskTag(text) {
  const clean = String(text || "");

  if (/\[RISK:no\]/i.test(clean)) {
    return { text: clean.replace(/\s*\[RISK:no\]\s*/gi, "\n").trimEnd(), noRisk: true, found: true };
  }

  if (/\[RISK:yes\]/i.test(clean)) {
    return { text: clean.replace(/\s*\[RISK:yes\]\s*/gi, "\n").trimEnd(), noRisk: false, found: true };
  }

  // ⚠️ 没标记 → **按有风险处理**（`noRisk: false`）。见文件头那段"安全边界"。
  return { text: clean, noRisk: false, found: false };
}

/**
 * 记一笔疑似命中（**fire-and-forget**，别 await）。
 *
 * ⚠️ **只存"命中的那个片段"和一小段上下文**，不存用户原话 ——
 *    够判断"这个词要不要加进例外表"就行，没必要把隐私留下来。
 *
 * @param {string} word      命中的片段，比如「想死」
 * @param {string} category  类别
 * @param {string} verdict   ai_no / ai_yes / no_tag / unknown
 * @param {string} sample    可选的短上下文（会被截断到 40 字）
 */
export async function recordSuspected(word, category = "self_harm", verdict = "unknown", sample = "") {
  const key = String(word || "").trim().slice(0, 64);
  if (!key) return false;

  const snippet = String(sample || "").trim().slice(0, 40);
  const list = snippet ? JSON.stringify([snippet]) : null;

  try {
    // ⚠️ `ON DUPLICATE KEY UPDATE` 一次搞定"计数 + 更新样本" ——
    //    不先查后写（那条路在并发下会丢计数）。
    // ⚠️ `samples` **只留最近一条**：够看出"这个词是在什么句子里被命中的"就行。
    //    想留更多就得在 SQL 里做 JSON 数组裁剪，MySQL 5.7 的写法又长又容易错，
    //    而多留几条的实际价值很低。
    await execute(
      `INSERT INTO suspected_words (word, category, verdict, hits, samples)
       VALUES (?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE
         hits = hits + 1,
         verdict = VALUES(verdict),
         samples = CASE WHEN ? IS NULL THEN samples ELSE CAST(? AS JSON) END`,
      [key, category, verdict, list, list, list]
    );
    return true;
  } catch (err) {
    // 记录失败不能影响任何别的事
    console.warn("[suspected] 记录失败：", err?.code || err?.message || err);
    return false;
  }
}

/** 读疑似词列表（后台用）—— 按命中次数降序，最该处理的排最前 */
export async function listSuspected({ limit = 100 } = {}) {
  const size = Math.max(1, Math.min(Number(limit) || 100, 500));

  try {
    const rows = await query(
      `SELECT word, category, verdict, hits, samples, note, updated_at
         FROM suspected_words
        ORDER BY hits DESC, updated_at DESC
        LIMIT ${size}`
    );

    return rows.map((row) => {
      let samples = [];
      try {
        samples = typeof row.samples === "string" ? JSON.parse(row.samples) : row.samples || [];
      } catch {
        samples = [];
      }

      return {
        word: row.word,
        category: row.category,
        verdict: row.verdict,
        hits: Number(row.hits) || 0,
        samples: Array.isArray(samples) ? samples : [],
        note: row.note || "",
        updatedAt: row.updated_at || null,
      };
    });
  } catch {
    // 表还没建出来时返回空，别让后台页面报错
    return [];
  }
}

/** 标一下"已处理"（比如已经加进例外表了） */
export async function markSuspected(word, note = "") {
  const key = String(word || "").trim().slice(0, 64);
  if (!key) return false;

  try {
    await execute("UPDATE suspected_words SET note = ? WHERE word = ?", [
      String(note || "").slice(0, 255),
      key,
    ]);
    return true;
  } catch {
    return false;
  }
}
