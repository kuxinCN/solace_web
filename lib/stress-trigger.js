/**
 * 触发判断与弹窗逻辑 —— 整个系统的"开关"都在这里。
 *
 * 四个闸门，按严格程度从松到紧：
 *   ① 该不该调 LLM（省 Token 的关键：默认 9 成的消息都不该调）
 *   ② 该不该弹窗（阈值 + 连续确认 + 冷却 + 拒绝史 + 是否正在放松）
 *   ③ 弹窗里给哪几种放松方式（后台可勾选）
 *   ④ 危机词 → **一票通行，跳过以上全部**
 *
 * ⚠️ **"不打扰"是这个功能能不能被接受的核心**：
 *    压力高的用户最不需要的就是被一个弹窗反复追着问。
 *    所以宁可少弹，也不要弹错 —— 每一次拒绝都会把阈值往上抬。
 */
import { getGroup } from "./settings.js";
import { matchCrisis } from "./stress-lexicon.js";
import { analyzeMessage, analyzeDiary, resolveLevel, BASE_SCORE } from "./stress-analyzer.js";
import {
  bumpMessageCount,
  clampScore,
  combine,
  DIARY_THRESHOLD_OFFSET,
  getStressState,
  peekMessageCount,
  recentFinalScores,
  recentScores,
  resetMessageCount,
  resolveThreshold,
  saveStressLog,
  smooth,
  updateStressState,
} from "./stress-state.js";
import { scoreByLLM } from "./stress-llm.js";

/* ------------------------------------------------------------ 默认参数 */

/** 本地规则触发 LLM 的参数（后台可覆盖） */
const TRIGGER_DEFAULTS = {
  periodicInterval: 10, // 每多少条消息做一次深度识别
  keywordCooldownMs: 2 * 60 * 1000, // 关键词触发的冷却
  chatPopupCooldownMs: 15 * 60 * 1000,
  diaryPopupCooldownMs: 30 * 60 * 1000,
  rejectCooldownMs: 5 * 60 * 1000,
  dailyLlmLimit: 60, // 每人每天最多调多少次 LLM（防跑飞）
};

/**
 * 把后台那套**平铺的标量配置**组装成内部用的触发参数。
 *
 * ⚠️ 配置系统只支持标量（存不了对象/数组），所以后台是
 *    `stressPeriodicInterval`、`stressKeywordCooldownMinutes`… 这样一个个字段。
 *    在这里统一换算成毫秒，下面就不用到处写 `Number(...) || 默认值` 了。
 */
export function stressTriggerConfig(config = {}) {
  return {
    periodicInterval: Math.max(
      1,
      Number(config?.stressPeriodicInterval) || TRIGGER_DEFAULTS.periodicInterval
    ),
    keywordCooldownMs:
      Math.max(1, Number(config?.stressKeywordCooldownMinutes) || 2) * 60 * 1000,
    chatPopupCooldownMs:
      Math.max(1, Number(config?.stressChatCooldownMinutes) || 15) * 60 * 1000,
    diaryPopupCooldownMs:
      Math.max(1, Number(config?.stressDiaryCooldownMinutes) || 30) * 60 * 1000,
    rejectCooldownMs: TRIGGER_DEFAULTS.rejectCooldownMs,
    dailyLlmLimit: Math.max(
      1,
      Number(config?.stressDailyLlmLimit) || TRIGGER_DEFAULTS.dailyLlmLimit
    ),
  };
}

/* -------------------------------------------------------- ① 是否调 LLM */

/**
 * @param {object} state 用户状态
 * @param {{hasKeyword:boolean, crisis:boolean}} local 本地分析结果
 * @param {{periodicInterval:number, keywordCooldownMs:number}} config
 */
export function shouldCallLLM(state, local, config = {}) {
  const now = Date.now();
  const interval = Number(config.periodicInterval) || TRIGGER_DEFAULTS.periodicInterval;
  const cooldownMs = Number(config.keywordCooldownMs) || TRIGGER_DEFAULTS.keywordCooldownMs;

  // 危机：无条件
  if (local.crisis) return { call: true, reason: "crisis" };

  // 周期
  if (Number(state.msg_count_since_analyze || 0) >= interval) {
    return { call: true, reason: "periodic" };
  }

  // 关键词（要过冷却）
  if (local.hasKeyword) {
    const until = state.keyword_cooldown_until ? new Date(state.keyword_cooldown_until).getTime() : 0;
    if (!until || now > until) return { call: true, reason: "keyword" };
  }

  return { call: false, reason: null };
}

