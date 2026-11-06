/**
 * 长期记忆 · 状态变更（旧记忆失效）
 *
 * 目标：**真实发生的本人状态变更 100% 命中；假设句 / 转述他人绝不误伤。**
 *
 * 判定顺序（从硬到软）：
 *   1. 转述他人 → 拦截（"我朋友今天辞职了"）；
 *   2. 假设 / 未发生 → 拦截（"如果我辞职…"、"我还没辞职呢"）；
 *   3. **强触发**：第一人称 + 核心动词 + 完成态（了/过）→ 无条件失效；
 *   4. 以上都不确定，但句子里出现了核心词 → 调一次极轻量模型做 Y/N 兜底
 *      （"我可能要辞职"这类拿不准的语境）。
 *
 * ⚠️ 不用"排除词"短路整条规则：那样只要句子里带了"朋友/同事"就全跳过，
 *    会把"我辞职了，同事都知道"这种真实事件漏掉。排除只在**旧记忆内容**上做
 *    （例如"换工作"不去动含"住/城市/小区"的居住记忆），不影响对用户句子的识别。
 */

const ACTIONS = [
  {
    id: "breakup",
    label: "分手或离婚",
    verbs: ["分手", "离婚"],
    pattern: /我[^，。！？]{0,10}(?:分手|离婚)(?:了|过)/,
    categories: ["relation"],
    keywords: ["女朋友", "男朋友", "对象", "伴侣", "老婆", "老公", "爱人", "恋爱", "恋人"],
    // 仅在"旧记忆内容"上排除：别人的感情经历不要被本人分手连带
    excludeKeywords: ["的朋友", "的同事", "的室友", "的同学"],
  },
  {
    id: "job",
    label: "辞职 / 离职 / 换工作 / 被裁",
    verbs: [
      "辞职",
      "离职",
      "换工作",
      "跳槽",
      "被裁",
      "失业",
      "转岗",
      "入职",
      "换了新工作",
      "换了份工作",
      "换了工作",
      "换新工作",
    ],
    // 两句式：① 动词直接跟"了/过"；② "换了（一/份）（新）工作"这种夹了宾语的写法
    pattern:
      /我[^，。！？]{0,10}(?:辞职|离职|换工作|跳槽|被裁|失业|转岗|入职)(?:了|过)|我[^，。！？]{0,10}(?:换|跳)了(?:一?份)?(?:新)?(?:工作|公司)/,
    categories: ["event", "self"],
    keywords: ["工作", "公司", "上班", "职位", "岗位", "单位", "老板"],
    // 居住类旧记忆常带"公司附近"，不能被"换工作"带走
    excludeKeywords: ["住", "城市", "小区", "租房", "搬家", "家附近"],
  },
  {
    id: "move",
    label: "搬家 / 换城市",
    verbs: ["搬家", "搬走", "搬去", "搬到", "换城市"],
    pattern: /我[^，。！？]{0,10}(?:搬家|搬走|搬去|搬到|换(?:了)?(?:一?个)?城市)(?:了|过)/,
    categories: ["event", "self"],
    keywords: ["住", "城市", "小区", "租房", "家附近"],
    excludeKeywords: [],
  },
  {
    id: "pet",
    label: "不再养宠物 / 把宠物送走",
    verbs: ["不养", "不再养", "送人", "送走"],
    pattern:
      /我[^，。！？]{0,10}(?:不养|不再养)[^，。！？]{0,6}了|我[^，。！？]{0,10}(?:送人|送走)[^，。！？]{0,6}了?/,
    categories: ["relation"],
    keywords: ["养", "猫", "狗", "宠物"],
    excludeKeywords: [],
  },
  {
    id: "quit",
    label: "戒烟 / 戒酒",
    verbs: ["戒烟", "戒酒", "不抽烟", "不喝酒"],
    pattern:
      /我[^，。！？]{0,10}(?:戒烟|戒酒)[^，。！？]{0,6}了|我[^，。！？]{0,10}不(?:抽|喝)(?:烟|酒)了/,
    categories: ["preference", "event"],
    keywords: ["烟", "酒"],
    excludeKeywords: [],
  },
  {
    id: "school",
    label: "毕业 / 退学 / 休学",
    verbs: ["毕业", "退学", "休学"],
    pattern: /我[^，。！？]{0,10}(?:毕业|退学|休学)(?:了|过)/,
    categories: ["event", "self"],
    keywords: ["学校", "大学", "高中", "读研", "上学", "专业"],
    excludeKeywords: [],
  },
];

/** 转述他人：别人做主语（注意"我和女朋友分手了"不会被这条拦住） */
const OTHER_SUBJECT_RE =
  /我(?![和跟])(?:的)?(?:朋友|同事|同学|室友|妈|爸|姐|妹|哥|弟|老师|领导|对象|男朋友|女朋友|他|她|别人)[^，。！？]{0,8}?(?:辞职|离职|换工作|跳槽|被裁|失业|转岗|入职|搬家|搬走|搬去|搬到|分手|离婚|不养|戒烟|戒酒|毕业|退学|休学)/;

/** 整句级假设：出现这些词，整条消息都不算既成事实 */
const HYPOTHETICAL_RE = /如果|假如|要是|万一|若是|若我|幻想|做梦|就好了|该多好|多好啊/;

