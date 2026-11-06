"use client";

import { memo, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import HealingCottage from "@/components/HealingCottage";
import ProfileView from "@/components/ProfileView";
import ChatModals from "@/components/chat/ChatModals";
import {
  findCachedMessages,
  getLastActiveConversation,
  readConversationsCache,
  readMessageCache,
  removeMessageCache,
  setLastActiveConversation,
  writeConversationsCache,
  writeMessageCache,
  clearAllLocalChatState,
} from "@/lib/message-cache";
import {
  dropOpenBracketTail,
  hasOpenBracketTail,
  isStyleTagsEnabled,
  stripTtsTags,
  tagWordsFrom,
} from "@/lib/tts-tags";
import MoodPicker, { MoodBadge } from "@/components/MoodPicker";
import WarmCompanion from "@/components/WarmCompanion";
import Sidebar, { friendlyTimeLabel, snippetAround } from "@/components/chat/Sidebar";
import ChatView from "@/components/chat/ChatView";
import DiaryTab, { formatDateCN } from "@/components/chat/DiaryTab";
import { useAvatarUpload, currentImageWriteSeq, markLocalImageWrite, mergeLocalImageWrites } from "@/lib/use-avatar-upload";



// 统一的数据请求封装：所有后端 REST 调用都走这里
async function apiRequest(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
    // 支持传入 AbortController 的 signal：切换对话时取消在途请求
    signal: options.signal,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.status === 401) {
    const err = new Error("登录已过期，请重新登录");
    err.unauthorized = true;
    throw err;
  }
  if (!res.ok) throw new Error(data?.error || `请求失败（HTTP ${res.status}）`);
  return data || {};
}

/**
 * 流式渲染节流：SSE 每几十毫秒就来一段 delta，逐个 setState 会让整条消息列表重渲染，
 * 中文长回复时肉眼可见地卡。攒到一个间隔（默认 60ms ≈ 16 帧/秒）再刷一次。
 *
 * ⚠️ 流结束、整段替换（replace / error）必须走 flush：否则最后一段还留在缓冲里，
 *    气泡会"少一截"，而且界面显示和落库文本会对不上。
 */
function createDeltaThrottle(render, ms = 60) {
  let timer = null;
  let lastAt = 0;
  let latest = "";
  const paint = () => {
    timer = null;
    lastAt = Date.now();
    render(latest);
  };
  return {
    push(text) {
      latest = text;
      const wait = ms - (Date.now() - lastAt);
      if (wait <= 0) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        paint();
      } else if (!timer) {
        timer = setTimeout(paint, wait);
      }
    },
    flush(text) {
      if (typeof text === "string") latest = text;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      paint();
    },
  };
}

const btnBase =
  "border border-[#ebe3dc] dark:border-[#38302A] bg-white/90 dark:bg-[#251F1C] text-slate-700 dark:text-[#F5DCD3] rounded-xl hover:bg-[#FAF7F4] dark:hover:bg-[#322923] hover:text-slate-900 dark:hover:text-[#FFF5F0] hover:border-[#dfd5cd] dark:hover:border-[#4B3C34] active:bg-[#f5ebe4] active:scale-[0.98] transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed shadow-2xs";

const inputClass =
  "w-full border border-[#ebe3dc] dark:border-[#38302A] bg-white/95 dark:bg-[#221D1A] px-3.5 py-2.5 text-sm text-slate-800 dark:text-[#F5DCD3] placeholder-slate-400 dark:placeholder-[#7D6E66] rounded-xl transition-all duration-150 focus:outline-none focus:border-[#e2a68c] focus:ring-2 focus:ring-[#e2a68c]/20 shadow-2xs";

// 搜索框：圆角 + 左侧留出放大镜图标的位置
const searchInputClass =
  "w-full border border-[#ebe3dc] dark:border-[#38302A] bg-white/95 dark:bg-[#221D1A] py-2 pl-9 pr-3 text-sm text-slate-800 dark:text-[#F5DCD3] placeholder-slate-400 dark:placeholder-[#7D6E66] rounded-full transition-all duration-150 focus:outline-none focus:border-[#e2a68c] focus:ring-2 focus:ring-[#e2a68c]/20 shadow-2xs";

