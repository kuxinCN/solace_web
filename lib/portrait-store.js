/**
 * 心理画像的**读写与触发** —— 把纯算法（`lib/portrait.js`）和数据库接起来。
 *
 * ⚠️ 为什么和算法分开两个文件：
 *    `lib/portrait.js` 是**纯函数**，不碰数据库、不碰网络 —— 那样才好验证、好单测、
 *    好在后台"按给定分数试算一遍"看规则对不对。
 *    真正读库、落库、判断要不要重算的逻辑都在这里。
 *
 * 数据来源（都是**只读**，尤其自研压力值 —— 不修改、不重训、不替换它的算法）：
 *   · `assessment_results` 的 `personality`（MBTI）/ `emotion`（GAD+PHQ）/ 题库 id（PSS-10 等）
 *   · `user_stress_state.combined_score`（自研压力值）
 */
import { execute, query } from "./db.js";
import { PORTRAIT_VERSION, buildPortrait } from "./portrait.js";

/** 自研压力值变化超过这么多，就值得重算一次画像 */
const STRESS_DELTA_THRESHOLD = 15;

/** 距上次更新超过这么多天才考虑"例行重算" */
const STALE_DAYS = 7;

/** 从 JSON 列里取值（MySQL 5.7+ 的 JSON 列出来是字符串，得自己 parse） */
function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** 取某个 type 的最新一条测评结果 */
async function latestAssessment(userId, type) {
  try {
    const rows = await query(
      `SELECT data, created_at FROM assessment_results
        WHERE user_id = ? AND type = ?
        ORDER BY id DESC LIMIT 1`,
      [Number(userId), String(type)]
    );
    if (!rows.length) return null;
    return { data: parseJson(rows[0].data) || {}, at: rows[0].created_at || null };
  } catch {
    return null;
  }
}

