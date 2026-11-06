/**
 * 长期记忆 · 自动压缩（画像级总结）
 *
 * 问题：单句记忆会一直累积。超过几百条之后，最老的那批既不会被列表重点展示，
 *       也很难在相关性精选里被选中 —— 信息还在，但永远轮不到它进 system prompt。
 *
 * 做法：每天一次（调度器），活跃事实超过阈值时，把**最旧的一批**交给模型合成
 *       一条 `category='profile'` 的长期印象；原记忆 `superseded_at = NOW()`。
 *
 * ⚠️ 先写总结、再标无效：AI 失败 / 返回 NONE / 总结被去重掉，都**什么都不改**，
 *    绝不做"先删后生成"——丢一条记忆比多一条重复更糟。
 * ⚠️ 不压 relation / preference：家人、宠物、喜好这类核心事实结构清晰，
 *    合成一段散文反而变糊（读取端本来就常驻它们）。
 * ⚠️ 标记而非删除：压缩后原文仍在记忆库里（「已失效」分组），用户可以随时恢复。
 */
import { requestChat } from "./ai.js";
import { execute, query } from "./db.js";
import { saveMemory } from "./memory-store.js";
import { recordCompaction } from "./memory-metrics.js";

const COMPACT_THRESHOLD = 150; // 活跃事实超过这个数才值得压缩
const COMPACT_BATCH = 40; // 一次最多压多少条（控制单次 token 成本）
const MIN_COMPACT_BATCH = 10; // 少于这个数就别费一次 AI 调用
const MAX_USERS = 20; // 每天最多处理多少用户（防御：用户量大时只处理最超标的）
const PROFILE_CHARS = 200; // user_memories.content 是 VARCHAR(200)

const COMPACT_PROMPT = `把下面这些关于同一个用户的零散记忆，合并成一段不超过 180 字的长期印象。
只保留以后还用得上的稳定信息（正在发生的事、反复出现的情绪主题、持续的状态），不要编造。
如果这些记忆之间没有值得保留的共同信息，直接输出 NONE。`;

/**
 * 从"旧 → 新"排好序的候选行里挑出可压缩的（纯函数，便于测试）。
 * 只压事件 / 情绪 / 模型自主 / 无分类；跳过 daily、profile、relation、preference。
 */
export function selectRowsToCompact(rows, batch = COMPACT_BATCH) {
  const picked = [];
  for (const row of rows) {
    const category = row?.category || null;
    if (!category) {
      picked.push(row); // 手动记的、没分类的也算普通事实
    } else if (category === "event" || category === "emotion" || category === "self") {
      picked.push(row);
    }
    if (picked.length >= batch) break;
  }
  return picked;
}

