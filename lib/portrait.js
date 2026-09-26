/**
 * 用户心理画像 —— **纯本地规则引擎，不调用任何 AI**。
 *
 * 设计目标（也是刻意这么做的理由）：
 *   * **可复现** —— 同样的输入永远得到同样的画像，不受模型波动影响；
 *   * **可解释** —— 每个标签都能追溯到"哪一个分数、用了哪条规则"，
 *     后台会把原始分数和标签一起展示，不让人只看标签猜依据；
 *   * **可版本迭代** —— 算法改了就把 `PORTRAIT_VERSION` 往上加，
 *     老用户不会被动重算（等下次触发条件满足时再按新规则算），
 *     这样"这个标签是哪版算法给的"始终说得清。
 *
 * 数据来源：PSS-10（0-40）、GAD-7（0-21）、PHQ-9（0-27）、
 *          自研压力值（0-100，**只读**）、MBTI（4 字母）。
 *
 * ⚠️ 这个模块**只管算和翻译**，不读写数据库、不碰网络。
 *    存哪里、什么时候触发重算是调用方的事。
 */

/** 画像算法版本。改了判定规则或阈值就往上加一位。 */
export const PORTRAIT_VERSION = "v1";

/**
 * 维度的取值范围，**同时也是指令的拼接顺序**
 * （`buildStyleDirectives` 按这个数组的顺序产出，调用方直接拼就行）。
 *
 * ⚠️ **「年龄段」排在最前是有意的**：它的优先级最高 ——
 *    未成年人的指令要能盖过其他维度里可能过于成人化的表达
 *    （自伤/抑郁这类敏感话题下必须引导他向现实中的成年人求助，
 *     见 `docs/PORTRAIT.md` 的「安全边界」）。
 *
 * ⚠️ 加了新维度时**不要改这个数组的顺序** ——
 *    顺序就是优先级，调了会改变所有用户收到的指令先后。
 */
export const PORTRAIT_KEYS = ["年龄段", "压力水平", "情绪风险", "人格倾向", "沟通偏好"];

/* ------------------------------------------------------------ 维度零：年龄段 */

/**
 * 年龄段 —— 从**生日**推算的年龄映射过来。
 *
 * ⚠️ **这是优先级最高的维度**：它排在 `PORTRAIT_KEYS` 最前，指令也最先拼进去。
 *    原因见 `docs/PORTRAIT.md` 的「安全边界」—— 未成年人的表达边界和成年人不一样，
 *    这条指令要能盖住其他维度提出的风格要求。
 *
 * ⚠️ 异常值（<10 岁 / >100 岁）**照样给标签，但标 `needsReview`** ——
 *    与其留空（那这类用户就完全拿不到年龄指令了），不如按最近的档处理、
 *    同时让后台看一眼生日是不是填错了。
 *
 * ⚠️ 画像里**只存年龄段，不存具体年龄值** —— 年龄本身已经在 `users.birthday` 里了，
 *    这里只留下"需要什么说话方式"这个结论。
 *
 * @param {number|null} age
 * @returns {{level: string, basis: string, needsReview: boolean}}
 */
export function judgeAgeGroup(age) {
  const value = Number(age);

  if (!Number.isFinite(value) || value < 0) {
    return { level: "", basis: "未填生日，跳过年龄段", needsReview: false };
  }

  const needsReview = value < 10 || value > 100;

  const level =
    value < 18
      ? "青少年"
      : value <= 25
        ? "青年"
        : value <= 40
          ? "成年"
          : value <= 60
            ? "中年"
            : "老年";

  return {
    level,
    basis: needsReview
      ? `生日推算 ${value} 岁（数值异常，已按「${level}」处理，建议核实生日）`
      : `生日推算 ${value} 岁`,
    needsReview,
  };
}

/* ------------------------------------------------------------ 维度一：压力水平 */

/**
 * 压力水平：PSS-10 与自研压力值加权综合。
 *
 * ⚠️ 权重 0.6 / 0.4 是有意的：**量表更可信**（它是标准工具、用户认真填的），
 *    聊天压力值是连续采样、反应快但噪声大。让量表主导、压力值做修正。
 *
 * ⚠️ 缺 PSS 时**只用聊天压力值**（新用户还没做测评，也得给个判断），
 *    这不算"降级"，是方案里写明的回退分支。
 *
 * @param {{pssScore?: number|null, chatStress?: number|null}} input
 * @returns {{level: string, basis: string, combined: number|null}}
 */