/** 取自研压力值（只读） */
async function currentStress(userId) {
  try {
    const rows = await query(
      "SELECT combined_score FROM user_stress_state WHERE user_id = ? LIMIT 1",
      [Number(userId)]
    );
    if (!rows.length) return null;
    const value = Number(rows[0].combined_score);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 把一个用户的画像算出来（**不落库**）—— 后台"试算"和重算都用它。
 */
export async function computePortrait(userId) {
  const [personality, emotion, pss, stress, birthday] = await Promise.all([
    latestAssessment(userId, "personality"),
    latestAssessment(userId, "emotion"),
    latestAssessment(userId, "pss-10"),
    currentStress(userId),
    userBirthday(userId),
  ]);

  return buildPortrait({
    // MBTI：`personality` 存的是 { type: "INTJ", I, N, T, J }
    mbti: personality?.data?.type || null,
    // GAD-7 / PHQ-9：`emotion` 存的是 { phq9, gad7 }（新版本还会带 phq9SelfHarm）
    gad: emotion?.data?.gad7 ?? null,
    phq: emotion?.data?.phq9 ?? null,
    phq9SelfHarm: emotion?.data?.phq9SelfHarm ?? null,
    // PSS-10：新题库走通用结构，结果里存 score
    pss: pss?.data?.score ?? null,
    chatStress: stress,
    // 年龄段：从用户资料里的生日推算（⚠️ 画像里**只存年龄段，不单独存年龄值**；
    // 原生日本来就存在 users.birthday，不在这里重复一份）
    age: calcAge(birthday),
  });
}

/**
 * 把生日换算成年龄（周岁）。
 *
 * ⚠️ `birthday` 是 `DATE` 列，mysql2 通常返回 **JS Date 对象**，
 *    但也可能是字符串（取决于连接配置），两种都认。
 *
 * @returns {number|null} 算不出来返回 null（用户没填 / 格式不对）
 */
export function calcAge(birthday) {
  if (!birthday) return null;

  const birth = birthday instanceof Date ? birthday : new Date(String(birthday).slice(0, 10));
  if (Number.isNaN(birth.getTime())) return null;

  const now = new Date();

  let age = now.getFullYear() - birth.getFullYear();
  const monthDiff = now.getMonth() - birth.getMonth();

  // 今年生日还没过 → 减一岁
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) age -= 1;

  if (!Number.isFinite(age) || age < 0 || age > 150) return null;
  return age;
}

/** 取用户的生日（只读，算年龄段用） */
async function userBirthday(userId) {
  try {
    const rows = await query("SELECT birthday FROM users WHERE id = ? LIMIT 1", [Number(userId)]);
    return rows[0]?.birthday ?? null;
  } catch {
    return null;
  }
}

/** 读已存的画像（不重算） */
export async function getPortrait(userId) {
  try {
    const rows = await query(
      "SELECT portrait, portrait_version, portrait_updated_at FROM users WHERE id = ? LIMIT 1",
      [Number(userId)]
    );
    if (!rows.length) return null;

    const stored = parseJson(rows[0].portrait);
    return {
      portrait: stored || null,
      version: rows[0].portrait_version || "",
      updatedAt: rows[0].portrait_updated_at || null,
    };
  } catch {
    return null;
  }
}

/**
 * 重算并落库。
 *
 * ⚠️ **失败不抛错**：画像算不出来不该影响用户做测评、更不该影响聊天。
 *    出错就记一行日志、返回 `{ ok: false }`，调用方照常往下走。
 *
 * @param {number} userId
 * @param {{ force?: boolean }} options force=true 时跳过"要不要重算"的判断
 */
export async function refreshPortrait(userId, { force = true } = {}) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "缺少 userId" };

  try {
    // ① 判断要不要重算（force 时直接跳过）
    if (!force) {
      const existing = await getPortrait(id);
      if (existing?.portrait && existing.version === PORTRAIT_VERSION) {
        return { ok: true, skipped: true, reason: "版本没变，跳过" };
      }
    }

    // ② 算
    const fresh = await computePortrait(id);

    // ③ 落库
    await execute(
      `UPDATE users
          SET portrait = ?, portrait_version = ?, portrait_updated_at = ?
        WHERE id = ?`,
      [JSON.stringify(fresh), PORTRAIT_VERSION, new Date(), id]
    );

    return { ok: true, portrait: fresh };
  } catch (err) {
    console.error("[portrait] 重算失败：", err?.code || err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * 压力值变化时按需重算。
 *
 * ⚠️ 只有在**变化够大**（默认 ±15）时才重算 ——
 *    压力值是连续采样的，每条消息都可能变一点，
 *    每次都重算画像等于每聊一句就写一次库，完全没有必要。
 *
 * @param {{ userId: number, before?: number|null, after?: number|null }} params
 */
export async function maybeRefreshByStress({ userId, before, after }) {
  const a = Number(before);
  const b = Number(after);

  // 拿不到前后值就不动（比如用户第一次产生压力记录）
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { ok: true, skipped: true, reason: "没有可比的前后值" };

  if (Math.abs(b - a) < STRESS_DELTA_THRESHOLD) {
    return { ok: true, skipped: true, reason: `压力值只变了 ${Math.abs(b - a).toFixed(0)}，没到 ${STRESS_DELTA_THRESHOLD}` };
  }

  return refreshPortrait(userId, { force: true });
}

/**
 * 例行重算（给定时任务用）：
 * **距上次更新超过 7 天、而且用户有新测评数据**时才重算。
 *
 * ⚠️ "且用户有新测评数据"这半句不能省 ——
 *    否则每 7 天给一个从不测评的用户重算一次，算出来的东西一模一样，纯属白跑。
 */
export async function refreshStalePortraits({ limit = 50 } = {}) {
  const size = Math.max(1, Math.min(Number(limit) || 50, 500));

  try {
    const rows = await query(
      `SELECT u.id,
              u.portrait_updated_at,
              (SELECT MAX(a.created_at) FROM assessment_results a WHERE a.user_id = u.id) AS last_assessment
         FROM users u
        WHERE u.portrait_updated_at IS NULL
           OR u.portrait_updated_at < DATE_SUB(NOW(), INTERVAL ${STALE_DAYS} DAY)
        ORDER BY u.id ASC
        LIMIT ${size}`
    );

    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
      const updatedAt = row.portrait_updated_at ? new Date(row.portrait_updated_at).getTime() : 0;
      const assessedAt = row.last_assessment ? new Date(row.last_assessment).getTime() : 0;

      // 没有测评数据，或者上次测评比上次画像还早 → 重算也是白算
      if (!assessedAt || assessedAt <= updatedAt) {
        skipped += 1;
        continue;
      }

      const result = await refreshPortrait(row.id, { force: true });
      if (result.ok) updated += 1;
    }

    return { ok: true, scanned: rows.length, updated, skipped };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), scanned: 0, updated: 0, skipped: 0 };
  }
}