/* -------------------------------------------------------- ② 是否弹窗 */

/**
 * 弹窗条件（**全部满足**才弹；危机跳过全部）。
 *
 * @param {number} userId
 * @param {number} finalScore
 * @param {"chat"|"diary"} source
 * @returns {Promise<{allow:boolean, reason:string, state:object}>}
 */
/**
 * 弹窗条件（**全部满足**才弹；危机跳过全部）。
 *
 * ⚠️ 这里修过三处，每一处都对应一个"明明压力很高却不弹"的真实故障：
 *
 *  ① **阈值来源** —— 用户表里存 `0` 表示"跟随后台配置"。
 *     原来建表默认写 70 并落库，导致后台怎么改都不生效。
 *
 *  ② **"连续两次"的判定** —— 只要求**上一条**达标（当前这次已经确认达标了）。
 *     原来查的是"最近 2 条都要达标"，但调用顺序是**先判断、后写库**，
 *     那一刻库里还没有当前这一条 —— 于是实际要连续 **3** 次才弹得出来。
 *
 *  ③ **"正在放松中"加了时间窗** —— 原来只要存在一条"接受但没点做完了"的记录
 *     就**永久**不再弹。用户点一次「现在做」然后直接关掉页面，这个功能就废了。
 */
export async function checkPopupTrigger(userId, finalScore, source = "chat") {
  const state = await getStressState(userId);
  const config = await getGroup("safety").catch(() => ({}));
  const trigger = stressTriggerConfig(config);

  if (Number(state.popup_enabled) === 0) {
    return { allow: false, reason: "用户关掉了提醒", threshold: 0, state };
  }

  // ① 用户自己调过的 > 后台配置 > 兜底
  const baseThreshold = resolveThreshold(state.threshold, config?.stressThreshold);
  const threshold =
    source === "diary" ? Math.max(40, baseThreshold - DIARY_THRESHOLD_OFFSET) : baseThreshold;

  if (finalScore < threshold) {
    return { allow: false, reason: `分数没到（${finalScore} < ${threshold}）`, threshold, state };
  }

  // ② 连续两次 = 当前这次 + 上一条
  const previous = await recentFinalScores(userId, 1);
  if (!previous.length || previous[0] < threshold) {
    return {
      allow: false,
      reason: `还差一次（上次 ${previous[0] ?? "无记录"}，这次 ${finalScore}，阈值 ${threshold}）`,
      threshold,
      state,
    };
  }

  const now = Date.now();

  // 弹窗冷却
  const cooldownMs =
    source === "diary"
      ? Number(trigger.diaryPopupCooldownMs) || TRIGGER_DEFAULTS.diaryPopupCooldownMs
      : Number(trigger.chatPopupCooldownMs) || TRIGGER_DEFAULTS.chatPopupCooldownMs;

  if (state.last_popup_at) {
    const last = new Date(state.last_popup_at).getTime();
    if (Number.isFinite(last) && now - last < cooldownMs) {
      const minutes = Math.ceil((cooldownMs - (now - last)) / 60000);
      return { allow: false, reason: `还在冷却（还剩约 ${minutes} 分钟）`, threshold, state };
    }
  }

  // 刚拒绝过
  if (Number(state.popup_reject_count || 0) > 0 && state.last_popup_at) {
    const last = new Date(state.last_popup_at).getTime();
    if (Number.isFinite(last) && now - last < TRIGGER_DEFAULTS.rejectCooldownMs) {
      return { allow: false, reason: "刚刚拒绝过，先不打扰", threshold, state };
    }
  }

  // ③ 正在放松中（⚠️ 带时间窗，不能永久阻塞）
  try {
    const active = await recentSessions(userId, 1);
    const session = active[0];
    if (
      session &&
      Number(session.accepted) === 1 &&
      Number(session.completed) === 0 &&
      isWithinRelaxingWindow(session.created_at)
    ) {
      return { allow: false, reason: "上次的放松还没结束", threshold, state };
    }
  } catch {
    /* 查不了就继续 */
  }

  return { allow: true, reason: "", threshold, state };
}

