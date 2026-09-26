/**
 * 内容安全 —— **三层判定**，在把用户消息发给 AI 之前过一遍。
 *
 * ```
 * 用户消息
 *    ↓
 * ① 危机（自伤倾向）—— 走正则，因为必须看上下文
 *      ├─ 紧迫危机（有「今晚」「已经买了」这类计划性表达）→ **截断**，给干预话术 + 热线
 *      └─ 非紧迫风险表达 → **安全模式**（正常调 AI + 附加安全指令）
 *    ↓
 * ② 安全词（伤害他人 / 违法行为）→ **安全模式**
 *    ↓
 * ③ 都没命中 → 正常回复
 * ```
 *
 * ⚠️ 设计原则（改动前务必读，别把它改成"审核机器人"）：
 *   1. **只拦真正危险的** —— 不拦负面情绪、不拦脏话、不拦"我想消失一会儿"。
 *      情绪陪伴产品的用户本来就会说很丧的话，拦掉等于把人推开。
 *   2. **能承接就不截断** —— 这是这次改造的重点：
 *      命中自伤表达时，与其甩一句固定话术，不如**让 AI 接着聊**，
 *      在 system prompt 里要求它先共情、再温和引导专业帮助。
 *      固定话术是"关门"，安全模式是"扶着"。
 *   3. **只有"已经在做计划"才截断** —— 紧迫危机（今晚 / 已经买了 / 写了遗书）
 *      说明用户不只是想过，而是有打算了。这时不该让 AI 自由发挥。
 *   4. **输出侧还有一道兜底** —— AI 回复里没提到热线就自动补一句，
 *      免得"引导专业帮助"这条要求被模型忽略。
 *   5. **不留原文** —— 命中只记录"类别 + 规则名"（`safety_flags` 表）。
 *
 * 词表在后台统一管理（`lib/lexicon-store.js`），改完保存立即生效。
 */
import { getGroup } from "./settings.js";
import { matchCrisis, matchSafety } from "./lexicon-store.js";

/** 心理咨询/援助热线 —— 输出侧兜底和话术里都用它，改的时候只改这一处 */
export const HOTLINE = "400-161-9995";

/**
 * 内置规则 —— **出厂兜底**。
 *
 * ⚠️ 自伤那一组只保留"lexicon 词表覆盖不到"的几类表达：
 *    词表（`keyword_groups`）里已经是完整的一套，这里是双保险。
 *    多一层不会误伤（正则都带上下文），少一层可能漏。
 */
const BUILTIN_RULES = [
  {
    category: "self_harm",
    name: "自伤/自杀倾向",
    patterns: [
      /(想|要|准备|打算|决定).{0,6}(自杀|自残|轻生|结束生命|了结自己|离开这个世界)/,
      // ⚠️ **这里刻意没有「我想死」** —— 它在词表里由「想 + 死」这一对覆盖，
      //    而词表那条路有 `DEATH_COMPOUND` 排除表（挡「想死磕」这类构词）。
      //    内置正则**没有**那套排除，放进来就会把「我想死磕这个课题」判成危机 ——
      //    用户实际报过这个误报（后台"试一句"用词表判定说不命中，聊天里却进了安全模式，
      //    两边结果不一致，就是这个原因）。
      /(不想活|活不下去|不想活了|活着没意思|不如死了|死了算了)/,
      /(伤害|结束).{0,4}(自己|我自己)/,
      /(割腕|跳楼|上吊|吞药).{0,8}(方法|怎么|如何|可以)/,
    ],
  },
  {
    category: "harmOthers",
    name: "伤害他人",
    patterns: [
      /(想|要|准备|打算).{0,6}(杀|弄死|捅死|砍死|打死).{0,4}(他|她|它|你|人)/,
      /(报复社会|同归于尽|拉人一起死)/,
    ],
  },
  {
    category: "illegal",
    name: "明显违法行为",
    patterns: [
      /(制毒|贩毒|买毒|吸毒|冰毒|海洛因|摇头丸)/,
      /(制造|购买|改装).{0,4}(枪|枪支|爆炸物|炸弹)/,
    ],
  },
];

/** 只有**紧迫危机**才用的话术（非紧迫走安全模式，不截断） */
const REPLY_TEMPLATES = {
  self_harm: [
    "我在这儿。",
    "你说的这些，我认真听到了。",
    `不用一个人扛着 —— 请现在打 ${HOTLINE}，那边的人会接住你；也可以直接拨 110 / 120。`,
    "你不需要一个人扛着，这也不是你的错。",
  ].join("\n"),
};

export const SAFETY_CATEGORIES = [
  { category: "self_harm", name: "自伤/自杀倾向", field: "extraSelfHarm" },
  { category: "harmOthers", name: "伤害他人", field: "extraViolence" },
  { category: "illegal", name: "明显违法行为", field: "extraIllegal" },
];

/** 把后台填的多行文本切成词数组（忽略空行和以 # 开头的注释行） */
function parseWords(text, max = 500) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .slice(0, max);
}