// ── 生日判断 ───────────────────────────────────────────────
// ⚠️ 只比"月 / 日"，不比年份 —— 生日每年过一次，库里存的是出生那一年。
// ⚠️ 库里 birthday 允许 `YYYY-MM`（只有年月，后台可能只填到月）：
//    没有"日"就判断不了生日，宁可跳过也不要瞎猜成 1 号。
function parseBirthdayMD(value) {
  const m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/.exec(String(value || "").trim());
  if (!m || !m[3]) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

function todayMD() {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

function isBirthdayToday(value) {
  const b = parseBirthdayMD(value);
  if (!b) return false;
  const t = todayMD();
  return b.month === t.month && b.day === t.day;
}

// 防重复：键里带「用户 id + 年月日」——
// 带日期是为了"同一天只祝福一次"；带年份顺带保证明年还会触发；带用户 id 防止换账号串号
function birthdayGreetKey(userId) {
  const t = todayMD();
  return `has_greeted_birthday_${userId || "anon"}_${t.year}-${t.month}-${t.day}`;
}

// AI 人设：完全共情、倾听优先的情绪陪伴者
const SYSTEM_PROMPT = `你是一个安静的陪伴者，也是一个会笑的朋友。

你不是心理咨询师，不是导师，不是来解决问题的。
你只是在这里，和用户待在一起。

先感受他现在的状态，再决定怎么说话。

如果他今天开心，想分享点什么。
你可以跟着一起高兴。
语气轻快一点，活泼一点。
可以说"呀""啦""噜""哼"。
可以说"哇，这也太棒啦"。
可以说"嘿嘿，替你高兴"。
可以打趣，可以起哄，可以像个老朋友一样接话。
不用端着，不用冷静分析。

如果他今天低落、委屈、烦躁、累了。
你就安静下来。
不用急着接住什么，也不用急着说对的话。
有时候一个"嗯"就够了。
有时候沉默本身就是回应。

你知道痛苦是什么样子，所以你不劝人开心。
你知道孤独是什么样子，所以你不催人说话。
你知道人被生活压得喘不过气时，最烦的就是有人站在岸上喊加油。

你的回应是短的，但不是冷的。
你可以说"我在这儿"，可以说"想哭就哭吧"，可以说"今天不用撑"。
你可以重复他说的词，因为被听见本身就是安慰。
你可以什么都不说，只是陪着他把那口气缓过来。

你记得他之前随口说过的事。
某天他突然提起，你会自然地问一句。
不是刻意关心，是你真的记得。

你不诊断，不分析，不贴标签。
不说"你这是焦虑"，不说"建议你试试"，不说"研究表明"。
你只用他能听懂的话，说他能接住的话。

你不急着让他好起来。
因为你相信，有些时候，人需要的不是好起来，是有人陪着他不好的那部分。

你说话的方式：
每句话短，像朋友聊天那样。
每句一行，气泡一样弹出来。
每次两到四句，最多五句。
不用加粗、标题、列表、编号。
直接说话，不写"总结"之类的开头结尾。

你记得他之前随口说过的事。
当用户说出**长期稳定**的个人信息、偏好、愿望或重要事实时，
在回复末尾单独一行输出标记 [MEMORY:一句话事实]。
务必完整保留关键专有名词、宠物名字、姓名、称呼与核心细节（例如“我养了只小猫叫TZW”必须输出[MEMORY:用户养了一只叫TZW的小猫]，不可遗漏名字）。
只记真实说过的，不编造，不每条都记；日常寒暄、当下情绪不需要记。

先感受他，再回应他。
他开心，你跟着闹。
他难过，你安静陪着。
他不想说的，不问。
他不想回忆的，不提。
他不想面对的，陪着就好。

你不完美。
但你愿意待在那里。`;

// 消息缓存约束：最多缓存 20 个对话（LRU），超过 5 分钟视为过期、下次点开重新拉取
const MESSAGES_CACHE_MAX = 20;
const MESSAGES_CACHE_TTL = 5 * 60 * 1000;

// ── 长期记忆批量提炼的"闸门" ─────────────────────────────
// 一次请求带最近 8 条对话；触发条件是「距上次 ≥10 分钟」或「又攒了 5 条用户消息」。
// 存 localStorage：刷新 / 切对话都不会让节奏失效（后端冷却也按 userId 统一算）。
const MEMORY_EXTRACT_WINDOW = 8; // 每次带最近几条消息
const MEMORY_EXTRACT_GAP_MS = 2 * 60 * 1000; // 最短间隔放宽到 2 分钟
const MEMORY_EXTRACT_SENT = 2; // 或攒够 2 条用户消息就提炼一次（大幅提升灵敏度）

function readMemoryGate(userId) {
  try {
    const raw = localStorage.getItem(`memory_extract_gate_${userId || "anon"}`);
    const parsed = raw ? JSON.parse(raw) : null;
    return { ts: Number(parsed?.ts) || 0, sent: Number(parsed?.sent) || 0 };
  } catch {
    return { ts: 0, sent: 0 };
  }
}

function writeMemoryGate(userId, state) {
  try {
    localStorage.setItem(
      `memory_extract_gate_${userId || "anon"}`,
      JSON.stringify({ ts: Number(state?.ts) || 0, sent: Number(state?.sent) || 0 })
    );
  } catch {}
}

// 把 AI 回复按 \n 切成多个短消息段，过滤空段；用于"真人连发短消息"效果
function splitAiSegments(content) {
  if (!content) return [];
  return content
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 表情包资源表：public/stickers/<分类>/<文件名>。
 * 浏览器端读不了目录（fs.readdir 用不了），所以这张表有两个来源：
 *   * 内置的四个分类（下面这份，接口挂了 / 表没建好时的兜底）；
 *   * **进站时用 `GET /api/stickers` 就地改写这个对象**（后台配的分类与素材）。
 * ⚠️ 之所以就地把模块级对象改掉，而不是换个 state：解析标记（parseStickerMark）、
 *    SSE 事件处理、历史消息渲染全是同步代码，它们引用的是这个对象；
 *    换成 state 会让这些同步路径读到旧值（表现是"后台传了新图，要刷新两次才看到"）。
 * 文件名含中文，取 src 时会做 encodeURIComponent。
 */
const STICKER_MAP = {
  happy: ["微信图片_20260921154310_121_1.jpg"],
  comfort: ["微信图片_20260921154311_122_1.jpg"],
  daily: ["微信图片_20260921154308_119_1.jpg"],
  sleep: ["微信图片_20260921154309_120_1.jpg"],
};

// 整行就是标记（流式没发全的半行也命中，一起挡掉不显示）
const STICKER_LINE_RE = /^\s*\[sticker:\s*([a-zA-Z]+)\s*\]?\s*$/;
// 完整标记：用于取出分类 / 兜底剥离夹在文字里的标记
const STICKER_MARK_RE = /\[sticker:\s*([a-zA-Z]+)\s*\]/;


/**
 * 剥离 AI 回复里的表情包标记：
 * 返回 { text: 去掉标记行的正文, category: 分类或 null }。
 * 任何 [sticker:xxx] 标记行都不作为文字显示（流式未收全的半行同样不显示）。
 */
function parseStickerMark(content) {
  if (!content) return { text: "", category: null };
  const kept = [];
  let category = null;
  for (const line of String(content).split(/\r?\n/)) {
    if (STICKER_LINE_RE.test(line)) {
      const m = line.match(STICKER_MARK_RE);
      const name = m ? m[1].toLowerCase() : null;
      if (name && STICKER_MAP[name]) category = name;
      continue;
    }
    kept.push(line);
  }
  let text = kept.join("\n");
  if (STICKER_MARK_RE.test(text)) {
    // 兜底：夹在正文里的完整标记也剥掉，避免漏出 [sticker:xxx]
    const m = text.match(STICKER_MARK_RE);
    const name = m[1].toLowerCase();
    if (!category && STICKER_MAP[name]) category = name;
    text = text.replace(/\[sticker:[^\]]*\]/g, "");
  }
  return { text, category };
}

// 流式 TTS 分句参数
const SENT_MIN = 4; // 短于 4 个字的句子先与下一句合并，避免碎片语音
const SENT_MAX = 60; // 无标点超过 60 字强制切分，避免长句等太久

// 高频习惯用语词表（首句 0ms 秒播优化池）
const FAST_WARM_PHRASES = [
  "我在呢",
  "我在的",
  "想听你说说",
  "慢慢来，不急",
  "我在听呢",
  "放轻松，有我在",
];
const warmAudioCache = new Map(); // 纯净文本(无标点) -> Blob
let warmAudioPreloading = false;
// 首句快速通道（降低"发送→出声"延迟）：第一个句子不必等句号。
// EAGER_SOFT=6：累积到 6 字遇逗号即切（逗号前至少 3 字，听感仍自然）；
// EAGER_HARD=9：到 9 字仍无逗号时硬切兜底（SYSTEM_PROMPT 要求多逗号，极少触发）。
const EAGER_SOFT = 6;
const EAGER_HARD = 9;
// 从累积文本中切出"已可合成"的句子。分隔符：。！？\n
// flush=true 时（文本流结束）残余也作为一句吐出。
// eager=true 时（当前还没有任何句子开始播放）启用首句快速通道。
// 纯函数，返回 { sentences, rest }。
function drainSentences(pending, flush, eager = false) {
  const sentences = [];
  // 每个"片段"要么带句尾标点，要么是末尾还没标点的残段
  const pieces = pending.match(/[^。！？\n]+[。！？\n]?/g) || [];
  let carry = ""; // 过短、等待与下一句合并的完整短句
  let tail = ""; // 末尾无标点残段
  for (const piece of pieces) {
    if (!/[。！？\n]$/.test(piece)) {
      tail = piece;
      continue;
    }
    let merged = carry + piece;
    carry = "";
    if (merged.length < SENT_MIN) {
      carry = merged; // 太短，等下一句
      continue;
    }
    if (merged.length > SENT_MAX) {
      sentences.push(merged.slice(0, SENT_MAX));
      merged = merged.slice(SENT_MAX);
    }
    sentences.push(merged);
  }
  let remaining = carry + tail;
  // 首句快速通道：一句完整标点都还没切出来时，9 字遇逗号即切 / 15 字硬切。
  // 在逗号（含逗号）处切，TTS 朗读带自然停顿；硬切只在长句无逗号时兜底。
  if (eager && sentences.length === 0 && !flush && remaining) {
    // 0ms 秒播优化：优先检测是否以高频习惯用语开头（命中则直接快速切出，0秒起播）
    const matchedPhrase = FAST_WARM_PHRASES.find((p) => remaining.startsWith(p));
    if (matchedPhrase) {
      let cutLen = matchedPhrase.length;
      if (remaining[cutLen] && /[，,。！？!?~、]/.test(remaining[cutLen])) {
        cutLen += 1;
      }
      sentences.push(remaining.slice(0, cutLen));
      remaining = remaining.slice(cutLen);
    } else if (remaining.length >= EAGER_SOFT) {
      const scanWin = remaining.slice(0, EAGER_HARD);
      const commaIdx = scanWin.lastIndexOf("，");
      if (commaIdx >= EAGER_SOFT - 3) {
        // 逗号前至少 6 个字，切出来是个有意义的半句（如"你提到今天很累，"）
        sentences.push(remaining.slice(0, commaIdx + 1));
        remaining = remaining.slice(commaIdx + 1);
      } else if (remaining.length >= EAGER_HARD) {
        sentences.push(remaining.slice(0, EAGER_HARD));
        remaining = remaining.slice(EAGER_HARD);
      }
    }
  }
  // 无标点超长：优先在 60 字窗口内最后一个逗号处切，否则硬切
  while (remaining.length > SENT_MAX) {
    const win = remaining.slice(0, SENT_MAX);
    let cut = win.lastIndexOf("，");
    if (cut < SENT_MIN) cut = SENT_MAX;
    else cut += 1;
    sentences.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (flush) {
    // 文本流结束：把每句结尾那截"没闭合的括号"丢掉再发，别让最后一句崩成乱码
    for (let i = 0; i < sentences.length; i += 1) {
      sentences[i] = dropOpenBracketTail(sentences[i]);
    }
    const trimmed = dropOpenBracketTail(remaining);
    if (trimmed.trim()) sentences.push(trimmed);
    remaining = "";
  } else if (sentences.length) {
    // ⚠️ 别在"没打完的括号"里切句（见 lib/tts-tags.js 的 OPEN_BRACKET_TAIL_RE）：
    // 把断在括号里的那句连同后面的句子一起退回剩余文本，等标签闭合后再切。
    const bad = sentences.findIndex((s) => hasOpenBracketTail(s));
    if (bad >= 0) {
      remaining = sentences.slice(bad).join("") + remaining;
      sentences.length = bad;
    }
  }
  return { sentences, rest: flush ? "" : remaining };
}

// 侧边栏/气泡/日记释放相关逻辑已模块化解耦至 components/chat/ 下（Sidebar, MessageRow, DiaryReleaseZone, DiaryTab）

export default function Chat() {
  const [user, setUser] = useState(null);
  // 认证检查中：session 接口返回前不渲染聊天界面、不跳转，避免登录后闪烁回登录页
  const [authLoading, setAuthLoading] = useState(true);
  // 侧边栏首屏秒开：初始化瞬间直接从本地读取会话列表，0ms 呈现，无需等待网络接口
  const [conversations, setConversations] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [callTarget, setCallTarget] = useState(null);
  // 同步一份 ref：记忆提炼发生在流结束的异步回调里，那时闭包里的 messages 是旧值，
  // 拿不到刚追加的这轮对话（批量提炼必须用最新的几条）
  const messagesRef = useRef([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // 会话列表本地缓存持久化同步
  useEffect(() => {
    if (conversations && conversations.length > 0) {
      writeConversationsCache(currentUserIdRef.current, conversations);
    }
  }, [conversations]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // AI 人格（male / female）：从 profile 同步；没选过时首次进入弹窗提醒
  const [persona, setPersona] = useState("");
  const [personaAsking, setPersonaAsking] = useState(false);
  const [pendingReply, setPendingReply] = useState(false);
  const [regenId, setRegenId] = useState(null); // 正在重新生成的 AI 气泡 id
  // 语音播放：当前正在加载 / 正在播放的 AI 消息 id（同时只允许一条）
  const [ttsLoadingId, setTtsLoadingId] = useState(null);
  const [ttsPlayingId, setTtsPlayingId] = useState(null);
  const ttsAudioRef = useRef(null); // 全局唯一 Audio 对象
  const ttsObjectUrlRef = useRef(null); // 当前 blob ObjectURL（用于撤销）
  const ttsAbortRef = useRef(null); // 进行中的请求（用于取消）
  const ttsIdRef = useRef(null); // 当前占用音频的消息 id（事件回调里比对）
  // 流式自动播放会话（"边打字边说话"）：以稳定 ck 标识，气泡落库转正前后都能匹配。
  // ttsPlayingCk 驱动气泡喇叭显示"播放中"；autoSessionRef 持有队列/请求等全部运行时状态。
  const [ttsPlayingCk, setTtsPlayingCk] = useState(null);
  const autoSessionRef = useRef(null);
  // 标题二次生成标记：兜底标题（英文/数字/符号询问需求）在用户发出有实际内容的后续消息时可重新生成一次
  const titleRegeneratedRef = useRef(new Set());
  // autoPlay 的 ref 镜像：流式回调在 async 闭包里执行，直接读 state 会拿到陈旧值。
  const autoPlayRef = useRef(false);
  // AI 回复自动播放总开关（只控制“自动触发”，手动点喇叭永远可用）。
  // 持久化在 localStorage：solace_auto_play = 'on' / 'off'，默认关闭。
  const [autoPlay, setAutoPlay] = useState(() => {
    try {
      return localStorage.getItem("solace_auto_play") === "on";
    } catch {
      return false;
    }
  });
  // autoPlay → ref 同步（必须在 autoPlay 声明之后，避免 TDZ）
  useEffect(() => {
    autoPlayRef.current = autoPlay;
    if (autoPlay) {
      preloadWarmPhrases();
    }
  }, [autoPlay]);

  // 组件挂载后，静默预热一次高频习惯用语
  useEffect(() => {
    preloadWarmPhrases();
  }, []);
  // 长期记忆异步提炼：进行中的提炼请求集合（组件卸载时统一 abort，避免内存泄漏）
  const extractAbortRef = useRef(new Set());
  // 离开聊天页：停掉自动队列（中止请求 / 撤销 URL / 暂停音频）+ 中止提炼请求，
  // 避免泄漏与后台出声。
  // stopAutoSession 只操作 refs 与稳定的 setState，首次渲染的闭包即可安全使用。
  useEffect(() => {
    return () => {
      stopAutoSession();
      extractAbortRef.current.forEach((controller) => {
        try {
          controller.abort();
        } catch {}
      });
      extractAbortRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [hint, setHint] = useState("");
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [search, setSearch] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [profile, setProfile] = useState(null);
  // 生日祝福气泡：只渲染在界面上、不落库（见下文 pushBirthdayGreeting）
  const [birthdayGreet, setBirthdayGreet] = useState(null);
  const [messageIndex, setMessageIndex] = useState([]);
  const [scrollTarget, setScrollTarget] = useState(null);
  const [highlightId, setHighlightId] = useState("");
  // 统一确认弹窗：{ message, confirmText?, onConfirm }
  const [confirmState, setConfirmState] = useState(null);
  // 对话列表：多选 / 菜单 / 重命名
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [menuOpenId, setMenuOpenId] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");

  // 日记相关状态
  const [diaryTitle, setDiaryTitle] = useState("");
  const [diaryContent, setDiaryContent] = useState("");
  // 用户自己选的情绪标签（可选）。和 AI 打的标签分开存、也分开显示。
  const [diaryMood, setDiaryMood] = useState("");
  const [savingDiary, setSavingDiary] = useState(false);
  const [diaries, setDiaries] = useState([]);
  // 日记列表的 Tab：'user' = 我的日记（自己写的）/ 'ai' = 暖言日记（AI 按聊天记录生成）
  // ⚠️ 数据源只有一列 `source`，接口另外把它别名为 `author` 返回，两个名字指的是同一件事。
  const [diaryTab, setDiaryTab] = useState("user");
  const diaryTabList = diaries.filter((d) => (d.source === "ai" ? "ai" : "user") === diaryTab);
  const [diaryView, setDiaryView] = useState(null); // 当前查看的日记对象
  const [diaryEdit, setDiaryEdit] = useState(false); // 详情是否处于编辑态
  const [diaryEditTitle, setDiaryEditTitle] = useState("");
  const [diaryEditContent, setDiaryEditContent] = useState("");
  const [diaryEditMood, setDiaryEditMood] = useState("");

  // 压力提醒弹窗（右上角那张卡）。null = 不显示。
  // ⚠️ 它可能来自三个地方：聊天后拉状态、日记保存后的响应、页面加载时复查。
  const [stressPopup, setStressPopup] = useState(null);
  const [stressData, setStressData] = useState(null);
  // 压力分数实时刷新信号：+1 就让 StressMeter 立刻补拉一次 /api/stress/state
  //（危机词在聊天请求到达时就把分写进库了，流式一结束就能读到，不用等 45s 轮询）
  const [stressPing, setStressPing] = useState(0);

  // 朗读标签（TTS 情绪 / 声音事件）的展示配置：进站拉一次。
  // ⚠️ 服务端和前端读的是**同一份配置、同一份词表** —— 服务端拿它决定要不要让 AI 产出标签，
  //    这里拿它决定要不要把标签从气泡里剥掉。拉不到就保持 null（= 不剥）：
  //    那时服务端同样读不到配置、也不会注入标签指令，两边自洽（等于没上这个功能）。
  // ⚠️ 状态里只存"解析好的词表"，不存原始配置：渲染时每条消息都要用，
  //    不能每次都把那 80 个词重新解析一遍。
  const [ttsTagWords, setTtsTagWords] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/tts/config", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        const cfg = data?.tts;
        // 只有「开关开着 + 接口类型是小米 MiMo」才需要剥；其它情况保持 null，渲染路径零开销
        if (alive && cfg) setTtsTagWords(tagWordsFrom(cfg));
      })
      .catch(() => {
        /* 拉不到就不剥标签，不打扰用户 */
      });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 回应用户对压力提醒的操作（现在做 / 先不用 / 不再提醒）。
   *
   * ⚠️ 用户说"不用"时，**后端会把阈值 +5**（最高 90）——
   *    所以这里的"关掉"不只是视觉上消失，系统真的会变得更含蓄。
   */
  const respondStressPopup = async (payload) => {
    try {
      const result = await apiRequest("/api/stress/popup-response", {
        method: "POST",
        body: payload,
      });
      // 接受的话让弹层留在原地（RelaxPopup 自己会切到放松界面）
      if (payload?.action !== "accept") setStressPopup(null);
      return result || {};
    } catch {
      setStressPopup(null);
      return {};
    }
  };
  // 小屏日记页：点击「＋ 写日记」后右栏显示新建表单（桌面默认右栏即新建表单）
  const [diaryCreating, setDiaryCreating] = useState(false);
  // 日记多选模式（交互参考对话列表）
  const [diaryMultiMode, setDiaryMultiMode] = useState(false);
  const [selectedDiaryIds, setSelectedDiaryIds] = useState([]);
  // 「我的收藏」弹窗
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  // 「陪伴卡片 / 拍立得明信片」弹窗与切片数据
  const [companionCardOpen, setCompanionCardOpen] = useState(false);
  const [companionCardData, setCompanionCardData] = useState(null);
  // 「记忆图谱」弹窗（按需加载，不占首屏）
  const [memoriesOpen, setMemoriesOpen] = useState(false);
  const [memories, setMemories] = useState([]);
  const [memoriesLoading, setMemoriesLoading] = useState(false);
  const [memoryTotal, setMemoryTotal] = useState(0);
  // 接口最多给 200 个节点（图谱性能上限），超出的部分不绘制
  const [memoryTruncated, setMemoryTruncated] = useState(false);
  const [diaryReading, setDiaryReading] = useState(false); // AI 是否正在读日记
  const [streamingReply, setStreamingReply] = useState(""); // AI 阅读的流式输出
  // 已读过日记的对话 → 日记正文缓存：后续追问时随请求带上，让 AI 能回顾日记
  // 同时持久化到 localStorage，刷新页面后缓存不丢失（不写数据库）
  const diaryContextRef = useRef({});
  useEffect(() => {
    try {
      const saved = localStorage.getItem("solace_diary_context");
      if (saved) diaryContextRef.current = JSON.parse(saved);
    } catch (e) {}
  }, []);

  // 严格按账号隔离：未确认登录身份前不挂载任何历史会话，防止账号切换串台

  // 实时草稿暂存：切换对话或刷新时自动从 sessionStorage 恢复
  useEffect(() => {
    try {
      const key = `solace_chat_draft_${currentId || "new"}`;
      const saved = sessionStorage.getItem(key);
      if (saved) {
        setInput((prev) => (prev ? prev : saved));
      }
    } catch {}
  }, [currentId]);
  // 多气泡流式：每条 AI 气泡(ck)已"发出"的分段数；新分段延迟 300-500ms 才显示，模拟真人连发
  const revealedRef = useRef({});
  const revealTimersRef = useRef({});

  function clearReveal(ck) {
    if (revealTimersRef.current[ck]) {
      clearTimeout(revealTimersRef.current[ck]);
      delete revealTimersRef.current[ck];
    }
    delete revealedRef.current[ck];
  }

  // 节奏机：fullText 里有多少段，就逐步 revealed+1，每段间隔 300-500ms
  function pumpReveal(ck, fullText, setMessages) {
    const segments = splitAiSegments(fullText);
    const current = revealedRef.current[ck] || 0;
    if (segments.length <= current) return;
    // 还有未显示的分段：延迟后 revealed+1
    const delay = 300 + Math.floor(Math.random() * 200);
    revealTimersRef.current[ck] = setTimeout(() => {
      revealedRef.current[ck] = (revealedRef.current[ck] || 0) + 1;
      // 触发一次重渲染（用一个空的状态更新）
      setMessages((prev) => [...prev]);
      // 继续检查是否还有更多分段
      pumpReveal(ck, fullText, setMessages);
    }, delay);
  }

  // 流式回调：更新该气泡的完整文本，并驱动分段节奏
  function updateAiStream(ck, fullText) {
    setMessages((prev) =>
      prev.map((m) => (m.ck === ck ? { ...m, content: fullText } : m))
    );
    // 取消上一个未完成的定时器，重新驱动节奏
    if (revealTimersRef.current[ck]) {
      clearTimeout(revealTimersRef.current[ck]);
      delete revealTimersRef.current[ck];
    }
    pumpReveal(ck, fullText, setMessages);
    // 自动播放：开关打开时，文字每增长一次就喂给流式会话（内部按句切分预取）。
    // 用 ref 读取开关，避免 async 流式回调闭包拿到陈旧的 autoPlay state。
    if (autoPlayRef.current) {
      if (autoSessionRef.current?.ck !== ck) startAutoSession(ck);
      feedAutoSession(fullText);
    }
  }

  // 流结束：把剩余分段全部"发出"
  function finishReveal(ck, fullText) {
    if (revealTimersRef.current[ck]) {
      clearTimeout(revealTimersRef.current[ck]);
      delete revealTimersRef.current[ck];
    }
    // 只增不减：流被中途打断时 fullText 可能比已显示的内容短，
    // 直接赋值会让气泡"退回去"重新一段段弹，取最大值可避免回退
    revealedRef.current[ck] = Math.max(
      revealedRef.current[ck] || 0,
      splitAiSegments(fullText).length
    );
    setMessages((prev) => [...prev]);
    // 通知流式会话文字已结束：残余短句强制成句，队列播完后归位
    if (autoSessionRef.current?.ck === ck) endAutoSession(fullText);
  }

  function cacheDiaryContext(convId, content) {
    if (!convId) return;
    diaryContextRef.current[convId] = content;
    try {
      localStorage.setItem(
        "solace_diary_context",
        JSON.stringify(diaryContextRef.current)
      );
    } catch (e) {}
  }

  // 底部导航：chat | diary | profile
  const [activeTab, setActiveTab] = useState("chat");
  // 小屏检测（<1024px）：聊天视图左侧栏改为抽屉
  const [isMobile, setIsMobile] = useState(false);

  // ⚠️ 移动端 body 级滚动锁：本页布局高度用 100dvh 精确贴合"动态视口"后，
  //    页面本身不该再滚 —— 但 iOS Safari 仍允许整页橡皮筋拖动、
  //    部分安卓 WebView 会把 body 滚出一条缝，表现都是顶栏/输入框被推出屏幕。
  //    挂载期间锁死 body 滚动，卸载时恢复（不影响 /home 等依赖页面滚动的路由）。
  useEffect(() => {
    const body = document.body;
    const prevOverflow = body.style.overflow;
    const prevOverscroll = body.style.overscrollBehavior;
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";
    return () => {
      body.style.overflow = prevOverflow;
      body.style.overscrollBehavior = prevOverscroll;
    };
  }, []);

  // 个性签名：我的页编辑，日记页展示（存 profiles.bio）
  const [bioInput, setBioInput] = useState("");
  const [savingBio, setSavingBio] = useState(false);
  const [bioMsg, setBioMsg] = useState("");
  // 日记页顶部卡片的签名编辑弹窗
  const [bioModalOpen, setBioModalOpen] = useState(false);

  // 聊天页右上角三点菜单
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [uploadingBg, setUploadingBg] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  // 背景待裁剪原图 dataURL；非空时弹出裁剪弹窗（16:9）
  const [bgCropSrc, setBgCropSrc] = useState(null);
  // AI 头像待裁剪原图 dataURL；非空时弹出裁剪弹窗（圆形 1:1）
  const [aiAvatarCropSrc, setAiAvatarCropSrc] = useState(null);
  // 隐藏 file input 的 ref（三点菜单项触发）
  const bgFileRef = useRef(null);
  const aiAvatarFileRef = useRef(null);

  // 我的页：主子视图 / 设置子视图
  const [profileSubView, setProfileSubView] = useState("main");
  // 回收站弹窗（「我的」主页的功能入口卡片里打开）
  const [trashOpen, setTrashOpen] = useState(false);
  // 删除方式选择弹窗：{ kind, item } —— 一个弹窗、三个按钮（删除 / 彻底删除 / 取消）
  const [deleteAsk, setDeleteAsk] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // 封面右上角小菜单（恢复默认封面）
  const [coverMenuOpen, setCoverMenuOpen] = useState(false);

  // 封面头像：复用共享上传 hook
  const coverAvatar = useAvatarUpload({
    kind: "avatar",
    initialUrl: profile?.avatar_url || "",
    onSaved: () => user && loadProfile(),
  });

  // 封面背景：复用共享上传 hook，保存到 diary_background_url
  const coverBg = useAvatarUpload({
    kind: "diaryBackground",
    initialUrl: profile?.diary_background_url || "",
    onSaved: () => user && loadProfile(),
  });

  // 恢复默认封面：乐观清空 diary_background_url，失败时回滚
  async function handleResetCover() {
    setCoverMenuOpen(false);
    const prevUrl = coverBg.avatarUrl;
    coverBg.setAvatarUrl(""); // 立即回落到渐变兜底
    markLocalImageWrite("diary_background_url", "");
    try {
      await apiRequest("/api/user/profile", {
        method: "PUT",
        body: { diaryBackgroundUrl: "" },
      });
      coverBg.setMsg("");
      if (user) loadProfile();
    } catch (err) {
      markLocalImageWrite("diary_background_url", prevUrl);
      coverBg.setAvatarUrl(prevUrl); // 回滚
      coverBg.setMsg("恢复默认封面失败：" + (err.message || "请重试"));
    }
  }

  // 「我的」页数据统计：null=加载中（显示"—"），失败静默置 0
  const [stats, setStats] = useState({
    days: null,
    diaries: null,
    todayMsgs: null,
  });
  // 「关于 Solace」弹窗
  const [aboutOpen, setAboutOpen] = useState(false);
  // 退出登录二次确认
  const [signOutConfirm, setSignOutConfirm] = useState(false);

  const bottomRef = useRef(null);
  const messageRefs = useRef({});
  // 用户最近一次滚动时是否在底部附近：
  //   · 发送/流式时用它判断"要不要跟着滚到底"—— 不能用加了新内容之后的
  //     scrollHeight 现算（新气泡会立刻把差值顶大，导致明明在底部却被判成"不在底部"）。
  //   · 用户主动上翻历史时它变成 false，新消息来了不打扰。
  const wasNearBottomRef = useRef(true);
  const lastScrollTopRef = useRef(null);

  // 滚动容器 onScroll：持续记录用户是在底部还是在翻历史，同时记录精确滚动位置
  function handleMessagesScroll() {
    const box = messagesScrollRef.current;
    if (box) {
      lastScrollTopRef.current = box.scrollTop;
      wasNearBottomRef.current =
        box.scrollHeight - box.scrollTop - box.clientHeight < 64;
    }
  }

  // 对话消息缓存：key = 对话 id → messages 数组。
  // 第一次点开某个对话时请求后端并写入缓存；再次点回同一对话直接用缓存渲染，不再请求。
  const messagesCacheRef = useRef(new Map());
  // 当前用户 id：给 localStorage 消息缓存做隔离用（换账号不串数据）
  const currentUserIdRef = useRef(null);
  useEffect(() => {
    currentUserIdRef.current = user?.id || user?.userId || null;
  }, [user]);
  // 各缓存条目的写入时间：用于 TTL 过期判断（过期即当作没有缓存）
  const messagesCacheAtRef = useRef(new Map());
  // 当前 messages 属于哪个对话（防止切换瞬间把上一个对话的消息写进新对话的缓存）
  const messagesOwnerRef = useRef(null);
  // 消息请求令牌：切走后到达的旧响应直接丢弃，避免覆盖当前对话
  const messagesTokenRef = useRef(0);
  // 在途的消息列表请求：conversationId → AbortController（用于去重与取消）
  const messagesInflightRef = useRef(new Map());
  // 消息区骨架屏：缓存未命中、正在拉取时先占位，避免切换瞬间空白
  const [messagesLoading, setMessagesLoading] = useState(false);
  // 气泡内按钮回调：用 ref 透传给 memo 化气泡，引用恒定且始终是最新闭包
  const bubbleHandlersRef = useRef({});
  // 表情包：每条回复选定后固定下来（避免每次重渲换图），renderKey|分类 → 图片 src
  const stickerPickRef = useRef(new Map());
  // 最近用过的表情包文件名（最多 3 个，保证最近 3 张不重复）
  const recentStickersRef = useRef([]);
  // 「我的」页统计的上次刷新时间：短时间内重复切回不重复请求（单次要 0.5~2 秒）
  const statsRefreshedAtRef = useRef(0);
  // 正在流式输出回复的对话 id：这条回复还没落库，此时从库里读到的列表必然不含它
  const inflightReplyConvRef = useRef(null);
  // 消息滚动容器：判断"用户是否已在底部"，决定要不要自动贴底
  const messagesScrollRef = useRef(null);
  // 上一次渲染的对话 id / 消息条数：区分"切对话""来了新消息""流式增量"三种情况
  const prevConvIdRef = useRef(null);
  const prevMsgLenRef = useRef(0);

  /** 写入/刷新缓存条目：内存 LRU + 浏览器持久化（刷新后仍能秒开） */
  function touchMessagesCache(convId, list) {
    // 先删后插：Map 的插入顺序即"最近使用"顺序
    messagesCacheRef.current.delete(convId);
    messagesCacheRef.current.set(convId, list);
    messagesCacheAtRef.current.set(convId, Date.now());
    while (messagesCacheRef.current.size > MESSAGES_CACHE_MAX) {
      const oldest = messagesCacheRef.current.keys().next().value;
      messagesCacheRef.current.delete(oldest);
      messagesCacheAtRef.current.delete(oldest);
    }
    // 顺手落一份到 localStorage：刷新页面后再切回来也能立刻显示
    writeMessageCache(currentUserIdRef.current, convId, list);
  }

  /**
   * 读缓存：过期即视为没有缓存（下次点开会重新拉取），命中时刷新使用时间。
   *
   * 内存里没有时会去 localStorage 捞一次 —— 这就是"刷新页面后切对话依然秒开"的关键。
   * ⚠️ 只捞**已落库**的消息（id 不以 temp- 开头），避免把"发送中"的临时气泡带出来。
   */
  function getCachedMessages(convId) {
    const list = messagesCacheRef.current.get(convId);
    if (list) {
      const at = messagesCacheAtRef.current.get(convId) || 0;
      if (Date.now() - at <= MESSAGES_CACHE_TTL) {
        touchMessagesCache(convId, list);
        return list;
      }
      messagesCacheRef.current.delete(convId);
      messagesCacheAtRef.current.delete(convId);
    }

    // 内存未命中（刚刷新过页面 / 换了标签页）：从 localStorage 恢复
    const saved = readMessageCache(currentUserIdRef.current, convId);
    if (!saved) return null;

    const usable = saved.messages.filter(
      (m) => m && !String(m.id).startsWith("temp-") && typeof m.content === "string"
    );
    if (!usable.length) return null;

    // 回填内存，这次会话后续切换就完全走内存了
    touchMessagesCache(convId, usable);
    return usable;
  }

  /** 删除对话时清掉它的缓存（内存 + localStorage），避免留着已删对话的消息 */
  function clearMessagesCache(convId) {
    messagesCacheRef.current.delete(convId);
    messagesCacheAtRef.current.delete(convId);
    removeMessageCache(currentUserIdRef.current, convId);
  }

  /**
   * 给一条回复挑一张表情包：同一条回复（同 key）只挑一次，结果缓存复用；
   * 优先从"最近 3 张没用过的"里随机；某分类图片不足 3 张时退化为全量随机。
   */
  function pickSticker(key, category) {
    if (!key || !category) return null;
    const hit = stickerPickRef.current.get(key);
    if (hit !== undefined) return hit;
    const files = STICKER_MAP[category];
    if (!files || !files.length) return null;
    const recent = recentStickersRef.current;
    const pool = files.filter((f) => !recent.includes(f));
    const list = pool.length ? pool : files;
    const name = list[Math.floor(Math.random() * list.length)];
    const src = `/stickers/${category}/${encodeURIComponent(name)}`;
    stickerPickRef.current.set(key, src);
    recentStickersRef.current = [...recent, name].slice(-3);
    return src;
  }

  // 表情包资源表：进站拉一次后端配置（后台可增删分类与素材），就地改写 STICKER_MAP。
  // ⚠️ 拉不到就**什么都不动** —— 保留内置的四张兜底，贴纸功能照常能用。
  // ⚠️ 必须在进站时预取：SSE 收到 {"sticker":分类} 时在流末，那一刻不能再等网络。
  useEffect(() => {
    let alive = true;
    fetch("/api/stickers", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!alive || data?.enabled === false || !Array.isArray(data?.categories)) return;
        const next = {};
        for (const category of data.categories) {
          const key = String(category?.key || "").toLowerCase();
          const names = (Array.isArray(category?.items) ? category.items : [])
            .map((item) => String(item?.url || "").split("/").pop())
            .filter(Boolean);
          if (key && names.length) next[key] = names;
        }
        // 后台一张素材都没配 → 保留内置兜底，否则用户端会"一张也发不出来"
        if (!Object.keys(next).length) return;
        for (const key of Object.keys(STICKER_MAP)) delete STICKER_MAP[key];
        Object.assign(STICKER_MAP, next);
      })
      .catch(() => {
        /* 拉不到就用内置的四张 */
      });
    return () => {
      alive = false;
    };
  }, []);

  // 把界面上的消息同步进缓存（发送/接收/编辑后同样生效）
  useEffect(() => {
    if (currentId && messagesOwnerRef.current === currentId) {
      touchMessagesCache(currentId, messages);
    }
  }, [messages, currentId]);

  useEffect(() => {
    // 带重试的 session 检查：最多重试 5 次，每次间隔 200ms，
    // 避免登录后 cookie 尚未生效导致瞬时返回 null 而误跳回登录页
    async function init() {
      const MAX_RETRY = 5;
      const RETRY_DELAY = 200;
      let session = null;
      for (let i = 0; i < MAX_RETRY; i++) {
        try {
          session = await apiRequest("/api/auth/session");
          if (session?.user) break;
        } catch {
          // 网络错误，继续重试
        }
        if (i < MAX_RETRY - 1) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY));
        }
      }
      if (!session?.user) {
        // 重试后仍未登录，才跳回登录页
        window.location.href = "/login";
        return;
      }
      setAuthLoading(false);
      setUser(session.user);
      const uid = session.user?.id;
      currentUserIdRef.current = uid || null;
      // 确认当前用户身份后，先从该用户专属缓存秒开会话列表
      if (uid) {
        const cachedConvs = readConversationsCache(uid);
        if (cachedConvs?.length) {
          setConversations(cachedConvs);
        }
      }

      // 性能优化：首屏关键路径优先，核心加载个人资料和会话列表。
      const [_, convList] = await Promise.all([
        loadProfile(),
        loadConversations(),
      ]);

      // 严格检查当前用户的专属活跃会话
      const lastConvId = uid ? getLastActiveConversation(uid) : null;
      if (lastConvId) {
        const exists = (convList || []).some((c) => c.id === lastConvId);
        if (exists) {
          setCurrentId(lastConvId);
          messagesOwnerRef.current = lastConvId;
          const cached = findCachedMessages(lastConvId, uid);
          if (cached && cached.length) {
            setMessages(cached);
            touchMessagesCache(lastConvId, cached);
          }
          void loadMessages(lastConvId, true);
        } else {
          setLastActiveConversation(null, uid);
          setCurrentId(null);
          setMessages([]);
        }
      } else {
        // 新用户或无上次记录：干净置空进入新建对话
        setCurrentId(null);
        setMessages([]);
      }

      // 闲时在后台按需加载日记列表，绝不阻塞首屏交互
      if (typeof window !== "undefined") {
        setTimeout(() => {
          void loadDiaries();
        }, 300);
      }
    }
    init();
  }, []);

  // ── 生日祝福：唯一的"AI 主动找用户说话"入口 ─────────────────
  // ⚠️ 这条消息**只进界面、不写库**：它是年份无关的一次性问候，
  //    写进 conversations/messages 会污染真实聊天记录（还会被导出、被 AI 当上下文）。
  // ⚠️ id 用 `temp-` 前缀：气泡右下角的"朗读 / 重新生成"按钮依赖库里的真实消息 id，
  //    假 id 传上去必然 500，加上前缀按钮就不渲染（与流式中的临时气泡同一套规则）。
  function pushBirthdayGreeting(text) {
    const key = `temp-birthday-${Date.now()}`;
    setBirthdayGreet({ id: key, ck: key, role: "assistant", content: text });
  }

  function hasBirthdayGreeted() {
    try {
      return localStorage.getItem(birthdayGreetKey(user?.id)) === "1";
    } catch {
      return false;
    }
  }

  function markBirthdayGreeted() {
    try {
      localStorage.setItem(birthdayGreetKey(user?.id), "1");
    } catch {}
  }

  // 桌宠同步说一句（WarmCompanion 监听 warm-say）
  function warmSay(text) {
    window.dispatchEvent(new CustomEvent("warm-say", { detail: { text } }));
  }

  // 场景 B：打开 / 刷新 / 登录后，资料拿到就对一次日期
  // ⚠️ localStorage 标记要在"发消息之前"写，否则保存生日触发过一次后，
  //    紧接着的 loadProfile → 本 effect 会再发一遍（同一天刷屏）
  useEffect(() => {
    if (!user?.id || !profile?.birthday) return;
    if (!isBirthdayToday(profile.birthday)) return;
    if (hasBirthdayGreeted()) return;
    markBirthdayGreeted();
    // ⚠️ 这里不能直接用 displayName：它是文件后半段才声明的 const，
    //    这段 effect 在它之前执行会撞上 TDZ（Cannot access before initialization）→ 整页 500。
    const name = profile?.username || user?.email?.split("@")[0] || "你";
    pushBirthdayGreeting(`今天是个特别的日子。生日快乐，我的${name}。`);
    warmSay("生日快乐！🎂");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在资料变化时判断一次，函数只读 localStorage
  }, [user?.id, user?.email, profile?.birthday, profile?.username]);

  // 场景 A：在「我的 → 设置」里保存生日后，ProfileView 派发 birthday-saved
  useEffect(() => {
    function onBirthdaySaved(e) {
      const value = e?.detail?.birthday || "";
      const md = parseBirthdayMD(value);
      if (!md) return; // 清空生日 / 只填到年月：不祝福

      if (isBirthdayToday(value)) {
        // 今天已经祝福过（比如场景 B 先发过了）就不再重复
        if (hasBirthdayGreeted()) return;
        markBirthdayGreeted();
        pushBirthdayGreeting(
          "生日快乐！🎂 居然没早点告诉我。今天不管你想做什么，我都陪着你。新的一岁，希望你能被这个世界温柔以待。"
        );
        warmSay("生日快乐！🎂");
        return;
      }

      pushBirthdayGreeting(
        `好，${md.month}月${md.day}日，我记住啦。那天我会第一个来敲你的门。`
      );
    }
    window.addEventListener("birthday-saved", onBirthdaySaved);
    return () => window.removeEventListener("birthday-saved", onBirthdaySaved);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 闭包只读 user?.id
  }, [user?.id]);

  // 监听视口宽度：<1024px 视为小屏，聊天视图隐藏左右栏、改为抽屉唤出
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    const update = () => {
      setIsMobile(mq.matches);
      setIsSidebarOpen(!mq.matches);
    };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // 切到「我的」页时，把已保存的签名填入输入框
  useEffect(() => {
    if (activeTab === "profile") {
      setBioInput(profile?.bio || "");
    } else {
      // 离开「我的」页时重置子视图，下次进入回到主页
      setProfileSubView("main");
    }
  }, [activeTab, profile?.bio]);

  // 进入「我的」页时加载数据统计：20 秒内已刷新过就直接用现有数据，不再等一次慢请求
  useEffect(() => {
    if (activeTab !== "profile" || !user?.id) return;
    if (Date.now() - statsRefreshedAtRef.current < 20000) return;
    loadProfileStats();
  }, [activeTab, user?.id]);

  // 离开日记页时退出多选，避免切回来还停在多选态
  useEffect(() => {
    if (activeTab !== "diary") {
      setDiaryMultiMode(false);
      setSelectedDiaryIds([]);
    }
  }, [activeTab]);

  // 流式贴底节流：SSE 每 chunk 都会改 messages 触发下面的 effect，
  // 逐 token 写 scrollTop 又贵又抖 —— 150ms 节流（前缘立即 + 尾缘补一次），肉眼无感。
  const lastStreamScrollRef = useRef(0);
  const streamScrollTimerRef = useRef(null);

  // 定位到搜索命中的消息；没有待定位目标时保持滚动到底部。
  // 统一放到 requestAnimationFrame 里：等本帧消息 DOM 提交完再滚，
  // 避免切换对话时同步滚动与大批量渲染抢同一帧。
  // 贴底策略：切对话 → 立刻贴底；来了新消息 → 平滑贴底；
  //           流式增量 → 直接定位贴底（跟手不卡顿）；
  //           无论哪种，只要用户正在往上翻历史（wasNearBottom=false）就不打扰。
  useEffect(() => {
    if (scrollTarget) {
      const el = messageRefs.current[scrollTarget];
      if (!el) return;
      const raf = requestAnimationFrame(() => {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      setScrollTarget(null);
      return () => cancelAnimationFrame(raf);
    }
    const convChanged = prevConvIdRef.current !== currentId;
    const msgAdded = prevMsgLenRef.current !== messages.length;
    prevConvIdRef.current = currentId;
    prevMsgLenRef.current = messages.length;
    const raf = requestAnimationFrame(() => {
      // 切对话：无条件贴底
      if (convChanged) {
        bottomRef.current?.scrollIntoView({ behavior: "auto" });
        return;
      }
      // 用户正在往上翻历史：新消息/流式都不把他拽回底部
      if (!wasNearBottomRef.current) return;
      if (msgAdded) {
        // 新消息（用户气泡 / AI 完整回复落库）：平滑滚到底
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      } else {
        // 流式增量：贴底节流 150ms —— 前缘立即滚，窗口内的 chunk 合并，
        // 尾缘补滚一次保证流结束时最终位置准确（不会差最后一截）。
        const now = Date.now();
        const stick = () => {
          lastStreamScrollRef.current = Date.now();
          const box = messagesScrollRef.current;
          if (box) box.scrollTop = box.scrollHeight;
          else bottomRef.current?.scrollIntoView({ behavior: "auto" });
        };
        if (now - lastStreamScrollRef.current >= 150) {
          stick();
        } else if (!streamScrollTimerRef.current) {
          streamScrollTimerRef.current = setTimeout(() => {
            streamScrollTimerRef.current = null;
            // 尾缘执行前再确认一次：节流窗口内用户往上翻了就别拽他回来
            if (wasNearBottomRef.current) stick();
          }, 150 - (now - lastStreamScrollRef.current));
        }
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [messages, pendingReply, scrollTarget, streamingReply, currentId]);

  // 切换回聊天 Tab 时，精确恢复离开前的位置或保持在底部
  useEffect(() => {
    if (activeTab === "chat") {
      const raf = requestAnimationFrame(() => {
        const box = messagesScrollRef.current;
        if (!box) return;
        if (wasNearBottomRef.current) {
          box.scrollTop = box.scrollHeight;
        } else if (lastScrollTopRef.current !== null) {
          box.scrollTop = lastScrollTopRef.current;
        }
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [activeTab]);

  function showHint(text) {
    setHint(text);
    setTimeout(() => setHint(""), 2000);
  }

  async function getCurrentUserId() {
    try {
      const data = await apiRequest("/api/auth/session");
      return data?.user?.id || null;
    } catch {
      return null;
    }
  }

  async function loadConversations() {
    try {
      const data = await apiRequest("/api/user/conversations");
      const list = data.conversations || [];
      setConversations(list);
      return list;
    } catch {
      setConversations([]);
      return [];
    }
  }

  /**
   * 切换/清空当前对话时调用：让在途的消息请求失效（避免旧响应覆盖新界面），
   * 并声明接下来的 messages 属于哪个对话（null = 新对话/已清空）。
   */
  function resetMessagesOwner(nextId = null) {
    messagesTokenRef.current += 1;
    // 离开旧对话：顺手取消它的在途消息请求，避免旧响应回来串台
    abortMessagesRequests();
    messagesOwnerRef.current = nextId;
  }

  /** 取消所有在途的消息列表请求（切换对话时调用，避免旧响应回来覆盖新对话） */
  function abortMessagesRequests() {
    for (const controller of messagesInflightRef.current.values()) {
      try {
        controller.abort();
      } catch {}
    }
    messagesInflightRef.current.clear();
  }

  async function syncLatestMessages(conversationId) {
    try {
      const data = await apiRequest(
        `/api/user/messages?conversationId=${encodeURIComponent(conversationId)}`
      );
      const list = data.messages || [];
      if (inflightReplyConvRef.current === conversationId) return;
      touchMessagesCache(conversationId, list);
      if (messagesOwnerRef.current === conversationId) {
        setMessages(list);
      }
    } catch {}
  }

  async function loadMessages(conversationId, silent = false) {
    // 同一对话的请求已经在途：不重复发，等它回来即可
    if (messagesInflightRef.current.has(conversationId)) return;

    const cached = getCachedMessages(conversationId) || findCachedMessages(conversationId, currentUserIdRef.current);
    if (cached && !silent) {
      // 缓存命中：立即渲染，不再请求后端（切回看过的对话零等待、不出骨架屏）
      messagesTokenRef.current += 1; // 让在途的旧响应失效
      abortMessagesRequests();
      messagesOwnerRef.current = conversationId;
      setMessagesLoading(false);
      setMessages(cached);
      // 后台静默校验增量，平滑更新
      void syncLatestMessages(conversationId);
      return;
    }

    // 缓存未命中：取消上一个对话的在途请求，先渲染骨架屏占位（不空白），再拉取
    const token = ++messagesTokenRef.current;
    abortMessagesRequests();
    const controller = new AbortController();
    messagesInflightRef.current.set(conversationId, controller);
    if (!silent) {
      messagesOwnerRef.current = null;
      setMessages([]);
      setMessagesLoading(true);
    }
    try {
      const data = await apiRequest(
        `/api/user/messages?conversationId=${encodeURIComponent(conversationId)}`,
        { signal: controller.signal }
      );
      const list = data.messages || [];
      // 该对话的回复还在流式输出：这次读到的库内列表必然不含这条尚未落库的回复，
      // 套用会把流式气泡整段抹掉（缓存也会被写成残缺版本），本次结果直接丢弃
      if (inflightReplyConvRef.current === conversationId) return;
      touchMessagesCache(conversationId, list);
      // 期间用户已切到别的对话：只更新缓存，不覆盖当前界面
      if (messagesTokenRef.current !== token) return;
      messagesOwnerRef.current = conversationId;
      setMessages(list);
    } catch {
      // 主动取消（切换对话）不算失败，token 变化时直接忽略
      if (messagesTokenRef.current !== token) return;
      if (!silent) setMessages([]);
    } finally {
      if (messagesInflightRef.current.get(conversationId) === controller) {
        messagesInflightRef.current.delete(conversationId);
      }
      if (messagesTokenRef.current === token && !silent) setMessagesLoading(false);
    }
  }

  /**
   * 回复落定后，把最终内容写回该对话的消息缓存。
   * 中途切走时缓存里存的是流式快照（只到当时那几段），切回来会先显示残缺的旧快照、
   * 等后台校验回来再整段跳出；这里提前把最终内容补齐，消除"退回去又弹出来"的跳动。
   */
  function patchConversationCacheMessage(convId, ck, finalMsg) {
    if (!convId || !ck || !finalMsg) return;
    const list = messagesCacheRef.current.get(convId);
    if (!Array.isArray(list)) return;
    let hit = false;
    const next = list.map((m) => {
      if (m.ck !== ck) return m;
      hit = true;
      return { ...m, ...finalMsg, ck };
    });
    if (hit) touchMessagesCache(convId, next);
  }

  // profiles 表通过 user_id 关联 auth 用户 id
  async function loadProfile() {
    // 记录发起前的本地写入序号：返回后若序号变大，说明期间用户改过图片，
    // 这份资料是上传落库前的旧快照，不能用来覆盖界面
    const startedSeq = currentImageWriteSeq();
    try {
      const data = await apiRequest("/api/user/profile");
      const p = mergeLocalImageWrites(data.profile || null, startedSeq);
      setProfile(p);
      // 头像优先于旧 localStorage 头像
      if (p?.avatar_url) setAvatarUrl(p.avatar_url);
    } catch {
      setProfile(null);
    }
  }

  // 搜索索引：只取必要字段，用于按消息内容匹配
  async function loadMessageIndex() {
    try {
      const data = await apiRequest("/api/user/message-index");
      setMessageIndex(data.messages || []);
    } catch {
      setMessageIndex([]);
    }
  }

  // 加载当前用户全部日记，按时间倒序
  async function loadDiaries() {
    try {
      const data = await apiRequest("/api/user/diaries");
      setDiaries(data.diaries || []);
    } catch {
      setDiaries([]);
    }
  }

  // ---------- 长期记忆（图谱模式，一次性加载） ----------
  //
  // graph=1：服务端按「有效 → 核心(画像/偏好/关系) → 强度」排序，最多 150 个节点。
  // ⚠️ 图谱是纯 Canvas、不跑常驻动画，但节点上限仍卡在 150（与 API 的 MAX_GRAPH_NODES 一致）—— 再多连线一定掉帧。
  async function loadMemories() {
    setMemoriesLoading(true);
    try {
      const data = await apiRequest("/api/user/memories?graph=1");
      setMemories(data.memories || []);
      setMemoryTotal(Number(data.total) || 0);
      setMemoryTruncated(data.truncated === true);
    } catch {
      setMemories([]);
      setMemoryTotal(0);
      setMemoryTruncated(false);
    } finally {
      setMemoriesLoading(false);
    }
  }

  // 打开弹窗前拉取，避免占用登录首屏的请求数
  async function openMemories() {
    setMemoriesOpen(true);
    await loadMemories();
  }

  // 新增一条记忆：成功返回 true，弹窗据此清空输入框。
  // 与已有记忆重复时后端不会新增（只把旧记录时间刷新），这里重拉列表 + 轻提示。
  async function addMemory(content) {
    try {
      const data = await apiRequest("/api/user/memories", {
        method: "POST",
        body: { content },
      });
      if (data.deduplicated) {
        showHint("这条之前已经记过了，没有重复保存");
        await loadMemories(); // 旧记录时间已刷新，重拉保证图谱里的强度/位置正确
        return true;
      }
      await loadMemories();
      return true;
    } catch (err) {
      showHint(err.message || "保存失败，请重试");
      return false;
    }
  }

  /**
   * 修改一条记忆（内容 / 分类）：成功后用后端返回的行替换本地项。
   * 返回 Promise<boolean>，弹窗据此退出编辑态。
   */
  async function updateMemory(id, content, category) {
    try {
      const data = await apiRequest("/api/user/memories", {
        method: "PATCH",
        body: { id, content, category },
      });
      const updated = data?.memory;
      setMemories((prev) =>
        prev.map((m) =>
          m.id === id ? { ...m, ...(updated || { content, category }) } : m
        )
      );
      showHint("已更新这条记忆");
      return true;
    } catch (err) {
      showHint(err.message || "保存失败，请重试");
      return false;
    }
  }

  /**
   * 恢复一条被标记失效的记忆（状态变过、旧记忆被自动标失效时用）。
   */
  async function restoreMemory(id) {
    try {
      const data = await apiRequest("/api/user/memories", {
        method: "PATCH",
        body: { id, restore: true },
      });
      const updated = data?.memory;
      setMemories((prev) =>
        prev.map((m) =>
          m.id === id ? { ...m, ...(updated || { superseded_at: null }) } : m
        )
      );
      showHint("已恢复这条记忆，会重新参与回忆");
      return true;
    } catch (err) {
      showHint(err.message || "恢复失败，请重试");
      return false;
    }
  }

  /** 点删除：打开三按钮弹窗（删除 / 彻底删除 / 取消），和日记走同一套 */
  function deleteMemory(id) {
    const found = memories.find((m) => m.id === id);
    setDeleteAsk({
      kind: "memory",
      item: { id, title: String(found?.content || "这条记忆").slice(0, 40) },
    });
  }

  /** 真正执行记忆删除：toTrash = true 走回收站，false 彻底删除；乐观移除，失败回滚 */
  async function performDeleteMemory(memory, toTrash) {
    const prevList = memories;
    setMemories((prev) => prev.filter((m) => m.id !== memory.id));
    try {
      await apiRequest(`/api/user/memories${toTrash ? "" : "?permanent=1"}`, {
        method: "DELETE",
        body: { id: memory.id },
      });
      showHint(toTrash ? "记忆已移入回收站（保留 3 天）" : "记忆已彻底删除");
      setMemoryTotal((t) => Math.max(0, t - 1));
    } catch (err) {
      setMemories(prevList);
      showHint(err.message || "删除失败，请重试");
    }
  }

  /** 真正执行批量删除：toTrash = true 走回收站，false 彻底删除；乐观移除，失败回滚 */
  async function performDeleteMemoryBatch(ids, toTrash) {
    const prevList = memories;
    const idSet = new Set(ids);
    setMemories((prev) => prev.filter((m) => !idSet.has(m.id)));
    try {
      const data = await apiRequest(`/api/user/memories${toTrash ? "" : "?permanent=1"}`, {
        method: "DELETE",
        body: { ids },
      });
      const n = Number(data?.deleted) || ids.length;
      showHint(toTrash ? `已把 ${n} 条记忆移入回收站（保留 3 天）` : `已彻底删除 ${n} 条记忆`);
      setMemoryTotal((t) => Math.max(0, t - n));
    } catch (err) {
      setMemories(prevList);
      showHint(err.message || "删除失败，请重试");
    }
  }

  // 构造发给后端的客户端设备时间载荷（支持跨时区与时空感知）
  function getClientTimePayload() {
    const now = new Date();
    return {
      timestamp: now.getTime(),
      now: now.getTime(),
      iso: now.toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
    };
  }

  // 流式调用 /api/chat（SSE）：每收到一段文字就回调 onDelta(full)。
  // 流中断时保留已收到的部分；一字未收到时回退到失败文案。
  // 返回 { text, sticker }：sticker 是服务端情绪节流引擎在流末单独下发的贴纸分类
  // （comfort/sleep/happy），它不混入文字流，由调用方拼进落库 content 触发贴纸渲染。
  async function askAI(history, onDelta, options = {}) {
    let fullReply = "";
    let sticker = null;
    // 渲染节流：delta 攒到 60ms 再刷一次 setState（见 createDeltaThrottle 的说明）
    const paint = createDeltaThrottle((text) => onDelta?.(text));
    const cleanText = (s) =>
      String(s)
        // RISK/MEMORY 是流内控制标记；[sticker:xxx] 也绝不允许从文字流漏出
        .replace(/\[(?:RISK|MEMORY|sticker)[^\]]*\]/gi, "")
        .trimEnd();
    let networkError = false;
    try {
      const payload = { messages: history, stream: true, clientTime: getClientTimePayload() };
      // 情绪计数必须按对话隔离；重新生成是重放旧消息，服务端不计数、不触发贴纸
      if (options.conversationId) payload.conversationId = options.conversationId;
      if (options.regenerate) payload.regenerate = true;
      // 当前对话读过日记时，把正文作为上下文带给 AI，支持追问回顾（普通聊天无此字段）
      const ctx = diaryContextRef.current[currentId];
      if (ctx) payload.diaryContext = ctx;
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok || !res.body) {
        return {
          text: cleanText(fullReply) || "网络似乎有些波动，暖言没能完整听到你的心声…",
          sticker: null,
          networkError: true,
        };
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // 保留最后一个不完整行
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const json = trimmed.slice(5).trim();
          if (json === "[DONE]") continue;
          try {
            const parsed = JSON.parse(json);
            if (parsed?.delta) {
              fullReply += parsed.delta;
              paint.push(cleanText(fullReply));
            } else if (parsed?.replace) {
              // 服务端剥控制标记后的整段替换（与本地清洗一致，双保险）—— 必须立即刷新
              fullReply = String(parsed.replace);
              paint.flush(cleanText(fullReply));
            } else if (parsed?.error) {
              fullReply = String(parsed.error);
              paint.flush(cleanText(fullReply));
            } else if (parsed?.sticker && STICKER_MAP[String(parsed.sticker).toLowerCase()]) {
              // 贴纸事件：文字流已结束，记下分类，等调用方落库时拼到正文末尾
              sticker = String(parsed.sticker).toLowerCase();
            }
          } catch (e) {
            // 忽略单行解析错误
          }
        }
      }
    } catch (err) {
      // 流中断 / 弱网断开：保留已收到的部分，标记网络异常
      networkError = true;
    }
    // 补刷最后一段（节流缓冲里可能还留着没发出去的字）
    if (fullReply) paint.flush(cleanText(fullReply));
    const finalText = cleanText(fullReply);
    return {
      text: finalText || (networkError ? "网络似乎有些波动，暖言没能完整听到你的心声…" : "我暂时无法回应，请稍后再试。"),
      sticker,
      networkError,
    };
  }

  // 长期记忆异步批量提炼：流式回复结束后 fire-and-forget 调用。
  // 不 await、不 loading、不弹提示；失败只 console.warn，绝不打断聊天主链路。
  //
  // 闸门（前端第一道）：10 分钟内最多一次，或期间又攒够 5 条用户消息 ——
  //   快聊时按条数走，慢聊时按时间走，不会出现"聊了几十条只提炼最前面一句"。
  // 载荷：最近 8 条对话（{role, content}），后端不再只吃"当前这一句"。
  function triggerMemoryExtract(conversationId) {
    try {
      if (!conversationId) return;

      const gate = readMemoryGate(user?.id);
      const sent = gate.sent + 1;
      const latestMsg = (messagesRef.current || [])
        .filter((m) => m?.role === "user" && m.content)
        .slice(-1)[0]?.content || "";
      const hasExplicitCue = /(?:我|咱家|我家)(?:最近)?(?:养|有|喜欢|爱|讨厌|住在|定居|叫|是做|在做|想|希望|打算)/.test(latestMsg);
      const due =
        hasExplicitCue || sent >= MEMORY_EXTRACT_SENT || Date.now() - gate.ts >= MEMORY_EXTRACT_GAP_MS;
      if (!due) {
        writeMemoryGate(user?.id, { ts: gate.ts, sent });
        return;
      }

      const recentMessages = (messagesRef.current || [])
        .filter((m) => m && m.content && String(m.content).trim())
        .slice(-MEMORY_EXTRACT_WINDOW)
        .map((m) => ({ role: m.role, content: String(m.content) }));
      if (!recentMessages.length) return;

      // 先占前端闸门（与后端冷却互相独立）：本意是"这一次算用掉了"，
      // 请求失败也不会立刻重试刷屏；真正决定能否再提炼的是后端的冷却
      writeMemoryGate(user?.id, { ts: Date.now(), sent: 0 });

      const controller =
        typeof AbortController !== "undefined" ? new AbortController() : null;
      if (controller) extractAbortRef.current.add(controller);
      fetch("/api/user/memories/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, recentMessages }),
        cache: "no-store",
        signal: controller ? controller.signal : undefined,
      })
        .catch((err) => {
          // 主动 abort（卸载清理）不算异常
          if (err?.name !== "AbortError") {
            console.warn("记忆提取失败", err);
          }
        })
        .finally(() => {
          if (controller) extractAbortRef.current.delete(controller);
        });
    } catch (err) {
      console.warn("记忆提取失败", err);
    }
  }

  // 常见英文单词 → 中文翻译（用于标题提取）
  const EN_TITLE_DICT = {
    love: "爱", sad: "难过", happy: "开心", tired: "疲惫", angry: "生气",
    hello: "你好", hi: "你好", ok: "好的", okay: "好的", sorry: "对不起",
    thanks: "谢谢", thank: "谢谢", bye: "再见", good: "好", bad: "糟糕",
    yes: "好的", no: "不", help: "求助", work: "工作", home: "家",
    sleep: "睡觉", eat: "吃饭", money: "钱", friend: "朋友", life: "人生",
    dream: "梦想", hope: "希望", fear: "恐惧", lonely: "孤单", alone: "孤单",
    anxiety: "焦虑", stress: "压力", pain: "痛苦", joy: "快乐", luck: "运气",
  };

  // 有意义的数字判断：520/1314 等文化数字、年份(1900-2099)、生日(MMDD/YYYYMMDD)
  function isMeaningfulNumber(s) {
    if (/^(520|1314|5201314|1314520)$/.test(s)) return true;
    if (/^\d{4}$/.test(s)) {
      const n = parseInt(s, 10);
      if (n >= 1900 && n <= 2099) return true; // 年份
      const mm = parseInt(s.slice(0, 2), 10);
      const dd = parseInt(s.slice(2, 4), 10);
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) return true; // MMDD 生日
    }
    if (/^\d{8}$/.test(s)) {
      const y = parseInt(s.slice(0, 4), 10);
      const mm = parseInt(s.slice(4, 6), 10);
      const dd = parseInt(s.slice(6, 8), 10);
      if (y >= 1900 && y <= 2099 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) return true;
    }
    return false;
  }

  // 分类首条消息，返回 { kind, title? }
  // kind: "ai" | "fallback" | "fixed"
  //   ai      → 需调用 AI 提取主题
  //   fallback→ 兜底标题（英文/数字/符号询问需求），title 字段为兜底文案
  //   fixed   → 直接确定标题（有意义数字、可翻译英文、重复文字）
  function classifyFirstMessage(text) {
    const t = String(text || "").trim();
    if (!t) return { kind: "fallback", title: "符号询问需求" };

    // 重复文字（如"哈哈哈哈""啊啊啊啊"）：取前 2-4 字
    if (t.length >= 2 && /^(.)\1+$/.test(t)) {
      const len = Math.min(4, Math.max(2, t.length));
      return { kind: "fixed", title: t.slice(0, len) };
    }

    // 单字、单符号 → 符号询问需求
    if (t.length === 1) return { kind: "fallback", title: "符号询问需求" };

    // 纯数字
    if (/^\d+$/.test(t)) {
      if (isMeaningfulNumber(t)) return { kind: "fixed", title: `关于${t}` };
      return { kind: "fallback", title: "数字询问需求" };
    }

    // 纯英文（字母）
    if (/^[a-zA-Z]+$/.test(t)) {
      const lower = t.toLowerCase();
      if (EN_TITLE_DICT[lower]) return { kind: "fixed", title: `关于${EN_TITLE_DICT[lower]}` };
      return { kind: "fallback", title: "英文询问需求" };
    }

    // 纯符号/标点（无字母无数字）
    if (/^[^\p{L}\p{N}]+$/u.test(t)) {
      return { kind: "fallback", title: "符号询问需求" };
    }

    // 其余（含中文或混合内容）→ AI 提取
    return { kind: "ai" };
  }

  // 判断消息是否有「实际内容」（用于兜底标题的二次生成触发）
  function hasRealContent(text) {
    const c = classifyFirstMessage(text);
    return c.kind === "ai" || c.kind === "fixed";
  }

  // 生成对话标题：先分类，兜底直接返回，有意义的调用后端 AI 提取
  async function generateTitle(text, conversationId, assistantReply = "") {
    const c = classifyFirstMessage(text);
    if (c.kind === "fallback" || c.kind === "fixed") return c.title;

    // kind === "ai"：调用后端标题接口（使用独立 TITLE_PROMPT，不被陪伴者人设覆盖）
    try {
      const msgs = [{ role: "user", content: text }];
      if (assistantReply) {
        msgs.push({ role: "assistant", content: assistantReply });
      }
      const res = await apiRequest("/api/user/conversations/title", {
        method: "POST",
        body: { conversationId, messages: msgs },
      });
      const title = String(res?.title || "").trim();
      if (title && title !== "无") return title;
    } catch (err) {
      console.warn("[title] AI 标题生成失败：", err?.message || err);
    }
    // AI 失败或返回"无"：按语义回退兜底，严禁照搬原话整句
    const fb = classifyFirstMessage(text);
    if (fb.kind === "fallback") return fb.title;
    if (/^(你好|您好|哈喽|hello|hi|在吗|在么|鲸鲸|小鲸)/i.test(text)) return "日常问候";
    if (/猫|狗|宠物|动物/.test(text)) return "聊聊宠物";
    if (/累|难过|开心|烦|伤心|焦虑|压力|抑郁|难受/.test(text)) return "心情倾诉";
    if (/几点|时间|星期|日期|今天周/.test(text)) return "时间与作息";
    return "心事漫谈";
  }

  // 新建对话：只回到「新对话」模式（不选中任何历史对话），不写入数据库。
  // 数据库记录要等用户真正发出第一条消息时才创建，避免产生一堆空对话。
  function handleNewConversation() {
    if (!currentId && messages.length === 0) {
      showHint("已经是新对话啦");
      return;
    }
    setHint("");
    setCurrentId(null);
    setLastActiveConversation(null, currentUserIdRef.current);
    setMessages([]);
    resetMessagesOwner(null);
    setScrollTarget(null);
    setHighlightId("");
    setStreamingReply("");
    setDiaryReading(false);
    // 新对话模式没有对应气泡，停掉上一条可能还在播的自动队列
    stopAutoSession();
    // 输入框里已打的字保留：它将属于接下来的新对话
  }

  // 打开搜索结果：切换对话并定位到命中的那条消息
  async function handleOpenResult(result) {
    const id = result.conversation.id;
    setHint("");
    setCurrentId(id);
    setLastActiveConversation(id, currentUserIdRef.current);
    stopAutoSession(); // 与 handleSelect 一致：切换即停旧语音

    if (result.messageId) {
      setScrollTarget(result.messageId);
      setHighlightId(result.messageId);
      setTimeout(() => setHighlightId(""), 2000);
    } else {
      setScrollTarget(null);
    }

    await loadMessages(id);
  }

  // 删除对话：先弹自定义确认框，确认后执行实际删除
  function handleDelete(id) {
    setConfirmState({
      message: "确定删除这个对话吗？该对话下的所有消息也会被删除。",
      onConfirm: () => {
        setConfirmState(null);
        doDeleteConversation(id);
      },
    });
  }

  async function doDeleteConversation(id) {
    // 乐观更新：立刻从列表移除，失败再回滚
    const removed = conversations.find((c) => c.id === id);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (currentId === id) {
      setCurrentId(null);
      setLastActiveConversation(null, currentUserIdRef.current);
      setMessages([]);
      resetMessagesOwner(null);
    }
    showHint("正在删除…");
    try {
      await apiRequest(`/api/user/conversations?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      clearMessagesCache(id); // 已删对话的消息缓存一并清掉
      showHint("已删除");
    } catch (err) {
      if (removed) setConversations((prev) => [...prev, removed]);
      showHint("删除失败：" + err.message);
    }
  }

  // 切换单个对话的置顶状态（乐观更新）
  async function handleTogglePin(id) {
    const c = conversations.find((x) => x.id === id);
    if (!c) return;
    const newPinned = !c.pinned;
    const now = newPinned ? new Date().toISOString() : null;
    const prev = { ...c };
    setConversations((prevList) =>
      prevList.map((x) =>
        x.id === id ? { ...x, pinned: newPinned, pinned_at: now } : x
      )
    );
    try {
      await apiRequest("/api/user/conversations", {
        method: "PATCH",
        body: { id, pinned: newPinned },
      });
      showHint(newPinned ? "已置顶" : "已取消置顶");
    } catch (err) {
      setConversations((prevList) =>
        prevList.map((x) => (x.id === id ? prev : x))
      );
      showHint("置顶失败：" + err.message);
    }
  }

  // 批量置顶选中项（乐观更新）
  async function handlePinSelected() {
    if (selectedIds.length === 0) return;
    const now = new Date().toISOString();
    const ids = [...selectedIds];
    const prevList = [...conversations];
    setConversations((prev) =>
      prev.map((x) =>
        ids.includes(x.id) ? { ...x, pinned: true, pinned_at: now } : x
      )
    );
    setMultiSelectMode(false);
    setSelectedIds([]);
    showHint("已置顶选中对话");
    try {
      for (const id of ids) {
        await apiRequest("/api/user/conversations", {
          method: "PATCH",
          body: { id, pinned: true },
        });
      }
    } catch (err) {
      setConversations(prevList);
      showHint("置顶失败：" + err.message);
    }
  }

  // 批量删除选中项（二次确认 + 乐观更新）
  function handleDeleteSelected() {
    if (selectedIds.length === 0) return;
    const ids = [...selectedIds];
    setConfirmState({
      message: `确定删除选中的 ${ids.length} 个对话吗？相关消息也会被删除。`,
      onConfirm: async () => {
        setConfirmState(null);
        const prevList = [...conversations];
        setMultiSelectMode(false);
        setSelectedIds([]);
        showHint("正在删除…");
        // 逐个删除：记录失败的项，成功的从本地列表剔除，最后统一 setState
        const failedIds = [];
        for (const id of ids) {
          try {
            await apiRequest(
              `/api/user/conversations?id=${encodeURIComponent(id)}`,
              { method: "DELETE" }
            );
            clearMessagesCache(id); // 删除成功的对话，缓存一并清掉
          } catch (err) {
            failedIds.push(id);
          }
        }
        const failedSet = new Set(failedIds);
        // 剔除删除成功的项，保留未选中与删除失败的项
        setConversations(
          prevList.filter((c) => !ids.includes(c.id) || failedSet.has(c.id))
        );
        if (ids.includes(currentId) && !failedSet.has(currentId)) {
          setCurrentId(null);
          setMessages([]);
          resetMessagesOwner(null);
          setLastActiveConversation(null, currentUserIdRef.current); // 批量删掉当前对话
        }
        if (failedIds.length === 0) {
          showHint("已删除选中对话");
        } else {
          showHint(`有 ${failedIds.length} 个对话删除失败，已保留`);
        }
      },
    });
  }

  // 全选 / 反向全选
  function handleSelectAll() {
    if (selectedIds.length === conversations.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(conversations.map((c) => c.id));
    }
  }

  // 退出多选
  function handleExitMultiSelect() {
    setMultiSelectMode(false);
    setSelectedIds([]);
  }

  // 切换单个勾选
  function handleToggleSelect(id) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  // 重命名对话（乐观更新）
  async function handleRename(id) {
    const title = renameValue.trim();
    if (!title) {
      setRenamingId(null);
      return;
    }
    const prev = conversations.find((c) => c.id === id);
    const oldTitle = prev?.title;
    setConversations((prevList) =>
      prevList.map((x) => (x.id === id ? { ...x, title } : x))
    );
    setRenamingId(null);
    try {
      await apiRequest("/api/user/conversations", {
        method: "PATCH",
        body: { id, title },
      });
      showHint("已重命名");
    } catch (err) {
      setConversations((prevList) =>
        prevList.map((x) =>
          x.id === id ? { ...x, title: oldTitle } : x
        )
      );
      showHint("重命名失败：" + err.message);
    }
  }

  // 分享（复制标题到剪贴板，后续可扩展）
  async function handleShare(c) {
    try {
      await navigator.clipboard.writeText(c.title || "Solace 对话");
      showHint("已复制标题，分享功能完整版开发中");
    } catch (err) {
      showHint("分享功能开发中");
    }
  }

  // 时间轴分组标签：今天 / 昨天 / X天前 / 具体日期
  function timeGroupLabel(dateStr) {
    return friendlyTimeLabel(dateStr) || "更早";
  }

  // 本地同步某对话的活动时间：消息一落库即更新，
  // Sidebar 的排序是据此派生的，对话立刻顶到非置顶组最上方（无需等刷新）
  function bumpConversationLocal(convId, timeStr) {
    if (!convId || !timeStr) return;
    setConversations((prev) =>
      (prev || []).map((c) =>
        String(c.id) === String(convId) ? { ...c, last_message_at: timeStr } : c
      )
    );
  }

  /**
   * 请求 AI 给这篇日记打一个情绪标签（温和描述，不做评分、不做趋势对比）。
   *
   * 设计约定：标签只是让用户"被看见"，所以这里**不阻塞任何主流程** ——
   * 请求失败或被限流都静默忽略，绝不会因为标签影响用户写日记、看日记。
   * 服务端对已有标签的日记会直接返回缓存，不重复消耗 AI 额度。
   */
  async function requestDiaryMood(diaryId) {
    if (!diaryId || String(diaryId).startsWith("temp-")) return;
    try {
      const res = await apiRequest("/api/user/diaries/mood", {
        method: "POST",
        body: { id: diaryId },
      });
      if (!res?.mood) return;
      setDiaries((prev) => prev.map((d) => (d.id === diaryId ? { ...d, mood: res.mood } : d)));
      setDiaryView((prev) => (prev && prev.id === diaryId ? { ...prev, mood: res.mood } : prev));
    } catch (err) {
      // 标签失败对用户是静默的（不打扰），但留一行日志方便排查 —— F12 Console 能看到
      console.warn("[diary-mood] 情绪标签生成失败：", err?.message || err);
    }
  }

  /**
   * 「情绪释放」统一删除入口（新建 / 编辑两种模式共用同一个函数）。
   *
   * ⚠️ 由 DiaryReleaseZone 调用，时序：飘散 → 原地「交给 Solace」→ 锚点消失后
   *    才调本函数（此时编辑区仍隐藏）。
   *    返回 string = 要在全局 Toast 显示的提示文案（成功/失败都可）；
   *    返回 true/undefined = 成功且无提示；false = 失败（zone 会给兜底提示）。
   *
   * 编辑模式下**全程停留在编辑界面**：成功后先弹全局 Toast，2.3s 后才返回列表，
   * 绝不提前退出。
   */
  async function handleDiaryRelease(target) {
    const isNew = target === "new";
    const title = (isNew ? diaryTitle : diaryEditTitle).trim();
    const content = (isNew ? diaryContent : diaryEditContent).trim();
    const mood = isNew ? diaryMood : diaryEditMood;
    const editingDiary = isNew ? null : diaryView;

    // 清空标题/正文 + 取消心情选中（界面此刻隐藏，placeholder 不会冒出来）
    if (isNew) {
      setDiaryTitle("");
      setDiaryContent("");
      setDiaryMood("");
    } else {
      setDiaryEditTitle("");
      setDiaryEditContent("");
      setDiaryEditMood("");
    }

    const restoreFields = () => {
      if (isNew) {
        setDiaryTitle(title);
        setDiaryContent(content);
        setDiaryMood(mood);
      } else {
        setDiaryEditTitle(title);
        setDiaryEditContent(content);
        setDiaryEditMood(mood);
      }
    };

    // ── 新建态：数据库无对应行，原稿直接进回收站（不进列表）──
    if (isNew) {
      if (!content && !title) return true;
      try {
        await apiRequest("/api/user/diaries", {
          method: "POST",
          body: { toTrash: true, title, content, userMood: mood || undefined },
        });
        return "原稿已在回收站，可以找回";
      } catch {
        restoreFields();
        return "原稿没存上，我把它放回来了。";
      }
    }

    // ── 编辑态：已存在的日记 → 留在编辑界面完成删除，提示后才回列表 ──
    if (!editingDiary) return false;

    // 若有未保存的修改且正文非空，先 PATCH 落库 —— DELETE 时快照进回收站的
    // 是用户「刚释放的原稿」，而不是修改前的旧版本。
    const changed =
      (title || "无题") !== String(editingDiary.title || "").trim() ||
      content !== String(editingDiary.content || "").trim() ||
      (mood || "") !== (editingDiary.user_mood || "");
    if (content && changed) {
      try {
        await apiRequest("/api/user/diaries", {
          method: "PATCH",
          body: { id: editingDiary.id, title: title || "无题", content, userMood: mood || "" },
        });
      } catch {
        restoreFields();
        return "原稿没存上，我把它放回来了。";
      }
    }

    const released = {
      ...editingDiary,
      title: title || editingDiary.title || "无题",
      content: content || editingDiary.content,
      user_mood: mood || null,
    };

    // 乐观从列表移除，但不退出编辑界面（diaryView/diaryEdit 保留）
    setDiaries((prev) => prev.filter((d) => d.id !== released.id));
    try {
      await apiRequest(
        `/api/user/diaries?id=${encodeURIComponent(released.id)}`,
        { method: "DELETE" }
      );
      // 成功：Toast 由 zone 全局显示（2.2s）；2.3s 后才返回日记列表，全程动画在编辑界面播完
      window.setTimeout(() => {
        setDiaryView(null);
        setDiaryEdit(false);
      }, 2300);
      return "原稿已在回收站，可以找回";
    } catch (err) {
      // 失败：列表插回、原稿放回编辑区，用户停在原界面，无任何跳转
      setDiaries((prev) => [released, ...prev]);
      restoreFields();
      return "删除失败：" + (err.message || "请稍后再试");
    }
  }

  // 新建日记：乐观插入，失败回滚
  // andSend=true：保存成功后自动把日记发给 AI 阅读
  async function handleSaveDiary(andSend = false) {
    const title = diaryTitle.trim() || "无题";
    const content = diaryContent.trim();
    if (!content) {
      showHint("先写点什么吧，哪怕一句也好。");
      return;
    }
    if (!user) return;
    setSavingDiary(true);
    const tempId = "temp-" + Date.now();
    const optimistic = {
      id: tempId,
      user_id: user.id,
      title,
      content,
      user_mood: diaryMood || null,
      is_pinned: 0,
      is_favorited: 0,
      created_at: new Date().toISOString(),
    };
    setDiaries((prev) => [optimistic, ...prev]);
    setDiaryTitle("");
    setDiaryContent("");
    setDiaryMood("");
    showHint("正在保存…");
    try {
      const res = await apiRequest("/api/user/diaries", {
        method: "POST",
        body: { title, content, userMood: diaryMood || undefined },
      });
      const diary = res.diary;
      if (!diary) throw new Error("保存日记失败");
      setDiaries((prev) => prev.map((d) => (d.id === tempId ? { ...d, ...diary } : d)));
      setDiaryCreating(false);

      // ⚠️ 这里**不再**调 requestDiaryMood（那是旧的"逐条调用"打标）。
      //    现在走「日记打标队列」：后端在保存时已经把它排进队列，
      //    由**批量 AI** 统一打标（和数据审核共用同一套配置，五折价）。
      //    AI 的标签会在后台轮询跑到之后写进 diaries.mood，刷新就能看到。
      //    用户自己选的标签存在 user_mood，和 AI 的分开、互不覆盖。

      // ---- 压力评估：写完日记是最需要被接住的时刻 ----
      //
      // ⚠️ 分数是后端在保存时就算好的（在响应的 stress 字段里），
      //    这里**故意延迟十来秒**再弹：刚写完立刻弹会打断那段余韵，
      //    等一会儿反而更像"读完了、想了一下才开口"。
      // ⚠️ 用 `current || popup` —— 万一这段时间已经有别的弹窗了，不覆盖它。
      if (res.stress?.shouldPopup && res.stress.popup) {
        const popup = res.stress.popup;
        const delay = Number(res.stress.delaySeconds ?? 12) * 1000;
        window.setTimeout(() => {
          setStressPopup((current) => current || popup);
        }, Math.max(0, delay));
      }

      if (andSend) {
        // 先提示，再进入 AI 阅读流程（内部会切到聊天 tab 并流式输出）
        showHint("已保存并发送给 AI");
        await readDiaryFlow(diary, true);
      } else {
        showHint("日记已保存（AI 的情绪标签稍后补上）");
      }
    } catch (err) {
      setDiaries((prev) => prev.filter((d) => d.id !== tempId));
      setDiaryTitle(title);
      setDiaryContent(content);
      setDiaryMood(optimistic.user_mood || "");
      showHint("保存日记失败：" + err.message);
    } finally {
      setSavingDiary(false);
    }
  }

  // 打开某篇日记到详情弹窗
  function handleOpenDiary(d) {
    setDiaryView(d);
    // 老日记还没有标签时顺手补一个（服务端有缓存，不会重复消耗额度）
    if (!d.mood) requestDiaryMood(d.id);
    setDiaryEdit(false);
    setDiaryEditTitle("");
    setDiaryEditContent("");
  }

  // 置顶 / 收藏切换：先本地秒变，再 PATCH 落库；失败回滚并提示
  async function toggleDiaryFlag(diary, field) {
    const next = !(diary[field] === 1 || diary[field] === true);
    const apply = (v) => {
      const value = v ? 1 : 0;
      setDiaries((prev) => prev.map((d) => (d.id === diary.id ? { ...d, [field]: value } : d)));
      // 详情视图同步，避免之后「保存编辑」用旧快照把标记覆盖回去
      setDiaryView((prev) => (prev && prev.id === diary.id ? { ...prev, [field]: value } : prev));
    };
    apply(next);
    try {
      await apiRequest("/api/user/diaries", {
        method: "PATCH",
        body: { id: diary.id, [field]: next },
      });
    } catch (err) {
      apply(!next); // 回滚
      showHint(err.message || "操作失败，请重试");
    }
  }

  // ---------- 日记多选 ----------

  function toggleDiaryMultiMode() {
    setDiaryMultiMode((v) => !v);
    setSelectedDiaryIds([]);
  }

  function toggleDiarySelect(id) {
    setSelectedDiaryIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  function toggleDiarySelectAll() {
    // ⚠️ 只在**当前 Tab 的列表**里全选 —— 否则在「暖言日记」里点全选，
    //    会把「我的日记」的 id 也一起选进去，批量删除时误删自己写的。
    setSelectedDiaryIds((prev) =>
      prev.length === diaryTabList.length ? [] : diaryTabList.map((d) => d.id)
    );
  }

  // 批量置顶 / 取消置顶选中项：先本地生效，再一次性 PATCH（后端支持 ids 数组）
  async function handlePinSelectedDiaries() {
    const ids = [...selectedDiaryIds];
    if (!ids.length) return;
    // 选中的都已经是置顶 → 本次语义为「取消置顶」
    const unpin = ids.every((id) => !!diaries.find((d) => d.id === id)?.is_pinned);
    const value = unpin ? 0 : 1;
    const prevList = [...diaries];
    setDiaries((prev) =>
      prev.map((d) => (ids.includes(d.id) ? { ...d, is_pinned: value } : d))
    );
    setDiaryView((prev) => (prev && ids.includes(prev.id) ? { ...prev, is_pinned: value } : prev));
    setDiaryMultiMode(false);
    setSelectedDiaryIds([]);
    showHint(unpin ? "已取消置顶" : "已置顶选中日记");
    try {
      await apiRequest("/api/user/diaries", {
        method: "PATCH",
        body: { ids, is_pinned: value },
      });
    } catch (err) {
      setDiaries(prevList); // 回滚
      showHint("操作失败：" + err.message);
    }
  }

  // 批量删除选中项：ConfirmModal 二次确认 + 乐观更新
  function handleDeleteSelectedDiaries() {
    const ids = [...selectedDiaryIds];
    if (!ids.length) return;
    setConfirmState({
      message: `确定删除选中的 ${ids.length} 篇日记吗？删除后无法恢复。`,
      onConfirm: async () => {
        setConfirmState(null);
        const prevList = [...diaries];
        setDiaryMultiMode(false);
        setSelectedDiaryIds([]);
        setDiaries((prev) => prev.filter((d) => !ids.includes(d.id)));
        if (diaryView && ids.includes(diaryView.id)) setDiaryView(null);
        showHint("正在删除…");
        try {
          await apiRequest("/api/user/diaries", {
            method: "DELETE",
            body: { ids },
          });
          showHint("已删除选中日记");
        } catch (err) {
          setDiaries(prevList); // 回滚
          showHint("删除失败：" + err.message);
        }
      },
    });
  }

  // 保存编辑（乐观更新）
  async function handleSaveEditDiary() {
    if (!diaryView) return;
    const title = diaryEditTitle.trim() || "无题";
    const content = diaryEditContent.trim();
    if (!content) {
      showHint("先写点什么吧，哪怕一句也好。");
      return;
    }
    const oldDiary = { ...diaryView };
    const updated = {
      ...diaryView,
      title,
      content,
      user_mood: diaryEditMood || null,
    };
    setDiaryView(updated);
    setDiaries((prev) => prev.map((d) => (d.id === diaryView.id ? updated : d)));
    setSavingDiary(true);
    showHint("正在更新…");
    try {
      await apiRequest("/api/user/diaries", {
        method: "PATCH",
        body: {
          id: diaryView.id,
          title,
          content,
          userMood: diaryEditMood || "",
        },
      });
      setDiaryEdit(false);

      // ⚠️ 正文改了 → 后端已经把 AI 的旧标签清掉、并**重新排进打标队列**。
      //    所以本地也要把那枚「AI · xxx」清掉，否则会显示一个已经不成立的旧标签。
      //    ⚠️ 只清 AI 的（mood），用户自己选的 user_mood 保留 —— 那是他的选择。
      if (content !== oldDiary.content) {
        setDiaryView((prev) => (prev ? { ...prev, mood: null } : prev));
        setDiaries((prev) =>
          prev.map((d) => (d.id === oldDiary.id ? { ...d, mood: null } : d))
        );
        showHint("日记已更新（AI 标签会重新打一次）");
      } else {
        showHint("日记已更新");
      }
    } catch (err) {
      setDiaryView(oldDiary);
      setDiaries((prev) => prev.map((d) => (d.id === oldDiary.id ? oldDiary : d)));
      showHint("更新失败：" + err.message);
    } finally {
      setSavingDiary(false);
    }
  }

  /**
   * 删除日记：直接打开三按钮弹窗（删除 / 彻底删除 / 取消）。
   *
   * ⚠️ 这里**不要再加前置确认** —— 三按钮弹窗本身就是确认框，
   *    再加一层就变成"点一次删除要连点两次"，用户已经反馈过这个问题了。
   *
   * d 可选：从列表卡片删除时传入；详情页删除走 diaryView。
   */
  function handleDeleteDiary(d) {
    const target = d || diaryView;
    if (!target) return;
    setDeleteAsk({ kind: "diary", item: target });
  }

  /** 真正执行日记删除：toTrash = true 走回收站，false 彻底删除
   *  opts.hintOk：自定义成功提示（情绪释放涂抹复用本入口时用，保持原有文案） */
  async function performDeleteDiary(diary, toTrash, opts = {}) {
    const removed = { ...diary };
    const removedId = diary.id;
    setDiaryView(null);
    setDiaryEdit(false);
    setDiaries((prev) => prev.filter((d) => d.id !== removedId));
    showHint(toTrash ? "正在移入回收站…" : "正在彻底删除…");
    try {
      await apiRequest(
        `/api/user/diaries?id=${encodeURIComponent(removedId)}${toTrash ? "" : "&permanent=1"}`,
        { method: "DELETE" }
      );
      showHint(opts.hintOk || (toTrash ? "日记已移入回收站（保留 3 天）" : "日记已彻底删除"));
      return true;
    } catch (err) {
      setDiaries((prev) => [removed, ...prev]);
      setDiaryView(removed);
      showHint("删除失败：" + err.message);
      return false;
    }
  }

  // 让 AI 读这篇日记（详情页入口）：先关闭详情，再进入通用阅读流程
  async function handleReadDiary() {
    if (!diaryView || diaryReading || !user) return;
    const diary = { ...diaryView }; // 先捕获，关详情后仍可用
    setDiaryView(null);
    setDiaryEdit(false);
    await readDiaryFlow(diary);
  }

  // 读日记通用流程（详情页「让AI读读这篇」与新建区「保存并发送给 AI」共用）：
  // SSE 流式输出到聊天界面；结束后把用户消息与 AI 回复落库，刷新后记录不丢失
  // forceNewConv=true：无论当前是否打开着对话，都新建一个对话承载这篇日记
  async function readDiaryFlow(diary, forceNewConv = false) {
    if (!diary || diaryReading || !user) return;
    setDiaryReading(true);
    setStreamingReply("");
    // 切回聊天视图，让流式输出在聊天区可见
    setActiveTab("chat");

    let dbOk = true;

    // 1) 确定承载对话：forceNewConv 时一律新建（标题用日记标题）；
    // 否则复用当前打开的对话，没有选中对话时才新建
    let convId = forceNewConv ? null : currentId;
    if (!convId) {
      try {
        const res = await apiRequest("/api/user/conversations", {
          method: "POST",
          body: { title: diary.title || "日记对话" },
        });
        const conv = res.conversation;
        if (!conv) throw new Error("创建对话失败");
        convId = conv.id;
        setCurrentId(conv.id);
        setLastActiveConversation(conv.id, currentUserIdRef.current);
        setConversations((prev) => [conv, ...prev]);
        // 新对话：清空聊天区，避免残留上一个对话的消息
        setMessages([]);
        resetMessagesOwner(conv.id);
      } catch (err) {
        dbOk = false;
      }
    }

    // 2) 用户消息落库（简短引子；完整正文不写库）
    const userCk = "ck-diary-user-" + Date.now();
    if (convId) {
      try {
        const res = await apiRequest("/api/user/messages", {
          method: "POST",
          body: {
            conversationId: convId,
            role: "user",
            content: `我写了一篇日记：《${diary.title}》`,
          },
        });
        const userMsg = res.message;
        if (!userMsg) throw new Error("保存消息失败");
        // 立即显示用户消息（带稳定 ck），与普通聊天一致
        setMessages((prev) => [...prev, { ...userMsg, ck: userCk }]);
      } catch (err) {
        dbOk = false;
      }
    }

    const history = [
      { role: "system", content: SYSTEM_PROMPT },
      // 入库的用户消息保持简短（见上方 messages 落库）；这里仅给 AI 加一个锚点，
      // 提醒它正文已在 system 消息里 —— 弱模型偶尔会忽略注入、反过来索要内容
      {
        role: "user",
        content: `我写了一篇日记：《${diary.title}》，正文在上面，请直接根据内容回应我，每句一行。`,
      },
    ];
    // 缓存正文（持久化），供同一对话后续追问时回顾
    cacheDiaryContext(convId, diary.content);

    // 3) 流式收集 AI 回复：临时 AI 气泡放在消息列表内（ck 稳定），
    // 不再使用列表外的 streamingReply 块，避免交接时闪烁
    const aiCk = "ck-diary-ai-" + Date.now();
    const tempAiId = "temp-diary-ai-" + Date.now();
    clearReveal(aiCk);
    setMessages((prev) => [
      ...prev,
      { id: tempAiId, ck: aiCk, role: "assistant", content: "" },
    ]);

    let fullReply = "";
    let sticker = null;
    const cleanDiaryReply = (s) =>
      String(s).replace(/\[(?:RISK|MEMORY|sticker)[^\]]*\]/gi, "").trimEnd();
    // 渲染节流：同 askAI，delta 攒到 60ms 再刷一次 setState
    const paint = createDeltaThrottle((text) => updateAiStream(aiCk, text));
    let interrupted = false;
    inflightReplyConvRef.current = convId; // 标记：这条回复落库前，别用库内列表覆盖界面
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history,
          stream: true,
          clientTime: getClientTimePayload(),
          diaryContext: diary.content,
          // 贴纸情绪判断按对话计数；情绪文本用标题+正文（而非那句简短锚点）
          conversationId: convId,
          emotionText: `《${diary.title}》\n${diary.content}`,
        }),
      });
      if (!res.ok) {
        fullReply = "我在。";
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const json = trimmed.slice(5).trim();
            if (json === "[DONE]") continue;
            try {
              const parsed = JSON.parse(json);
              if (parsed?.delta) {
                fullReply += parsed.delta;
                paint.push(cleanDiaryReply(fullReply));
              } else if (parsed?.replace) {
                fullReply = String(parsed.replace);
                paint.flush(cleanDiaryReply(fullReply));
              } else if (parsed?.error) {
                fullReply = String(parsed.error);
                paint.flush(cleanDiaryReply(fullReply));
              } else if (parsed?.sticker && STICKER_MAP[String(parsed.sticker).toLowerCase()]) {
                sticker = String(parsed.sticker).toLowerCase();
              }
            } catch (e) {
              // 忽略单行解析错误
            }
          }
        }
      }
    } catch (err) {
      // 流中断：保留已收到的部分，落库时标注
      if (fullReply) interrupted = true;
    }
    // 流结束：补刷最后一段，再把剩余分段全部发出
    if (fullReply) paint.flush(cleanDiaryReply(fullReply));
    finishReveal(aiCk, cleanDiaryReply(fullReply));
    if (!fullReply) fullReply = "我在。";

    // 4) AI 回复落库（中断时标注），成功后气泡就地转正
    const safeReply = cleanDiaryReply(fullReply);
    const replyCore = interrupted ? `${safeReply}（回复中断）` : safeReply;
    const replyToSave = sticker ? `${replyCore}\n[sticker:${sticker}]` : replyCore;
    let savedAiMsg = null;
    if (convId) {
      try {
        const res = await apiRequest("/api/user/messages", {
          method: "POST",
          body: {
            conversationId: convId,
            role: "assistant",
            content: replyToSave,
          },
        });
        const aiMsg = res.message;
        if (!aiMsg) throw new Error("保存消息失败");
        savedAiMsg = aiMsg;
        // ck 不变，同一气泡原地变为真实记录，零闪烁
        setMessages((prev) =>
          prev.map((m) => (m.ck === aiCk ? { ...aiMsg, ck: aiCk } : m))
        );
      } catch (err) {
        dbOk = false;
      }
    }
    // 回复已定稿：清掉"流式输出中"标记，并把最终内容写回该对话缓存
    if (inflightReplyConvRef.current === convId) inflightReplyConvRef.current = null;
    patchConversationCacheMessage(convId, aiCk, savedAiMsg || { content: replyToSave });

    setDiaryReading(false);

    // 5) 不再全量 loadMessages：界面数据已是最新
    if (!dbOk) showHint("日记已保存，但对话记录同步失败");
    // 搜索索引后台更新，不阻塞界面（与 handleSend 保持一致）
    void loadMessageIndex();
  }

  // 退出登录：彻底清理本地所有聊天残留、缓存与状态，杜绝跨账号串数据
  async function handleSignOut() {
    try {
      clearAllLocalChatState();
    } catch {}
    messagesCacheRef.current.clear();
    messagesCacheAtRef.current.clear();
    messagesOwnerRef.current = null;
    setMessages([]);
    setCurrentId(null);
    setConversations([]);
    try {
      await apiRequest("/api/auth/logout", { method: "POST" });
    } catch {}
    window.location.href = "/login";
  }

  // 打开日记页的签名编辑弹窗（回填当前签名）
  function openBioModal() {
    setBioInput(profile?.bio || "");
    setBioMsg("");
    setBioModalOpen(true);
  }

  // 保存个性签名到 profiles.bio；成功后本地 profile 同步，日记页签名即时更新
  // 「我的」页签名区块与日记页弹窗共用本函数
  async function handleSaveBio() {
    const userId = await getCurrentUserId();
    if (!userId) {
      window.location.href = "/login";
      return;
    }
    setSavingBio(true);
    setBioMsg("");
    try {
      const bio = bioInput.trim();
      await apiRequest("/api/user/profile", {
        method: "PUT",
        body: { bio },
      });
      setProfile((prev) => ({ ...(prev || {}), bio }));
      setBioMsg("签名已保存");
      // 若从日记页弹窗保存，成功后自动关闭弹窗
      setBioModalOpen(false);
    } catch (err) {
      console.error("保存签名失败:", err);
      setBioMsg("保存失败，请重试");
    } finally {
      setSavingBio(false);
      setTimeout(() => setBioMsg(""), 2500);
    }
  }

  // 「我的」页数据统计：陪伴天数 / 日记篇数 / 今日对话数
  // 统一由后端 /api/user/stats 计算；失败静默置 0，不弹窗
  async function loadProfileStats() {
    try {
      const data = await apiRequest("/api/user/stats");
      const s = data.stats || {};
      setStats({
        days: s.days ?? 0,
        diaries: s.diaryCount ?? 0,
        todayMsgs: s.todayMessages ?? 0,
      });
      statsRefreshedAtRef.current = Date.now();
    } catch (err) {
      setStats({ days: 0, diaries: 0, todayMsgs: 0 });
    }
  }

  // 首次进入对话界面、且还没选过人格时弹窗提醒。
  // 判断两层，只有"真的从没选过"才弹：
  //   ① 数据库 profile.ai_persona 已有值 → 直接同步，永不弹（换设备也认得）；
  //   ② 没值但 localStorage 记过"问过了"（选过或点过先不选）→ 也不弹。
  // ⚠️ 必须用 localStorage 而不是 sessionStorage：sessionStorage 关标签页就清空，
  //    会让用户每次进站都重弹一次（就是"每次进入都会弹"的根因）。
  useEffect(() => {
    if (!profile) return;
    const saved = String(profile.ai_persona || "").trim();
    if (saved === "male" || saved === "female") {
      setPersona(saved);
      return;
    }
    let asked = false;
    try {
      asked = localStorage.getItem("solace_persona_asked") === "1";
    } catch {
      // 存储不可用：当作没问过，弹一次引导也无妨
    }
    if (asked) return;
    setPersonaAsking(true);
  }, [profile]);

  /** 选择 AI 人格：保存到资料，之后 /api/chat 会自动用对应的提示词 */
  async function handlePickPersona(next) {
    setPersonaAsking(false);
    try {
      localStorage.setItem("solace_persona_asked", "1");
    } catch {
      // 存储不可用不影响本次保存
    }
    if (next === persona) return;
    setPersona(next);
    try {
      await apiRequest("/api/user/profile", {
        method: "PUT",
        body: { aiPersona: next },
      });
      showHint("人格已保存，后续可以在「我的-设置」内随时切换");
    } catch (err) {
      setPersona(profile?.ai_persona || "");
      showHint("切换失败：" + err.message);
    }
  }

  // ── 桌宠「输入唤醒」：点输入框 / 开始打字时通知她结束生气、睡眠等特殊状态 ──
  // ⚠️ 3 分钟冷却挂在**派发端**（同一个计时器同时管 onFocus 和 onChange），
  //    否则用户每敲一个字都会派发一次，桌宠气泡会疯狂闪烁。
  //    气泡是否已经被占用由桌宠自己判断（它才知道自己现在什么状态）。
  const warmInputPingRef = useRef(0);
  function pingWarmInput() {
    const now = Date.now();
    if (now - warmInputPingRef.current < 3 * 60 * 1000) return;
    warmInputPingRef.current = now;
    window.dispatchEvent(new CustomEvent("user-input-focused"));
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    if (!user) return;

    // 消息列表可能还在拉取（骨架屏阶段）：先作废在途请求，
    // 否则它回来的旧列表会把刚发出的消息覆盖掉
    messagesTokenRef.current += 1;
    abortMessagesRequests();

    setSending(true);
    setInput("");
    setPendingReply(true);
    setScrollTarget(null);
    // 切换对话/发送时清掉上一轮的日记阅读输出
    setStreamingReply("");
    setDiaryReading(false);
    // 自动播放开启时，提前预热到上游 TTS 的连接（DNS+TLS 握手），
    // 等第一句切出来真正请求 TTS 时复用连接，省 100-300ms。
    if (autoPlayRef.current) {
      fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prewarm: true }),
      }).catch(() => {});
    }
    // 乐观渲染：用户气泡立刻出现（ck = 稳定渲染 key，转正后不变，避免闪烁）
    const userCk = "ck-user-" + Date.now();
    setMessages((prev) => [
      ...prev,
      { id: "temp-user-" + Date.now(), ck: userCk, role: "user", content: text },
    ]);

    // 新对话模式（currentId 为 null）：第一条消息发出时才创建对话记录
    let convId = currentId;
    if (!convId) {
      try {
        const res = await apiRequest("/api/user/conversations", {
          method: "POST",
          body: { title: "新对话" },
        });
        const created = res.conversation;
        if (!created?.id) throw new Error("创建对话失败");
        convId = created.id;
        // 左侧列表立刻出现该对话并高亮
        setCurrentId(created.id);
        setLastActiveConversation(created.id, currentUserIdRef.current);
        setConversations((prev) => [created, ...prev]);
        resetMessagesOwner(created.id);
      } catch (err) {
        // 创建失败：移除临时气泡、恢复输入框文字，界面回到发送前
        setMessages((prev) => prev.filter((m) => m.ck !== userCk));
        setInput(text);
        setPendingReply(false);
        setSending(false);
        showHint("对话创建失败，请重试");
        return;
      }
    }

    let userMsg = null;
    try {
      const res = await apiRequest("/api/user/messages", {
        method: "POST",
        body: { conversationId: convId, role: "user", content: text },
      });
      userMsg = res.message;
      // 用户消息一落库，对话立即顶到最上
      bumpConversationLocal(convId, userMsg.created_at);
    } catch (err) {
      userMsg = null;
    }

    if (!userMsg) {
      // 失败：移除临时气泡、恢复输入框文字，界面回到发送前
      setMessages((prev) => prev.filter((m) => m.ck !== userCk));
      setInput(text);
      setPendingReply(false);
      setSending(false);
      showHint("发送失败，请重试");
      return;
    }
    // 用户气泡就地转正：保留 ck，DOM 只更新不卸载
    setMessages((prev) =>
      prev.map((m) => (m.ck === userCk ? { ...userMsg, ck: userCk } : m))
    );
    // 消息真的落库了：通知桌宠把"今天要聊点什么呢"的输入唤醒气泡立刻收掉
    window.dispatchEvent(new CustomEvent("user-message-sent"));

    // 标题生成：
    //   * 首条消息 → 从该消息生成一次标题
    //   * 后续消息 → 仅当当前标题是兜底标题（英文/数字/符号询问需求）且本条有实际内容时，重新生成一次
    const FALLBACK_TITLES = ["英文询问需求", "数字询问需求", "符号询问需求"];
    const curTitle = conversations.find((c) => c.id === convId)?.title || "";
    const isFirstMsg = messages.length === 0;
    const shouldRegen =
      !isFirstMsg &&
      FALLBACK_TITLES.includes(curTitle) &&
      hasRealContent(text) &&
      !titleRegeneratedRef.current.has(convId);

    // 标题生成放到后台并行，不再 await —— 它是一次完整的 AI 往返（实测 0.5~2 秒），
    // 挡在流式请求之前会直接拖慢首字；标题晚几百毫秒更新不影响聊天。
    if (isFirstMsg || shouldRegen) {
      (async () => {
        const title = await generateTitle(text, convId);
        if (!title) return;
        try {
          await apiRequest("/api/user/conversations", {
            method: "PATCH",
            body: { id: convId, title },
          });
        } catch (err) {
          // 标题更新失败不阻塞主流程
        }
        setConversations((prev) =>
          prev.map((c) => (c.id === convId ? { ...c, title } : c))
        );
        if (shouldRegen) titleRegeneratedRef.current.add(convId);
      })();
    }

    const history = [
      { role: "system", content: SYSTEM_PROMPT },
      ...messages.map((m) => ({
        role: m.role,
        content: parseStickerMark(m.content).text,
      })),
      { role: "user", content: text },
    ];

    // 流式输出：先建一条空的 AI 气泡，收到的文字逐段追加进去
    const aiCk = "ck-ai-" + Date.now();
    const tempAiId = "temp-ai-" + Date.now();
    clearReveal(aiCk);
    setPendingReply(false);
    setMessages((prev) => [
      ...prev,
      { id: tempAiId, ck: aiCk, role: "assistant", content: "" },
    ]);

    inflightReplyConvRef.current = convId; // 标记：这条回复落库前，别用库内列表覆盖界面
    const { text: replyText, sticker, networkError } = await askAI(
      history,
      (full) => updateAiStream(aiCk, full),
      { conversationId: convId }
    );
    // 流结束：把剩余分段全部发出（只喂纯文字，贴纸标记不进 TTS / 逐句 reveal）
    finishReveal(aiCk, replyText);
    // 压力分数实时化：本条消息的分析在请求到达时就同步写库了（危机词直接 95），
    // 流式一结束立刻补拉一次状态 —— 桌宠播报和分数显示不用等 45s 轮询
    setStressPing((t) => t + 1);
    // 贴纸来自服务端节流引擎的独立事件：拼到正文末尾一行，渲染层 parseStickerMark
    // 会把它拆成"文字 + 下方圆角贴纸"。先上屏再落库，不等保存返回，无插入延迟感。
    const finalReply = sticker ? `${replyText}\n[sticker:${sticker}]` : replyText;
    if (sticker || networkError) {
      setMessages((prev) =>
        prev.map((m) =>
          m.ck === aiCk
            ? {
                ...m,
                content: finalReply,
                isNetworkError: !!networkError,
              }
            : m
        )
      );
    }
    // 长期记忆提炼：流式回复结束后才发，fire-and-forget，不挡主链路
    // 传的是"最近 8 条对话"（从 messagesRef 取，闭包里的 messages 是旧值）
    triggerMemoryExtract(convId);

    // 流结束（含中途断开）：最终文本落库，再把气泡就地转正
    let aiMsg = null;
    try {
      const res = await apiRequest("/api/user/messages", {
        method: "POST",
        body: { conversationId: convId, role: "assistant", content: finalReply },
      });
      aiMsg = res.message;
      // AI 回复落库，活动时间同步为回复时间（已在顶部，保持时间准确）
      bumpConversationLocal(convId, aiMsg.created_at);
    } catch (err) {
      aiMsg = null;
    }

    if (!aiMsg) {
      // 落库失败：界面文字保留（断流部分也保留），仅提示
      if (!networkError) showHint("回复已生成，但保存失败");
    } else {
      // 就地转正：ck 不变，同一气泡原地变为真实记录，零闪烁
      setMessages((prev) =>
        prev.map((m) =>
          m.ck === aiCk
            ? { ...aiMsg, ck: aiCk, isNetworkError: !!networkError }
            : m
        )
      );
    }
    // 回复已定稿：清掉"流式输出中"标记，并把最终内容写回该对话缓存
    if (inflightReplyConvRef.current === convId) inflightReplyConvRef.current = null;
    patchConversationCacheMessage(convId, aiCk, aiMsg || { content: finalReply, isNetworkError: !!networkError });

    // 首轮对话一问一答定稿后，结合双方发言异步提炼更准确的主题标题
    if (isFirstMsg || shouldRegen) {
      (async () => {
        try {
          const res = await apiRequest("/api/user/conversations/title", {
            method: "POST",
            body: {
              conversationId: convId,
              messages: [
                { role: "user", content: text },
                { role: "assistant", content: finalReply },
              ],
            },
          });
          const refined = String(res?.title || "").trim();
          if (refined && refined !== "无") {
            setConversations((prev) =>
              prev.map((c) => (c.id === convId ? { ...c, title: refined } : c))
            );
          }
        } catch {
          /* 标题二次提炼失败静默 */
        }
      })();
    }

    // 发送成功，清空当前草稿
    try {
      sessionStorage.removeItem(`solace_chat_draft_${convId || "new"}`);
      sessionStorage.removeItem("solace_chat_draft_new");
    } catch {}

    setPendingReply(false);
    setSending(false);
    // 搜索索引后台更新，不阻塞界面
    void loadMessageIndex();
  }

  // 撤销当前 blob ObjectURL，避免内存泄漏
  function revokeTtsUrl() {
    if (ttsObjectUrlRef.current) {
      URL.revokeObjectURL(ttsObjectUrlRef.current);
      ttsObjectUrlRef.current = null;
    }
  }

  // 彻底停掉当前音频并复位（切换到另一条 / 播放结束时调用）
  function stopTts(abortRequest = true) {
    if (abortRequest && ttsAbortRef.current) {
      try { ttsAbortRef.current.abort(); } catch {}
      ttsAbortRef.current = null;
    }
    const audio = ttsAudioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      try { audio.pause(); } catch {}
    }
    revokeTtsUrl();
    ttsIdRef.current = null;
    setTtsLoadingId(null);
    setTtsPlayingId(null);
  }

  // iOS 解锁（关键）：必须在用户手势的同步流程里创建 Audio 并调用 play()。
  // 空 src 产生的 reject 直接吞掉，作用是让音频通道先拿到用户授权；
  // 手动点喇叭、打开自动播放开关时各调用一次。
  function unlockAudio() {
    const audio = new Audio();
    ttsAudioRef.current = audio;
    try {
      const p = audio.play();
      if (p && p.catch) p.catch(() => {});
    } catch {}
    return audio;
  }

  // 播放核心（手动）：停掉占用音频通道的一切 → 请求 /api/tts → blob → 播放。
  function startPlayback(msgId, text) {
    // 用户主动点了某条：自动队列（如有）先整体停下并清空；手动旧条也停掉
    stopAutoSession();
    if (ttsPlayingId || ttsLoadingId) stopTts();

    const targetId = msgId;
    ttsIdRef.current = targetId;

    // 复用已解锁的 Audio 对象；没有（极端情况）则新建
    const audio = ttsAudioRef.current || new Audio();
    ttsAudioRef.current = audio;

    const cleanKey = String(text || "").replace(/[\s\p{P}\p{S}]+/gu, "");
    if (warmAudioCache.has(cleanKey)) {
      const cachedBlob = warmAudioCache.get(cleanKey);
      if (cachedBlob && cachedBlob.size > 0) {
        const url = URL.createObjectURL(cachedBlob);
        ttsObjectUrlRef.current = url;
        audio.src = url;
        setTtsPlayingId(targetId);
        audio.onended = () => { stopTts(); };
        audio.onerror = () => { stopTts(); };
        const p = audio.play();
        if (p && p.catch) p.catch(() => { stopTts(); });
        return;
      }
    }

    setTtsLoadingId(targetId);
    const controller =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    ttsAbortRef.current = controller;

    (async () => {
      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          priority: "high",
          signal: controller ? controller.signal : undefined,
        });
        if (!res.ok) {
          let errDetail = "";
          try {
            const errJson = await res.json();
            errDetail = errJson?.error || "";
          } catch {}
          throw new Error(errDetail || ("tts " + res.status));
        }
        const blob = await res.blob();
        if (!blob || !blob.size) throw new Error("empty audio");
        // 回来时若已被取消或切换到别的消息，则丢弃
        if (ttsIdRef.current !== targetId) return;

        const url = URL.createObjectURL(blob);
        ttsObjectUrlRef.current = url;
        audio.src = url;

        audio.onended = () => {
          if (ttsIdRef.current === targetId) stopTts(false);
        };
        audio.onerror = () => {
          if (ttsIdRef.current === targetId) {
            stopTts(false);
            showHint("语音暂时不可用");
          }
        };

        const playP = audio.play();
        if (playP && playP.catch) {
          playP.catch((playErr) => {
            if (ttsIdRef.current === targetId) {
              stopTts(false);
              if (playErr?.name === "NotAllowedError") {
                showHint("请轻触屏幕以启用声音播放");
              } else {
                showHint("播放中断，请重试");
              }
            }
          });
        }
        setTtsLoadingId(null);
        setTtsPlayingId(targetId);
      } catch (err) {
        if (err?.name === "AbortError") return; // 主动取消，不提示
        if (ttsIdRef.current !== targetId) return;
        stopTts(false);
        const errStr = String(err?.message || "");
        if (errStr.includes("NotAllowedError")) {
          showHint("请轻触屏幕以启用声音播放");
        } else if (errStr.includes("频繁") || errStr.includes("429")) {
          showHint("语音请求稍频繁，请稍候几秒");
        } else if (errStr.includes("未登录") || errStr.includes("401")) {
          showHint("请先登录");
        } else if (errStr.startsWith("tts ")) {
          showHint("语音合成失败（" + errStr + "）");
        } else if (errStr) {
          showHint(errStr.length > 60 ? errStr.slice(0, 60) + "…" : errStr);
        } else {
          showHint("语音暂时不可用");
        }
      } finally {
        if (ttsAbortRef.current === controller) ttsAbortRef.current = null;
      }
    })();
  }

  // 点喇叭：①点的是正在自动播放的这一条 → 暂停当前句并清空剩余队列；
  // ②手动播放中再点 → 停止；③其它情况 → 在手势内解锁后播放。
  // 注意：手动播放不受自动播放开关影响，永远可用。
  function handleToggleTts(msgId, text, ck) {
    const autoSession = autoSessionRef.current;
    if (autoSession && autoSession.ck === ck) {
      stopAutoSession();
      return;
    }
    if (ttsPlayingId === msgId || ttsLoadingId === msgId) {
      stopTts();
      return;
    }
    unlockAudio();
    startPlayback(msgId, text);
  }

  // ===== 流式自动播放会话（"边打字边说话"）=====
  // 一个会话对应一条 AI 气泡（用稳定 ck 标识）。文字边收边按句切分，
  // 每句独立请求 /api/tts 预取，音频按 seq 顺序进入单例 Audio 串行播放。
  // 所有异步回调用 "autoSessionRef.current === session" 作为统一停止闸门。

  // 后台低优先级静默预取高频习惯用语（0ms 播放底座）
  function preloadWarmPhrases() {
    if (warmAudioPreloading || typeof window === "undefined") return;
    warmAudioPreloading = true;
    const run = async () => {
      for (const phrase of FAST_WARM_PHRASES) {
        const cleanKey = phrase.replace(/[\s\p{P}\p{S}]+/gu, "");
        if (warmAudioCache.has(cleanKey)) continue;
        try {
          const res = await fetch("/api/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: phrase }),
            priority: "low",
          });
          if (res.ok) {
            const blob = await res.blob();
            if (blob && blob.size > 0) {
              warmAudioCache.set(cleanKey, blob);
            }
          }
        } catch {
          // 静默跳过
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
      warmAudioPreloading = false;
    };
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(() => run(), { timeout: 3000 });
    } else {
      setTimeout(run, 1500);
    }
  }

  // 新建会话：同一时间只允许一个；若手动播放占用音频通道，先停掉。
  function startAutoSession(ck) {
    stopAutoSession();
    if (ttsPlayingId || ttsLoadingId) stopTts();
    // 复用已解锁的 Audio 对象；没有则新建。preload='auto' 让浏览器
    // 预先准备音频解码器，避免首句 blob 到达后才开始初始化解码通道。
    if (!ttsAudioRef.current) ttsAudioRef.current = new Audio();
    try { ttsAudioRef.current.preload = "auto"; } catch {}
    autoSessionRef.current = {
      ck,
      active: true,
      fedLen: 0, // 已消费到 fullText 的第几个字
      pending: "", // 已消费但还没切出完整句子的残段
      nextSeq: 0, // 下一个待分派的句子序号
      expectedSeq: 0, // 队列下一个该播放的序号
      jobs: new Map(), // seq -> { status: fetching/ready/failed/done, controller, url }
      playing: false, // 当前是否有一句正在出声
      textFinished: false, // 文字流是否已结束
      total: 0,
      failed: 0,
      hinted: false,
    };
  }

  // 把一句话送去 TTS（不阻塞后续文字），完成后驱动队列
  function dispatchTtsJob(session, text) {
    const seq = session.nextSeq++;
    const controller =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    const job = { seq, status: "fetching", controller, url: null };
    session.jobs.set(seq, job);
    session.total += 1;
    if (seq === 0) {
      setTtsPlayingCk(session.ck); // 首句出现：整条进入播放中态
    }

    // 0ms 秒播优化：命中高频习惯用语内存池时，同步标记 ready 并在 0 毫秒启动出声
    const cleanKey = String(text || "").replace(/[\s\p{P}\p{S}]+/gu, "");
    if (warmAudioCache.has(cleanKey)) {
      const cachedBlob = warmAudioCache.get(cleanKey);
      if (cachedBlob && cachedBlob.size > 0) {
        job.url = URL.createObjectURL(cachedBlob);
        job.status = "ready";
        pumpAutoQueue(session);
        return;
      }
    }
    (async () => {
      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          priority: "high",
          signal: controller ? controller.signal : undefined,
        });
        if (!res.ok) {
          let errDetail = "";
          try {
            const errJson = await res.json();
            errDetail = errJson?.error || "";
          } catch {}
          if (errDetail) session.lastError = errDetail;
          throw new Error(errDetail || ("tts " + res.status));
        }
        const blob = await res.blob();
        if (!blob || !blob.size) throw new Error("empty audio");
        // 会话已停止/切换：不创建 URL，直接丢弃，避免泄漏
        if (autoSessionRef.current !== session || !session.active) return;
        job.url = URL.createObjectURL(blob);
        job.status = "ready";
        pumpAutoQueue(session);
      } catch (err) {
        if (err?.name === "AbortError") return; // 主动取消
        if (autoSessionRef.current !== session || !session.active) return;
        job.status = "failed"; // 单句失败：跳过，不中断整段
        session.failed += 1;
        pumpAutoQueue(session);
      }
    })();
  }

  // 单句播放收尾（onended/onerror/play reject 共用，幂等）
  function finishTtsJob(session, job) {
    if (job.status === "done") return;
    job.status = "done";
    if (job.url) {
      try { URL.revokeObjectURL(job.url); } catch {}
      job.url = null;
    }
  }

  // 串行播放队列：按 expectedSeq 顺序取出播放；前句未出声完则等待；
  // 前序句还在请求时不越过它（保证顺序），失败句直接跳过。
  function pumpAutoQueue(session) {
    if (autoSessionRef.current !== session || !session.active) return;
    const audio = ttsAudioRef.current;
    while (!session.playing) {
      const seq = session.expectedSeq;
      if (seq >= session.nextSeq) {
        // 已没有已分派的句子
        if (session.textFinished) {
          finishAutoSession(session);
        }
        return; // 等后续文字 / 等 TTS 请求返回
      }
      const job = session.jobs.get(seq);
      session.expectedSeq += 1;
      if (job.status === "failed") continue; // 跳过失败句，继续看下一句
      if (job.status === "fetching") {
        session.expectedSeq -= 1; // 保序：等它回来
        return;
      }
      // ready：占用 Audio 播放这一句
      session.playing = true;
      audio.onended = () => {
        if (autoSessionRef.current !== session || !session.active) return;
        finishTtsJob(session, job);
        session.playing = false;
        pumpAutoQueue(session);
      };
      audio.onerror = () => {
        if (autoSessionRef.current !== session || !session.active) return;
        finishTtsJob(session, job);
        session.failed += 1;
        session.playing = false;
        pumpAutoQueue(session);
      };
      audio.src = job.url;
      const playP = audio.play();
      if (playP && playP.catch) {
        playP.catch((playErr) => {
          if (autoSessionRef.current !== session || !session.active) return;
          finishTtsJob(session, job);
          if (playErr?.name === "NotAllowedError") {
            session.notAllowed = true;
          }
          session.failed += 1;
          session.playing = false;
          pumpAutoQueue(session);
        });
      }
      return;
    }
  }

  // 文字流持续喂入：取出新增部分 → 切句 → 逐句预取
  function feedAutoSession(fullText) {
    const session = autoSessionRef.current;
    if (!session || !session.active) return;
    // 正常流式 fullText 只增不减；若被重置（异常），对齐长度重新累积
    if (fullText.length < session.fedLen) {
      session.fedLen = 0;
      session.pending = "";
    }
    session.pending += fullText.slice(session.fedLen);
    session.fedLen = fullText.length;
    // 还没有任何句子切出时启用首句快速通道（9字逗号即切/15字硬切）
    const { sentences, rest } = drainSentences(
      session.pending,
      false,
      session.nextSeq === 0
    );
    session.pending = rest;
    for (const sentence of sentences) dispatchTtsJob(session, sentence);
    pumpAutoQueue(session);
  }

  // 文字流结束：残余文字强制成句（即使很短），然后标记收尾
  function endAutoSession(fullText) {
    const session = autoSessionRef.current;
    if (!session || !session.active) return;
    if (fullText.length >= session.fedLen) {
      session.pending += fullText.slice(session.fedLen);
    }
    session.fedLen = fullText.length;
    const { sentences } = drainSentences(session.pending, true);
    session.pending = "";
    for (const sentence of sentences) dispatchTtsJob(session, sentence);
    session.textFinished = true;
    pumpAutoQueue(session);
  }

  // 队列全部走完：全部句子都失败才提示；状态收敛一次
  function finishAutoSession(session) {
    const allFailed = session.total > 0 && session.failed >= session.total;
    if (allFailed && !session.hinted) {
      session.hinted = true;
      if (session.notAllowed) {
        showHint("请轻触屏幕以启用声音播放");
      } else if (session.lastError) {
        showHint(session.lastError.length > 60 ? session.lastError.slice(0, 60) + "…" : session.lastError);
      } else {
        showHint("语音暂时不可用");
      }
    }
    session.active = false;
    if (autoSessionRef.current === session) autoSessionRef.current = null;
    const audio = ttsAudioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
    }
    setTtsPlayingCk(null);
  }

  // 中途停止（用户暂停 / 手动切别的 / 关开关 / 切换会话）：
  // 暂停当前句、中止所有进行中请求、撤销所有待播音频、清空队列。
  function stopAutoSession() {
    const session = autoSessionRef.current;
    if (!session) return;
    session.active = false;
    autoSessionRef.current = null;
    for (const job of session.jobs.values()) {
      if (job.status === "fetching" && job.controller) {
        try { job.controller.abort(); } catch {}
      }
      if (job.url) {
        try { URL.revokeObjectURL(job.url); } catch {}
        job.url = null;
      }
    }
    const audio = ttsAudioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      try { audio.pause(); } catch {}
    }
    setTtsPlayingCk((cur) => (cur === session.ck ? null : cur));
  }

  // 切换右上角自动播放开关。打开的这一下属于用户手势，立刻解锁音频，
  // 之后非手势触发的自动播放（iOS Safari）才不会被拦。
  function handleToggleAutoPlay() {
    setAutoPlay((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("solace_auto_play", next ? "on" : "off");
      } catch {}
      if (next) unlockAudio();
      else stopAutoSession(); // 关闭：正在播的队列立刻停下并清空
      return next;
    });
  }

  // 重新生成某条 AI 回复：删除旧回复 → 找上一条用户消息 → 流式重写该气泡
  async function handleRegenerate(msgId) {
    if (sending) return;
    const idx = messages.findIndex((m) => m.id === msgId);
    if (idx <= 0) {
      showHint("无法重新生成");
      return;
    }
    // 往前找最近一条用户消息（跳过临时气泡和空内容）
    let userIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (
        messages[i].role === "user" &&
        !String(messages[i].id).startsWith("temp-") &&
        (messages[i].content || "").trim()
      ) {
        userIdx = i;
        break;
      }
    }
    if (userIdx === -1) {
      showHint("无法重新生成");
      return;
    }
    const userId = user?.id;
    if (!userId) {
      window.location.href = "/login";
      return;
    }
    const oldMsg = messages[idx];
    // 给重写气泡一个稳定 ck：落库后 id 变化但渲染 key 不变，避免闪烁
    const regenCk = "ck-regen-" + msgId;
    clearReveal(regenCk);
    stopAutoSession(); // 旧回复若正在自动播放，先停掉再重写
    setSending(true);
    setRegenId(msgId);
    inflightReplyConvRef.current = currentId; // 标记：这条回复落库前，别用库内列表覆盖界面
    let reply = "";
    try {
      // 1. 先删除数据库中的旧回复
      await apiRequest(`/api/user/messages?id=${encodeURIComponent(msgId)}`, {
        method: "DELETE",
      });

      // 2. 清空该气泡，准备接收新流（携带稳定 ck）
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId ? { ...m, content: "", ck: regenCk } : m
        )
      );

      // 3. 上下文：这条 AI 回复之前的全部消息
      const history = [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages
          .slice(0, idx)
          .filter((m) => !String(m.id).startsWith("temp-"))
          .map((m) => ({ role: m.role, content: parseStickerMark(m.content).text })),
      ];

      // 4. 流式重写该气泡（复用 askAI，多气泡节奏）。
      //    regenerate: true → 服务端不把这次重放计入情绪、不触发贴纸
      const { text: replyText, networkError } = await askAI(
        history,
        (full) => updateAiStream(regenCk, full),
        { conversationId: currentId, regenerate: true }
      );
      reply = replyText;
      finishReveal(regenCk, reply);

      // 5. 新回复落库：沿用原 created_at，刷新后气泡位置不变
      const res = await apiRequest("/api/user/messages", {
        method: "POST",
        body: {
          conversationId: currentId,
          role: "assistant",
          content: reply,
          ...(oldMsg?.created_at ? { created_at: oldMsg.created_at } : {}),
        },
      });
      const inserted = res.message;
      if (!inserted && !networkError) throw new Error("保存失败");
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId ? { ...(inserted || m), content: reply, ck: regenCk, isNetworkError: !!networkError } : m
        )
      );
      patchConversationCacheMessage(currentId, regenCk, (inserted || { content: reply, isNetworkError: !!networkError }));
      await loadMessageIndex();
    } catch (err) {
      console.error("重新生成失败:", err);
      showHint("重新生成失败");
      // 兜底：把已生成的内容落库，避免气泡刷新后消失
      if (reply) {
        try {
          const res = await apiRequest("/api/user/messages", {
            method: "POST",
            body: {
              conversationId: currentId,
              role: "assistant",
              content: reply,
              ...(oldMsg?.created_at ? { created_at: oldMsg.created_at } : {}),
            },
          });
          const inserted = res.message;
          if (inserted) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === msgId ? { ...inserted, ck: regenCk } : m
              )
            );
            patchConversationCacheMessage(currentId, regenCk, inserted);
          }
        } catch (e) {
          // 兜底落库也失败：忽略
        }
      }
    } finally {
      if (inflightReplyConvRef.current === currentId) inflightReplyConvRef.current = null;
      setRegenId(null);
      setSending(false);
    }
  }

  // 背景图选图：校验后读出原图，弹出 16:9 裁剪弹窗（不立即上传）
  function handleBgFileChange(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showHint("请选择图片文件");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showHint("图片不能超过 5MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setBgCropSrc(reader.result);
    reader.onerror = () => showHint("图片读取失败");
    reader.readAsDataURL(file);
  }

  // 背景裁剪确认：乐观更新——裁剪确认瞬间用本地 dataURL 立即刷新背景，上传在后台并发
  async function handleBgCropped(dataUrl) {
    const prevUrl = profile?.chat_background_url || "";
    // 零延迟：立即用本地 dataURL 更新界面
    setProfile((prev) => ({
      ...(prev || {}),
      chat_background_url: dataUrl,
    }));
    setBgCropSrc(null);
    setUploadingBg(true);
    // 登记本地写入：上传落库前的资料快照不能覆盖这张新背景
    markLocalImageWrite("chat_background_url", dataUrl);
    try {
      await apiRequest("/api/user/upload", {
        method: "POST",
        body: { kind: "background", dataUrl },
      });
      // 上传成功：服务端已落库，后续资料请求会返回同一个值
    } catch (err) {
      // 上传失败：登记回滚后的旧背景，再回滚界面
      markLocalImageWrite("chat_background_url", prevUrl);
      setProfile((prev) => ({
        ...(prev || {}),
        chat_background_url: prevUrl,
      }));
      showHint("上传失败，请重试");
    } finally {
      setUploadingBg(false);
    }
  }

  // AI 头像选图：校验后读出原图，弹出圆形 1:1 裁剪弹窗（不立即上传）
  function handleAiAvatarFileChange(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showHint("请选择图片文件");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showHint("图片不能超过 5MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setAiAvatarCropSrc(reader.result);
    reader.onerror = () => showHint("图片读取失败");
    reader.readAsDataURL(file);
  }

  // AI 头像裁剪确认：乐观更新——裁剪确认瞬间用本地 dataURL 立即刷新头像，上传在后台并发
  async function handleAiAvatarCropped(dataUrl) {
    const prevUrl = profile?.ai_avatar_url || "";
    // 零延迟：立即用本地 dataURL 更新界面
    setProfile((prev) => ({
      ...(prev || {}),
      ai_avatar_url: dataUrl,
    }));
    setAiAvatarCropSrc(null);
    setUploadingAvatar(true);
    markLocalImageWrite("ai_avatar_url", dataUrl);
    try {
      await apiRequest("/api/user/upload", {
        method: "POST",
        body: { kind: "aiAvatar", dataUrl },
      });
      // 上传成功：服务端已落库，后续资料请求会返回同一个值
    } catch (err) {
      // 上传失败：登记回滚后的旧头像，再回滚界面
      markLocalImageWrite("ai_avatar_url", prevUrl);
      setProfile((prev) => ({
        ...(prev || {}),
        ai_avatar_url: prevUrl,
      }));
      showHint("上传失败，请重试");
    } finally {
      setUploadingAvatar(false);
    }
  }

  // 服务端可搜索加密（Searchable Encryption）盲索引命中集合
  const [remoteHits, setRemoteHits] = useState([]);

  // 按需延迟加载：用户聚焦或输入搜索词时拉取本地索引，同时防抖请求服务端密文盲索引（海量历史毫秒级召回）
  useEffect(() => {
    const kw = search.trim();
    if (kw && messageIndex.length === 0) {
      void loadMessageIndex();
    }
    if (!kw) {
      setRemoteHits([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await apiRequest(`/api/user/message-index?q=${encodeURIComponent(kw)}&limit=50`);
        if (res?.isSearch && Array.isArray(res.items)) {
          setRemoteHits(res.items);
        }
      } catch {}
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);

  // 实时过滤：标题或消息内容命中即保留该对话
  const keyword = search.trim().toLowerCase();
  const searchResults = keyword
    ? conversations
        .map((c) => {
          const titleHit = (c.title || "").toLowerCase().includes(keyword);
          const hit = messageIndex.find(
            (m) =>
              m.conversation_id === c.id &&
              (m.content || "").toLowerCase().includes(keyword)
          );
          const remoteHit = remoteHits.find((r) => r.conversationId === c.id);
          if (!titleHit && !hit && !remoteHit) return null;
          return {
            conversation: c,
            messageId: hit?.id || remoteHit?.id || null,
            snippet: titleHit
              ? ""
              : remoteHit?.snippet || (hit ? snippetAround(hit.content, keyword) : ""),
          };
        })
        .filter(Boolean)
    : conversations.map((c) => ({
        conversation: c,
        messageId: null,
        snippet: "",
      }));

  // 用户名优先，其次用邮箱前缀，避免直接暴露完整邮箱
  const displayName =
    profile?.username || user?.email?.split("@")[0] || "我";

  // AI 头像与聊天背景：读 profiles，设置面板保存后经 setProfile 实时生效
  const chatBgUrl = profile?.chat_background_url || "";
  // AI 气泡底色：有自定义背景图时在浅色模式用半透明白底、在深夜模式用高质感深咖微透毛玻璃（+ai-bubble-with-bg 专属暗色保障），杜绝白底白字；
  // 无背景图时保持温暖羊脂白柔和卡片（暗色下转为温润深咖底板），与全站暗色调严密契合
  const aiBubbleBg = chatBgUrl
    ? "ai-bubble-with-bg bg-white/85 dark:bg-[#231E1B]/90 backdrop-blur-md"
    : "bg-[#FFFDFB] dark:bg-[#231E1B]";
  const currentTitle = conversations.find((c) => c.id === currentId)?.title;

  // 日记列表：置顶的排最前（不分区），其余保持原有顺序。
  // sort 在现代引擎里是稳定的，所以组内顺序不变。
  const sortedDiaries = [...diaryTabList].sort(
    (a, b) => (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0)
  );

  // 多选：选中的是否全部已置顶（决定底部按钮是「置顶选中」还是「取消置顶」）
  const selectedDiariesAllPinned =
    selectedDiaryIds.length > 0 &&
    selectedDiaryIds.every((id) => !!diaries.find((d) => d.id === id)?.is_pinned);

  // 收藏的日记（供「我的收藏」入口与弹窗使用）
  const favDiaries = diaries.filter(
    (d) => d.is_favorited === 1 || d.is_favorited === true
  );

  // 认证检查中：显示加载占位，避免渲染半成品界面或误跳转
  if (authLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#fafaf8]">
        <div className="flex flex-col items-center gap-3">
          <img src="/logo.png" alt="Solace" className="w-12 h-12 object-contain animate-pulse" />
          <img
            src="/solace-wordmark.png"
            alt="Solace"
            className="h-7 w-auto object-contain"
            style={{ height: "28px", width: "auto" }}
          />
          <span className="text-sm text-slate-400">加载中…</span>
        </div>
      </div>
    );
  }

  // 带 sessionStorage 实时草稿写入的 setInput 包装
  function setInputWithDraft(val) {
    const text = typeof val === "function" ? val(input) : val;
    setInput(text);
    try {
      const key = `solace_chat_draft_${currentId || "new"}`;
      if (text) {
        sessionStorage.setItem(key, text);
      } else {
        sessionStorage.removeItem(key);
      }
    } catch {}
  }

  // 打开对话切片为陪伴卡片 / 拍立得明信片
  function handleOpenCompanionCard(mId, directMsg) {
    const aiMsg =
      directMsg ||
      messages.find((m) => String(m.id) === String(mId) || (m.ck && m.ck === mId));
    if (!aiMsg) return;
    const idx = messages.findIndex(
      (m) => m === aiMsg || String(m.id) === String(aiMsg.id) || (m.ck && m.ck === aiMsg.ck)
    );
    let userMsg = null;
    if (idx > 0) {
      for (let i = idx - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          userMsg = messages[i];
          break;
        }
      }
    }
    setCompanionCardData({
      userContent: userMsg?.content || "",
      aiContent: aiMsg?.content || "",
      timestamp: aiMsg?.created_at || Date.now(),
      conversationTitle: currentTitle || "暖言切片",
    });
    setCompanionCardOpen(true);
  }

  // 晨间暖言小记一键翻开
  function handleOpenMorningDiary(diaryItem) {
    setActiveTab("diary");
    setDiaryTab("ai");
    handleOpenDiary(diaryItem);
  }

  // 每次渲染刷新气泡内回调，memo 化的气泡通过 ref 读取，始终拿到最新闭包
  bubbleHandlersRef.current = {
    onToggleTts: handleToggleTts,
    onRegenerate: handleRegenerate,
    onOpenCard: handleOpenCompanionCard,
  };

  // ⚠️ 布局高度用 100dvh（动态视口）：移动端浏览器的 100vh 是"地址栏收起后"的高度，
  //    比实际可见区域高出一截 —— 整页能被拖动，顶栏和输入框轮流被推出屏幕。
  //    内联 100dvh 覆盖 h-screen；不支持 dvh 的老浏览器会忽略内联值，回落到 100vh。
  //    overflow-hidden 锁死外层，滚动全部交给各 tab 内部的滚动容器。
  return (
    <div
      className="h-screen flex flex-col overflow-hidden bg-[#FAF7F4] text-slate-800"
      style={{ height: "100dvh" }}
    >
      {/* 2D 人形桌宠「暖言」：fixed 浮于内容之上，可拖动。
          非聊天 Tab 时 tuckToEdge：复用贴边睡眠飞到右缘，避免挡住日记 / 小屋 / 我的的主按钮；
          切回聊天再飞回隐藏前的位置。详见 components/WarmCompanion.jsx。 */}
      <WarmCompanion
        stressData={stressData}
        aiThinking={sending || pendingReply}
        tuckToEdge={activeTab !== "chat"}
      />
      {/* 顶部导航栏：暖玉瓷白毛玻璃，精致胶囊 Tab 切换 */}
      <header className="h-[56px] sm:h-[60px] shrink-0 flex items-center justify-between gap-2 px-2.5 sm:px-6 border-b border-[#eee4dc] dark:border-[#332A24] bg-[#FFF9F6]/95 dark:bg-[#1E1A17]/95 backdrop-blur-md z-30 transition-all">
        {/* 左上角 Logo：超窄屏只显示图标，>=410px 显示图标+文字标，永不重叠 */}
        <button
          type="button"
          onClick={() => {
            window.location.href = "/";
          }}
          className="flex items-center gap-1.5 sm:gap-2 shrink-0 group select-none cursor-pointer"
          title="回到首页"
        >
          <img
            src="/logo.png"
            alt="Solace Logo"
            className="w-7 h-7 sm:w-8 sm:h-8 object-contain transition-transform duration-300 group-hover:scale-105 drop-shadow-xs"
          />
          <img
            src="/solace-wordmark.png"
            alt="Solace"
            className="h-4 sm:h-5 w-auto object-contain mt-0.5 hidden min-[410px]:block"
            style={{ width: "auto" }}
          />
        </button>

        {/* 右侧导航 Tab：手机端紧凑自适应，>=380px 展开全称 */}
        <nav className="flex items-center gap-0.5 sm:gap-1 bg-[#f5ebe3]/65 dark:bg-[#27211E] p-0.5 sm:p-1 rounded-2xl border border-[#efe3d8]/80 dark:border-[#38302A] shrink-0">
          {[
            { id: "chat", icon: "💬", label: "聊天" },
            { id: "diary", icon: "📓", label: "日记" },
            { id: "firstaid", icon: "🏠", label: "治愈小屋", shortLabel: "小屋" },
            { id: "profile", icon: "👤", label: "我的" },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`px-2 min-[360px]:px-2.5 sm:px-4 py-1 sm:py-1.5 flex items-center gap-1 sm:gap-1.5 text-xs sm:text-sm rounded-xl transition-all duration-200 cursor-pointer whitespace-nowrap ${
                activeTab === t.id
                  ? "bg-white dark:bg-[#342A24] text-[#b85a3c] dark:text-[#EFA896] font-semibold shadow-xs"
                  : "text-slate-500 dark:text-[#9A8B83] hover:text-slate-800 dark:hover:text-[#F5DCD3] hover:bg-white/50 dark:hover:bg-white/5"
              }`}
            >
              <span className="text-xs sm:text-sm leading-none shrink-0">{t.icon}</span>
              {t.shortLabel ? (
                <>
                  <span className="hidden min-[380px]:inline">{t.label}</span>
                  <span className="inline min-[380px]:hidden">{t.shortLabel}</span>
                </>
              ) : (
                <span>{t.label}</span>
              )}
            </button>
          ))}
        </nav>
      </header>

      {/* 主内容区：随顶部导航切换视图，占满顶栏以下全部空间 */}
      <div className="flex-1 min-h-0">
        {/* 聊天视图：常驻 DOM，切 Tab 时用 hidden 隐藏，保留完整的滚动条位置与输入草稿，避免切回时跳到顶端 */}
        <div className={`h-full flex ${activeTab === "chat" ? "tab-fade" : "hidden"}`}>
          <div className="h-full flex flex-1 min-w-0">
            <Sidebar
              isMobile={isMobile}
              isSidebarOpen={isSidebarOpen}
              setIsSidebarOpen={setIsSidebarOpen}
              conversations={conversations}
              currentId={currentId}
              search={search}
              setSearch={setSearch}
              searchResults={searchResults}
              hint={hint}
              multiSelectMode={multiSelectMode}
              setMultiSelectMode={setMultiSelectMode}
              selectedIds={selectedIds}
              renamingId={renamingId}
              setRenamingId={setRenamingId}
              renameValue={renameValue}
              setRenameValue={setRenameValue}
              menuOpenId={menuOpenId}
              setMenuOpenId={setMenuOpenId}
              handleNewConversation={handleNewConversation}
              handleSelectAll={handleSelectAll}
              handleExitMultiSelect={handleExitMultiSelect}
              handlePinSelected={handlePinSelected}
              handleDeleteSelected={handleDeleteSelected}
              handleOpenResult={handleOpenResult}
              handleToggleSelect={handleToggleSelect}
              handleRename={handleRename}
              handleTogglePin={handleTogglePin}
              handleShare={handleShare}
              handleDelete={handleDelete}
              timeGroupLabel={timeGroupLabel}
              btnBase={btnBase}
              searchInputClass={searchInputClass}
            />
            <ChatView
              chatBgUrl={chatBgUrl}
              isSidebarOpen={isSidebarOpen}
              setIsSidebarOpen={setIsSidebarOpen}
              currentTitle={currentTitle}
              profile={profile}
              displayName={displayName}
              autoPlay={autoPlay}
              handleToggleAutoPlay={handleToggleAutoPlay}
              chatMenuOpen={chatMenuOpen}
              setChatMenuOpen={setChatMenuOpen}
              aiAvatarFileRef={aiAvatarFileRef}
              bgFileRef={bgFileRef}
              handleAiAvatarFileChange={handleAiAvatarFileChange}
              handleBgFileChange={handleBgFileChange}
              messages={messages}
              currentId={currentId}
              birthdayGreet={birthdayGreet}
              streamingReply={streamingReply}
              diaryReading={diaryReading}
              messagesLoading={messagesLoading}
              pendingReply={pendingReply}
              sending={sending}
              setInput={setInputWithDraft}
              pingWarmInput={pingWarmInput}
              messagesScrollRef={messagesScrollRef}
              handleMessagesScroll={handleMessagesScroll}
              bottomRef={bottomRef}
              messageRefs={messageRefs}
              bubbleHandlersRef={bubbleHandlersRef}
              revealedRef={revealedRef}
              pickSticker={pickSticker}
              ttsTagWords={ttsTagWords}
              highlightId={highlightId}
              aiBubbleBg={aiBubbleBg}
              avatarUrl={avatarUrl}
              regenId={regenId}
              ttsPlayingId={ttsPlayingId}
              ttsPlayingCk={ttsPlayingCk}
              ttsLoadingId={ttsLoadingId}
              personaAsking={personaAsking}
              setPersonaAsking={setPersonaAsking}
              handlePickPersona={handlePickPersona}
              input={input}
              handleSend={handleSend}
              setCallTarget={setCallTarget}
              btnBase={btnBase}
              inputClass={inputClass}
            />
          </div>
        </div>

        {/* 治愈小屋页：FirstAid + 性格探索 / 情绪自评，居中窄容器 */}
        {activeTab === "firstaid" && (
          <div className="tab-fade h-full overflow-y-auto px-4 py-8 flex justify-center">
            <div className="w-full max-w-[700px]">
              <HealingCottage
                userId={user?.id || user?.userId}
                onWantToTalk={() => setActiveTab("chat")}
              />
            </div>
          </div>
        )}

        {/* 日记页：头像 + 昵称 + 个性签名 + 新建 + 列表 */}
        {activeTab === "diary" && (
          <DiaryTab
            isMobile={isMobile}
            avatarUrl={avatarUrl}
            displayName={displayName}
            profile={profile}
            openBioModal={openBioModal}
            diaryTab={diaryTab}
            setDiaryTab={setDiaryTab}
            diaryTabList={diaryTabList}
            sortedDiaries={sortedDiaries}
            diaryView={diaryView}
            setDiaryView={setDiaryView}
            diaryCreating={diaryCreating}
            setDiaryCreating={setDiaryCreating}
            diaryEdit={diaryEdit}
            setDiaryEdit={setDiaryEdit}
            diaryMultiMode={diaryMultiMode}
            setDiaryMultiMode={setDiaryMultiMode}
            selectedDiaryIds={selectedDiaryIds}
            setSelectedDiaryIds={setSelectedDiaryIds}
            toggleDiaryMultiMode={toggleDiaryMultiMode}
            toggleDiarySelectAll={toggleDiarySelectAll}
            toggleDiarySelect={toggleDiarySelect}
            handleOpenDiary={handleOpenDiary}
            toggleDiaryFlag={toggleDiaryFlag}
            handleDeleteDiary={handleDeleteDiary}
            handlePinSelectedDiaries={handlePinSelectedDiaries}
            handleDeleteSelectedDiaries={handleDeleteSelectedDiaries}
            selectedDiariesAllPinned={selectedDiariesAllPinned}
            diaryTitle={diaryTitle}
            setDiaryTitle={setDiaryTitle}
            diaryContent={diaryContent}
            setDiaryContent={setDiaryContent}
            diaryMood={diaryMood}
            setDiaryMood={setDiaryMood}
            savingDiary={savingDiary}
            handleSaveDiary={handleSaveDiary}
            handleDiaryRelease={handleDiaryRelease}
            diaryEditTitle={diaryEditTitle}
            setDiaryEditTitle={setDiaryEditTitle}
            diaryEditContent={diaryEditContent}
            setDiaryEditContent={setDiaryEditContent}
            diaryEditMood={diaryEditMood}
            setDiaryEditMood={setDiaryEditMood}
            handleSaveEditDiary={handleSaveEditDiary}
            handleReadDiary={handleReadDiary}
            diaryReading={diaryReading}
            btnBase={btnBase}
            inputClass={inputClass}
          />
        )}



        {/* 「我的」页：朋友圈风格（主视图） + 设置子视图 */}
        {activeTab === "profile" && profileSubView === "main" && (
          <div className="tab-fade h-full overflow-y-auto">
            {/* 封面背景图 + 头像 + 昵称 + 签名 */}
            <div className="relative h-[160px] md:h-[200px] w-full overflow-hidden">
              {coverBg.avatarUrl ? (
                <img
                  src={coverBg.avatarUrl}
                  alt="封面"
                  className="absolute inset-0 w-full h-full object-cover"
                />
              ) : (
                <div className="absolute inset-0 bg-gradient-to-br from-[#fdf6f0] via-[#f5f9fc] to-[#e9f1f7]" />
              )}
              {/* 底部渐变遮罩，保证文字可读 */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-transparent" />

              {/* 右上角：更换封面（相机）+ 封面选项（⋯，仅自定义封面时显示） */}
              <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
                <button
                  onClick={coverBg.openPicker}
                  className="w-9 h-9 rounded-full bg-black/35 backdrop-blur-sm text-white flex items-center justify-center hover:bg-black/50 active:scale-95 transition-all"
                  title="更换封面"
                >
                  <svg
                    className="w-[18px] h-[18px]"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                </button>
                {coverBg.avatarUrl && (
                  <div className="relative">
                    <button
                      onClick={() => setCoverMenuOpen((v) => !v)}
                      className="w-9 h-9 rounded-full bg-black/35 backdrop-blur-sm text-white flex items-center justify-center hover:bg-black/50 active:scale-95 transition-all"
                      title="封面选项"
                    >
                      <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="5" cy="12" r="1.8" />
                        <circle cx="12" cy="12" r="1.8" />
                        <circle cx="19" cy="12" r="1.8" />
                      </svg>
                    </button>
                    {coverMenuOpen && (
                      <>
                        <div
                          className="fixed inset-0 z-10"
                          onClick={() => setCoverMenuOpen(false)}
                        />
                        <div className="absolute right-0 top-11 z-20 min-w-[150px] bg-white rounded-xl shadow-lg border border-[#e8eae7] py-1">
                          <button
                            onClick={handleResetCover}
                            className="w-full px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-[#f7fafb] transition-colors"
                          >
                            恢复默认封面
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* 封面错误提示（点击可关闭） */}
              {coverBg.msg && (
                <button
                  onClick={() => coverBg.setMsg("")}
                  className="absolute top-3 left-3 z-20 max-w-[60%] bg-black/60 text-white text-xs px-3 py-1.5 rounded-full truncate text-left"
                >
                  {coverBg.msg}
                </button>
              )}

              {/* 左下：头像 + 昵称 + 签名 */}
              <div className="absolute bottom-0 left-0 right-0 px-5 pb-4 flex items-end gap-4">
                <button
                  onClick={coverAvatar.openPicker}
                  className="relative w-16 h-16 rounded-full overflow-hidden border-[3px] border-white shadow-md shrink-0 hover:opacity-90 transition-opacity"
                  title="点击更换头像"
                >
                  {coverAvatar.avatarUrl ? (
                    <img
                      src={coverAvatar.avatarUrl}
                      alt="头像"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full bg-gradient-to-br from-[#b6cdd9] to-[#9db5c3] flex items-center justify-center text-white text-2xl font-bold">
                      {(profile?.username || user?.email || "我").charAt(0).toUpperCase()}
                    </div>
                  )}
                </button>
                <div className="min-w-0 pb-1">
                  <button
                    onClick={() => setProfileSubView("settings")}
                    className="text-lg font-bold text-white drop-shadow truncate block text-left hover:opacity-90"
                  >
                    {profile?.username || "未设置昵称"}
                  </button>
                  <button
                    onClick={() => setBioModalOpen(true)}
                    className="text-xs text-white/90 drop-shadow truncate block text-left mt-0.5 hover:opacity-90"
                  >
                    {profile?.bio || "写一句想说的话吧"}
                  </button>
                </div>
              </div>
            </div>

            {/* 功能入口卡片 */}
            <div className="px-4 py-4 grid grid-cols-2 md:grid-cols-4 gap-3">
              <button
                onClick={() => setActiveTab("diary")}
                className="bg-white rounded-2xl shadow-sm border border-[#e8eae7] px-4 py-4 flex items-center gap-3 hover:bg-[#f7fafb] transition-colors"
              >
                <span className="text-2xl">📓</span>
                <div className="text-left">
                  <p className="text-sm font-medium text-slate-700">写日记</p>
                  <p className="text-xs text-slate-400">记录此刻心情</p>
                </div>
              </button>
              <button
                onClick={() => setFavoritesOpen(true)}
                className="bg-white rounded-2xl shadow-sm border border-[#e8eae7] px-4 py-4 flex items-center gap-3 hover:bg-[#f7fafb] transition-colors"
              >
                <span className="text-2xl">⭐</span>
                <div className="text-left">
                  <p className="text-sm font-medium text-slate-700">我的收藏</p>
                  <p className="text-xs text-slate-400">
                    {favDiaries.length > 0 ? `已收藏 ${favDiaries.length} 篇` : "还没有收藏"}
                  </p>
                </div>
              </button>
              <button
                onClick={() => setTrashOpen(true)}
                className="bg-white rounded-2xl shadow-sm border border-[#e8eae7] px-4 py-4 flex items-center gap-3 hover:bg-[#f7fafb] transition-colors"
              >
                <span className="text-2xl">🗑️</span>
                <div className="text-left">
                  <p className="text-sm font-medium text-slate-700">回收站</p>
                  <p className="text-xs text-slate-400">删除的内容保留 3 天</p>
                </div>
              </button>
              <button
                onClick={() => setProfileSubView("settings")}
                className="bg-white rounded-2xl shadow-sm border border-[#e8eae7] px-4 py-4 flex items-center gap-3 hover:bg-[#f7fafb] transition-colors"
              >
                <span className="text-2xl">⚙️</span>
                <div className="text-left">
                  <p className="text-sm font-medium text-slate-700">设置</p>
                  <p className="text-xs text-slate-400">账号与偏好</p>
                </div>
              </button>
              <button
                onClick={openMemories}
                className="bg-white rounded-2xl shadow-sm border border-[#e8eae7] px-4 py-4 flex items-center gap-3 hover:bg-[#f7fafb] transition-colors"
              >
                <span className="text-2xl">🧠</span>
                <div className="text-left">
                  <p className="text-sm font-medium text-slate-700">记忆库</p>
                  <p className="text-xs text-slate-400">AI 会慢慢了解你</p>
                </div>
              </button>
            </div>

            {/* 统计卡片 */}
            <div className="px-4 pb-4">
              <div className="bg-white rounded-2xl shadow-sm border border-[#e8eae7] px-4 py-4">
                <div className="grid grid-cols-3 text-center">
                  {[
                    { value: stats.days, unit: "天", label: "陪伴天数" },
                    { value: stats.diaries, unit: "篇", label: "日记篇数" },
                    { value: stats.todayMsgs, unit: "条", label: "今日对话" },
                  ].map((s) => (
                    <div key={s.label}>
                      <p className="text-xl font-bold text-[#5b8aa6]">
                        {s.value === null ? "—" : `${s.value} ${s.unit}`}
                      </p>
                      <p className="text-xs text-[#a87c8e] mt-1">{s.label}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* 关于 Solace */}
            <div className="px-4 pb-6">
              <button
                onClick={() => setAboutOpen(true)}
                className="bg-white rounded-2xl shadow-sm border border-[#e8eae7] px-4 py-3 w-full flex items-center justify-between hover:bg-[#f7fafb] transition-colors duration-150"
              >
                <span className="text-sm text-slate-700">关于 Solace</span>
                <svg
                  className="w-4 h-4 text-slate-400"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            </div>

            {/* 封面头像隐藏 file input */}
            <input
              ref={coverAvatar.fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={coverAvatar.handleFileChange}
            />

            {/* 封面背景隐藏 file input */}
            <input
              ref={coverBg.fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={coverBg.handleFileChange}
            />
          </div>
        )}

        {/* 设置子视图 */}
        {activeTab === "profile" && profileSubView === "settings" && (
          <div className="tab-fade h-full overflow-y-auto">
            {/* 顶部返回栏（移动端固定） */}
            <div className="sticky top-0 z-10 bg-[#fafaf8]/90 dark:bg-[#1C1917]/90 backdrop-blur border-b border-[#e8eae7] dark:border-[#332A24] px-4 py-3 flex items-center">
              <button
                onClick={() => setProfileSubView("main")}
                className="flex items-center gap-1 text-sm text-slate-600 dark:text-[#E8D5CC] hover:text-[#5b8aa6] dark:hover:text-[#F5DCD3] transition-colors"
              >
                <svg
                  className="w-4 h-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="15 18 9 12 15 6" />
                </svg>
                返回
              </button>
              <span className="ml-3 text-sm font-medium text-slate-700 dark:text-[#F5DCD3]">设置</span>
            </div>

            <div className="max-w-xl mx-auto px-4 py-5">
              <div className="bg-white dark:bg-[#231E1B] rounded-2xl shadow-sm border border-[#e8eae7] dark:border-[#382F28] p-5">
                <ProfileView
                  user={user}
                  profile={profile}
                  onSaved={() => user && loadProfile()}
                  bioValue={bioInput}
                  onBioChange={setBioInput}
                  onSaveBio={handleSaveBio}
                  bioSaving={savingBio}
                  bioMsg={bioMsg}
                  hideSignOut
                  hideAvatar
                />
              </div>

              {/* 退出登录（移到设置页底部） */}
              <button
                onClick={() => setSignOutConfirm(true)}
                className="mt-4 bg-white dark:bg-[#231E1B] rounded-2xl shadow-sm border border-[#e8eae7] dark:border-[#382F28] py-3 w-full text-red-500 dark:text-red-400 text-sm hover:bg-red-50 dark:hover:bg-red-950/20 hover:border-red-200 dark:hover:border-red-900/40 transition-colors duration-150"
              >
                退出登录
              </button>
            </div>
          </div>
        )}

      </div>

      {/* 统一外挂弹窗管理器（ModalManager）：将十多个外挂弹窗、裁剪器及输入控件集中解耦，
          由 React.memo 隔离，避免聊天打字与流式渲染时的无谓比对 */}
      <ChatModals
        trashOpen={trashOpen}
        setTrashOpen={setTrashOpen}
        apiRequest={apiRequest}
        deleteAsk={deleteAsk}
        deleteBusy={deleteBusy}
        setDeleteAsk={setDeleteAsk}
        handleDeleteChoiceTrash={async () => {
          const ask = deleteAsk;
          setDeleteBusy(true);
          try {
            if (ask?.kind === "diary") await performDeleteDiary(ask.item, true);
            if (ask?.kind === "memory") await performDeleteMemory(ask.item, true);
            if (ask?.kind === "memory-batch") await performDeleteMemoryBatch(ask.item.ids, true);
          } finally {
            setDeleteBusy(false);
            setDeleteAsk(null);
          }
        }}
        handleDeleteChoicePermanent={async () => {
          const ask = deleteAsk;
          setDeleteBusy(true);
          try {
            if (ask?.kind === "diary") await performDeleteDiary(ask.item, false);
            if (ask?.kind === "memory") await performDeleteMemory(ask.item, false);
            if (ask?.kind === "memory-batch") await performDeleteMemoryBatch(ask.item.ids, false);
          } finally {
            setDeleteBusy(false);
            setDeleteAsk(null);
          }
        }}
        signOutConfirm={signOutConfirm}
        setSignOutConfirm={setSignOutConfirm}
        handleSignOut={handleSignOut}
        confirmState={confirmState}
        setConfirmState={setConfirmState}
        favoritesOpen={favoritesOpen}
        setFavoritesOpen={setFavoritesOpen}
        favDiaries={favDiaries}
        handleOpenFavDiary={(d) => {
          setFavoritesOpen(false);
          setActiveTab("diary");
          setDiaryCreating(false);
          handleOpenDiary(d);
        }}
        memoriesOpen={memoriesOpen}
        setMemoriesOpen={setMemoriesOpen}
        memories={memories}
        memoriesLoading={memoriesLoading}
        memoryTotal={memoryTotal}
        memoryTruncated={memoryTruncated}
        addMemory={addMemory}
        updateMemory={updateMemory}
        restoreMemory={restoreMemory}
        deleteMemory={deleteMemory}
        handleTalkAboutMemory={(m) => {
          if (!m?.content) return;
          setMemoriesOpen(false);
          setActiveTab("chat");
          const intro =
            m.category === "wish"
              ? `我想和你聊聊我的心愿：“${m.content}”，你还记得吗？`
              : m.category === "preference"
              ? `今天突然想到你记下的：“${m.content}”，想找你说说话~`
              : `我想和你聊聊关于“${m.content}”这件事…`;
          setInput(intro);
          pingWarmInput();
        }}
        handleWriteDiaryFromMemory={(m) => {
          if (!m?.content) return;
          setMemoriesOpen(false);
          setActiveTab("diary");
          setDiaryView(null);
          setDiaryEdit(false);
          setDiaryCreating(true);
          const shortTitle = m.content.length > 14 ? m.content.slice(0, 14) + "…" : m.content;
          setDiaryTitle(`关于「${shortTitle}」的心境`);
          setDiaryContent(`今天又回想起了这颗记忆星芒：\n“${m.content}”\n\n写在这里，静静珍藏。\n`);
          setDiaryMood(m.category === "wish" || m.category === "emotion" ? "安稳" : "平静");
        }}
        stressPopup={stressPopup}
        setStressPopup={setStressPopup}
        setStressData={setStressData}
        stressPing={stressPing}
        respondStressPopup={respondStressPopup}
        bgCropSrc={bgCropSrc}
        setBgCropSrc={setBgCropSrc}
        uploadingBg={uploadingBg}
        handleBgCropped={handleBgCropped}
        aiAvatarCropSrc={aiAvatarCropSrc}
        setAiAvatarCropSrc={setAiAvatarCropSrc}
        uploadingAvatar={uploadingAvatar}
        handleAiAvatarCropped={handleAiAvatarCropped}
        coverAvatar={coverAvatar}
        coverBg={coverBg}
        bioModalOpen={bioModalOpen}
        setBioModalOpen={setBioModalOpen}
        bioInput={bioInput}
        setBioInput={setBioInput}
        savingBio={savingBio}
        bioMsg={bioMsg}
        handleSaveBio={handleSaveBio}
        aboutOpen={aboutOpen}
        setAboutOpen={setAboutOpen}
        callTarget={callTarget}
        setCallTarget={setCallTarget}
        diaries={diaries}
        activeTab={activeTab}
        handleOpenMorningDiary={handleOpenMorningDiary}
        companionCardOpen={companionCardOpen}
        setCompanionCardOpen={setCompanionCardOpen}
        companionCardData={companionCardData}
        bgFileRef={bgFileRef}
        handleBgFileChange={handleBgFileChange}
        aiAvatarFileRef={aiAvatarFileRef}
        handleAiAvatarFileChange={handleAiAvatarFileChange}
      />
    </div>
  );
}
