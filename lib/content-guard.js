/**
 * 内容安全过滤：在把用户消息发给 AI 之前过一遍。
 *
 * ⚠️ 设计原则（改动前务必读，别把它改成"审核机器人"）：
 *   1. **只拦真正危险的类别** —— 自伤倾向、伤害他人、明显违法。
 *      不拦负面情绪、不拦脏话、不拦"我想消失一会儿"这种表达。
 *      情绪陪伴产品的用户本来就会说很丧的话，拦掉等于把人推开。
 *   2. **拦下之后不是拒答** —— 给一句温和的承接 + 求助信息。
 *      一个说"我不想活了"的人，需要的是被接住，不是一句"内容违规"。
 *   3. **不留原文** —— 命中只记录"类别 + 规则名"（`safety_flags` 表），
 *      绝不把用户原话存进日志或数据库，既保护隐私也避免二次伤害。
 *   4. **宁少勿多** —— 规则写太宽会把正常倾诉也拦掉（比如"累死了"），
 *      那比漏判更伤体验。命中后仍允许用户换个说法继续说。
 *
 * 词表可在后台「内容安全」页面热更新，改完保存立即生效，不用重新部署。
 */
import { getGroup } from "./settings";

/** 内置规则：出厂即有的兜底，后台只需要补充自己关心的词 */
const BUILTIN_RULES = [
  {
    category: "self_harm",
    name: "自伤/自杀倾向",
    patterns: [
      /(想|要|准备|打算|决定).{0,6}(自杀|自残|轻生|结束生命|了结自己|离开这个世界)/,
      /(不想活|活不下去|不想活了|活着没意思|不如死了|死了算了|我想死)/,
      /(伤害|结束).{0,4}(自己|我自己)/,
      /(割腕|跳楼|上吊|吞药).{0,8}(方法|怎么|如何|可以)/,
    ],
  },
  {
    category: "violence",
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

/** 命中后的承接话术（按类别） */
const REPLY_TEMPLATES = {
  self_harm: [
    "我在这儿。",
    "你说的这些，我认真听到了。",
    "不用一个人扛着 —— 如果你愿意，随时可以打 400-161-9995，那边的人会接住你。",
    "现在，先陪我待一会儿好吗？",
  ].join("\n"),
  violence: [
    "我听到你现在很愤怒，也很痛。",
    "但你刚才说的那件事，我不能陪你往下走。",
    "如果这股劲真的压不住，先离开现场、找个能说话的人 —— 也可以打 400-161-9995。",
  ].join("\n"),
  illegal: [
    "这件事我没法陪你聊下去。",
    "如果你正被它困住，找专业的人帮忙会比一个人扛好得多。",
    "要是想聊点别的，我一直在这儿。",
  ].join("\n"),
};

export const SAFETY_CATEGORIES = [
  { category: "self_harm", name: "自伤/自杀倾向", field: "extraSelfHarm" },
  { category: "violence", name: "伤害他人", field: "extraViolence" },
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

/** 转义正则元字符：后台填的词按"字面包含"匹配，不当正则用 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 读取当前生效的规则（内置 + 后台自定义）。
 * 设置读不到时只用内置规则，保证过滤能力始终在线。
 */
async function loadRules() {
  let config = null;
  try {
    config = await getGroup("safety");
  } catch {
    config = null;
  }

  const enabled = config?.enabled !== false; // 默认开启
  const rules = BUILTIN_RULES.map((rule) => ({ ...rule, patterns: [...rule.patterns] }));

  if (enabled && config) {
    for (const meta of SAFETY_CATEGORIES) {
      const words = parseWords(config[meta.field]);
      if (!words.length) continue;
      const target = rules.find((rule) => rule.category === meta.category);
      if (!target) continue;
      // 后台词按"包含即命中"处理，转义后再拼成正则
      for (const word of words) {
        target.patterns.push(new RegExp(escapeRegExp(word), "i"));
      }
    }
  }

  return { enabled, rules };
}

/**
 * 检查一段用户输入。
 *
 * @returns {Promise<{ blocked: false } | { blocked: true, category: string, name: string, reply: string }>}
 *   命中时返回预设的承接话术；调用方应直接把 reply 返回给用户，不再调用 AI。
 */
export async function checkUserContent(text) {
  const content = String(text || "").trim();
  if (!content) return { blocked: false };

  const { enabled, rules } = await loadRules();
  if (!enabled) return { blocked: false };

  // 只看最后一条用户消息，并做长度保护（超长内容不参与匹配，避免正则性能问题）
  const sample = content.slice(0, 2000);

  for (const rule of rules) {
    if (rule.patterns.some((pattern) => pattern.test(sample))) {
      return {
        blocked: true,
        category: rule.category,
        name: rule.name,
        reply: REPLY_TEMPLATES[rule.category] || REPLY_TEMPLATES.self_harm,
      };
    }
  }

  return { blocked: false };
}