/** 取最近一条放松记录（用于"是否正在放松中"） */
async function recentSessions(userId, limit = 1) {
  try {
    const { query } = await import("./db.js");
    return await query(
      `SELECT id, accepted, completed, created_at FROM relaxation_sessions
        WHERE user_id = ? ORDER BY id DESC LIMIT ${Math.max(1, Math.min(limit, 10))}`,
      [Number(userId)]
    );
  } catch {
    return [];
  }
}

/**
 * 一次放松最长算多久。
 *
 * ⚠️ 超过这个时间就认为用户已经忘了 / 放弃了 —— 否则一条"接受但没点做完了"
 *    的记录会**永久**堵住后续所有提醒（这是真发生过的 bug）。
 */
const RELAXING_WINDOW_MS = 2 * 60 * 60 * 1000;

function isWithinRelaxingWindow(createdAt) {
  const at = createdAt ? new Date(createdAt).getTime() : 0;
  if (!Number.isFinite(at) || at <= 0) return false;
  return Date.now() - at < RELAXING_WINDOW_MS;
}

/* ----------------------------------------------- ③ 弹窗内容（给前端） */

/**
 * 组装弹窗数据。
 *
 * ⚠️ **必须把"压力值 + 对应情绪"讲清楚**（用户明确要求）——
 *    只弹一句"要不要放松"会让人莫名其妙，甚至有点被冒犯。
 *
 * ⚠️ 措辞原则：说"我读到的状态"，不说"你就是怎样"。
 *    这是**系统的读数**，不是对用户的判断。
 *
 * @param {{score:number, source:"chat"|"diary", levels:Array, config:object, crisis?:boolean}} params
 */
export function buildPopupPayload({ score, source = "chat", levels = [], config = {}, crisis = false }) {
  const level = resolveLevel(score, levels);
  const value = clampScore(score);

  // 后台勾选开放哪些方式（默认两种都开）
  const methods = [];
  if (config?.relaxOfferBreathing !== false) {
    methods.push({ id: "breathing", label: "呼吸放松", desc: "跟着圆圈呼吸，3 分钟" });
  }
  if (config?.relaxOfferButterfly !== false) {
    methods.push({ id: "butterfly", label: "蝴蝶拍", desc: "双手交替轻拍，安抚自己" });
  }

  const opening = crisis
    ? "我读到了一些很沉的信号，想先陪着你。"
    : source === "diary"
      ? "刚刚读完你写的这些，"
      : "我注意到你最近好像有点累，";

  return {
    crisis,
    score: value,
    levelLabel: level?.label || "",
    levelHint: level?.hint || "",
    source,
    methods,
    message: crisis
      ? "如果你现在有伤害自己的念头，请立刻告诉身边信任的人，或拨打全国心理援助热线 400-161-9995，也可以直接拨 110 / 120。你不需要一个人扛着，这也不是你的错。"
      : `${opening}现在的状态读到 ${value} 分 · ${level?.label || "压力偏高"}。要不要一起做一次 3 分钟的放松，先把它放一放？`,
  };
}

/* --------------------------------------------------- ④ 主流程：聊天 */

/**
 * 处理一条用户消息（在聊天接口里调用）。
 *
 * ⚠️ **设计成"先给结论、后算深度分"**：
 *    本地规则几毫秒就算完了，先把「本地分 + 要不要弹窗」返回给聊天接口，
 *    用户的消息**立刻**能发出去；LLM 那一步异步跑，算完了写库、影响后续判断。
 *    如果同步等 LLM，每条触发消息的用户都要多等几秒 —— 那是不可接受的。
 *
 * @returns {Promise<{score:number, localScore:number, level:object|null, crisis:boolean, shouldPopup:boolean, popup:object|null}>}
 */