export function judgeStressLevel({ pssScore, chatStress } = {}) {
  const pss = Number(pssScore);
  const stress = Number(chatStress);

  const hasPss = Number.isFinite(pss);
  // ⚠️ 聊天压力值的默认是 50（中性）—— 从没聊过天的用户也给中性值，
  //    否则"没数据"会被误判成"压力很低"
  const hasStress = Number.isFinite(stress);

  if (!hasPss && !hasStress) {
    return { level: "中", basis: "暂无数据（PSS 未测、也没有聊天压力值）", combined: null };
  }

  let combined;
  let basis;

  if (hasPss && hasStress) {
    combined = (pss / 40) * 0.6 + (stress / 100) * 0.4;
    basis = `PSS ${pss}/40（权重 0.6） + 聊天压力值 ${stress}/100（权重 0.4）`;
  } else if (hasPss) {
    combined = pss / 40;
    basis = `PSS ${pss}/40（没有聊天压力值，只用量表）`;
  } else {
    combined = stress / 100;
    basis = `聊天压力值 ${stress}/100（PSS 未测，只用压力值）`;
  }

  // ⚠️ 阈值依据：PSS-10 常以总分 ≥20 作为"高压力"分界（约 50% 分位以上）。
  //    归一化后 20/40 = 0.5，这里的高压线定在 0.65 是**再往上抬了一档** ——
  //    因为"高压力"会换来更克制的回复风格，宁可少标、不要错标。
  const level = combined < 0.35 ? "低" : combined < 0.65 ? "中" : "高";

  return { level, basis, combined: Math.round(combined * 100) / 100 };
}

/* ------------------------------------------------------------ 维度二：情绪风险 */

/**
 * 情绪风险：GAD-7 与 PHQ-9 等权综合。
 *
 * ⚠️ **PHQ-9 第 9 题（自伤念头）单独处理**：
 *    只要有分，情绪风险**直接判"高"**，并在画像里带一个 `needsAttention` 标记。
 *    这一条不看总分、不做加权 —— 自伤念头的存在本身就是需要关注的信号，
 *    被平均分稀释掉是不可接受的。
 *
 * @param {{gadScore?: number|null, phqScore?: number|null, phq9SelfHarm?: number|null}} input
 * @returns {{level: string, basis: string, combined: number|null, needsAttention: boolean}}
 */
export function judgeEmotionRisk({ gadScore, phqScore, phq9SelfHarm } = {}) {
  // ① 自伤念头优先，直接返回
  const selfHarm = Number(phq9SelfHarm);
  if (Number.isFinite(selfHarm) && selfHarm > 0) {
    return {
      level: "高",
      basis: `PHQ-9 第 9 题有分（${selfHarm} 分）—— 直接判高，并在后台标记需关注`,
      combined: null,
      needsAttention: true,
    };
  }

  const gad = Number(gadScore);
  const phq = Number(phqScore);

  const hasGad = Number.isFinite(gad);
  const hasPhq = Number.isFinite(phq);

  if (!hasGad && !hasPhq) {
    return { level: "低", basis: "暂无数据（GAD-7 和 PHQ-9 都没测）", combined: null, needsAttention: false };
  }

  let combined;
  let basis;

  if (hasGad && hasPhq) {
    combined = (gad / 21) * 0.5 + (phq / 27) * 0.5;
    basis = `GAD-7 ${gad}/21 + PHQ-9 ${phq}/27（等权）`;
  } else if (hasGad) {
    combined = gad / 21;
    basis = `GAD-7 ${gad}/21（PHQ-9 未测）`;
  } else {
    combined = phq / 27;
    basis = `PHQ-9 ${phq}/27（GAD-7 未测）`;
  }

  // ⚠️ 阈值对应关系（写下来方便以后核对）：
  //    低：GAD ≈ 4 分以内 / PHQ ≈ 5 分以内
  //    中：GAD ≈ 9 分 / PHQ ≈ 12 分
  //    GAD-7 中文版推荐分界是 6 分、PHQ-9 轻度起点是 5 分 —— 所以"低"的上界
  //    卡得很紧，宁可早一点进入"中"。
  const level = combined < 0.2 ? "低" : combined < 0.45 ? "中" : "高";

  return { level, basis, combined: Math.round(combined * 100) / 100, needsAttention: false };
}

