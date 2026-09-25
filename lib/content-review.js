/**
 * 内容安全审核（异步 / 批量）
 *
 * 背景：用户改头像、背景图、昵称、签名时**立刻生效**（不卡审核），
 * 但这些内容会被标上「未审核」，之后交给 AI 判定：
 *   合规 → 清掉标记
 *   违规 → 把对应字段改回后台配置的默认值
 *
 * 为什么是异步：审核用的是小米 MiMo 的「批量推理」—— 一次提交一批，
 * 结果**延迟返回**（不是实时）。所以流程拆成两步：
 *   ① submitPendingTasks() 把待审内容打包提交，拿到批次 id
 *   ② pollBatches() 回头查批次状态，完成了就把结果落库、执行处置
 *
 * 两种模式：
 *   batch  —— 批量推理（用户要的），提交 / 轮询两条腿走路
 *   inline —— 逐条调用对话接口，立刻出结果（批量接口不可用时兜底）
 *
 * ⚠️ 安全约定：
 *   * 所有写库的列名都来自本文件顶部的 REVIEW_FIELDS 常量，绝不拼接外部输入；
 *   * AI 返回解析不出来时**一律判合规**（宁可放过，不可误伤）；
 *   * 审核失败（网络 / 额度 / 协议不符）**绝不影响用户已经改好的资料**。
 */
import { execute, query } from "./db";
import { getGroup } from "./settings";
import { toMysqlDateTime } from "./util";

/**
 * 会被审核的字段。
 * defaultKey 指向 `settings.review` 里的默认值键 —— 判定违规时用它回填。
 */
export const REVIEW_FIELDS = [
  { field: "username", label: "昵称", column: "username", defaultKey: "defaultNickname", isImage: false },
  { field: "bio", label: "个性签名", column: "bio", defaultKey: "defaultBio", isImage: false },
  { field: "avatar_url", label: "头像", column: "avatar_url", defaultKey: "defaultAvatar", isImage: true },
  { field: "ai_avatar_url", label: "AI 头像", column: "ai_avatar_url", defaultKey: "defaultAiAvatar", isImage: true },
  {
    field: "chat_background_url",
    label: "聊天背景",
    column: "chat_background_url",
    defaultKey: "defaultChatBackground",
    isImage: true,
  },
  {
    field: "diary_background_url",
    label: "我的页背景",
    column: "diary_background_url",
    defaultKey: "defaultDiaryBackground",
    isImage: true,
  },
];

const FIELD_MAP = new Map(REVIEW_FIELDS.map((item) => [item.field, item]));

/**
 * 日记情绪打标任务的"字段定义"。
 *
 * ⚠️ 它和上面那些审核字段有两点不同，别混起来：
 *   1. **处置目标不是 users 的列，而是 `diaries.mood`**（所以这里的 column 指 diaries 的列）；
 *   2. 它不判"合规 / 违规"，而是**从 8 个情绪词里挑一个**。
 * 所以它走单独的解析（pickMoodFromText）和单独的写回逻辑。
 */
const DIARY_MOOD_FIELD = {
  field: "diary_mood",
  label: "日记情绪",
  column: "mood",
  defaultKey: "defaultDiaryMood",
  isImage: false,
};

/**
 * 「AI 根据聊天记录生成日记」的任务定义。
 *
 * ⚠️ 它和上面几类都不同：
 *   * **没有处置目标** —— target_id 是空的（日记还不存在，是这次要生成的）；
 *   * 结果不是"改某个字段"，而是**新建一篇日记**（`source = 'ai'`）；
 *   * `content` 里放的是**那天的聊天记录**，不是日记正文。
 */
const DIARY_GENERATE_FIELD = {
  field: "diary_generate",
  label: "AI 日记",
  column: "content",
  defaultKey: "",
  isImage: false,
};

/**
 * 提交到小米控制台时，批量任务的**显示名**。
 *
 * ⚠️ 三件事在控制台里**必须能分开认**：审核是审核、生成日记是生成日记、打标是打标。
 *    所以提交时会**按任务类型拆成不同批次**，每个批次有自己的名字 ——
 *    控制台的批量列表里一眼就能看出哪一行是哪一类，出问题排查也不用猜。
 *
 * ⚠️ `name` 是**必填字段，但官方文档里没写** —— 不传会被直接拒（HTTP 500）。
 *    这个坑踩过一次，见 docs/CONTENT-REVIEW.md 的排障记录。
 */
const BATCH_KIND_NAME = {
  review: "Solace·内容审核",
  diary_mood: "Solace·日记打标",
  diary_generate: "Solace·日记生成",
};

/** 取某类任务的批次显示名 */
function batchNameOf(kind) {
  return BATCH_KIND_NAME[kind] || BATCH_KIND_NAME.review;
}

/** 单条待审内容的长度上限（图片是 data URL，给得宽一些） */
const MAX_TEXT_CHARS = 400;
const MAX_IMAGE_CHARS = 1400 * 1024;

/** 上游请求超时（上传 JSONL、创建批次这类控制面请求） */
const CONTROL_TIMEOUT_MS = 30000;

function now() {
  return toMysqlDateTime(new Date());
}

/**
 * 认证请求头。
 *
 * ⚠️ 这里是踩过坑的：小米 MiMo 的**批量推理文档**里，curl 示例用的是标准
 *    `Authorization: Bearer`；而对话 / TTS 走的是 `api-key` 头。
 *    两种写法平台都接受，所以遇到小米域名干脆**两个头一起发** ——
 *    多带一个没有副作用，但少带一个就是 401。
 */
function authHeaders(baseUrl, apiKey) {
  const base = String(baseUrl || "").toLowerCase();
  const headers = { "Content-Type": "application/json" };
  headers.Authorization = `Bearer ${apiKey}`;
  if (base.includes("xiaomimimo.com")) {
    headers["api-key"] = apiKey;
  }
  return headers;
}

/** 把后台填的地址补成 {base}/xxx（允许直接粘完整地址） */
function endpoint(baseUrl, suffix) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  const cleaned = base
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/files$/i, "")
    .replace(/\/batches$/i, "");
  return `${cleaned}${suffix}`;
}

