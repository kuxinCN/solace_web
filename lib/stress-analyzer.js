/**
 * 本地压力打分（0 Token，目标 <20ms）。
 *
 * 设计原则：
 *   * ⚠️ **不调用任何 I/O** —— 词库在模块加载时建好索引，这里只做字符串操作；
 *   * ⚠️ **不用正则**（危机词除外，那里必须靠上下文，见 lexicon 的说明）；
 *   * ⚠️ **只描述压力感受，不做任何诊断** —— 输出的数字不会展示给用户看原始含义，
 *     界面上呈现的是"情绪档位"（后台可配），避免"你得了 73 分"这种伤害。
 *
 * 基准分 50 = 中性。高于 50 表示读到了压力信号，低于 50 表示读到了放松信号。
 */
import {
  NEGATIVE_INDEX,
  POSITIVE_INDEX,
  INTENSIFIERS,
  NEGATIONS,
  NEGATIVE_EMOJIS,
  POSITIVE_EMOJIS,
  collectChars,
  matchCrisis,
} from "./stress-lexicon.js";

/** 中性基准分 */
export const BASE_SCORE = 50;

/** 聊天输入截断长度 */
const MAX_CHAT_CHARS = 200;

/** 日记输入截断长度 */
const MAX_DIARY_CHARS = 2000;

/* ------------------------------------------------------------- 时间工具 */

/**
 * 取"北京时间"的小时数（0-23）。
 *
 * ⚠️ **不依赖运行环境的时区**：容器/服务器时区设置一旦不同，
 *    `getHours()` 就会把白天当凌晨、把凌晨当白天，直接影响打分。
 *    这里用 UTC + 8 硬算，任何环境下结果一致。
 */
export function beijingHour(date = new Date()) {
  return (date.getUTCHours() + 8) % 24;
}

/** 是否凌晨 0-5 点（按北京时间） */
export function isLateNight(date = new Date()) {
  const hour = beijingHour(date);
  return hour >= 0 && hour < 5;
}

/* ------------------------------------------------------------- 匹配工具 */

/**
 * 取某个词位置的"程度倍数"：看它前面 3 个字里有没有程度副词。
 * 例：「**非常**焦虑」→ 1.5 倍；「**有点**累」→ 0.8 倍。
 */
function multiplierOf(content, index) {
  const prefix = content.slice(Math.max(0, index - 3), index);
  for (const [adverb, factor] of INTENSIFIERS) {
    if (prefix.includes(adverb)) return factor;
  }
  return 1;
}

/**
 * 判断某个词是否被否定：只看**紧邻的前一个字**。
 * ⚠️ 只看一个字是有意的 —— 看太远会把"我不觉得累"和"我不累但很焦虑"搞混。
 */
function isNegated(content, index) {
  if (index <= 0) return false;
  return NEGATIONS.includes(content[index - 1]);
}

/** 统计某个子串在文本里出现的次数 */
function countOccurrences(content, piece) {
  return content.split(piece).length - 1;
}

/**
 * 遍历词表打分（用首字索引预筛：文本里没出现过的首字直接跳过）。
 * @returns {{delta: number, matched: string[]}}
 */
function scoreWords(content, index, chars) {
  let delta = 0;
  const matched = [];

  for (const [first, entries] of index) {
    if (!chars.has(first)) continue;

    for (const [word, weight] of entries) {
      const at = content.indexOf(word);
      if (at === -1) continue;

      matched.push(word);
      const value = weight * multiplierOf(content, at);
      delta += isNegated(content, at) ? -value : value;
    }
  }

  return { delta, matched };
}

/* --------------------------------------------------------- 聊天单条消息 */

/**
 * 分析一条用户消息。
 *
 * @param {string} text 用户消息原文
 * @returns {{score:number, hasKeyword:boolean, crisis:boolean, keywords:string[], crisisLabel:string|null}}
 */
