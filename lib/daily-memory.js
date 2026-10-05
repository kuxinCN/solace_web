/**
 * 长期记忆 · 每日批量汇总（T+1 离线提炼）。
 *
 * 干什么：
 *   每天由调度器在零点后跑一次：把用户**昨天**的对话捞出来，
 *   AI 提炼成一条"画像级"记忆（稳定特征 / 近况 / 偏好）写入 user_memories。
 *   和关键词实时触发（extract route）互补 —— 后者抓单句，这里看一整天的全貌。
 *
 * ⚠️ 设计红线：
 *   * **不阻塞调度器** —— 每个用户独立 try/catch，任何失败只打日志；
 *   * **有界扫描** —— 单用户最多 120 条消息、文本 6000 字，总用户数封顶，
 *     防止一次把远端 MySQL 或内存打爆；
 *   * **两道去重** —— 调度器日期槽（进程内）+ 本文件的 DB 查询（重启后也认），
 *     同一用户同一天只写一条，重跑/重启都不会重复。
 *
 * ⚠️ 为什么**不走** content_review 审核队列（照抄日记那条链路）：
 *   那是"人工审核"的流水线，记忆提炼不需要人审，直接写库即可，
 *   走队列反而会把"该不该入记忆"拖成"等审核结果"。
 */
import { requestChat } from "./ai.js";
import { execute, query } from "./db.js";
import { hasSameDailyMemory } from "./memory-store.js";
import { getGroup } from "./settings.js";
import { isStyleTagsEnabled, stripTtsTags, tagWordsFrom } from "./tts-tags.js";

const MAX_USERS = 50; // 一次最多处理多少个用户（防御：用户量大时只处理前 50 个）
const MIN_MSGS = 4; // 昨天聊得太少的用户跳过 —— 硬凑一条反而显得敷衍
const MAX_MSGS = 120; // 每个用户最多用最近多少条消息
const MAX_CHARS = 6000; // 拼给 AI 的对话文本上限（超出从后截，保留最近的部分）
const MEM_CHARS = 200; // 记忆条目的内容上限（user_memories.content 是 VARCHAR(200)）

const SUMMARY_SYSTEM_PROMPT =
  "从下面的对话中提炼这个用户最多200字的稳定特征、近况或偏好。只保留事实，不要情绪渲染，不要评价，不要用第一人称，直接输出提炼结果。";