function timeoutSignal(ms) {
  return typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

/* ------------------------------------------------------------------ 入队 */

/**
 * 把一条刚被修改的资料放进审核队列。
 *
 * ⚠️ 调用方必须用 try/catch 包住它 —— 审核系统出问题**不能**影响用户改资料。
 * 返回 true 表示已入队，false 表示跳过（内容为空 / 字段不认识 / 审核已关闭）。
 */
/**
 * 把一条内容放进队列。
 *
 * @param taskKind  "review"（默认，内容审核）/ "diary_mood"（日记情绪打标）
 * @param targetId  目标记录 id —— 日记打标时是 `diaries.id`
 *
 * ⚠️ 调用方必须用 try/catch 包住它 —— 队列出问题**不能**影响用户写日记 / 改资料。
 * 返回 true 表示已入队，false 表示跳过（内容为空 / 字段不认识 / 超长）。
 */
export async function enqueueReview({
  userId,
  field,
  content,
  taskKind = "review",
  targetId = null,
}) {
  const kind =
    taskKind === "diary_mood" || taskKind === "diary_generate" ? taskKind : "review";

  // 日记那两类走各自的"字段定义"（处置目标不是 users 的列）
  const meta =
    kind === "diary_mood"
      ? DIARY_MOOD_FIELD
      : kind === "diary_generate"
        ? DIARY_GENERATE_FIELD
        : FIELD_MAP.get(String(field || ""));
  if (!meta || !userId) return false;

  const value = typeof content === "string" ? content : "";

  // 清空内容 = 没什么可处理的
  if (!value.trim()) return false;

  // ⚠️ 长度上限按任务类型区分：
  //    聊天记录比"昵称 / 签名"长得多 —— 生成日记时如果还用 400 字的默认上限，
  //    任务会直接被拦在队列外面（而且一点提示都没有）。
  const maxChars = kind === "diary_generate" ? 20000 : meta.isImage ? MAX_IMAGE_CHARS : MAX_TEXT_CHARS;
  if (value.length > maxChars) return false;

  try {
    await execute(
      `INSERT INTO content_review_tasks (user_id, task_kind, field, target_id, content, is_image, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [userId, kind, meta.field, targetId || null, value, meta.isImage ? 1 : 0]
    );

    // 给 users 行打上「待审核」tag —— 后台用户列表能一眼看出谁还有内容没过审。
    // 用 CONCAT 累加字段名，避免覆盖掉同一个用户其它字段的待审状态。
    //
    // ⚠️ **日记打标不打这个 tag**：那不是"审核"，用户看自己头像旁边永远挂着
    //    "未审核"会莫名其妙（而且日记是私密的，跟资料审核不是一回事）。
    if (kind === "review") {
      await execute(
        `UPDATE users
            SET review_pending = TRIM(BOTH ',' FROM CONCAT(COALESCE(review_pending, ''), ?, ','))
          WHERE id = ?`,
        [`${meta.field},`, userId]
      );
    }

    return true;
  } catch (err) {
    // 表还没建（老库首次升级）或者数据库抖动：静默跳过，别打扰用户
    console.error("[review] 入队失败：", err?.code || err?.message || err);
    return false;
  }
}

/** 去掉某个字段的待审 tag（审核完成 / 清空内容时调用） */
async function clearPendingTag(userId, field) {
  try {
    const rows = await query("SELECT review_pending FROM users WHERE id = ? LIMIT 1", [userId]);
    const current = String(rows[0]?.review_pending || "");
    if (!current) return;

    const kept = current
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item && item !== field);

    await execute("UPDATE users SET review_pending = ? WHERE id = ?", [
      kept.length ? kept.join(",") : null,
      userId,
    ]);
  } catch {
    /* 标记清理失败不影响主流程 */
  }
}

/* ------------------------------------------------------------ 提示词组装 */

/**
 * 判断一条任务该用什么消息体。
 *
 * ⚠️ 两类任务走**完全不同的提示词**：
 *   · review      → 系统提示词用「审核提示词」，要求它输出 JSON 判定
 *   · diary_mood  → 系统提示词用「打标提示词」，只要它输出一个情绪词
 *   所以必须按 task_kind 分流，否则日记会被当资料审、资料会被当日记打标。
 */
function buildMessages(task, config) {
  const kind = String(task.task_kind || "review");

  // ---- 日记情绪打标 ----
  if (kind === "diary_mood") {
    return [
      { role: "system", content: String(config.diaryMoodPrompt || "") },
      { role: "user", content: String(task.content || "") },
    ];
  }

  // ---- AI 根据聊天记录生成日记 ----
  // ⚠️ 这里的 task.content 放的是**那天的聊天记录**（不是日记正文）——
  //    生成出来后，日记正文来自 AI 的返回。
  if (kind === "diary_generate") {
    return [
      { role: "system", content: String(config.diaryGeneratePrompt || "") },
      { role: "user", content: String(task.content || "") },
    ];
  }

  // ---- 内容审核 ----
  const meta = FIELD_MAP.get(String(task.field)) || { label: "资料" };
  const isImage = Number(task.is_image) === 1;

  const instruction = isImage
    ? `下面这张图片是用户设置的「${meta.label}」。请按系统提示里的规则判断它是否违规。`
    : `下面是用户设置的「${meta.label}」：\n"""\n${task.content}\n"""\n请按系统提示里的规则判断它是否违规。`;

  const content = isImage
    ? [
        { type: "text", text: instruction },
        { type: "image_url", image_url: { url: task.content } },
      ]
    : instruction;

  return [
    { role: "system", content: String(config.reviewPrompt || "") },
    { role: "user", content },
  ];
}

/* ------------------------------------------------------------ 结果解析 */

/**
 * 从模型输出里抠出判定结果。
 *
 * ⚠️ 这里的分寸很重要，改之前先读这段注释：
 *
 *   1. **尽量读懂模型的输出** —— 不同模型返回的字段名和取值五花八门
 *      （verdict / result / label / is_violation，值可能是 pass / reject /
 *       合规 / 违规 / true / false），所以做了大量兼容。
 *
 *   2. **真读不懂时返回 "unknown"，不猜**。
 *      以前这里是"一律按合规处理"，结果是：一条明明是脏话的内容，
 *      因为模型没按 JSON 格式回答，就被当成通过了 —— 审核形同虚设。
 *      现在的做法是交给**人工**：unknown 会被标成 failed 进后台待人工队列，
 *      既不会误伤用户（不动他的资料），也不会漏掉。
 */
export function parseVerdict(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) {
    return { verdict: "unknown", reason: "AI 没有返回任何内容" };
  }

  // 去掉常见的代码块包裹
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();

  // 优先取第一个 { 到最后一个 } 之间的内容
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1));
      const parsed = readVerdictFromObject(obj);
      if (parsed) return parsed;
    } catch {
      /* 不是合法 JSON，落到下面 */
    }
  }

  // 读不懂 → 交人工，绝不默认放过
  return {
    verdict: "unknown",
    reason: `AI 返回的不是约定格式，已转人工复核：${cleaned.slice(0, 120)}`,
  };
}

/* --------------------------------------------------------- 情绪词解析 */

/** 8 个温和的情绪标签（和 lib/ai.js 的 MOOD_LABELS 保持一致） */
export const DIARY_MOODS = [
  "轻快",
  "平静",
  "安稳",
  "有点沉",
  "疲惫",
  "烦躁",
  "孤单",
  "说不清",
];

/**
 * 从模型输出里挑出一个合法的情绪词。
 *
 * 这是**白名单**式解析：模型即使胡说八道，也只会落到「说不清」——
 * 绝不会把乱七八糟的文字写进 diaries.mood。
 * 返回空串表示"没挑出来"，调用方会落到后台配的默认标签。
 */
export function pickMoodFromText(rawText) {
  const text = String(rawText || "").replace(/\s+/g, "");
  if (!text) return "";

  // 先找完全相等的
  const exact = DIARY_MOODS.find((item) => text === item);
  if (exact) return exact;

  // 再找包含的（模型可能多说了一点，比如"标签：疲惫"）
  const included = DIARY_MOODS.find((item) => text.includes(item));
  if (included) return included;

  return "";
}

/* ---------------------------------------------------- 生成日记的解析 */

/**
 * 解析「AI 生成日记」的输出。
 *
 * 约定的输出格式（在 `generatePrompt` 里写好的）：
 *
 *   标签：轻快
 *   标题：今天有点不一样
 *   正文：
 *   今天……（正文可以有很多段）
 *
 * ⚠️ **为什么不用 JSON**：让模型在批量推理里吐 JSON 太容易坏
 *    （审核那边已经吃过一次亏，见 docs 里那个排障表）。
 *    改成「行首标记 + 后面全是正文」这种格式，容错性好得多。
 *
 * ⚠️ 解析不出来就返回 null，调用方会把任务标成 failed 交人工 ——
 *    **不会瞎写一篇日记塞给用户**。
 */
export function parseDiaryDraft(rawText) {
  const raw = String(rawText || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return null;

  const lines = raw.split("\n");
  let mood = "";
  let title = "";
  let contentStart = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();

    if (!mood) {
      const matched = line.match(/^标签[:：]\s*(.+)$/);
      if (matched) {
        mood = pickMoodFromText(matched[1]);
        continue;
      }
    }

    if (!title) {
      const matched = line.match(/^标题[:：]\s*(.+)$/);
      if (matched) {
        title = matched[1].trim().slice(0, 120);
        continue;
      }
    }

    // 「正文：」这一行之后全都是正文
    if (/^正文[:：]\s*$/.test(line)) {
      contentStart = i + 1;
      break;
    }
  }

  // 没找到「正文：」标记的话退一步：把"标签 / 标题"之外的内容都当正文
  let content =
    contentStart >= 0
      ? lines.slice(contentStart).join("\n").trim()
      : lines
          .filter((line) => !/^(标签|标题)[:：]/.test(line.trim()))
          .join("\n")
          .trim();

  content = content.slice(0, 20000);
  if (!content) return null;

  return {
    mood: mood || "",
    title: title || "无题",
    content,
  };
}

/** 取值时可能出现的字段名（各家模型的叫法不一样） */
const VERDICT_KEYS = [
  "verdict",
  "result",
  "judgment",
  "judgement",
  "decision",
  "label",
  "status",
  "violation",
  "is_violation",
  "isViolation",
  "violated",
];

/** 精确匹配用的词（短词放这里，避免 "no" 匹配到 "normal" 这种事故） */
const REJECT_EXACT = ["reject", "rejected", "fail", "failed", "true", "yes", "y", "1", "违规", "不合规", "违反", "否", "是"];
const PASS_EXACT = ["pass", "passed", "ok", "okay", "safe", "clean", "good", "false", "no", "n", "0", "合规", "正常", "通过", "没问题"];

/** 只在"包含"时才算数的长词（不会误伤） */
const REJECT_CONTAINS = ["violation", "violate", "inappropriate", "违规", "不合规", "违反", "违规内容"];
const PASS_CONTAINS = ["compliant", "complience", "compliance", "合规", "正常", "无违规", "clean", "safe"];

/**
 * 从一个对象里尽力读出判定。读不出来返回 null（交给上层转人工）。
 * 兼容：不同字段名、布尔值、中英文取值、以及 "not violation" 这类否定写法。
 */
function readVerdictFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;

  let rawVerdict;
  for (const key of VERDICT_KEYS) {
    if (obj[key] !== undefined && obj[key] !== null) {
      rawVerdict = obj[key];
      break;
    }
  }
  if (rawVerdict === undefined || rawVerdict === null) return null;

  const reason = String(
    obj.reason ?? obj.message ?? obj.explain ?? obj.explanation ?? obj.detail ?? ""
  ).slice(0, 220);

  // 布尔值：惯例是 true = 违规
  if (rawVerdict === true) return { verdict: "reject", reason };
  if (rawVerdict === false) return { verdict: "pass", reason };

  let value = String(rawVerdict).toLowerCase().trim();
  if (!value) return null;

  // 处理 "not violation" / "no_violation" 这类否定写法 —— 先反转再判断
  const negated = /^(not|no|non)[\s_\-]+/.test(value);
  if (negated) {
    value = value.replace(/^(not|no|non)[\s_\-]+/, "");
    // 否定 + "违规" = 合规
    if (REJECT_EXACT.includes(value) || REJECT_CONTAINS.some((w) => value.includes(w))) {
      return { verdict: "pass", reason };
    }
    if (PASS_EXACT.includes(value) || PASS_CONTAINS.some((w) => value.includes(w))) {
      return { verdict: "reject", reason };
    }
    return null;
  }

  // 先精确匹配（短词在这一步，避免 "no" 命中 "normal"）
  if (REJECT_EXACT.includes(value)) return { verdict: "reject", reason };
  if (PASS_EXACT.includes(value)) return { verdict: "pass", reason };

  // 再包含匹配（只用长词）
  if (REJECT_CONTAINS.some((w) => value.includes(w))) return { verdict: "reject", reason };
  if (PASS_CONTAINS.some((w) => value.includes(w))) return { verdict: "pass", reason };

  return null;
}

/* ------------------------------------------------------------ 违规处置 */

/**
 * 应用一条判定结果。
 * reject 时把 users 的对应列改回默认值，并在 review_flagged 里记一笔。
 */
export async function applyVerdict({ taskId, verdict, reason, provider }) {
  const rows = await query(
    "SELECT id, user_id, task_kind, field, target_id, content, is_image FROM content_review_tasks WHERE id = ? LIMIT 1",
    [taskId]
  );
  if (!rows.length) return { ok: false, error: "任务不存在" };

  const task = rows[0];
  const kind = String(task.task_kind || "review");

  /* ---------------- AI 生成日记：创建一篇新日记 ---------------- */
  if (kind === "diary_generate") {
    // ⚠️ 这类任务的"结果"不是判定，而是**一整篇日记** ——
    //    verdict 里装的是解析好的草稿对象：{ mood, title, content }
    const draft = verdict && typeof verdict === "object" ? verdict : null;

    if (!draft || !draft.content) {
      await execute(
        "UPDATE content_review_tasks SET status = 'failed', reason = ?, reviewed_at = ? WHERE id = ?",
        [`生成结果为空或格式不对：${String(reason || "").slice(0, 180)}`, now(), taskId]
      );
      return { ok: false, error: "生成结果无法解析" };
    }

    const diaryConfig = await getGroup("diary");

    // 写进 diaries：
    //   * **source = 'ai'**  → 前端会标上「AI 生成」，用户一眼能区分
    //   * **mood 直接带上**  → 这就是"生成出来就带着标签"，不用再排一次打标队列
    //   * **diary_date = 昨天** → 这篇日记写的就是**昨天那一天**，不是"现在"。
    //     created_at 仍然是"生成时刻"（今天 23 点），那是审计用的；
    //     界面上展示的日期一律以 diary_date 为准，否则用户会以为这是今天的日记。
    const insert = await execute(
      `INSERT INTO diaries (user_id, title, content, mood, source, diary_date)
       VALUES (?, ?, ?, ?, 'ai', DATE_SUB(CURDATE(), INTERVAL 1 DAY))`,
      [
        task.user_id,
        String(draft.title || "无题").slice(0, 120),
        String(draft.content).slice(0, 20000),
        String(draft.mood || diaryConfig?.defaultMood || "说不清").slice(0, 16),
      ]
    );

    await execute(
      "UPDATE content_review_tasks SET status = 'pass', reason = ?, provider = ?, reviewed_at = ? WHERE id = ?",
      [
        `已生成日记：${String(draft.title || "").slice(0, 40)}`,
        String(provider || ""),
        now(),
        taskId,
      ]
    );

    return {
      ok: true,
      verdict: "generated",
      field: "diary_generate",
      label: "AI 日记",
      diaryId: insert.insertId,
    };
  }

  /* ---------------- 日记情绪打标：结果写进 diaries.mood ---------------- */
  if (kind === "diary_mood") {
    // 打标没有"违规"概念 —— 传进来的 verdict 就是解析好的那个情绪词
    const diaryConfig = await getGroup("diary");
    const mood =
      String(verdict || "").trim() ||
      String(diaryConfig?.defaultMood || "").trim() ||
      "说不清";

    // ⚠️ 和审核一样，先确认"这条日记还在、内容没被改过"：
    //    用户在等待期间改写了日记，就不该拿旧结果去覆盖新内容。
    const current = await query(
      "SELECT content FROM diaries WHERE id = ? AND user_id = ? LIMIT 1",
      [task.target_id, task.user_id]
    );

    if (!current.length) {
      await execute(
        "UPDATE content_review_tasks SET status = 'pass', reason = ?, reviewed_at = ? WHERE id = ?",
        ["日记已不存在（可能已删除）", now(), taskId]
      );
      return { ok: true, verdict: "gone", field: "diary_mood", label: "日记情绪" };
    }

    if (String(current[0].content ?? "") !== String(task.content ?? "")) {
      await execute(
        "UPDATE content_review_tasks SET status = 'pass', reason = ?, reviewed_at = ? WHERE id = ?",
        ["打标期间日记被改过，这次结果作废（新内容会重新排队）", now(), taskId]
      );
      return { ok: true, verdict: "stale", field: "diary_mood", label: "日记情绪" };
    }

    // 写进 diaries.mood（AI 的标签）—— 用户的 user_mood 不动，两个分开存
    await execute("UPDATE diaries SET mood = ? WHERE id = ? AND user_id = ?", [
      mood,
      task.target_id,
      task.user_id,
    ]);
    await execute(
      "UPDATE content_review_tasks SET status = 'pass', reason = ?, provider = ?, reviewed_at = ? WHERE id = ?",
      [`AI 打的标签：${mood}`, String(provider || ""), now(), taskId]
    );

    return { ok: true, verdict: "mood", field: "diary_mood", label: "日记情绪", mood };
  }

  /* ---------------- 内容审核：下面都是原来的逻辑 ---------------- */
  const meta = FIELD_MAP.get(String(task.field));
  if (!meta) return { ok: false, error: "字段类型未知" };

  // 三态：reject（违规）/ pass（合规）/ failed（读不懂，转人工）
  //
  // ⚠️ failed 这个中间态是必须的：
  //    模型返回格式不对时，我们**既不能当合规**（会漏掉脏话，审核形同虚设），
  //    也**不能当违规**（会误伤用户、把他的昵称重置掉）。
  //    所以只能交给人工 —— 状态标成 failed，出现在后台的「待人工」列表里。
  const finalVerdict =
    verdict === "reject" ? "reject" : verdict === "pass" ? "pass" : "failed";
  const finalReason = String(reason || "").slice(0, 250);

  await execute(
    `UPDATE content_review_tasks
        SET status = ?, reason = ?, provider = ?, reviewed_at = ?
      WHERE id = ?`,
    [finalVerdict, finalReason, String(provider || ""), now(), taskId]
  );

  if (finalVerdict === "reject") {
    // ⚠️ 先确认「被判违规的那份内容」现在还挂在用户身上：
    //    用户完全可能在被判定的这段时间里又改了一次，
    //    这时不能拿基于旧内容的判定去覆盖他刚写的新内容。
    const currentRows = await query(
      `SELECT \`${meta.column}\` AS value FROM users WHERE id = ? LIMIT 1`,
      [task.user_id]
    );
    const currentValue = String(currentRows[0]?.value ?? "");
    const judgedValue = String(task.content ?? "");

    if (currentValue !== judgedValue) {
      await execute(
        "UPDATE content_review_tasks SET reason = ?, reviewed_at = ? WHERE id = ?",
        [`${finalReason}（判定期间内容已被用户再次修改，未做处置）`.slice(0, 250), now(), taskId]
      );
      await clearPendingTag(task.user_id, meta.field);
      return { ok: true, verdict: "stale", field: meta.field, label: meta.label };
    }

    const config = await getGroup("review");
    let fallback = String(config?.[meta.defaultKey] || "").trim();

    // ⚠️ 昵称绝对不能落成 NULL：
    //    如果后台没配「默认昵称」（或配成了空），写 NULL 会让用户名变成一片空白 ——
    //    聊天列表、会话标题、「我的」页到处都在取名字，空名字看起来就像坏掉了。
    //    这里兜一个「用户」：宁可显示"用户"，也不能空着。
    if (!fallback && meta.field === "username") fallback = "用户";

    // ⚠️ meta.column 来自本文件的常量表，不是外部输入 —— 不存在注入面
    await execute(`UPDATE users SET \`${meta.column}\` = ? WHERE id = ?`, [
      fallback || null,
      task.user_id,
    ]);

    try {
      const flagRows = await query("SELECT review_flagged FROM users WHERE id = ? LIMIT 1", [
        task.user_id,
      ]);
      const kept = String(flagRows[0]?.review_flagged || "")
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item && item !== meta.field);
      kept.push(meta.field);
      await execute("UPDATE users SET review_flagged = ? WHERE id = ?", [
        kept.join(",").slice(0, 250),
        task.user_id,
      ]);
    } catch {
      /* 标记写入失败不影响主流程 */
    }
  }

  // ⚠️ 只有**审出结果**了才清掉「未审核」tag。
  //    failed 的那些还挂在「待人工」队列里，tag 必须留着 ——
  //    否则后台的用户列表里就看不出他还有内容没过审。
  if (finalVerdict !== "failed") {
    await clearPendingTag(task.user_id, meta.field);
  }

  return { ok: true, verdict: finalVerdict, field: meta.field, label: meta.label };
}