/* ------------------------------------------------- 维度三 / 四：人格与沟通偏好 */

/** 从 4 字母类型里取某一位（大小写都认；取不到返回 ""） */
function letterAt(mbtiType, index) {
  const type = String(mbtiType || "").trim().toUpperCase();
  return /^[A-Z]{4}$/.test(type) ? type[index] : "";
}

/**
 * 人格倾向：看 MBTI 的 E / I 这一位。
 *
 * ⚠️ 只取这一位，**不做任何"综合评估"** —— 画像要可解释，
 *    "因为你是 INTJ 所以内向"这句话用户和运营都看得懂，
 *    而"综合多个维度得出你偏内向"没人能验证。
 *
 * @returns {{level: string, basis: string}} level 为 "内向" / "外向" / ""（无数据）
 */
export function judgePersonality(mbtiType) {
  const letter = letterAt(mbtiType, 0);

  if (letter === "I") return { level: "内向", basis: `MBTI ${String(mbtiType).toUpperCase()} 的第 1 位是 I` };
  if (letter === "E") return { level: "外向", basis: `MBTI ${String(mbtiType).toUpperCase()} 的第 1 位是 E` };

  return { level: "", basis: "MBTI 未测" };
}

/**
 * 沟通偏好：看 MBTI 的 T / F 这一位。
 *
 * @returns {{level: string, basis: string}} level 为 "直接" / "温和" / ""（无数据）
 */
export function judgeCommunication(mbtiType) {
  const letter = letterAt(mbtiType, 2);

  if (letter === "T") return { level: "直接", basis: `MBTI ${String(mbtiType).toUpperCase()} 的第 3 位是 T` };
  if (letter === "F") return { level: "温和", basis: `MBTI ${String(mbtiType).toUpperCase()} 的第 3 位是 F` };

  return { level: "", basis: "MBTI 未测" };
}

/* ------------------------------------------------------------------ 汇总 */

/**
 * 生成完整画像。
 *
 * @param {object} input
 * @param {number|null} [input.pss]      PSS-10 总分（0-40）
 * @param {number|null} [input.gad]      GAD-7 总分（0-21）
 * @param {number|null} [input.phq]      PHQ-9 总分（0-27）
 * @param {number|null} [input.phq9SelfHarm] PHQ-9 第 9 题得分（>0 直接拉高风险）
 * @param {number|null} [input.chatStress]   自研压力值（0-100，只读）
 * @param {string}      [input.mbti]     MBTI 四字母
 * @returns {{
 *   portrait: Record<string, string>,
 *   basis: Record<string, string>,
 *   sourceScores: object,
 *   needsAttention: boolean,
 *   portraitVersion: string,
 *   updatedAt: string,
 * }}
 */
export function buildPortrait({ pss, gad, phq, phq9SelfHarm, chatStress, mbti, age } = {}) {
  // ⚠️ 年龄段先算 —— 它是**优先级最高**的维度（排在 PORTRAIT_KEYS 最前）
  const ageGroup = judgeAgeGroup(age);
  const stress = judgeStressLevel({ pssScore: pss, chatStress });
  const emotion = judgeEmotionRisk({ gadScore: gad, phqScore: phq, phq9SelfHarm });
  const personality = judgePersonality(mbti);
  const communication = judgeCommunication(mbti);

  return {
    // ⚠️ 取值可能是空字符串（那个维度没有数据）——
    //    调用方拼风格指令时会跳过空的，**不要在这里填默认值**，
    //    否则"没测过"和"测出来是中等"就分不清了。
    portrait: {
      年龄段: ageGroup.level,
      压力水平: stress.level,
      情绪风险: emotion.level,
      人格倾向: personality.level,
      沟通偏好: communication.level,
    },
    // 每个标签的判定依据（后台展示用：让人看得到"凭什么"）
    basis: {
      年龄段: ageGroup.basis,
      压力水平: stress.basis,
      情绪风险: emotion.basis,
      人格倾向: personality.basis,
      沟通偏好: communication.basis,
    },
    // ⚠️ **这里刻意不放年龄值** —— 画像只保留"年龄段"这个结论，
    //    具体年龄一直存在 `users.birthday` 里，不在这里重复一份
    //    （依据里的"X 岁"是给人核对用的说明文字，不是结构化字段）。
    sourceScores: {
      PSS: Number.isFinite(Number(pss)) ? Number(pss) : null,
      GAD: Number.isFinite(Number(gad)) ? Number(gad) : null,
      PHQ: Number.isFinite(Number(phq)) ? Number(phq) : null,
      PHQ9SelfHarm: Number.isFinite(Number(phq9SelfHarm)) ? Number(phq9SelfHarm) : null,
      chatStress: Number.isFinite(Number(chatStress)) ? Number(chatStress) : null,
      MBTI: String(mbti || "").trim().toUpperCase() || null,
    },
    needsAttention: emotion.needsAttention,
    // 生日明显不合理的（<10 岁 / >100 岁）→ 后台标一下，让人去核实
    ageNeedsReview: ageGroup.needsReview,
    portraitVersion: PORTRAIT_VERSION,
    updatedAt: new Date().toISOString(),
  };
}