/** 动词前的否定 / 意图词（只看核心词前面 8 个字，避免"我辞职了，不想干了"被误拦） */
const PENDING_MARKERS = ["想", "打算", "准备", "考虑", "要不要", "是否", "没", "没有", "还没", "不"];

/** 取核心词第一次出现之前的一小段（用于判断否定/意图） */
function beforeVerb(text, verb) {
  const idx = text.indexOf(verb);
  if (idx < 0) return null;
  return text.slice(Math.max(0, idx - 8), idx);
}

/** 这条消息是不是在转述别人 */
export function isOtherPerson(text) {
  return OTHER_SUBJECT_RE.test(String(text || ""));
}

/** 这条消息是不是纯假设 */
export function isHypothetical(text) {
  return HYPOTHETICAL_RE.test(String(text || ""));
}

/** 该动作在这句话里是否被"假设 / 未发生"挡住 */
function isPending(text, action) {
  for (const verb of action.verbs) {
    const before = beforeVerb(text, verb);
    if (before && PENDING_MARKERS.some((marker) => before.includes(marker))) return true;
  }
  return false;
}

/**
 * 同步规则判定：只返回**确定命中**的动作（不做模型兜底）。
 * 导出便于测试。
 */
export function detectConflictRules(text) {
  const source = String(text || "").trim();
  if (!source) return [];

  // 1) 转述他人：整条都按"不是用户本人的事"处理
  if (isOtherPerson(source)) return [];

  const matched = [];
  for (const action of ACTIONS) {
    // 2) 整句假设 / 该动作前有否定、意图词 → 跳过这个动作
    if (isHypothetical(source)) continue;
    if (isPending(source, action)) continue;
    // 3) 强触发：第一人称 + 核心动词 + 了/过
    if (action.pattern.test(source)) matched.push(action);
  }
  return matched;
}

/** 这句话里出现了哪些核心动作词（用于决定要不要走模型兜底） */
function mentionedActions(text) {
  return ACTIONS.filter((action) => action.verbs.some((verb) => text.includes(verb)));
}

/**
 * 轻量模型兜底：只在"含核心词但正则拿不准"时调一次。
 * 超时 4 秒；失败/超时一律当作"没发生"（宁可漏判，不误杀）。
 */
async function askModelHappened(text, action) {
  try {
    const { requestChat } = await import("./ai.js");
    const request = requestChat({
      messages: [
        { role: "system", content: "只回答 Y 或 N，不要解释。" },
        {
          role: "user",
          content: `用户说：${text}\n请判断用户是否已经真实发生了「${action.label}」行为？回答 Y 或 N。`,
        },
      ],
      maxTokens: 8,
    });
    const result = await Promise.race([
      request,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: "timeout" }), 4000)),
    ]);
    if (!result?.ok) return false;
    return /^\s*Y\b/i.test(String(result.reply || ""));
  } catch {
    return false;
  }
}

/**
 * 异步判定：规则确定命中就直接用；否则对"提到核心词但没匹配上"的动作
 * 调一次轻量模型（例如"我可能要辞职"）。
 */
export async function resolveConflictRules(text) {
  const source = String(text || "").trim();
  const deterministic = detectConflictRules(source);
  if (deterministic.length) return deterministic;
  if (!source || isOtherPerson(source) || isHypothetical(source)) return [];

  const candidates = mentionedActions(source).filter((action) => !isPending(source, action));
  const result = [];
  for (const action of candidates) {
    if (await askModelHappened(source, action)) result.push(action);
  }
  return result;
}

/**
 * 把与新状态冲突的旧记忆标记为失效。
 *
 * @param {number} userId
 * @param {number} newId 刚写入的新记忆 id（不能把自己标失效）
 * @param {string} text 新记忆原文
 * @returns {Promise<number>} 被标记的旧记忆条数
 */
export async function supersedeConflicts(userId, newId, text) {
  const matched = await resolveConflictRules(text);
  if (!matched.length) return 0;

  // 延迟 import：避免 memory-store ↔ 本文件在模块初始化期互相拉依赖
  const { execute } = await import("./db.js");

  let total = 0;
  for (const rule of matched) {
    const catPlaceholders = rule.categories.map(() => "?").join(", ");
    const keywordClause = rule.keywords.map(() => "content LIKE ?").join(" OR ");

    // 排除词只作用在"旧记忆内容"上（不影响对用户这句话的判定）
    const excluded = Array.isArray(rule.excludeKeywords) ? rule.excludeKeywords : [];
    const excludeClause = excluded.length
      ? ` AND NOT (${excluded.map(() => "content LIKE ?").join(" OR ")})`
      : "";

    try {
      const result = await execute(
        `UPDATE user_memories
            SET superseded_at = NOW()
          WHERE user_id = ?
            AND id <> ?
            AND superseded_at IS NULL
            AND (category IS NULL OR category IN (${catPlaceholders}))
            AND (${keywordClause})${excludeClause}`,
        [
          userId,
          newId,
          ...rule.categories,
          ...rule.keywords.map((word) => `%${word}%`),
          ...excluded.map((word) => `%${word}%`),
        ]
      );
      total += Number(result?.affectedRows || 0);
    } catch {
      /* 单条规则失败不影响其它规则，也不影响新记忆写入 */
    }
  }
  return total;
}