/* ------------------------------------------------------------ 本地预检 */

/**
 * 本地预检词表（明确到没有讨论余地的那些）。
 *
 * 为什么要本地拦一遍：有些词根本不需要问 AI —— 本地命中既快又准，
 * 还能避免"模型今天判断得比较宽松，把 fuck 放过去了"这种不确定性。
 *
 * ⚠️ 选词原则：**只放没有歧义的**。
 *    比如"滚"在中文里既可能是骂人、也可能是"滚去睡觉"的亲昵说法，就不放。
 *    误伤用户的代价远大于漏过一条（漏过的管理员还能在后台人工看）。
 *
 * ⚠️ 英文用「词首匹配」而不是子串匹配：
 *    `\bfuck` 能盖住 fuck / fucking / fucked，但不会误伤 shiitake（香菇）。
 */
const EN_BLOCKLIST = [
  "fuck",
  "fuk",
  "fck",
  "shit",
  "bitch",
  "bastard",
  "asshole",
  "dickhead",
  "cunt",
  "whore",
  "slut",
  "nigger",
  "nigga",
  "retard",
  "porn",
  "rape",
  "nudes",
];

/**
 * 中文脏话词表。
 *
 * ⚠️ 这份表是**用真实案例补出来的**，别删这段注释：
 *    用户实测「我tm草泥马，你个废物，臭sb」这串内容，**一条都没命中** ——
 *    因为当时的词表只有"操你""傻逼"这种**规范写法**，而实际骂人用的是
 *    谐音（草泥马）、拼音缩写（tm / sb）、以及"废物"这类侮辱词。
 *
 *    教训：**骂人的写法比词典更新得快**。所以下面按「家族 + 变体」列，
 *    而不是只列规范写法。以后遇到漏的，优先往这里补。
 */