export async function onUserMessage(userId, message) {
  const config = await getGroup("safety").catch(() => ({}));

  // ⚠️ 开关关着就整个跳过。调用方（聊天接口）一般已经查过一次，这里再兜一层 ——
  //    双保险，避免哪个入口漏了检查就悄悄开始"监测"用户。
  if (!config?.stressEnabled) {
    return {
      skipped: true,
      score: BASE_SCORE,
      localScore: BASE_SCORE,
      level: null,
      crisis: false,
      shouldPopup: false,
      popup: null,
    };
  }

  const levels = normalizeLevels(config);

  // 平铺的标量配置 → 组装成内部参数，顺便挂回 config —
  // 下面几处（冷却时间、周期）直接读 config.stressTrigger 就好，不用再换算一遍
  config.stressTrigger = stressTriggerConfig(config);

  const local = analyzeMessage(message);

  // 危机：立即返回，弹窗跳过所有限制
  if (local.crisis) {
    const popup = buildPopupPayload({ score: 95, source: "chat", levels, config, crisis: true });

    await saveStressLog({
      userId,
      source: "chat",
      score: 95,
      smoothed: 95,
      localScore: 95,
      crisis: true,
      triggered: true,
    });
    await updateStressState(userId, {
      chat_score: 95,
      combined_score: 95,
      last_popup_at: new Date(),
    });
    resetMessageCount(userId);

    return {
      score: 95,
      localScore: 95,
      level: resolveLevel(95, levels),
      crisis: true,
      shouldPopup: true,
      popup,
    };
  }

  const state = await getStressState(userId);
  const smoothed = clampScore(smooth(state.chat_score, local.score));
  const decision = shouldCallLLM(state, local, config?.stressTrigger || {});

  const shouldPopup = await checkPopupTrigger(userId, smoothed, "chat");
  const popup = shouldPopup.allow
    ? buildPopupPayload({ score: smoothed, source: "chat", levels, config })
    : null;

  // 先写状态与日志（用户响应不等这个的深度分）
  await updateStressState(userId, {
    chat_score: smoothed,
    combined_score: combine(smoothed, state.diary_score, 0),
    msg_count_since_analyze: decision.call ? 0 : peekCount(userId),
    last_analyze_at: decision.call ? new Date() : state.last_analyze_at,
    keyword_cooldown_until:
      decision.reason === "keyword"
        ? new Date(Date.now() + (Number(config?.stressTrigger?.keywordCooldownMs) || TRIGGER_DEFAULTS.keywordCooldownMs))
        : state.keyword_cooldown_until,
    last_popup_at: shouldPopup.allow ? new Date() : state.last_popup_at,
  });

  await saveStressLog({
    userId,
    source: "chat",
    score: smoothed,
    smoothed,
    localScore: local.score,
    llmScore: null,
    crisis: false,
    triggered: shouldPopup.allow,
  });

  // ⚠️ 压力值变化够大时顺手重算**心理画像**（纯本地算法，不调用任何 AI）。
  //
  //    * **不 await** —— 这条在聊天热路径上，不能让用户多发一条消息就多等一轮；
  //    * `maybeRefreshByStress` 会先比变化量，**没超过 15 分就立刻返回**，
  //      所以平时几乎零成本（只有真的变化够大时才查库重算）；
  //    * 动态 import，不给这条热路径增加模块加载负担。
  void (async () => {
    try {
      const { maybeRefreshByStress } = await import("./portrait-store.js");
      await maybeRefreshByStress({
        userId,
        before: state.combined_score,
        after: combine(smoothed, state.diary_score, 0),
      });
    } catch {
      /* 画像算不出来不影响聊天 */
    }
  })();

  if (decision.call) {
    resetMessageCount(userId);
    // ⚠️ 故意不 await：让深度识别在后台跑，不拖慢用户发消息
    runDeepAnalysis({ userId, source: "chat", local }).catch(() => {});
  } else {
    bumpMessageCount(userId);
  }

  return {
    score: smoothed,
    localScore: local.score,
    level: resolveLevel(smoothed, levels),
    crisis: false,
    shouldPopup: shouldPopup.allow,
    popup,
  };
}

/** 读内存里的消息计数（**不落库** —— 聊天路径上不能每条都写数据库） */
function peekCount(userId) {
  return peekMessageCount(userId);
}