/* --------------------------------------------------- 标签 → 聊天风格指令 */

/**
 * 每个取值对应的风格指令。
 *
 * ⚠️ 写这些句子时的两条原则：
 *   ① **说"怎么回"，不说"用户是什么样的人"** ——
 *      给模型的应该是**行动指令**，不是标签描述。写"用户是内向的人"
 *      模型容易在回复里体现出"我在把你当内向的人对待"，
 *      而写"少追问、给思考空间"它会直接照做。
 *   ② **每条都要是"能立刻执行"的** —— "注意语气"这种话模型没法落地，
 *      "回复更简短"才能。
 */
const STYLE_RULES = {
  // ⚠️ 年龄段排在第一 —— 它是最先拼进 system prompt 的指令，优先级最高。
  //    未成年人那条尤其重要：它要能盖住其他维度里可能过于成人化的表达。
  年龄段: {
    青少年:
      "用户为未成年人：语气需格外温和、避免成人化表达；涉及自伤、抑郁等敏感话题时，必须引导他向信任的成年人或专业机构求助，这一条优先于其他任何风格要求。",
    青年: "用户为青年：可正常交流，语气轻松。",
    成年: "用户为成年人：可更直接、平等地交流。",
    中年: "用户为中年：注意尊重其生活经验，避免说教。",
    老年: "用户为老年人：表达需更清晰、简短，避免网络用语。",
  },
  压力水平: {
    高: "用户压力较高：回复更简短，先共情再给建议，不要长篇大论。",
    中: "用户有一定压力：保持温和，适当给予支持。",
  },
  情绪风险: {
    高: "用户情绪风险较高：避免说教和评判，多确认他的感受。",
    中: "用户情绪偏低：注意语气柔和。",
  },
  人格倾向: {
    内向: "用户偏内向：少追问，给他思考的空间，回复简洁。",
    外向: "用户偏外向：可以适当互动，回复可以稍长一些。",
  },
  沟通偏好: {
    直接: "用户偏好直接表达：减少铺垫，逻辑清晰。",
    温和: "用户偏好温和表达：注意措辞的友善和共情。",
  },
};

/**
 * 把画像翻译成**追加到 system prompt 的短指令**。
 *
 * ⚠️ 只产出 0-4 条，且**缺失的维度直接跳过**（新用户没做测评时一条都不产出）——
 *    调用方拿到空数组就用原来的全局人格提示词，**不报错、不降级**。
 *
 * @param {Record<string,string>} portrait 画像标签
 * @returns {string[]}
 */
export function buildStyleDirectives(portrait) {
  if (!portrait || typeof portrait !== "object") return [];

  const directives = [];

  for (const key of PORTRAIT_KEYS) {
    const value = String(portrait[key] || "").trim();
    if (!value) continue;

    const line = STYLE_RULES[key]?.[value];
    // ⚠️ "低"是刻意没有对应指令的：低压力 / 低情绪风险**不需要特别调整**，
    //    给模型加一堆"用户状态很好"的指令反而会让语气变得轻快，
    //    那对一个来倾诉的人是不合时宜的。
    if (line) directives.push(line);
  }

  return directives;
}

/**
 * 拼最终的风格段落（给 chat 接口用）。
 *
 * @returns {string} 空字符串表示"没有可用的画像指令"
 */
export function buildStyleBlock(portrait) {
  const directives = buildStyleDirectives(portrait);
  if (!directives.length) return "";

  return `当前用户适配（根据他的测评和近期状态自动调整，不要在回复里提起这些）：\n${directives
    .map((line) => `- ${line}`)
    .join("\n")}`;
}