const ZH_BLOCKLIST = [
  // ---- 操你妈 / 草泥马 家族（含常见谐音）----
  "操你",
  "草你",
  "艹你",
  "曹你",
  "草泥马",
  "草尼玛",
  "曹尼玛",
  "艹泥马",
  "草原马",
  "草泥媽",
  "操他妈",
  "草他妈",
  "艹他妈",

  // ---- 妈的 / 尼玛 家族 ----
  "他妈的",
  "你妈的",
  "妈的",
  "尼玛",
  "尼马",
  "特么",

  // ---- 傻逼家族 ----
  "傻逼",
  "煞笔",
  "沙比",
  "杀笔",
  "傻批",
  "傻比",
  "傻x",
  "傻b",

  // ---- 侮辱性称呼 ----
  "贱人",
  "婊子",
  "表子",
  "杂种",
  "狗杂种",
  "畜生",
  "废物",
  "蠢货",
  "蠢猪",
  "猪脑子",
  "脑残",
  "智障",
  "弱智",
  "死胖子",
  "丑八怪",

  // ---- 恶毒诅咒 ----
  "死全家",
  "全家死",
  "你妈死了",
  "尼玛死了",
  "死妈",

  // ---- 广告引流 ----
  "加微信",
  "微信号是",
  "加qq",
  "加扣扣",
  "代刷",
  "刷单",
  "博彩",
  "赌场",
  "洗钱",
  "扫码加",
  "私聊我",
  "低价出",
];

/**
 * 拼音缩写类的脏话（两三个字母）。
 *
 * ⚠️ 这些**不能直接子串匹配** —— "asb" 里也含 "sb"，会误伤正常内容。
 *    规则是：**前后不能是英文字母**才算命中。
 *    例：「我tm草泥马」✅ 命中（前后是中文）；「ASB Bank」❌ 不命中（前面是字母）。
 */
const ZH_ABBR_BLOCKLIST = [
  "sb", // 傻逼
  "tm", // 他妈
  "tmd", // 他妈的
  "nmsl", // 你妈死了
  "cnm", // 草泥马
  "mdzz", // 妈的智障
  "wdnmd", // 我打你妈的
];

/**
 * 跑一遍本地词表，命中就返回命中的那个词，没命中返回空串。
 *
 * @param text         要检查的文本
 * @param customWords  后台「自定义违禁词」的多行文本（可选）
 */
export function matchBlocklist(text, customWords = "") {
  const raw = String(text || "");
  if (!raw) return "";

  const lower = raw.toLowerCase();

  // 英文：\b 词首匹配，避免误伤包含这些字母组合的正常单词
  for (const word of EN_BLOCKLIST) {
    try {
      if (new RegExp(`\\b${word}`, "i").test(lower)) return word;
    } catch {
      /* 词表里出现非法正则字符时跳过这个词，不影响其它 */
    }
  }

  // 中文：直接子串匹配
  for (const word of ZH_BLOCKLIST) {
    if (lower.includes(word.toLowerCase())) return word;
  }

  // 拼音缩写：前后不能是英文字母（避免 asb 这类误伤）
  for (const word of ZH_ABBR_BLOCKLIST) {
    try {
      if (new RegExp(`(?:^|[^a-z])${word}(?:[^a-z]|$)`, "i").test(lower)) return word;
    } catch {
      /* 忽略非法正则 */
    }
  }

  // 后台自己加的违禁词
  for (const word of parseCustomWords(customWords)) {
    if (!word) continue;
    // 纯英文/符号的词按词首匹配（避免误伤含这些字母的普通单词），含中文的直接子串匹配
    if (/^[\x20-\x7e]+$/.test(word)) {
      try {
        if (new RegExp(`\\b${word}`, "i").test(lower)) return word;
      } catch {
        /* 词里有非法正则字符，跳过这个词 */
      }
    } else if (lower.includes(word)) {
      return word;
    }
  }

  return "";
}

/** 把后台填的多行词表拆成数组（每行一个，# 开头忽略） */
function parseCustomWords(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.toLowerCase())
    .slice(0, 500); // 上限 500：防止有人整本词典贴进来，每条都要跑一遍
}

/**
 * 提交前先跑一遍本地预检：命中的直接判违规，不浪费 AI 调用。
 * @returns { remaining, rejected } —— 剩下要送 AI 的任务，和本地已判违规的条数
 */
async function precheckLocally(tasks, config) {
  const remaining = [];
  let rejected = 0;

  for (const task of tasks) {
    // 图片没法做本地文本匹配，直接留给 AI
    if (Number(task.is_image) === 1) {
      remaining.push(task);
      continue;
    }

    const hit = matchBlocklist(task.content, config?.customBlocklist);
    if (!hit) {
      remaining.push(task);
      continue;
    }

    try {
      await applyVerdict({
        taskId: task.id,
        verdict: "reject",
        reason: `本地词表命中「${hit}」（不用送 AI 就能判定）`,
        provider: "local",
      });
      rejected += 1;
    } catch {
      // 处置失败就退回给 AI 处理，别让这条卡住
      remaining.push(task);
    }
  }

  return { remaining, rejected };
}

/* ------------------------------------------------------------ 提交（批量） */

/**
 * 取出一批待审任务（**不做任何过滤**，图片和文本都取出来）。
 *
 * ⚠️ 为什么这里不过滤：图片和文本的"去向"不一样 ——
 *    文本能进批量，图片不能（多模态消息体会让整批创建失败）。
 *    分流放在 submitPendingTasks 里做，这里只管取。
 */
async function takePending(limit, config) {
  void config;
  return query(
    `SELECT id, user_id, task_kind, field, target_id, content, is_image
       FROM content_review_tasks
      WHERE status = 'pending'
      ORDER BY id ASC
      LIMIT ?`,
    [limit]
  );
}

/**
 * 把一批任务标成「等人工」（status = manual）。
 *
 * 主要用在图片上：批量推理吃不下多模态消息体（整批创建会直接失败），
 * 所以批量模式下图片不进 AI。标成 manual 之后：
 *   · 不会再被 takePending 捞出来反复尝试（否则每次提交都白跑一遍）
 *   · 后台「待人工」筛选里能看到，管理员点一下就能通过 / 驳回
 */
async function markTasksManual(taskIds, reason) {
  if (!taskIds.length) return 0;
  try {
    const result = await execute(
      `UPDATE content_review_tasks
          SET status = 'manual', reason = ?, reviewed_at = ?
        WHERE id IN (${taskIds.map(() => "?").join(",")})`,
      [String(reason).slice(0, 250), now(), ...taskIds]
    );
    return result.affectedRows || 0;
  } catch {
    return 0;
  }
}

/**
 * 把待审内容提交上去。
 *
 * @returns { ok, provider, batchId?, taskCount, error?, fallback? }
 */