/** 清理模型输出：去引号 / 换行，截到 200 字 */
function cleanMemory(raw) {
  const text = String(raw || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/^[\s"'「『（(【\[]+/, "")
    .replace(/[\s"'」』）)】\]]+$/, "")
    .trim();
  if (!text) return "";
  return text.slice(0, MEM_CHARS);
}

/** 单用户的提炼 + 写库；返回 true=已写入，false=跳过 */
async function summarizeOneUser(userId, transcript) {
  const result = await requestChat({
    messages: [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: `对话：\n${transcript}` },
    ],
    maxTokens: 64,
  });
  if (!result.ok) return false;

  const content = cleanMemory(result.reply);
  if (!content) return false;

  // 跨天去重：连续几天的对话量差不多时，AI 会反复生成几乎一样的汇总
  //（"状态平稳，工作较忙"），这类重复同样不进记忆库。
  try {
    if (await hasSameDailyMemory(userId, content, 7)) return false;
  } catch {
    /* 查重失败不拦，宁可多一条也不丢记忆 */
  }

  await execute(
    "INSERT INTO user_memories (user_id, content, category) VALUES (?, ?, 'daily')",
    [userId, content]
  );
  return true;
}

/**
 * 生成"昨天"的记忆汇总。
 *
 * @returns {{ ok:boolean, created:number, tooShort:number, already:number, scanned:number, message:string }}
 */
export async function generateDailyMemories() {
  // ① 昨天的消息（照 createDailyDiaryTasks 的拉取写法，但只取内容字段）
  let rows = [];
  try {
    rows = await query(
      `SELECT user_id, role, content
         FROM messages
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 1 DAY)
          AND created_at < CURDATE()
          AND content IS NOT NULL
          AND content <> ''
        ORDER BY user_id ASC, id ASC
        LIMIT ?`,
      [MAX_USERS * MAX_MSGS * 2]
    );
  } catch (err) {
    return { ok: false, created: 0, message: `查询昨天消息失败：${err?.message || err}` };
  }

  if (!rows.length) {
    return { ok: true, created: 0, scanned: 0, tooShort: 0, already: 0, message: "昨天没有任何聊天记录" };
  }

  // ⚠️ 朗读标签必须在这里剥掉：这份汇总会喂给 AI 提炼记忆、也会展示在用户的「记忆」弹窗里，
  //    `[温柔]` 出现在记忆里既怪又白占字数（见 lib/tts-tags.js）。只动 assistant 的消息。
  //    读不到配置 / 没开 / 不是小米 MiMo 时不碰任何内容。
  let tagWords = null;
  try {
    const ttsConfig = await getGroup("tts");
    if (isStyleTagsEnabled(ttsConfig)) tagWords = tagWordsFrom(ttsConfig);
  } catch {
    tagWords = null;
  }

  // ② 按用户分组
  const byUser = new Map();
  for (const row of rows) {
    const uid = Number(row.user_id);
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(
      tagWords && row.role === "assistant" && typeof row.content === "string"
        ? { ...row, content: stripTtsTags(row.content, tagWords) }
        : row
    );
  }

  // 昨天（北京时间）—— 去重查询用；服务器时区不可信，照画像那边的算法算
  const nowBeijing = new Date(Date.now() + 8 * 3600 * 1000);
  nowBeijing.setUTCDate(nowBeijing.getUTCDate() - 1);
  const yesterday = nowBeijing.toISOString().slice(0, 10);

  let created = 0;
  let tooShort = 0;
  let already = 0;
  let scanned = 0;

  for (const [userId, list] of byUser) {
    if (scanned >= MAX_USERS) break;

    if (list.length < MIN_MSGS) {
      tooShort += 1;
      continue;
    }

    // ③ 去重：该用户昨天是否已写过 daily 记忆（重启后靠这道 DB 兜底）
    try {
      const exists = await query(
        `SELECT id FROM user_memories
          WHERE user_id = ? AND category = 'daily' AND DATE(created_at) = ?
          LIMIT 1`,
        [userId, yesterday]
      );
      if (exists.length) {
        already += 1;
        continue;
      }
    } catch {
      /* 查不了就继续；真重复了也只会多一条，不致命 */
    }

    // ④ 拼对话文本：只取最近的 MAX_MSGS 条，每条截 300 字
    const picked = list.slice(-MAX_MSGS);
    let transcript = picked
      .map((item) => `${item.role === "user" ? "我" : "AI"}：${String(item.content).slice(0, 300)}`)
      .join("\n");
    if (transcript.length > MAX_CHARS) {
      // 超长从后面截 —— 保留最近的部分，那儿的情绪和事实最完整
      transcript = `（前文略）\n${transcript.slice(-MAX_CHARS)}`;
    }

    // ⑤ 提炼 + 写库（失败静默，不打断后面的用户）
    try {
      if (await summarizeOneUser(userId, transcript)) created += 1;
    } catch (err) {
      console.warn(`[daily-memory] 用户 ${userId} 提炼失败：`, err?.message || err);
    }
    scanned += 1;
  }

  const parts = [`扫描 ${scanned} 位用户`];
  if (created) parts.push(`写入 ${created} 条`);
  if (tooShort) parts.push(`跳过 ${tooShort} 位（昨天聊得太少）`);
  if (already) parts.push(`跳过 ${already} 位（已有当日汇总）`);

  return { ok: true, created, tooShort, already, scanned, message: parts.join("，") };
}
