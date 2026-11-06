/**
 * 长期记忆 · 权重衰减与遗忘（每天跑一次，由 lib/scheduler.js 的日期槽触发）。
 *
 * 要解决的是"记忆只增不减"：聊得越久，库里堆的短期情绪、过期事件越多，
 * 全是同等权重，注入时挤占预算、稀释注意力，而真正的长期信息反而被埋掉。
 *
 * 三条规则（与产品约定一致）：
 *   ① 强度按「距上次被想起的天数 × 类别速率」重算 ——
 *      核心（画像 / 偏好 / 关系 / 愿望）极慢，边缘（情绪 / 日报）最快；
 *   ② 非核心记忆 **100 天没被提及 → strength 直接归零**；
 *   ③ strength < 10 时正文只留第一个字（"文字消亡"），归零后进回收站（保留 3 天）。
 *
 * ⚠️ 强度是**按绝对时间重算**，不是在原值上逐日递减：
 *    `strength = 100 - 天数 × 速率` 天然幂等 —— 进程重启、任务重跑、跨天补跑都不会多扣几次。
 *    唯一会重置它的是"唤醒"（lib/memory-store.js 的 markMemoriesAccessed，注入即恢复 100）。
 *
 * ⚠️ 回收站复用 lib/trash.js：遗忘的记忆在「我的 → 回收站 → 记忆」里还能看到并恢复，
 *    到期后由清理任务物理删除。绝不直接 DELETE 掉用户的东西。
 */
import { execute, query } from "./db.js";
import { pushToTrash } from "./trash.js";
import { toMysqlDateTime } from "./util.js";

/* ============================== 规则参数 ============================== */

// 核心类别（产品白名单）：画像 / 偏好 / 关系 / 愿望 ——
// 衰减极慢、**不受 100 天硬清零约束**、**永远不会被物理删除或文字截断**。
// ⚠️ 强度下限 CORE_FLOOR：再久没被提起也只是"暗下去"，仍保持完整内容。
//    （昵称在账号资料里、不在记忆表，天然不参与衰减；"核心创伤"会被压缩进 profile 总结，同样受这条保护）
export const CORE_CATEGORIES = ["profile", "preference", "relation", "wish"];
export const CORE_FLOOR = 30; // 核心记忆的强度下限：30 分是"暗色但完整"，不会更低

// 每天掉多少强度。100 / 速率 ≈ 单靠衰减走到 0 需要的天数
export const DECAY_RATE = {
  profile: 0.1, // 画像总结：1000 天
  preference: 0.1, // 偏好：1000 天
  relation: 0.1, // 关系（家人 / 宠物）：1000 天
  wish: 0.1, // 愿望：1000 天
  self: 0.3, // 模型自主标记的事实：约 333 天
  event: 0.5, // 具体事件：约 200 天
  emotion: 0.8, // 瞬时情绪：约 125 天
  daily: 1, // 每日汇总：100 天
  other: 0.5, // 未分类 / 老数据
};

export const HARD_FORGET_DAYS = 100; // 非核心记忆：超过这么多天没被提及 → strength = 0
export const TEXT_DECAY_BELOW = 10; // strength 低于这个数：正文只保留第一个字
const FORGET_BATCH = 200; // 一次最多回收多少条（分批删，避免单条 SQL 太长）
const DECAY_BATCH = 5000; // 一次最多重算多少条（按 last_accessed_at 从旧到新）

const CORE_IN_SQL = `(${CORE_CATEGORIES.map((name) => `'${name}'`).join(",")})`;
const CATEGORY_IN_SQL = (name) => `'${String(name).replace(/'/g, "''")}'`;

/**
 * 类别 → 每日速率的 SQL 表达式。由上面那张 DECAY_RATE 表生成，
 * 避免"JS 里一份、SQL 里又一份"两边改漏。
 */
const RATE_CASE = `CASE
    ${Object.entries(DECAY_RATE)
      .filter(([name]) => name !== "other")
      .map(([name, rate]) => `WHEN category = ${CATEGORY_IN_SQL(name)} THEN ${Number(rate)}`)
      .join("\n    ")}
    ELSE ${Number(DECAY_RATE.other)}
  END`;

/* ============================== 执行 ============================== */

/**
 * 跑一轮衰减 + 消亡 + 回收。每天一次即可，也可以手动调用（幂等）。
 *
 * @param {{ decayLimit?: number, forgetLimit?: number }} [options]
 * @returns {Promise<{updated:number, truncated:number, forgotten:number, skipped:boolean}>}
 */