export async function submitPendingTasks({ limit } = {}) {
  const config = await getGroup("review");

  // ⚠️ 日记相关的配置在**另一个分组**（后台有单独的「日记」tab），
  //    但下面组装消息体、解析结果都要用到，所以在这里合并进来 ——
  //    这样 buildMessages / applyVerdict 只认 config，不用关心它是哪个分组来的。
  try {
    const diaryConfig = await getGroup("diary");
    config.diaryMoodPrompt = diaryConfig?.moodPrompt;
    config.defaultDiaryMood = diaryConfig?.defaultMood;
    config.diaryGeneratePrompt = diaryConfig?.generatePrompt;
  } catch {
    /* 读不到就留空，会走默认提示词 */
  }

  if (!config?.enabled) return { ok: false, error: "数据审核未启用", taskCount: 0 };
  if (!config.baseUrl || !config.apiKey || !config.model) {
    return { ok: false, error: "审核 AI 还没配置完整（接口地址 / API Key / 模型名）", taskCount: 0 };
  }

  // ⚠️ 提前拦住一个"必死"的情况，省得白试：
  //
  //    小米有两种 API Key：
  //      `sk-` 开头 → 按量计费（从现金余额扣费）✅ 批量能用
  //      `tp-` 开头 → Token Plan 套餐的 Key ⚠️ 批量不能用
  //
  //    官方文档在批量那页明确写了「批量推理不支持 Token Plan 抵扣」。
  //    拿 tp- 的 Key 提交批量，上游只回一句 internal_error，根本看不出原因。
  //    与其让它失败一遍再降级，不如在这里直接说清楚。
  if (
    String(config.mode || "batch") === "batch" &&
    /^tp-/i.test(String(config.apiKey).trim())
  ) {
    return {
      ok: false,
      provider: "none",
      taskCount: 0,
      error:
        "批量推理不支持 Token Plan 套餐的 Key（tp- 开头）—— 官方文档写明「批量只从现金余额扣费」。请换成 sk- 开头的按量计费 Key，或把「审核方式」改成「逐条调用」",
    };
  }

  const max = Math.min(Number(limit) || config.maxItemsPerBatch || 20, 100);
  const pending = await takePending(max, config);
  if (!pending.length) {
    return { ok: true, provider: "none", taskCount: 0, message: "没有待审核的内容" };
  }

  const useBatch = String(config.mode || "batch") === "batch";
  const imagesEnabled = config.reviewImages !== false;
  const imageHandling = String(config.imageHandling || "manual");

  const imageTasks = pending.filter((task) => Number(task.is_image) === 1);
  const textTasks = pending.filter((task) => Number(task.is_image) !== 1);

  /* ---- 图片任务分流 ----
   *   关了「连图片一起送审」           → 标人工
   *   批量模式 + imageHandling=manual  → 标人工（批量吃不下图片）
   *   批量模式 + imageHandling=inline  → 用逐条单独审
   *   逐条模式                         → 跟文本一起走逐条
   *
   * ⚠️ 为什么图片不能进批量：图片是多模态消息体（content 是数组 + base64），
   *    实测会让**整个批次在创建阶段就失败**（HTTP 500）—— 一条图片拖垮整批。
   *    但逐条是单条调用，互不牵连，所以那条路是通的。
   */
  let imagesToInline = [];
  let manualCount = 0;

  if (imageTasks.length) {
    const imageIds = imageTasks.map((task) => task.id);

    if (!imagesEnabled) {
      manualCount = await markTasksManual(
        imageIds,
        "后台关闭了「连图片一起送审」，图片转入人工队列"
      );
    } else if (useBatch && imageHandling !== "inline") {
      manualCount = await markTasksManual(
        imageIds,
        "图片不走批量（多模态消息体会让整批创建失败），已转入人工队列"
      );
    } else {
      imagesToInline = imageTasks;
    }
  }

  /* ---- 文本任务先过本地词表（图片不参与文本匹配）---- */
  const { remaining: textToSend, rejected: localRejected } = await precheckLocally(
    textTasks,
    config
  );

  const textViaBatch = useBatch ? textToSend : [];
  let inlineTasks = useBatch ? [...imagesToInline] : [...textToSend, ...imagesToInline];

  if (!textViaBatch.length && !inlineTasks.length) {
    return {
      ok: true,
      provider: "none",
      taskCount: pending.length,
      localRejected,
      manualCount,
      message:
        [
          localRejected ? `本地词表判违规 ${localRejected} 条` : "",
          manualCount ? `${manualCount} 条图片转入人工队列` : "",
        ]
          .filter(Boolean)
          .join("；") || "没有需要送 AI 的内容",
    };
  }

  /* ---- 文本走批量；失败则连同图片一起转逐条 ---- */
  //
  // ⚠️ **按任务类型拆批次**：审核、日记打标、日记生成各提交一个批次。
  //    这样小米控制台的批量列表里三件事各自成行、名字各不相同 ——
  //    全混在一个批次里的话，看到一排同名的"内容审核"根本分不出哪批是打标。
  let batchInfo = { batches: [] };

  if (textViaBatch.length) {
    // 按 task_kind 分组（保持插入顺序，方便对着日志看）
    const groups = new Map();
    for (const task of textViaBatch) {
      const kind = String(task.task_kind || "review");
      if (!groups.has(kind)) groups.set(kind, []);
      groups.get(kind).push(task);
    }

    for (const [kind, list] of groups) {
      try {
        const info = await submitAsBatch({ tasks: list, config });
        batchInfo.batches.push(info);
      } catch (err) {
        const message = err?.message || String(err);
        console.error(`[review] 批量提交失败（${batchNameOf(kind)}）：`, message);

        // 记一条失败批次，后台能看到"什么时候试过批量、报的什么错"
        try {
          await execute(
            `INSERT INTO content_review_batches
               (provider, status, task_count, failed_count, error, completed_at)
             VALUES ('mimo-batch', 'failed', ?, ?, ?, ?)`,
            [list.length, list.length, message.slice(0, 500), now()]
          );
        } catch {
          /* 记录失败不影响降级流程 */
        }

        if (config.autoFallback === false) {
          return { ok: false, provider: "mimo-batch", taskCount: 0, error: message };
        }

        batchInfo.fallback = true;
        batchInfo.batchError = message;
        inlineTasks = [...list, ...inlineTasks];
      }
    }
  }

  /* ---- 逐条处理：图片，以及批量失败后降级过来的文本 ---- */
  let inlineResult = {};
  if (inlineTasks.length) {
    inlineResult = await submitInline({ tasks: inlineTasks, config });
  }

  const provider =
    textViaBatch.length && !batchInfo.fallback
      ? "mimo-batch"
      : inlineTasks.length
        ? "inline"
        : "none";

  const batchList = batchInfo.batches || [];

  return {
    ok: inlineResult.ok !== false,
    provider,
    taskCount: pending.length,
    localRejected,
    manualCount,
    ...batchInfo,
    // 兼容旧前端：以前只有一个批次，读的是 batchId / batchName
    batchId: batchList[0]?.batchId || null,
    batchName: batchList.map((item) => item.name).filter(Boolean).join("、") || "",
    batchCount: batchList.length,
    message: batchList.length
      ? `已提交 ${batchList.length} 个批次：${batchList
          .map((item) => `${item.name}（${item.taskCount ?? "?"} 条）`)
          .join("、")}`
      : "没有需要送批量推理的内容",
    ...inlineResult,
  };
}