/**
 * 安全模式下追加给模型的指令。
 *
 * ⚠️ 最后一句「不要直接给热线，要先回应用户说的具体内容」是**必须的** ——
 *    不然模型很容易把热线当成万能回复甩出来，那和固定话术没区别，
 *    用户会立刻感觉到"它没在听我说话"。
 */
export const SAFE_MODE_INSTRUCTION = [
  "用户当前表达涉及自伤/伤人/违法风险。",
  "请先共情、承接情绪，不要评判，不要跳过用户说的内容。",
  `在回复末尾温和引导专业帮助，并附上心理援助热线 ${HOTLINE}。`,
  "不要直接给热线，要先回应用户说的具体内容。",
].join("\n");

/** 安全模式判定结果里附带的风险摘要（给 chat 接口拼指令用） */
export function describeSafeMode(result) {
  if (!result?.safeMode) return "";
  return `本次命中：${result.name || result.category || "风险表达"}`;
}

/**
 * 输出侧兜底：AI 回复里没提到热线就补一句。
 *
 * ⚠️ 为什么要兜底：`SAFE_MODE_INSTRUCTION` 只是"要求"，模型**可能不照做**
 *    （尤其回复很短的时候）。风险场景下不该赌模型的自觉。
 *
 * ⚠️ 判断只看有没有出现号码本身，不看措辞 —— 措辞千变万化，号码才是硬指标。
 */
export function ensureHotline(reply) {
  const text = String(reply || "");
  if (!text.trim()) return text;

  // 号码写成 4001619995 / 400-161-9995 都算提到
  if (text.includes("4001619995") || text.includes("400-161-9995")) return text;

  return `${text}\n\n如果这些情绪一直在，别一个人扛着 —— 可以打心理援助热线 ${HOTLINE}，那边 24 小时有人。`;
}

/**
 * 检查一段用户输入。
 *
 * @returns {Promise<
 *   | { blocked: false, safeMode: false }
 *   | { blocked: true, safeMode: false, category: string, name: string, reply: string }
 *   | { blocked: false, safeMode: true, category: string, name: string, reply: "" }
 * >}
 */
export async function checkUserContent(text) {
  const content = String(text || "").trim();
  if (!content) return { blocked: false, safeMode: false };

  const config = await getGroup("safety").catch(() => null);
  if (config?.enabled === false) return { blocked: false, safeMode: false };

  // 长度保护：超长内容不参与匹配，避免正则性能问题
  const sample = content.slice(0, 2000);

  /* ---------------- ① 危机（自伤倾向）—— 优先级最高 ---------------- */

  const crisis = matchCrisis(sample);
  const builtinSelfHarm = BUILTIN_RULES[0].patterns.some((pattern) => pattern.test(sample));

  if (crisis.hit || builtinSelfHarm) {
    if (crisis.urgent) {
      // 紧迫（有计划 / 时间 / 已做准备）→ 截断，不让 AI 自由发挥
      return {
        blocked: true,
        safeMode: false,
        category: "self_harm",
        name: "自伤/自杀倾向（紧迫）",
        reply: REPLY_TEMPLATES.self_harm,
      };
    }

    // 非紧迫 → 安全模式：正常调 AI，但附上安全指令
    //
    // ⚠️ `confidence` 一起带出去：`suspect` 的（前缀+后缀组合出来的，比如"想"+"死"）
    //    会额外给对话 AI 一次"翻案"的机会 —— 它可以在回复里带 `[RISK:no]` 声明这是日常用法。
    //    内置正则的命中一律算 `high`（那几条都自带上下文，误报率极低）。
    return {
      blocked: false,
      safeMode: true,
      category: "self_harm",
      name: "自伤/自杀倾向",
      reply: "",
      confidence: crisis.hit ? crisis.confidence || "high" : "high",
      matched: crisis.matched || "",
    };
  }

  /* ---------------- ② 安全词（伤人 / 违法）→ 安全模式 ---------------- */

  const safety = matchSafety(sample);
  if (safety.hit) {
    return {
      blocked: false,
      safeMode: true,
      category: safety.groupId,
      name: safety.label,
      reply: "",
    };
  }

  // 内置正则兜底（跳过自伤那组，上面已经查过）
  for (const rule of BUILTIN_RULES) {
    if (rule.category === "self_harm") continue;
    if (rule.patterns.some((pattern) => pattern.test(sample))) {
      return { blocked: false, safeMode: true, category: rule.category, name: rule.name, reply: "" };
    }
  }

  // 兼容老的「自定义追加词」（后台 safety 分组里的三张文本框）
  // ⚠️ 保留这段是有意的：老部署里管理员可能加过词，
  //    那些词已经迁进 keyword_groups 了，但库里可能还有存量，多查一遍成本极低。
  for (const meta of SAFETY_CATEGORIES) {
    const words = parseWords(config?.[meta.field]);
    if (!words.length) continue;
    if (words.some((word) => sample.includes(word))) {
      return { blocked: false, safeMode: true, category: meta.category, name: meta.name, reply: "" };
    }
  }

  return { blocked: false, safeMode: false };
}