export function analyzeMessage(text) {
  if (!text || typeof text !== "string") {
    return { score: BASE_SCORE, hasKeyword: false, crisis: false, keywords: [], crisisLabel: null };
  }

  const content = text.slice(0, MAX_CHAT_CHARS);

  // ① 危机优先：命中直接 95 分，**跳过所有其它规则**
  const crisisLabel = matchCrisis(content);
  if (crisisLabel) {
    return {
      score: 95,
      hasKeyword: true,
      crisis: true,
      keywords: [crisisLabel],
      crisisLabel,
    };
  }

  let score = 0;
  const chars = collectChars(content);

  // ② 负面词 / ③ 正面词（正面词权重是负数，所以同样是加）
  const negative = scoreWords(content, NEGATIVE_INDEX, chars);
  const positive = scoreWords(content, POSITIVE_INDEX, chars);
  score += negative.delta + positive.delta;

  const matchedKeywords = [...negative.matched, ...positive.matched];
  const hasKeyword = matchedKeywords.length > 0;

  // ④ 标点：感叹号 ×2、问号 ×1（全角半角都算）
  score += (countOccurrences(content, "！") + countOccurrences(content, "!")) * 2;
  score += countOccurrences(content, "？") + countOccurrences(content, "?");

  // ⑤ 表情
  for (const emoji of NEGATIVE_EMOJIS) {
    score += countOccurrences(content, emoji) * 2;
  }
  for (const emoji of POSITIVE_EMOJIS) {
    score -= countOccurrences(content, emoji) * 2;
  }

  // ⑥ 长度：很短但夹着情绪词 → 像是憋出来的一句；超长 → 可能是在倾倒情绪
  if (content.length < 5 && hasKeyword) score += 5;
  if (content.length > MAX_CHAT_CHARS) score += 3;

  // ⑦ 凌晨（按北京时间）：夜里同样的情绪更沉
  if (isLateNight() && score > 0) score *= 1.2;

  const finalScore = Math.max(0, Math.min(100, Math.round(BASE_SCORE + score)));

  return { score: finalScore, hasKeyword, crisis: false, keywords: matchedKeywords, crisisLabel: null };
}

/* ------------------------------------------------------------- 日记多句 */

/**
 * 分析一篇日记。
 *
 * 和单条消息的区别：
 *   * 先**分句**，只保留含情绪词的句子，再从中挑最极端的几句送给 LLM
 *     —— 长日记里大部分是叙事，情绪集中在少数几句；
 *   * 有日记特有的加分项（篇幅长、第一人称密集、深夜写）。
 *
 * ⚠️ **只取"低于中性"的极端句**：
 *    原规格用 `Math.abs(score - 50)` 排序，会把「今天特别开心」排到最前面，
 *    等于把减压内容当成压力证据送给 LLM —— 那是反着的。压力评估只关心负向。
 *
 * @param {string} text 日记正文
 * @returns {{score:number, crisis:boolean, crisisLabel:string|null, emotionSentences:string[]}}
 */
export function analyzeDiary(text) {
  if (!text || typeof text !== "string") {
    return { score: BASE_SCORE, crisis: false, crisisLabel: null, emotionSentences: [] };
  }

  const full = text.slice(0, MAX_DIARY_CHARS);

  // ① 危机词：整篇检查
  const crisisLabel = matchCrisis(full);
  if (crisisLabel) {
    return { score: 95, crisis: true, crisisLabel, emotionSentences: [] };
  }

  // ② 分句
  const sentences = full
    .split(/[。！？!?\n\r]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  // ③ 抽情绪句（含任意情绪词的句子）
  const emotionSentences = [];
  for (const sentence of sentences) {
    const chars = collectChars(sentence);
    let hit = false;

    for (const [first, entries] of NEGATIVE_INDEX) {
      if (!chars.has(first)) continue;
      if (entries.some(([word]) => sentence.includes(word))) {
        hit = true;
        break;
      }
    }

    if (!hit) {
      for (const [first, entries] of POSITIVE_INDEX) {
        if (!chars.has(first)) continue;
        if (entries.some(([word]) => sentence.includes(word))) {
          hit = true;
          break;
        }
      }
    }

    if (hit) emotionSentences.push(sentence);
  }

  // ④ 按"离中性有多远"排序，但**只保留偏压力那一侧**（score > 50）
  const scored = emotionSentences
    .map((sentence) => ({ sentence, score: analyzeMessage(sentence).score }))
    .filter((item) => item.score > BASE_SCORE)
    .sort((a, b) => b.score - a.score);

  const topSentences = scored.slice(0, 5).map((item) => item.sentence);

  // ⑤ 整篇打分
  let score = analyzeMessage(full).score;

  // ⑥ 日记特有的加分
  if (full.length > 500) score += 5;
  if (countOccurrences(full, "我") > 10) score += 3;
  if (isLateNight()) score += 5;

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    crisis: false,
    crisisLabel: null,
    emotionSentences: topSentences,
  };
}

/* --------------------------------------------------------------- 档位 */

/**
 * 把压力值映射成情绪档位。
 *
 * ⚠️ **档位和文案是后台可配的**（内容安全与压力 → 压力档位），
 *    传进来的 levels 来自配置；这里只负责"取第一个 max >= score 的档"。
 *
 * @param {number} score 0-100
 * @param {Array<{id:string,max:number,label:string,hint?:string}>} levels 档位表（按 max 升序）
 */
export function resolveLevel(score, levels = []) {
  const safe = Math.max(0, Math.min(100, Number(score) || 0));
  const sorted = [...levels].filter((item) => item && item.label).sort((a, b) => (a.max || 0) - (b.max || 0));

  for (const level of sorted) {
    if (safe <= (Number(level.max) || 0)) return level;
  }
  // 超出最后一档的 max（比如配置只到 85）→ 归到最后一档
  return sorted.length ? sorted[sorted.length - 1] : null;
}