/** 走批量推理：上传 JSONL → 创建批次 → 记录批次行 */
async function submitAsBatch({ tasks, config }) {
  // ⚠️ 批量推理用的是**独立的域名**，不是对话接口那个：
  //    https://batch-api-{region}.xiaomimimo.com/v1  （region 从控制台批量推理页看）
  //    没配 batchBaseUrl 时会退回对话地址 —— 那样提交必然失败，
  //    然后走自动降级（逐条模式），功能不受影响。
  const batchBase = String(config.batchBaseUrl || "").trim() || config.baseUrl;

  // ① 组装 JSONL。格式严格按小米文档：
  //    {"custom_id":"request-1","method":"POST","url":"/v1/chat/completions","body":{...}}
  //    —— custom_id 在文件内必须唯一，我们用任务 id，回收结果时靠它对齐。
  const lines = tasks.map((task) =>
    JSON.stringify({
      custom_id: `rev-${task.id}`,
      method: "POST",
      url: "/v1/chat/completions",
      // ⚠️ body 里**只放 model 和 messages**，和官方模板完全一致：
      //
      //   {"custom_id":"request-1","method":"POST","url":"/v1/chat/completions",
      //    "body":{"model":"mimo-v2.6-flash","messages":[{"role":"user","content":"Hello"}]}}
      //
      //   之前这里多带了 max_tokens / temperature。虽然都是标准 OpenAI 字段，
      //   但小米控制台的手动提交页写着「系统将逐条校验，校验通过的成员可继续发送」——
      //   既然有校验环节，**照官方模板一字不改**才是最不容易被拒的写法。
      body: {
        model: config.model,
        messages: buildMessages(task, config),
      },
    })
  );

  const form = new FormData();
  form.append("purpose", "batch");
  form.append(
    "file",
    new Blob([lines.join("\n")], { type: "application/jsonl" }),
    "solace-review.jsonl"
  );

  const headers = authHeaders(batchBase, config.apiKey);
  delete headers["Content-Type"]; // multipart 必须让 fetch 自己带 boundary

  const uploadRes = await fetch(endpoint(batchBase, "/files"), {
    method: "POST",
    headers,
    body: form,
    signal: timeoutSignal(CONTROL_TIMEOUT_MS),
  });
  const uploadText = await uploadRes.text();
  if (!uploadRes.ok) {
    throw new Error(`上传审核文件失败（HTTP ${uploadRes.status}）：${uploadText.slice(0, 200)}`);
  }

  let uploaded = null;
  try {
    uploaded = JSON.parse(uploadText);
  } catch {
    uploaded = null;
  }
  const fileId = uploaded?.id || uploaded?.file_id || "";
  if (!fileId) throw new Error("上传成功但没有拿到文件 id，说明接口协议和预期不一致");

  // ② 创建批次
  //
  // ⚠️ completion_window 是个坑，这里做了自动重试：
  //    官方文档说接口「当前固定 24h」，只有控制台建任务才能设 1–14 天。
  //    实测填 168h（7 天）这类值时，服务端直接回 **HTTP 500 internal_error**，
  //    整个提交就挂在"创建批次"这一步（上传文件那步其实是成功的）。
  //
  //    所以策略是：**先用你配的值试，失败且不是 24h 就自动退回 24h 重试一次** ——
  //    功能不该因为一个可选参数挂掉。
  const createBatch = async (windowValue) => {
    const res = await fetch(endpoint(batchBase, "/batches"), {
      method: "POST",
      headers: authHeaders(batchBase, config.apiKey),
      body: JSON.stringify({
        input_file_id: fileId,
        endpoint: "/v1/chat/completions",
        completion_window: windowValue,
        // ⚠️ name 这个字段官方文档里**没写**（文档的 curl 示例只有 3 个字段），
        //    但它实测很重要 —— 线索是从上游返回里看出来的：
        //    控制台建的任务带着 "name":"test"，那就是页面上的「任务描述」。
        //    不带它时上游直接 500 internal_error，带上才通。
        // ⚠️ 名字**按任务类型区分**（审核 / 打标 / 生成）。
      //    调用方（submitPendingTasks）已经按类型把任务分好组了，
      //    所以这里从第一条任务上读就能确定 —— 小米后台的批量列表里
      //    三件事各自成行，一眼能认出哪一行是哪一类。
      name: batchNameOf(String(tasks[0]?.task_kind || "review")),
      }),
      signal: timeoutSignal(CONTROL_TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  };

  const wantedWindow = String(config.completionWindow || "").trim() || "24h";
  let batchResult = await createBatch(wantedWindow);
  let windowNote = "";

  if (!batchResult.ok && wantedWindow !== "24h") {
    console.warn(
      `[review] 用 ${wantedWindow} 创建批次失败（HTTP ${batchResult.status}），自动退回 24h 重试`
    );
    const firstStatus = batchResult.status;
    batchResult = await createBatch("24h");

    windowNote = batchResult.ok
      ? `「最长等待时间」填的 ${wantedWindow} 被上游拒绝（HTTP ${firstStatus}），已自动改用 24h`
      : "";
  }

  if (!batchResult.ok) {
    // ⚠️ 把「我们发了什么」也带上：
    //    上游只回一句 internal_error 的时候，没有这些参数根本没法定位问题
    const imageCount = tasks.filter((task) => Number(task.is_image) === 1).length;
    throw new Error(
      `创建审核批次失败（HTTP ${batchResult.status}）：${batchResult.text.slice(0, 200)}` +
        `｜本次参数：endpoint=/v1/chat/completions、completion_window=${wantedWindow}、` +
        `任务数=${tasks.length}（其中图片 ${imageCount} 条）、文件 ${fileId}`
    );
  }

  const batchText = batchResult.text;

  let created = null;
  try {
    created = JSON.parse(batchText);
  } catch {
    created = null;
  }
  const remoteId = created?.id || created?.batch_id || "";
  if (!remoteId) throw new Error("创建批次成功但没有返回批次 id");

  // ③ 落库：批次记录 + 任务状态
  //
  // expires_at 是上游返回的过期时间（Unix 秒）。存下来是为了能**验证**
  // 「最长等待时间」有没有生效 —— 设了 7 天而上游仍按 24h 算的话，
  // 这个时间会把真相暴露出来（后台批次列表里能看到）。
  const expiresAt = Number(created?.expires_at) || 0;

  const insert = await execute(
    `INSERT INTO content_review_batches
       (remote_id, provider, status, file_id, task_count, expires_at)
     VALUES (?, 'mimo-batch', 'submitted', ?, ?, ?)`,
    [
      remoteId,
      fileId,
      tasks.length,
      expiresAt ? toMysqlDateTime(new Date(expiresAt * 1000)) : null,
    ]
  );

  const ids = tasks.map((task) => task.id);
  await execute(
    `UPDATE content_review_tasks
        SET status = 'submitted', batch_id = ?, provider = 'mimo-batch', submitted_at = ?
      WHERE id IN (${ids.map(() => "?").join(",")})`,
    [remoteId, now(), ...ids]
  );

  await execute(
    "UPDATE content_review_batches SET remote_id = ? WHERE id = ?",
    [remoteId, insert.insertId]
  );

  return {
    batchId: remoteId,
    localBatchId: insert.insertId,
    // 带回去给上层汇总成提示语（"已提交 2 个批次：Solace·内容审核（12 条）、Solace·日记打标（5 条）"）
    name: batchNameOf(String(tasks[0]?.task_kind || "review")),
    taskCount: tasks.length,
    ...(windowNote ? { windowNote } : {}),
  };
}

/** 逐条模式：立刻调用对话接口，拿到结果当场处置 */
async function submitInline({ tasks, config }) {
  const url = endpoint(config.baseUrl, "/chat/completions");
  let passCount = 0;
  let rejectCount = 0;
  let failedCount = 0;

  for (const task of tasks) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: authHeaders(config.baseUrl, config.apiKey),
        body: JSON.stringify({
          model: config.model,
          messages: buildMessages(task, config),
          max_tokens: 200,
          temperature: 0,
        }),
        signal: timeoutSignal(Math.min(Number(config.timeoutSeconds) || 120, 600) * 1000),
      });

      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 150)}`);

      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }

      const reply = data?.choices?.[0]?.message?.content || "";

      // ⚠️ 按任务类型走**不同的解析**：
      //    · 审核     → pass / reject / unknown
      //    · 日记打标 → 从 8 个情绪词里挑一个（白名单）
      //    · 生成日记 → 解析出 { 标签, 标题, 正文 }
      const taskKindValue = String(task.task_kind || "review");
      const isDiaryMood = taskKindValue === "diary_mood";
      const isGenerate = taskKindValue === "diary_generate";

      const parsed = isDiaryMood
        ? {
            verdict: pickMoodFromText(reply),
            reason: `AI 打标：${String(reply).slice(0, 80)}`,
          }
        : isGenerate
          ? {
              verdict: parseDiaryDraft(reply),
              reason: `AI 生成：${String(reply).slice(0, 80)}`,
            }
          : parseVerdict(reply);

      const applied = await applyVerdict({
        taskId: task.id,
        verdict: parsed.verdict,
        reason: parsed.reason,
        provider: "inline",
      });

      if (isDiaryMood) {
        // 打标：就算没挑出词，也会落到后台配的默认标签，所以算成功
        passCount += 1;
        if (!parsed.verdict) {
          console.warn(`[review] 日记打标没挑出情绪词，已用默认标签（任务 #${task.id}）`);
        }
      } else if (isGenerate) {
        // 生成日记：解析失败会返回 ok:false（任务已标成 failed）
        if (applied.ok) passCount += 1;
        else failedCount += 1;
      } else if (parsed.verdict === "reject") rejectCount += 1;
      else if (parsed.verdict === "pass") passCount += 1;
      else failedCount += 1;
    } catch (err) {
      failedCount += 1;
      // 单条失败不中断整批：标记 failed，后台可以人工处理
      try {
        await execute(
          "UPDATE content_review_tasks SET status = 'failed', reason = ?, reviewed_at = ? WHERE id = ?",
          [`审核请求失败：${String(err?.message || err).slice(0, 200)}`, now(), task.id]
        );
      } catch {
        /* 忽略 */
      }
      // 第一条就失败（多半是配置问题）时提前退出，别把剩下的都试一遍
      if (failedCount === 1 && passCount === 0 && rejectCount === 0) {
        const message = String(err?.message || err);
        const insert = await execute(
          `INSERT INTO content_review_batches
             (provider, status, task_count, failed_count, error, completed_at)
           VALUES ('inline', 'failed', ?, ?, ?, ?)`,
          [tasks.length, failedCount, message.slice(0, 500), now()]
        );
        void insert;
        return { ok: false, error: message, passCount, rejectCount, failedCount };
      }
    }
  }

  await execute(
    `INSERT INTO content_review_batches
       (provider, status, task_count, pass_count, reject_count, failed_count, completed_at)
     VALUES ('inline', 'completed', ?, ?, ?, ?, ?)`,
    [tasks.length, passCount, rejectCount, failedCount, now()]
  );

  return { ok: true, passCount, rejectCount, failedCount };
}

/* ------------------------------------------------------------ 轮询结果 */