/** 压缩单个用户；不足阈值 / AI 失败都返回 skipped，不改任何数据 */
export async function compactUserMemories(userId, options = {}) {
  const force = options.force === true; // 手动触发（后台接口）：跳过 150 条阈值
  const batch = Math.max(1, Math.min(Number(options.batch) || COMPACT_BATCH, 200));
  const threshold = force ? 0 : COMPACT_THRESHOLD;
  const minBatch = force ? 1 : MIN_COMPACT_BATCH;

  let counts = [];
  try {
    counts = await query(
      `SELECT COUNT(*) AS n FROM user_memories
        WHERE user_id = ? AND superseded_at IS NULL
          AND (category IS NULL OR category NOT IN ('daily', 'profile'))`,
      [userId]
    );
  } catch {
    return { skipped: true, reason: "db-error" };
  }
  const total = Number(counts?.[0]?.n) || 0;
  if (total <= threshold) return { skipped: true, reason: "below-threshold", total };

  let rows = [];
  try {
    rows = await query(
      `SELECT id, content, category FROM user_memories
        WHERE user_id = ? AND superseded_at IS NULL
          AND (category IS NULL OR category IN ('event', 'emotion', 'self'))
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
      [userId, batch]
    );
  } catch {
    return { skipped: true, reason: "db-error" };
  }

  const picked = selectRowsToCompact(rows, batch);
  if (picked.length < minBatch) {
    return { skipped: true, reason: "not-enough", picked: picked.length };
  }

  const transcript = picked.map((row) => `- ${row.content}`).join("\n");
  let result;
  try {
    result = await requestChat({
      messages: [
        { role: "system", content: COMPACT_PROMPT },
        { role: "user", content: `记忆：\n${transcript}` },
      ],
      maxTokens: 400,
    });
  } catch {
    return { skipped: true, reason: "ai-failed" };
  }
  if (!result?.ok) return { skipped: true, reason: "ai-failed" };

  const cleaned = String(result.reply || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PROFILE_CHARS);
  if (!cleaned || /^NONE\b/i.test(cleaned)) return { skipped: true, reason: "empty" };

  // ⚠️ 第一步：先写总结。写不进去就直接返回，**绝不进入标记阶段**。
  //    `skipConflict`：总结会复述历史事件（"此前换了工作…"），拿它去跑
  //    "状态变更失效"规则等于用旧事失效新记忆。
  let saved;
  try {
    saved = await saveMemory(userId, cleaned, "profile", { skipConflict: true });
  } catch {
    return { skipped: true, reason: "db-failed" };
  }
  // ⚠️ saveMemory 命中近似旧画像时只会"强化"、内容没变 —— 这时标记原文失效就是丢信息
  if (saved.status !== "created") {
    return { skipped: true, reason: "deduplicated", id: saved.id };
  }

  // ⚠️ 第二步：确认总结**真的在库里且有效**，再动旧记忆。
  //    哪怕驱动返回了 insertId，也以"查到这一行"为准；
  //    中途数据库断开时这里查不到 → 直接返回，旧记忆保持原样（不会出现"旧的失效了、新画像没生成"）。
  try {
    const verify = await query(
      `SELECT id FROM user_memories
        WHERE user_id = ? AND id = ? AND category = 'profile' AND superseded_at IS NULL
        LIMIT 1`,
      [userId, saved.id]
    );
    if (!verify.length) return { skipped: true, reason: "profile-missing", id: saved.id };
  } catch {
    return { skipped: true, reason: "db-unverified", id: saved.id };
  }

  // ⚠️ 第三步：单条 UPDATE 原子标记（40 条一起，要么全生效要么全不生效）。
  //    这里失败只会多一条重复的画像，不会丢内容 —— 下次压缩还会再来。
  const ids = picked.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(", ");
  let compacted = 0;
  try {
    const rel = await execute(
      `UPDATE user_memories
          SET superseded_at = NOW()
        WHERE user_id = ? AND id IN (${placeholders}) AND superseded_at IS NULL`,
      [userId, ...ids]
    );
    compacted = Number(rel?.affectedRows || 0);
  } catch {
    /* 标记失败：总结已经写进去了，下次再标也行（重复压不会丢内容） */
  }

  // 观测指标：记录一次压缩（异步，失败静默）
  if (compacted > 0) {
    try {
      recordCompaction(userId, compacted);
    } catch {
      /* 统计失败不影响压缩本身 */
    }
  }

  return { created: saved.id, compacted };
}

/**
 * 调度器入口：找出最超标的用户逐个压缩。
 * 单个用户失败不影响后面的用户。
 */
export async function compactAllUsersMemories() {
  let rows = [];
  try {
    rows = await query(
      `SELECT user_id, COUNT(*) AS n FROM user_memories
        WHERE superseded_at IS NULL
          AND (category IS NULL OR category NOT IN ('daily', 'profile'))
        GROUP BY user_id
        HAVING n > ?
        ORDER BY n DESC
        LIMIT ?`,
      [COMPACT_THRESHOLD, MAX_USERS]
    );
  } catch {
    return { ok: false, users: 0, compacted: 0 };
  }

  let users = 0;
  let compacted = 0;
  for (const row of rows) {
    try {
      const result = await compactUserMemories(Number(row.user_id));
      if (result?.compacted) {
        users += 1;
        compacted += result.compacted;
      }
    } catch (err) {
      console.warn(`[memory] 用户 ${row.user_id} 压缩失败：`, err?.message || err);
    }
  }
  return { ok: true, users, compacted };
}