export async function decayAllMemories(options = {}) {
  const decayLimit = Math.max(1, Number(options.decayLimit) || DECAY_BATCH);
  const forgetLimit = Math.max(1, Number(options.forgetLimit) || FORGET_BATCH);

  const result = { updated: 0, truncated: 0, forgotten: 0, repaired: 0, skipped: false };

  try {
    // ---- ⓪ 核心白名单兜底：先把任何跌破下限的核心记忆拉回 CORE_FLOOR ----
    //
    // ⚠️ 这是"核心永不消失"的最后一道保险：
    //    老数据、手动改库、规则切换前留下的 0 分核心记忆，都会在这里被救回来，
    //    绝不会流到下面的"回收站 → 删除"那一步。
    const repaired = await execute(
      `UPDATE user_memories
          SET strength = ${CORE_FLOOR}
        WHERE category IN ${CORE_IN_SQL}
          AND strength < ${CORE_FLOOR}`
    );
    result.repaired = Number(repaired?.affectedRows || 0);

    // ---- ① 重算强度 ----
    //
    // 「最近一天内被创建 / 被唤醒」的行直接跳过：
    //   * 它们本来就在 100，算了也是 100；
    //   * 更重要的是别让每天的定时任务去改写刚写入的行走一遭无谓的 I/O。
    //
    // ⚠️ 硬清零只作用于**非核心**类别：用户名字、生日、宠物这类信息，
    //    不能因为三个月没聊到就从记忆里消失（见文件头的产品约定）。
    // ⚠️ 分三种情况：
    //    ① 核心四类（画像 / 偏好 / 关系 / 愿望）→ 再久也不低于 CORE_FLOOR，绝不进回收站、不截字；
    //    ② 边缘记忆（事件 / 情绪 / 日报，以及 self / 未分类）超过 100 天没被提及 → 直接归零；
    //    ③ 其它 → 按类别速率正常衰减。
    const decay = await execute(
      `UPDATE user_memories
          SET strength = CASE
              WHEN category IN ${CORE_IN_SQL}
                THEN GREATEST(
                       ${CORE_FLOOR},
                       LEAST(
                         100,
                         ROUND(100 - DATEDIFF(NOW(), COALESCE(last_accessed_at, created_at)) * (${RATE_CASE}))
                       )
                     )
              WHEN DATEDIFF(NOW(), COALESCE(last_accessed_at, created_at)) > ${HARD_FORGET_DAYS}
                THEN 0
              ELSE GREATEST(
                     0,
                     LEAST(
                       100,
                       ROUND(100 - DATEDIFF(NOW(), COALESCE(last_accessed_at, created_at)) * (${RATE_CASE}))
                     )
                   )
            END
        WHERE strength > 0
          AND COALESCE(last_accessed_at, created_at) < NOW() - INTERVAL 1 DAY
        ORDER BY COALESCE(last_accessed_at, created_at) ASC
        LIMIT ${decayLimit}`
    );
    result.updated = Number(decay?.affectedRows || 0);
  } catch (err) {
    // 表还没建 / 列还没补上：安静跳过，别影响调度器里的其它任务
    console.warn("[memory-decay] 强度重算失败：", err?.message || err);
    result.skipped = true;
    return result;
  }

  // ---- ② 文字消亡：strength < 10 只留第一个字 ----
  //
  // ⚠️ 这一步**不可逆**（内容已经被截掉）。之所以敢这么做，是因为它只作用于
  //    "眼看就要消失"的记忆；而唤醒（注入）在 strength ≥ 10 时就已把它救回来了。
  try {
    const truncated = await execute(
      `UPDATE user_memories
          SET content = LEFT(content, 1)
        WHERE strength > 0
          AND strength < ${TEXT_DECAY_BELOW}
          AND CHAR_LENGTH(content) > 1
        LIMIT ${decayLimit}`
    );
    result.truncated = Number(truncated?.affectedRows || 0);
  } catch (err) {
    console.warn("[memory-decay] 文字消亡失败：", err?.message || err);
  }

  // ---- ③ strength = 0 → 回收站，再从库里删掉 ----
  //
  // ⚠️ 先入回收站再删：这一路是自动发生的，用户没有任何操作，
  //    万一规则判断错了（比如某类记忆衰减过快），还得能捞回来。
  let dying = [];
  try {
    dying = await query(
      `SELECT id, user_id, content, category, strength, created_at
         FROM user_memories
        WHERE strength <= 0
          AND category NOT IN ${CORE_IN_SQL}
        ORDER BY id ASC
        LIMIT ?`,
      [forgetLimit]
    );
  } catch (err) {
    console.warn("[memory-decay] 查询待遗忘记忆失败：", err?.message || err);
    return result;
  }

  for (const row of dying) {
    try {
      await pushToTrash({
        userId: Number(row.user_id),
        itemType: "memory",
        title: String(row.content || "").slice(0, 40) || "一条记忆",
        payload: {
          id: row.id,
          content: row.content,
          category: row.category,
          strength: row.strength,
          // ⚠️ 必须转成 MySQL 的 'YYYY-MM-DD HH:mm:ss'：
          //    mysql2 取出来的是 Date，JSON 化会变成带时区的 ISO 串，
          //    恢复时原样插回 DATETIME 列会被严格模式拒绝（"内容丢了、恢复不了"）。
          createdAt: row.created_at ? toMysqlDateTime(new Date(row.created_at)) : null,
        },
      });
    } catch {
      /* 单条入回收站失败不阻断删除（与手动删除的约定一致） */
    }
  }

  if (dying.length) {
    const ids = dying.map((row) => Number(row.id)).filter(Boolean);
    const placeholders = ids.map(() => "?").join(", ");
    try {
      const removed = await execute(
        `DELETE FROM user_memories WHERE id IN (${placeholders})`,
        ids
      );
      result.forgotten = Number(removed?.affectedRows || 0);
    } catch (err) {
      console.warn("[memory-decay] 删除已遗忘记忆失败：", err?.message || err);
    }
  }

  return result;
}