/**
 * 查一遍进行中的批次。完成的就把结果落库并执行处置。
 * @returns { ok, checked, completed, detail[] }
 */
export async function pollBatches() {
  const config = await getGroup("review");
  if (!config?.baseUrl || !config?.apiKey) {
    return { ok: false, error: "审核 AI 还没配置完整", checked: 0, completed: 0 };
  }

  const batches = await query(
    `SELECT id, remote_id, file_id, task_count
       FROM content_review_batches
      WHERE status = 'submitted' AND remote_id IS NOT NULL
      ORDER BY id ASC
      LIMIT 20`
  );

  // ⚠️ 查批次状态**必须用批量地址**！这是刚踩的坑：
  //    提交时用的是 batchBase（batch-api-cn.xiaomimimo.com），
  //    但这里以前用了 config.baseUrl（对话地址 api.xiaomimimo.com）——
  //    请求打到了对话服务上，永远查不到批次，
  //    表现就是「控制台显示任务 5 分钟就跑完了，后台却一直卡在"进行中"」。
  const batchBase = String(config.batchBaseUrl || "").trim() || config.baseUrl;

  const detail = [];
  let completed = 0;

  for (const batch of batches) {
    try {
      const res = await fetch(endpoint(batchBase, `/batches/${batch.remote_id}`), {
        headers: authHeaders(batchBase, config.apiKey),
        signal: timeoutSignal(CONTROL_TIMEOUT_MS),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 150)}`);

      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }

      const status = String(data?.status || "").toLowerCase();

      if (status === "completed") {
        const outputFileId = data?.output_file_id || "";
        const summary = outputFileId
          ? await applyBatchResults({ batchId: batch.id, outputFileId, config, batchBase })
          : { passCount: 0, rejectCount: 0, failedCount: 0, note: "批次完成但没有结果文件" };
        await execute(
          `UPDATE content_review_batches
              SET status = 'completed', output_file_id = ?, pass_count = ?, reject_count = ?,
                  failed_count = ?, completed_at = ?
            WHERE id = ?`,
          [
            outputFileId,
            summary.passCount,
            summary.rejectCount,
            summary.failedCount,
            now(),
            batch.id,
          ]
        );
        completed += 1;
        detail.push({ batchId: batch.remote_id, status, ...summary });
      } else if (status === "failed" || status === "expired" || status === "cancelled") {
        const message = String(data?.errors?.data?.[0]?.message || data?.error || status).slice(0, 400);
        await execute(
          "UPDATE content_review_batches SET status = 'failed', error = ?, completed_at = ? WHERE id = ?",
          [message, now(), batch.id]
        );
        detail.push({ batchId: batch.remote_id, status, error: message });
      } else {
        // validating / in_progress / finalizing：还在跑，下次再看
        detail.push({ batchId: batch.remote_id, status: status || "unknown" });
      }
    } catch (err) {
      detail.push({ batchId: batch.remote_id, status: "error", error: String(err?.message || err).slice(0, 200) });
    }
  }

  return { ok: true, checked: batches.length, completed, detail };
}

/** 下载结果 JSONL 并逐行应用 */
async function applyBatchResults({ batchId, outputFileId, config, batchBase }) {
  // ⚠️ 下载结果也必须用**批量地址** —— 和查状态是同一个坑：
  //    结果文件存在批量服务那边，拿对话地址去取是取不到的。
  const base =
    String(batchBase || "").trim() || String(config?.batchBaseUrl || "").trim() || config.baseUrl;

  const res = await fetch(endpoint(base, `/files/${outputFileId}/content`), {
    headers: authHeaders(base, config.apiKey),
    signal: timeoutSignal(CONTROL_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`下载审核结果失败（HTTP ${res.status}）：${text.slice(0, 150)}`);

  let passCount = 0;
  let rejectCount = 0;
  let failedCount = 0;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let item = null;
    try {
      item = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const customId = String(item?.custom_id || "");
    const taskId = Number(customId.replace(/^rev-/, ""));
    if (!Number.isInteger(taskId) || taskId <= 0) continue;

    const reply = item?.response?.body?.choices?.[0]?.message?.content || "";
    const statusCode = Number(item?.response?.status_code) || 0;

    // ⚠️ 失败行有两种形态，**必须都认出来**，否则会被当成"模型没说话"而判成合规：
    //    ① 请求级失败（错误文件里的行）：response 是 null，错误在 item.error
    //       {"custom_id":"...","response":null,"error":{"code":"inference_failed","message":"400 Bad Request"}}
    //    ② 调用级失败：response 存在但 status_code >= 400
    const itemError = item?.error || null;

    try {
      if (itemError || !item?.response) {
        failedCount += 1;
        await execute(
          "UPDATE content_review_tasks SET status = 'failed', reason = ?, reviewed_at = ? WHERE id = ?",
          [
            `上游未返回结果：${String(itemError?.message || itemError?.code || "response 为空").slice(
              0,
              180
            )}`,
            now(),
            taskId,
          ]
        );
        continue;
      }

      if (statusCode && statusCode >= 400) {
        failedCount += 1;
        await execute(
          "UPDATE content_review_tasks SET status = 'failed', reason = ?, reviewed_at = ? WHERE id = ?",
          [
            `AI 返回 HTTP ${statusCode}：${String(item?.response?.body?.error?.message || "").slice(
              0,
              180
            )}`,
            now(),
            taskId,
          ]
        );
        continue;
      }

      // ⚠️ 结果行里只有 custom_id（→ 任务 id），看不出这条是"审核"还是"日记打标"，
      //    所以单独查一下类型。每批最多 20 条，这点开销可以接受。
      let taskKind = "review";
      try {
        const kindRow = await query(
          "SELECT task_kind FROM content_review_tasks WHERE id = ? LIMIT 1",
          [taskId]
        );
        taskKind = String(kindRow[0]?.task_kind || "review");
      } catch {
        /* 查不到就按审核处理 */
      }

      const isDiaryMood = taskKind === "diary_mood";
      const isGenerate = taskKind === "diary_generate";

      // ⚠️ 按类型分流（和逐条模式保持一致）：
      //    打标要情绪词、生成要一整篇日记，都不能用审核那套 JSON 解析
      const parsed = isDiaryMood
        ? {
            verdict: pickMoodFromText(reply),
            reason: `AI 打标：${String(reply).slice(0, 80)}`,
          }
        : isGenerate
          ? {
              verdict: parseDiaryDraft(reply),
              reason: `AI 生成：${String(reply).slice(0, 80)}`,
            }
          : parseVerdict(reply);

      const applied = await applyVerdict({
        taskId,
        verdict: parsed.verdict,
        reason: parsed.reason,
        provider: "mimo-batch",
      });
      if (!applied.ok) {
        failedCount += 1;
        continue;
      }

      if (isDiaryMood) {
        passCount += 1;
      } else if (isGenerate) {
        passCount += 1;
      } else if (parsed.verdict === "reject") rejectCount += 1;
      else if (parsed.verdict === "pass") passCount += 1;
      else failedCount += 1;
    } catch (err) {
      failedCount += 1;
      console.error("[review] 应用审核结果失败：", err?.message || err);
    }
  }

  void batchId;
  return { passCount, rejectCount, failedCount };
}

/* ------------------------------------------------------------ 人工判定 */

/**
 * 人工判定（后台点「通过 / 驳回」用）。
 * 主要用于：AI 审核失败的任务、以及关掉 AI 审图后积压的图片。
 */
export async function applyManualVerdict({ taskId, approve, adminName }) {
  try {
    if (!approve) {
      // 驳回 = 走和 AI 判定相同的处置逻辑
      const result = await applyVerdict({
        taskId,
        verdict: "reject",
        reason: `管理员 ${adminName || ""} 人工判定为不合规`.trim(),
        provider: "manual",
      });
      return result;
    }

    const rows = await query(
      "SELECT id, user_id, field FROM content_review_tasks WHERE id = ? LIMIT 1",
      [taskId]
    );
    if (!rows.length) return { ok: false, error: "任务不存在" };

    const meta = FIELD_MAP.get(String(rows[0].field));
    await execute(
      "UPDATE content_review_tasks SET status = 'pass', reason = ?, provider = 'manual', reviewed_at = ? WHERE id = ?",
      [`管理员 ${adminName || ""} 人工通过`.trim(), now(), taskId]
    );
    if (meta) await clearPendingTag(rows[0].user_id, meta.field);
    return { ok: true, verdict: "pass" };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/* ------------------------------------------------------------ 存量补审 */

/** 读出这批用户在审核表里的最新记录，用来判断"这份内容是不是已经审过" */
async function loadLatestMap(users) {
  const map = new Map();
  if (!users.length) return map;

  try {
    const ids = users.map((user) => user.id);
    const rows = await query(
      `SELECT user_id, field, content
         FROM content_review_tasks
        WHERE user_id IN (${ids.map(() => "?").join(",")})
        ORDER BY id DESC`,
      ids
    );
    // 按 id 倒序取的，所以每个 (用户, 字段) 遇到的第一条就是最新的
    for (const row of rows) {
      const key = `${row.user_id}:${row.field}`;
      if (!map.has(key)) map.set(key, String(row.content ?? ""));
    }
  } catch {
    /* 表还不存在时按"没有任何记录"处理，后面入队会自然失败并跳过 */
  }

  return map;
}

/**
 * 扫描存量数据：把「已经有内容、但还没审过」的字段补进审核队列。
 *
 * 为什么需要它：审核是后加的功能，老用户早就填好了昵称、头像 ——
 * 这些内容从来没进过队列，后台的「待提交」永远是 0。
 * 点一次「扫描存量数据」就能把它们补齐。
 *
 * 判定规则：
 *   * 值非空的字段才入队（空的没什么可审）
 *   * 该字段**最新一条审核记录的正文和当前值完全一样** → 这份内容审过了，跳过
 *   * 其余一律入队（含"改过但还没提交过审核"的情况）
 *
 * ⚠️ 一次最多入队 limit 条（默认 100）。内部会自动翻页跳过已审过的用户，
 *    所以不会出现"点一次什么都没干、再点还是同一批"的死循环。
 */
export async function scanExistingContent({ limit = 100 } = {}) {
  const max = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const PAGE = 100;

  let cursor = 0;
  let scannedUsers = 0;
  let scannedFields = 0;
  let queued = 0;
  let skipped = 0;
  const tooLarge = [];
  let reachedEnd = false;

  while (queued < max) {
    const users = await query(
      `SELECT id, username, bio, avatar_url, ai_avatar_url, chat_background_url, diary_background_url
         FROM users
        WHERE status = 1
          AND id > ?
          AND (
            (username IS NOT NULL AND TRIM(username) <> '')
            OR (bio IS NOT NULL AND TRIM(bio) <> '')
            OR (avatar_url IS NOT NULL AND avatar_url <> '')
            OR (ai_avatar_url IS NOT NULL AND ai_avatar_url <> '')
            OR (chat_background_url IS NOT NULL AND chat_background_url <> '')
            OR (diary_background_url IS NOT NULL AND diary_background_url <> '')
          )
        ORDER BY id ASC
        LIMIT ?`,
      [cursor, PAGE]
    );

    if (!users.length) {
      reachedEnd = true;
      break;
    }

    cursor = users[users.length - 1].id;
    scannedUsers += users.length;

    const latest = await loadLatestMap(users);

    for (const user of users) {
      for (const meta of REVIEW_FIELDS) {
        if (queued >= max) break;

        const raw = String(user[meta.column] ?? "");
        if (!raw.trim()) continue;
        scannedFields += 1;

        if (latest.get(`${user.id}:${meta.field}`) === raw) {
          skipped += 1;
          continue;
        }

        const accepted = await enqueueReview({
          userId: user.id,
          field: meta.field,
          content: raw,
        });

        if (accepted) {
          queued += 1;
        } else if (raw.length > (meta.isImage ? MAX_IMAGE_CHARS : MAX_TEXT_CHARS)) {
          // 图片太大（超过 1.4MB）的个例，列出来让管理员知道
          tooLarge.push(`${meta.label}#${user.id}`);
          skipped += 1;
        } else {
          skipped += 1;
        }
      }
      if (queued >= max) break;
    }
  }

  // 还剩多少用户没扫（不是精确值，用来提示"可以再点一次"）
  let remainder = 0;
  try {
    const rest = await query(
      `SELECT COUNT(*) AS n FROM users WHERE status = 1 AND id > ?`,
      [cursor]
    );
    remainder = Number(rest[0]?.n) || 0;
  } catch {
    remainder = 0;
  }

  /* ---- 日记打标：把还没打过标签的日记也排进队列 ---- */
  //
  // 只处理「有正文、且 mood 还是空的」—— 已经打过标签的不用重复打。
  // 用户手动改过正文的，diaries 那边会把 mood 清成 NULL，于是也会被这里捞到。
  let diaryQueued = 0;
  try {
    const diaries = await query(
      `SELECT id, user_id, content
         FROM diaries
        WHERE mood IS NULL
          AND content IS NOT NULL
          AND content <> ''
        ORDER BY id ASC
        LIMIT 50`
    );

    for (const diary of diaries) {
      const accepted = await enqueueReview({
        userId: diary.user_id,
        taskKind: "diary_mood",
        content: String(diary.content),
        targetId: diary.id,
      });
      if (accepted) diaryQueued += 1;
    }
  } catch {
    /* diaries 表不存在之类的，跳过就好 */
  }

  const parts = [`扫描 ${scannedUsers} 个用户`];
  parts.push(`新入队 ${queued} 条`);
  if (diaryQueued) parts.push(`其中日记打标 ${diaryQueued} 条`);
  if (skipped) parts.push(`跳过 ${skipped} 条（内容没变过或为空）`);
  if (tooLarge.length) parts.push(`其中 ${tooLarge.length} 条图片过大未入队`);
  if (remainder && !reachedEnd && queued >= max) {
    parts.push(`还剩约 ${remainder} 个用户，可以再点一次`);
  } else if (reachedEnd || !remainder) {
    parts.push("已经扫到最后一个用户");
  }

  return {
    ok: true,
    scannedUsers,
    scannedFields,
    queued,
    diaryQueued,
    skipped,
    tooLarge: tooLarge.slice(0, 5),
    remainder,
    reachedEnd,
    message: parts.join("，"),
  };
}