/* --------------------------------------------------- 主流程：日记 */

/**
 * 日记保存后调用。
 *
 * ⚠️ 和聊天不同：日记是一次性的长文本，**信息密度高**，
 *    所以本地分 ≥65 或抽到情绪句就值得调一次 LLM（这时不该省）。
 *
 * @returns {Promise<{score:number, level:object|null, crisis:boolean, shouldPopup:boolean, popup:object|null, delaySeconds:number}>}
 */
export async function onDiarySave(userId, diaryText, { diaryDate = null } = {}) {
  const config = await getGroup("safety").catch(() => ({}));

  // ⚠️ 和聊天一样，开关关着就整个跳过
  if (!config?.stressEnabled) {
    return {
      skipped: true,
      score: BASE_SCORE,
      level: null,
      crisis: false,
      shouldPopup: false,
      popup: null,
      delaySeconds: 0,
    };
  }

  const levels = normalizeLevels(config);

  const local = analyzeDiary(diaryText);

  if (local.crisis) {
    const popup = buildPopupPayload({ score: 95, source: "diary", levels, config, crisis: true });
    await saveStressLog({
      userId,
      source: "diary",
      score: 95,
      smoothed: 95,
      localScore: 95,
      crisis: true,
      triggered: true,
    });
    await updateStressState(userId, { diary_score: 95, combined_score: 95, last_popup_at: new Date() });

    return { score: 95, level: resolveLevel(95, levels), crisis: true, shouldPopup: true, popup, delaySeconds: 0 };
  }

  const state = await getStressState(userId);

  // 日记的"年龄"：老日记不该满权重压着（这就是规格里那个一直失效的衰减）
  const ageDays = diaryDate ? daysBetween(diaryDate, new Date()) : 0;

  const smoothed = clampScore(smooth(state.diary_score, local.score));
  const combined = combine(state.chat_score, smoothed, ageDays);

  const shouldPopup = await checkPopupTrigger(userId, smoothed, "diary");
  const popup = shouldPopup.allow
    ? buildPopupPayload({ score: smoothed, source: "diary", levels, config })
    : null;

  await updateStressState(userId, {
    diary_score: smoothed,
    combined_score: combined,
    last_popup_at: shouldPopup.allow ? new Date() : state.last_popup_at,
  });

  await saveStressLog({
    userId,
    source: "diary",
    score: combined,
    smoothed,
    localScore: local.score,
    crisis: false,
    triggered: shouldPopup.allow,
  });

  // 值得做深度识别的情况
  const wantDeep = local.score >= 65 || local.emotionSentences.length > 0;
  if (wantDeep) {
    runDeepAnalysis({ userId, source: "diary", local }).catch(() => {});
  }

  return {
    score: smoothed,
    level: resolveLevel(smoothed, levels),
    crisis: false,
    shouldPopup: shouldPopup.allow,
    popup,
    delaySeconds: shouldPopup.allow ? 12 : 0,
  };
}

/* ------------------------------------------------- 异步深度识别 */

/**
 * 深度识别（LLM）。**结果只用来更新状态** —— 不阻塞、不改已经返回给前端的结论。
 */
async function runDeepAnalysis({ userId, source, local }) {
  try {
    const pieces =
      source === "diary"
        ? (local.emotionSentences || []).slice(0, 5)
        : await recentUserMessages(userId, 3);

    if (!pieces.length) return;

    // 简易的"每日上限"：看今天已经调了多少次（用 stress_logs 里的 llm 结果计数）
    const config = await getGroup("safety").catch(() => ({}));
    const limit = Number(config?.stressTrigger?.dailyLlmLimit) || TRIGGER_DEFAULTS.dailyLlmLimit;
    if (await exceededDailyLlmLimit(userId, limit)) return;

    const result = await scoreByLLM(pieces, { kind: source });
    if (!result) return;

    const state = await getStressState(userId);

    if (source === "diary") {
      const merged = Math.round(0.7 * Number(state.diary_score || BASE_SCORE) + 0.3 * result.score);
      await updateStressState(userId, {
        diary_score: clampScore(merged),
        combined_score: combine(state.chat_score, merged, 0),
      });
    } else {
      const merged = Math.round(0.7 * Number(state.chat_score || BASE_SCORE) + 0.3 * result.score);
      await updateStressState(userId, {
        chat_score: clampScore(merged),
        combined_score: combine(merged, state.diary_score, 0),
      });
    }

    // 补一条日志（llm_score 有值的那条）
    await saveStressLog({
      userId,
      source,
      score: clampScore(Number(state.combined_score || BASE_SCORE)),
      smoothed: clampScore(Number(state.chat_score || BASE_SCORE)),
      localScore: local.score,
      llmScore: result.score,
      crisis: false,
      triggered: false,
    });
  } catch (err) {
    console.warn("[stress] 深度识别失败：", err?.message || err);
  }
}