/* -------------------------------------------------- AI 生成日记任务 */

/**
 * 为「**昨天**」排一批「生成日记」的任务（每天跑一次）。
 *
 * 为什么不生成今天的：今天还没聊完，生成出来是半截的。
 *
 * 逻辑：
 *   ① 拉出昨天的全部聊天消息（一个查询，按用户分组）
 *   ② 每组：聊得太少的跳过（硬凑出来的日记没意义）
 *   ③ 已经生成过的跳过（24 小时内查一次，防止重复跑）
 *   ④ 拼成一段对话文本 → 排进队列（task_kind = 'diary_generate'）
 *      → 由**批量推理**生成 → 结果写成一篇 source='ai' 的日记
 *
 * ⚠️ 拼聊天记录时**限制条数和总字数**：批量请求的每一行都不宜过大，
 *    而且聊天记录太长反而会让模型抓不住重点。
 */
export async function createDailyDiaryTasks() {
  const config = await getGroup("diary");
  if (!config?.generateEnabled) {
    return { ok: true, created: 0, skipped: true, message: "「AI 自动生成日记」未启用" };
  }

  const minMessages = Math.max(Number(config.minMessages) || 4, 1);
  const maxMessages = Math.min(Math.max(Number(config.maxMessages) || 120, 1), 500);
  const maxChars = Math.min(Math.max(Number(config.maxChars) || 6000, 200), 40000);

  // ① 昨天的消息（每次最多拉 maxMessages × 20 条，避免一次把内存拉爆）
  let rows = [];
  try {
    rows = await query(
      `SELECT user_id, role, content, created_at
         FROM messages
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 1 DAY)
          AND created_at < CURDATE()
          AND content IS NOT NULL
          AND content <> ''
        ORDER BY user_id ASC, id ASC
        LIMIT ?`,
      [maxMessages * 20]
    );
  } catch (err) {
    return { ok: false, created: 0, error: err?.message || String(err) };
  }

  if (!rows.length) {
    return { ok: true, created: 0, message: "昨天没有任何聊天记录" };
  }

  // ② 按用户分组
  const byUser = new Map();
  for (const row of rows) {
    const uid = Number(row.user_id);
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(row);
  }

  let created = 0;
  let tooShort = 0;
  let already = 0;

  for (const [userId, list] of byUser) {
    // 聊得太少就不生成 —— 硬凑一篇出来反而显得敷衍
    if (list.length < minMessages) {
      tooShort += 1;
      continue;
    }

    // ③ 去重：24 小时内已经给这位用户生成过就不再生成
    try {
      const exists = await query(
        `SELECT id FROM diaries
          WHERE user_id = ? AND source = 'ai'
            AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
          LIMIT 1`,
        [userId]
      );
      if (exists.length) {
        already += 1;
        continue;
      }
    } catch {
      /* 查不了就继续；真重复了也只是多一篇，不会出错 */
    }

    // ④ 拼聊天记录：只取最近的 maxMessages 条，每条截 300 字
    const picked = list.slice(-maxMessages);
    let transcript = picked
      .map((item) => `${item.role === "user" ? "我" : "AI"}：${String(item.content).slice(0, 300)}`)
      .join("\n");

    if (transcript.length > maxChars) {
      // 超长就从**后面**截 —— 保留最近的部分，那儿的情绪最完整
      transcript = `（前文略）\n${transcript.slice(-maxChars)}`;
    }

    const accepted = await enqueueReview({
      userId,
      taskKind: "diary_generate",
      content: transcript,
      targetId: null,
    });
    if (accepted) created += 1;
  }

  const parts = [`为 ${byUser.size} 位有聊天记录的用户检查`];
  if (created) parts.push(`新排入 ${created} 篇待生成`);
  if (tooShort) parts.push(`跳过 ${tooShort} 位（昨天聊得太少）`);
  if (already) parts.push(`跳过 ${already} 位（24 小时内已生成过）`);

  return { ok: true, created, tooShort, already, message: parts.join("，") };
}