/** 取最近 n 条用户消息（只取 user 角色） */
async function recentUserMessages(userId, limit = 3) {
  try {
    const { query } = await import("./db.js");
    const rows = await query(
      `SELECT content FROM messages
        WHERE user_id = ? AND role = 'user' AND content IS NOT NULL AND content <> ''
        ORDER BY id DESC LIMIT ${Math.max(1, Math.min(limit, 10))}`,
      [Number(userId)]
    );
    return rows.map((row) => String(row.content).slice(0, 50)).reverse();
  } catch {
    return [];
  }
}

/** 今天调 LLM 的次数是否超限 */
async function exceededDailyLlmLimit(userId, limit) {
  try {
    const { query } = await import("./db.js");
    const rows = await query(
      `SELECT COUNT(*) AS n FROM stress_logs
        WHERE user_id = ? AND llm_score IS NOT NULL AND created_at >= CURDATE()`,
      [Number(userId)]
    );
    return Number(rows[0]?.n || 0) >= limit;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ 工具 */

/** 两个日期相差几天 */
function daysBetween(from, to) {
  try {
    const a = from instanceof Date ? from : new Date(String(from).slice(0, 10));
    const b = to instanceof Date ? to : new Date(to);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
    return Math.max(0, Math.floor((b.getTime() - a.getTime()) / 86400000));
  } catch {
    return 0;
  }
}

/**
 * 把后台配置里的**标量字段**组装成档位数组。
 *
 * ⚠️ 配置系统只支持标量（字符串/数字/布尔），存不了数组 ——
 *    所以档位是 4 组 `level1Max / level1Label / level1Hint` 这样的平铺字段。
 *    好处是后台用普通输入框就能改，不用给管理员一个 JSON 编辑器。
 *
 * ⚠️ 只要**任意一档配了名字**，就整组以配置为准（不混用默认值）；
 *    一档都没配才整体退回内置默认。
 */
export function normalizeLevels(input) {
  const config = input && !Array.isArray(input) ? input : {};

  const raw = [
    { id: "level1", max: config.level1Max, label: config.level1Label, hint: config.level1Hint },
    { id: "level2", max: config.level2Max, label: config.level2Label, hint: config.level2Hint },
    { id: "level3", max: config.level3Max, label: config.level3Label, hint: config.level3Hint },
    { id: "level4", max: config.level4Max, label: config.level4Label, hint: config.level4Hint },
  ];

  const cleaned = raw
    .map((item, index) => ({
      id: item.id,
      max: Math.max(0, Math.min(100, Number(item.max) || (index + 1) * 25)),
      label: String(item.label || "").trim().slice(0, 20),
      hint: String(item.hint || "").trim().slice(0, 60),
    }))
    .filter((item) => item.label)
    .sort((a, b) => a.max - b.max);

  if (cleaned.length) return cleaned;

  // 内置默认（和 stress-lexicon 的 DEFAULT_STRESS_LEVELS 保持一致）
  return [
    { id: "level1", max: 40, label: "很放松", hint: "读起来你现在挺稳的" },
    { id: "level2", max: 65, label: "有点累", hint: "能感觉到一些疲惫" },
    { id: "level3", max: 85, label: "压力偏高", hint: "这份沉有点压着你了" },
    { id: "level4", max: 100, label: "压力很高", hint: "你现在背的东西很重" },
  ];
}

/** 供外部（状态接口）读取趋势 */
export async function stressTrend(userId) {
  return recentScores(userId, 20);
}
