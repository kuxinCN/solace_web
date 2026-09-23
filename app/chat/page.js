"use client";

import { useEffect, useRef, useState } from "react";
import HealingCottage from "@/components/HealingCottage";
import ConfirmModal from "@/components/ConfirmModal";
import ProfileView from "@/components/ProfileView";
import BioModal from "@/components/BioModal";
import AboutModal from "@/components/AboutModal";
import ImageCropper from "@/components/ImageCropper";

// 统一的数据请求封装：所有后端 REST 调用都走这里
async function apiRequest(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
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

const btnBase =
  "border border-[#d5d9d7] bg-[#fdfdfc] text-slate-700 rounded-lg hover:bg-[#e8eff2] hover:text-slate-900 active:bg-[#dbe6ea] active:scale-[0.98] transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed";

const inputClass =
  "w-full border border-[#d5d9d7] bg-white p-2 text-sm text-gray-800 placeholder-gray-400 rounded-lg transition-colors duration-150 focus:outline-none focus:border-[#8fb3c7] focus:ring-1 focus:ring-[#8fb3c7]";

// 搜索框：圆角 + 左侧留出放大镜图标的位置
const searchInputClass =
  "w-full border border-[#d5d9d7] bg-white py-2 pl-9 pr-3 text-sm text-gray-800 placeholder-gray-400 rounded-full transition-colors duration-150 focus:outline-none focus:border-[#8fb3c7] focus:ring-1 focus:ring-[#8fb3c7]";

// AI 人设：完全共情、倾听优先的情绪陪伴者
const SYSTEM_PROMPT = `你是一位温柔的情绪陪伴者，不是心理咨询师，也不是老师。

你的最高原则是：先接住情绪，再谈其他。
1. 用户倾诉时，你的第一句话必须先回应他的感受，让他觉得被听见。例如："听起来你真的很累，想哭就哭吧，我在这里。""这件事憋在心里很久了吧，谢谢你愿意说给我听。"
2. 严禁生搬硬套心理学理论、教科书概念、专业术语或数据事实。不要说"这是典型的焦虑表现""建议你尝试认知重构""研究表明……"这类话。
3. 不讲大道理，不给人生建议，不评判对错，不催他振作、不要急着让他"好起来"。用户需要的不是解决方案，而是有人陪着。
4. 语气像认识很久的老朋友：温暖、自然、口语化、有温度。可以用"嗯""我在""慢慢说"这样简短的回应。
5. 多用一句问一句的节奏，把话头轻轻递回给用户，让他愿意继续说下去。
6. 回复要短，通常两三句话就够，不要长篇大论。
7. 每句话控制在 20 字以内，如果需要说多句话，请用换行符 \n 分隔，不要写成一大段。`;

// 读日记时的额外指令（只发给 AI，不存进数据库）
const DIARY_INSTRUCTION = `你刚刚读了用户的日记，请以陪伴者身份自然地回应。可以自然引用日记里的具体细节或情绪（比如"你提到今天很累""你写的那段话我记下了"），然后给予一定安慰，并向用户表示如果可以继续倾诉。不要逐句复述原文。回复不超过 60 字，要具体、有温度，不要用通用套话。`;

// 把 AI 回复按 \n 切成多个短消息段，过滤空段；用于"真人连发短消息"效果
function splitAiSegments(content) {
  if (!content) return [];
  return content
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 流式 TTS 分句参数
const SENT_MIN = 4; // 短于 4 个字的句子先与下一句合并，避免碎片语音
const SENT_MAX = 60; // 无标点超过 60 字强制切分，避免长句等太久
// 首句快速通道（降低"发送→出声"延迟）：第一个句子不必等句号。
const EAGER_SOFT = 9; // 首句累积到 9 字：窗口内有逗号就在逗号后切，TTS 立刻开始
const EAGER_HARD = 15; // 首句到 15 字仍无逗号：硬切一次（罕见兜底，SYSTEM_PROMPT 要求多逗号）
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
    if (remaining.length >= EAGER_SOFT) {
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
  if (flush && remaining.trim()) sentences.push(remaining);
  return { sentences, rest: flush ? "" : remaining };
}

// 对话活动时间（last_message_at）的友好标签：
// 今天 / 昨天 / X天前 / 具体日期（今年 M/D，跨年 YYYY/M/D）。
// 侧边栏行内时间与分组标题共用，保证两处口径一致。
function friendlyTimeLabel(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today - that) / 86400000);
  if (diffDays <= 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays <= 6) return `${diffDays}天前`;
  return d.getFullYear() === now.getFullYear()
    ? `${d.getMonth() + 1}/${d.getDate()}`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

// 截取命中关键词附近的一小段文字，用于搜索结果预览
function snippetAround(content, keyword) {
  const text = content || "";
  const idx = text.toLowerCase().indexOf(keyword);
  if (idx < 0) return text.slice(0, 30);
  const start = Math.max(0, idx - 8);
  const end = Math.min(text.length, idx + keyword.length + 20);
  return (start > 0 ? "…" : "") + text.slice(start, end);
}

// 日期格式化为 "2026年9月18日"
function formatDateCN(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}


// dataURL 转 Blob（上传聊天背景 / AI 头像用）
function dataUrlToBlob(dataUrl) {
  const [meta, base64] = dataUrl.split(",");
  const mime = meta.match(/:(.*?);/)[1];
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// AI 头像：优先用户自定义（profiles.ai_avatar_url），否则默认渐变圆形
function AiAvatar({ url }) {
  if (url) {
    return (
      <img
        src={url}
        alt="AI"
        className="w-8 h-8 shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <div className="w-8 h-8 shrink-0 rounded-full bg-gradient-to-br from-[#a9c6da] to-[#c3b4d6] flex items-center justify-center text-white text-sm font-bold">
      S
    </div>
  );
}

function UserAvatar({ url, name }) {
  if (url) {
    return (
      <img
        src={url}
        alt="我"
        className="w-8 h-8 shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <div className="w-8 h-8 shrink-0 rounded-full bg-gradient-to-br from-[#b6cdd9] to-[#9db5c3] flex items-center justify-center text-white text-sm font-bold">
      {(name || "我").charAt(0).toUpperCase()}
    </div>
  );
}

// 单条对话行：复选框(多选) / 标题(或重命名输入框) / 摘要 / 时间 / ··· 菜单
function ConvRow({
  c,
  snippet,
  selected,
  multi,
  currentId,
  renaming,
  renameValue,
  menuOpen,
  onOpen,
  onToggleSelect,
  onMenu,
  onRename,
  onRenameCommit,
  onRenameCancel,
  setRenameValue,
  onPin,
  onMultiSelect,
  onShare,
  onDelete,
  closeMenu,
}) {
  const timeLabel = friendlyTimeLabel(c.last_message_at || c.created_at);

  return (
    <div
      onClick={multi ? onToggleSelect : onOpen}
      className={`group relative flex items-center gap-1.5 rounded-lg p-2 mb-0.5 cursor-pointer transition-colors duration-150 ${
        multi && selected
          ? "bg-[#dbeaf2] text-slate-900"
          : c.id === currentId
          ? "bg-[#e3edf2] text-slate-900 font-medium"
          : "text-slate-700 hover:bg-[#eef1f2]"
      }`}
    >
      {/* 多选复选框 */}
      {multi && (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
          className="w-4 h-4 accent-[#7fa3b8] shrink-0"
        />
      )}

      {/* 主体：标题 / 重命名输入框 + 摘要 */}
      <div className="min-w-0 flex-1">
        {renaming ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRenameCommit(c.id);
              if (e.key === "Escape") onRenameCancel();
            }}
            className="w-full border border-[#8fb3c7] rounded px-1.5 py-0.5 text-sm bg-white outline-none"
          />
        ) : (
          <p className="truncate text-sm">{c.title}</p>
        )}
        {snippet && !renaming && (
          <p className="text-xs text-slate-400 truncate font-normal">{snippet}</p>
        )}
      </div>

      {/* 右侧：时间 + ··· 菜单（多选/重命名时隐藏） */}
      {!multi && !renaming && (
        <div className="flex items-center gap-1 shrink-0">
          {timeLabel && (
            <span className="text-[10px] text-slate-400">{timeLabel}</span>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMenu();
            }}
            title="更多操作"
            className="text-slate-400 hover:text-slate-700 px-1 rounded transition-colors duration-150"
          >
            ⋯
          </button>
        </div>
      )}

      {/* 下拉菜单 */}
      {menuOpen && !multi && !renaming && (
        <>
          <div className="fixed inset-0 z-40" onClick={closeMenu} />
          <div className="absolute right-0 top-8 z-50 w-32 bg-white rounded-lg shadow-lg border border-[#e8eae7] py-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRename(c);
              }}
              className="w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-[#eef1f2]"
            >
              重命名
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onPin(c.id);
              }}
              className="w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-[#eef1f2]"
            >
              {c.pinned ? "取消置顶" : "置顶"}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onShare(c);
              }}
              className="w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-[#eef1f2]"
            >
              分享
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onMultiSelect();
              }}
              className="w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-[#eef1f2]"
            >
              多选
            </button>
            <div className="my-0.5 border-t border-[#e8eae7]" />
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(c.id);
              }}
              className="w-full text-left px-3 py-1.5 text-sm text-[#c0654a] hover:bg-[#fbeee8]"
            >
              删除
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// 置顶区 + 时间轴分组布局
function ConversationGroups({
  conversations,
  multiSelectMode,
  selectedIds,
  currentId,
  renamingId,
  renameValue,
  menuOpenId,
  timeGroupLabel,
  onOpen,
  onToggleSelect,
  setMenuOpenId,
  setRename,
  onRename,
  onRenameCommit,
  onRenameCancel,
  onPin,
  onMultiSelect,
  onShare,
  onDelete,
}) {
  const pinned = conversations
    .filter((c) => c.pinned)
    .sort((a, b) => new Date(b.pinned_at || 0) - new Date(a.pinned_at || 0));
  const unpinned = conversations
    .filter((c) => !c.pinned)
    .sort(
      (a, b) =>
        new Date(b.last_message_at || b.created_at || 0) -
        new Date(a.last_message_at || a.created_at || 0)
    );

  // 按活动时间标签分组
  const groups = {};
  for (const c of unpinned) {
    const label = timeGroupLabel(c.last_message_at || c.created_at);
    if (!groups[label]) groups[label] = [];
    groups[label].push(c);
  }

  const renderRow = (c) => (
    <ConvRow
      key={c.id}
      c={c}
      snippet=""
      selected={selectedIds.includes(c.id)}
      multi={multiSelectMode}
      currentId={currentId}
      renaming={renamingId === c.id}
      renameValue={renameValue}
      menuOpen={menuOpenId === c.id}
      onOpen={() => onOpen(c)}
      onToggleSelect={() => onToggleSelect(c.id)}
      onMenu={() => setMenuOpenId(menuOpenId === c.id ? null : c.id)}
      onRename={() => onRename(c)}
      onRenameCommit={() => onRenameCommit(c.id)}
      onRenameCancel={onRenameCancel}
      setRenameValue={setRename}
      onPin={() => onPin(c.id)}
      onMultiSelect={onMultiSelect}
      onShare={() => onShare(c)}
      onDelete={() => onDelete(c.id)}
      closeMenu={() => setMenuOpenId(null)}
    />
  );

  return (
    <>
      {/* 置顶区 */}
      {pinned.length > 0 && (
        <div className="mb-1">
          <p className="text-[11px] text-slate-400 px-2 py-1">置顶</p>
          {pinned.map(renderRow)}
          <div className="border-t border-[#e0e3e0] my-1.5 mx-2" />
        </div>
      )}

      {/* 时间轴分组 */}
      {Object.keys(groups).map((label) => (
        <div key={label} className="mb-1">
          <p className="text-[11px] text-slate-400 px-2 py-1">{label}</p>
          {groups[label].map(renderRow)}
          <div className="border-t border-[#eceee9] my-1 mx-2" />
        </div>
      ))}
    </>
  );
}

export default function Chat() {
  const [user, setUser] = useState(null);
  // 认证检查中：session 接口返回前不渲染聊天界面、不跳转，避免登录后闪烁回登录页
  const [authLoading, setAuthLoading] = useState(true);
  const [conversations, setConversations] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
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
  }, [autoPlay]);
  // 离开聊天页：停掉自动队列（中止请求 / 撤销 URL / 暂停音频），避免泄漏与后台出声。
  // stopAutoSession 只操作 refs 与稳定的 setState，首次渲染的闭包即可安全使用。
  useEffect(() => {
    return () => {
      stopAutoSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [hint, setHint] = useState("");
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [search, setSearch] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [profile, setProfile] = useState(null);
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
  const [savingDiary, setSavingDiary] = useState(false);
  const [diaries, setDiaries] = useState([]);
  const [diaryView, setDiaryView] = useState(null); // 当前查看的日记对象
  const [diaryEdit, setDiaryEdit] = useState(false); // 详情是否处于编辑态
  const [diaryEditTitle, setDiaryEditTitle] = useState("");
  const [diaryEditContent, setDiaryEditContent] = useState("");
  // 小屏日记页：点击「＋ 写日记」后右栏显示新建表单（桌面默认右栏即新建表单）
  const [diaryCreating, setDiaryCreating] = useState(false);
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
    revealedRef.current[ck] = splitAiSegments(fullText).length;
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

  // 个性签名：我的页编辑，日记页展示（存 profiles.bio）
  const [bioInput, setBioInput] = useState("");
  const [savingBio, setSavingBio] = useState(false);
  const [bioMsg, setBioMsg] = useState("");
  // 日记页顶部卡片的签名编辑弹窗
  const [bioModalOpen, setBioModalOpen] = useState(false);

  // 设置面板：聊天背景 / AI 头像
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uploadingBg, setUploadingBg] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  // 背景待裁剪原图 dataURL；非空时弹出裁剪弹窗（16:9）
  const [bgCropSrc, setBgCropSrc] = useState(null);
  // AI 头像待裁剪原图 dataURL；非空时弹出裁剪弹窗（圆形 1:1）
  const [aiAvatarCropSrc, setAiAvatarCropSrc] = useState(null);

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
        window.location.href = "/";
        return;
      }
      setAuthLoading(false);
      setUser(session.user);
      await loadProfile(session.user.id);
      await loadConversations(session.user.id);
      await loadMessageIndex(session.user.id);
      await loadDiaries(session.user.id);
    }
    init();
  }, []);

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
    if (activeTab === "profile") setBioInput(profile?.bio || "");
  }, [activeTab, profile?.bio]);

  // 进入「我的」页时加载/刷新数据统计
  useEffect(() => {
    if (activeTab === "profile" && user?.id) loadProfileStats(user.id);
  }, [activeTab, user?.id]);

  // 定位到搜索命中的消息；没有待定位目标时保持滚动到底部
  useEffect(() => {
    if (scrollTarget) {
      const el = messageRefs.current[scrollTarget];
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setScrollTarget(null);
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pendingReply, scrollTarget, streamingReply]);

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

  async function loadConversations(userId) {
    try {
      const data = await apiRequest("/api/user/conversations");
      setConversations(data.conversations || []);
    } catch {
      setConversations([]);
    }
  }

  async function loadMessages(conversationId) {
    try {
      const data = await apiRequest(
        `/api/user/messages?conversationId=${encodeURIComponent(conversationId)}`
      );
      setMessages(data.messages || []);
    } catch {
      setMessages([]);
    }
  }

  // profiles 表通过 user_id 关联 auth 用户 id
  async function loadProfile(userId) {
    try {
      const data = await apiRequest("/api/user/profile");
      const p = data.profile || null;
      setProfile(p);
      // 头像优先于旧 localStorage 头像
      if (p?.avatar_url) setAvatarUrl(p.avatar_url);
    } catch {
      setProfile(null);
    }
  }

  // 搜索索引：只取必要字段，用于按消息内容匹配
  async function loadMessageIndex(userId) {
    try {
      const data = await apiRequest("/api/user/message-index");
      setMessageIndex(data.messages || []);
    } catch {
      setMessageIndex([]);
    }
  }

  // 加载当前用户全部日记，按时间倒序
  async function loadDiaries(userId) {
    try {
      const data = await apiRequest("/api/user/diaries");
      setDiaries(data.diaries || []);
    } catch {
      setDiaries([]);
    }
  }

  // 流式调用 /api/chat（SSE）：每收到一段文字就回调 onDelta(full)，最后返回完整回复
  // 流中断时保留已收到的部分；一字未收到时回退到失败文案
  async function askAI(history, onDelta) {
    let fullReply = "";
    try {
      const payload = { messages: history, stream: true };
      // 当前对话读过日记时，把正文作为上下文带给 AI，支持追问回顾（普通聊天无此字段）
      const ctx = diaryContextRef.current[currentId];
      if (ctx) payload.diaryContext = ctx;
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok || !res.body) {
        return fullReply || "我暂时无法回应，请稍后再试。";
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
            const delta = parsed?.delta;
            if (delta) {
              fullReply += delta;
              onDelta?.(fullReply);
            }
          } catch (e) {
            // 忽略单行解析错误
          }
        }
      }
    } catch (err) {
      // 流中断：保留已收到的部分，不清空
    }
    return fullReply || "我暂时无法回应，请稍后再试。";
  }

  // 用 AI 提取首条消息的主题作为对话标题（5-10 字）
  async function generateTitle(text) {
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              role: "system",
              content:
                "你是标题生成器。用5-10个汉字总结用户消息的主题，只返回标题文字本身，不要加引号、标点、解释或前后缀。如果用户消息是无意义内容（如单个数字、单个字、只有标点、'嗯''1''啊'等），直接原样返回用户消息内容。",
            },
            { role: "user", content: text },
          ],
        }),
      });
      const data = await res.json();
      const title = (data?.reply || "").trim().replace(/["'"「」]/g, "");
      return title || text.slice(0, 15);
    } catch (err) {
      return text.slice(0, 15);
    }
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
    setMessages([]);
    setScrollTarget(null);
    setHighlightId("");
    setStreamingReply("");
    setDiaryReading(false);
    // 新对话模式没有对应气泡，停掉上一条可能还在播的自动队列
    stopAutoSession();
    // 输入框里已打的字保留：它将属于接下来的新对话
  }

  async function handleSelect(id) {
    setHint("");
    setScrollTarget(null);
    setHighlightId("");
    setCurrentId(id);
    stopAutoSession(); // 切换对话：旧回复语音不再继续
    await loadMessages(id);
  }

  // 打开搜索结果：切换对话并定位到命中的那条消息
  async function handleOpenResult(result) {
    const id = result.conversation.id;
    setHint("");
    setCurrentId(id);
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
      setMessages([]);
    }
    showHint("正在删除…");
    try {
      await apiRequest(`/api/user/conversations?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
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
      created_at: new Date().toISOString(),
    };
    setDiaries((prev) => [optimistic, ...prev]);
    setDiaryTitle("");
    setDiaryContent("");
    showHint("正在保存…");
    try {
      const res = await apiRequest("/api/user/diaries", {
        method: "POST",
        body: { title, content },
      });
      const diary = res.diary;
      if (!diary) throw new Error("保存日记失败");
      setDiaries((prev) => prev.map((d) => (d.id === tempId ? { ...d, ...diary } : d)));
      setDiaryCreating(false);
      if (andSend) {
        // 先提示，再进入 AI 阅读流程（内部会切到聊天 tab 并流式输出）
        showHint("已保存并发送给 AI");
        await readDiaryFlow(diary, true);
      } else {
        showHint("日记已保存");
      }
    } catch (err) {
      setDiaries((prev) => prev.filter((d) => d.id !== tempId));
      setDiaryTitle(title);
      setDiaryContent(content);
      showHint("保存日记失败：" + err.message);
    } finally {
      setSavingDiary(false);
    }
  }

  // 打开某篇日记到详情弹窗
  function handleOpenDiary(d) {
    setDiaryView(d);
    setDiaryEdit(false);
    setDiaryEditTitle("");
    setDiaryEditContent("");
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
    const updated = { ...diaryView, title, content };
    setDiaryView(updated);
    setDiaries((prev) =>
      prev.map((d) => (d.id === diaryView.id ? updated : d))
    );
    setSavingDiary(true);
    showHint("正在更新…");
    try {
      await apiRequest("/api/user/diaries", {
        method: "PATCH",
        body: { id: diaryView.id, title, content },
      });
      setDiaryEdit(false);
      showHint("日记已更新");
    } catch (err) {
      setDiaryView(oldDiary);
      setDiaries((prev) =>
        prev.map((d) => (d.id === oldDiary.id ? oldDiary : d))
      );
      showHint("更新失败：" + err.message);
    } finally {
      setSavingDiary(false);
    }
  }

  // 删除日记：二次确认 + 乐观删除（d 可选：从列表卡片删除时传入，详情页删除走 diaryView）
  function handleDeleteDiary(d) {
    const target = d || diaryView;
    if (!target) return;
    setConfirmState({
      message: "确定删除这篇日记吗？删除后无法恢复。",
      onConfirm: () => {
        setConfirmState(null);
        doDeleteDiary(target);
      },
    });
  }

  async function doDeleteDiary(target) {
    const diary = target || diaryView;
    if (!diary) return;
    const removed = { ...diary };
    const removedId = diary.id;
    setDiaryView(null);
    setDiaryEdit(false);
    setDiaries((prev) => prev.filter((d) => d.id !== removedId));
    showHint("正在删除…");
    try {
      await apiRequest(`/api/user/diaries?id=${encodeURIComponent(removedId)}`, {
        method: "DELETE",
      });
      showHint("日记已删除");
    } catch (err) {
      setDiaries((prev) => [removed, ...prev]);
      setDiaryView(removed);
      showHint("删除失败：" + err.message);
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
        setConversations((prev) => [conv, ...prev]);
        // 新对话：清空聊天区，避免残留上一个对话的消息
        setMessages([]);
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
      // 用户消息保持简短；完整正文通过 diaryContext 字段单独注入
      { role: "user", content: `我写了一篇日记：《${diary.title}》\n\n${DIARY_INSTRUCTION}` },
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
    let interrupted = false;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history,
          stream: true,
          diaryContext: diary.content,
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
              const delta = parsed?.delta;
              if (delta) {
                fullReply += delta;
                updateAiStream(aiCk, fullReply);
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
    // 流结束：剩余分段全部发出
    finishReveal(aiCk, fullReply);
    if (!fullReply) fullReply = "我在。";

    // 4) AI 回复落库（中断时标注），成功后气泡就地转正
    const replyToSave = interrupted ? `${fullReply}（回复中断）` : fullReply;
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
        // ck 不变，同一气泡原地变为真实记录，零闪烁
        setMessages((prev) =>
          prev.map((m) => (m.ck === aiCk ? { ...aiMsg, ck: aiCk } : m))
        );
      } catch (err) {
        dbOk = false;
      }
    }

    setDiaryReading(false);

    // 5) 不再全量 loadMessages：界面数据已是最新
    if (!dbOk) showHint("日记已保存，但对话记录同步失败");
    // 搜索索引后台更新，不阻塞界面（与 handleSend 保持一致）
    void loadMessageIndex(user.id);
  }

  // 退出登录
  async function handleSignOut() {
    await apiRequest("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
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
      window.location.href = "/";
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
  async function loadProfileStats(userId) {
    try {
      const data = await apiRequest("/api/user/stats");
      const s = data.stats || {};
      setStats({
        days: s.days ?? 0,
        diaries: s.diaryCount ?? 0,
        todayMsgs: s.todayMessages ?? 0,
      });
    } catch (err) {
      setStats({ days: 0, diaries: 0, todayMsgs: 0 });
    }
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    if (!user) return;

    setSending(true);
    setInput("");
    setPendingReply(true);
    setScrollTarget(null);
    // 切换对话/发送时清掉上一轮的日记阅读输出
    setStreamingReply("");
    setDiaryReading(false);
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
        setConversations((prev) => [created, ...prev]);
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

    // 首条消息自动命名：用 AI 提取主题（仅在该对话的第一条消息时执行一次）
    if (messages.length === 0) {
      const title = await generateTitle(text);
      try {
        await apiRequest("/api/user/conversations", {
          method: "PATCH",
          body: { id: convId, title },
        });
      } catch (err) {
        // 标题更新失败不阻塞主流程
      }
      // 本地更新标题，不再全量 loadConversations
      setConversations((prev) =>
        prev.map((c) => (c.id === convId ? { ...c, title } : c))
      );
    }

    const history = [
      { role: "system", content: SYSTEM_PROMPT },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
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

    const reply = await askAI(history, (full) => updateAiStream(aiCk, full));
    // 流结束：把剩余分段全部发出
    finishReveal(aiCk, reply);

    // 流结束（含中途断开）：最终文本落库，再把气泡就地转正
    let aiMsg = null;
    try {
      const res = await apiRequest("/api/user/messages", {
        method: "POST",
        body: { conversationId: convId, role: "assistant", content: reply },
      });
      aiMsg = res.message;
      // AI 回复落库，活动时间同步为回复时间（已在顶部，保持时间准确）
      bumpConversationLocal(convId, aiMsg.created_at);
    } catch (err) {
      aiMsg = null;
    }

    if (!aiMsg) {
      // 落库失败：界面文字保留（断流部分也保留），仅提示
      showHint("回复已生成，但保存失败");
    } else {
      // 就地转正：ck 不变，同一气泡原地变为真实记录，零闪烁
      setMessages((prev) =>
        prev.map((m) => (m.ck === aiCk ? { ...aiMsg, ck: aiCk } : m))
      );
    }

    setPendingReply(false);
    setSending(false);
    // 搜索索引后台更新，不阻塞界面
    void loadMessageIndex(user.id);
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
          signal: controller ? controller.signal : undefined,
        });
        if (!res.ok) throw new Error("tts " + res.status);
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
          playP.catch(() => {
            if (ttsIdRef.current === targetId) {
              stopTts(false);
              showHint("语音暂时不可用");
            }
          });
        }
        setTtsLoadingId(null);
        setTtsPlayingId(targetId);
      } catch (err) {
        if (err?.name === "AbortError") return; // 主动取消，不提示
        if (ttsIdRef.current !== targetId) return;
        stopTts(false);
        showHint("语音暂时不可用");
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

  // 新建会话：同一时间只允许一个；若手动播放占用音频通道，先停掉。
  function startAutoSession(ck) {
    stopAutoSession();
    if (ttsPlayingId || ttsLoadingId) stopTts();
    if (!ttsAudioRef.current) ttsAudioRef.current = new Audio();
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
    (async () => {
      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          signal: controller ? controller.signal : undefined,
        });
        if (!res.ok) throw new Error("tts " + res.status);
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
        playP.catch(() => {
          if (autoSessionRef.current !== session || !session.active) return;
          finishTtsJob(session, job);
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
      showHint("语音暂时不可用");
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
      window.location.href = "/";
      return;
    }
    const oldMsg = messages[idx];
    // 给重写气泡一个稳定 ck：落库后 id 变化但渲染 key 不变，避免闪烁
    const regenCk = "ck-regen-" + msgId;
    clearReveal(regenCk);
    stopAutoSession(); // 旧回复若正在自动播放，先停掉再重写
    setSending(true);
    setRegenId(msgId);
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
          .map((m) => ({ role: m.role, content: m.content })),
      ];

      // 4. 流式重写该气泡（复用 askAI，多气泡节奏）
      reply = await askAI(history, (full) => updateAiStream(regenCk, full));
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
      if (!inserted) throw new Error("保存失败");
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId ? { ...inserted, ck: regenCk } : m
        )
      );
      await loadMessageIndex(userId);
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
          }
        } catch (e) {
          // 兜底落库也失败：忽略
        }
      }
    } finally {
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

  // 背景裁剪确认：上传裁剪结果，实时预览不刷新
  async function handleBgCropped(dataUrl) {
    setUploadingBg(true);
    try {
      const upRes = await apiRequest("/api/user/upload", {
        method: "POST",
        body: { kind: "background", dataUrl },
      });
      const url = upRes.url || dataUrl;
      setProfile((prev) => ({
        ...(prev || {}),
        chat_background_url: url,
      }));
      setBgCropSrc(null);
      showHint("背景已更新");
    } catch (err) {
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

  // AI 头像裁剪确认：上传裁剪结果，实时预览不刷新
  async function handleAiAvatarCropped(dataUrl) {
    setUploadingAvatar(true);
    try {
      const upRes = await apiRequest("/api/user/upload", {
        method: "POST",
        body: { kind: "aiAvatar", dataUrl },
      });
      const url = upRes.url || dataUrl;
      setProfile((prev) => ({
        ...(prev || {}),
        ai_avatar_url: url,
      }));
      setAiAvatarCropSrc(null);
      showHint("AI 头像已更新");
    } catch (err) {
      showHint("上传失败，请重试");
    } finally {
      setUploadingAvatar(false);
    }
  }

  // 设置面板：恢复默认（清空 profiles 中的 URL）
  async function handleResetSetting(kind) {
    const userId = await getCurrentUserId();
    if (!userId) {
      window.location.href = "/";
      return;
    }
    const isBg = kind === "bg";
    const column = isBg ? "chat_background_url" : "ai_avatar_url";
    const apiField = isBg ? "chatBackgroundUrl" : "aiAvatarUrl";
    try {
      await apiRequest("/api/user/profile", {
        method: "PUT",
        body: { [apiField]: "" },
      });
      setProfile((prev) => ({ ...(prev || {}), [column]: null }));
      showHint("已恢复默认");
    } catch (err) {
      console.error("恢复默认失败:", err);
      showHint("恢复失败，请重试");
    }
  }

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
          if (!titleHit && !hit) return null;
          return {
            conversation: c,
            messageId: hit?.id || null,
            snippet: titleHit ? "" : snippetAround(hit.content, keyword),
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
  const aiAvatarUrl = profile?.ai_avatar_url || "";
  const chatBgUrl = profile?.chat_background_url || "";
  // AI 气泡底色：有自定义背景图时用独立半透明白底（+轻微毛玻璃）保证文字清晰；
  // 无背景图时保持原淡灰，在米白底色上外观不变
  const aiBubbleBg = chatBgUrl
    ? "bg-white/75 backdrop-blur-sm"
    : "bg-[#f1f3f2]";
  const currentTitle = conversations.find((c) => c.id === currentId)?.title;

  // 侧边栏内容：桌面内联与小屏抽屉共用
  const sidebarBody = (
    <>
      <button
        onClick={() => {
          handleNewConversation();
          if (isMobile) setIsSidebarOpen(false);
        }}
        className={`${btnBase} p-2 mb-2`}
      >
        + 新建对话
      </button>

      <div className="relative mb-2">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <circle cx="11" cy="11" r="7" />
          <line x1="20" y1="20" x2="16.2" y2="16.2" />
        </svg>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索对话或消息内容"
          className={searchInputClass}
        />
      </div>

      {hint && <p className="text-xs text-slate-500 mb-2">{hint}</p>}

      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 && (
          <p className="text-sm text-slate-400">暂无对话</p>
        )}

        {/* 多选模式操作栏 */}
        {multiSelectMode && conversations.length > 0 && (
          <div className="flex items-center gap-1 mb-2 p-1.5 rounded-lg bg-[#eef1f2] sticky top-0 z-10">
            <button
              onClick={handleSelectAll}
              className={`${btnBase} px-2 py-1 text-xs`}
            >
              {selectedIds.length === conversations.length ? "取消全选" : "全选"}
            </button>
            <button
              onClick={handleExitMultiSelect}
              className={`${btnBase} px-2 py-1 text-xs`}
            >
              取消
            </button>
            <span className="text-xs text-slate-400 ml-auto mr-1">
              已选 {selectedIds.length}
            </span>
            <button
              onClick={handlePinSelected}
              disabled={selectedIds.length === 0}
              className={`${btnBase} px-2 py-1 text-xs`}
            >
              置顶
            </button>
            <button
              onClick={handleDeleteSelected}
              disabled={selectedIds.length === 0}
              className="border border-[#e8b4a0] bg-[#f5b8a0] text-white rounded-lg px-2 py-1 text-xs hover:bg-[#f0a48a] disabled:opacity-50 transition-all duration-150"
            >
              删除
            </button>
          </div>
        )}

        {/* 搜索模式：扁平列表 */}
        {keyword && searchResults.length === 0 && (
          <p className="text-sm text-slate-400">没有匹配的对话</p>
        )}
        {keyword &&
          searchResults.map(({ conversation: c, messageId, snippet }) => (
            <ConvRow
              key={c.id}
              c={c}
              snippet={snippet}
              selected={selectedIds.includes(c.id)}
              multi={multiSelectMode}
              currentId={currentId}
              renaming={renamingId === c.id}
              renameValue={renameValue}
              menuOpen={menuOpenId === c.id}
              onOpen={() => {
                handleOpenResult({ conversation: c, messageId });
                if (isMobile) setIsSidebarOpen(false);
              }}
              onToggleSelect={() => handleToggleSelect(c.id)}
              onMenu={() => setMenuOpenId(menuOpenId === c.id ? null : c.id)}
              onRename={() => {
                setRenamingId(c.id);
                setRenameValue(c.title || "");
                setMenuOpenId(null);
              }}
              onRenameCommit={() => handleRename(c.id)}
              onRenameCancel={() => setRenamingId(null)}
              setRenameValue={setRenameValue}
              onPin={() => {
                handleTogglePin(c.id);
                setMenuOpenId(null);
              }}
              onMultiSelect={() => {
                setMultiSelectMode(true);
                setMenuOpenId(null);
              }}
              onShare={() => {
                handleShare(c);
                setMenuOpenId(null);
              }}
              onDelete={() => {
                handleDelete(c.id);
                setMenuOpenId(null);
              }}
              closeMenu={() => setMenuOpenId(null)}
            />
          ))}

        {/* 非搜索模式：置顶区 + 时间轴分组 */}
        {!keyword && conversations.length > 0 && (
          <ConversationGroups
            conversations={conversations}
            multiSelectMode={multiSelectMode}
            selectedIds={selectedIds}
            currentId={currentId}
            renamingId={renamingId}
            renameValue={renameValue}
            menuOpenId={menuOpenId}
            timeGroupLabel={timeGroupLabel}
            onOpen={(c) => {
              handleOpenResult({ conversation: c, messageId: null });
              if (isMobile) setIsSidebarOpen(false);
            }}
            onToggleSelect={handleToggleSelect}
            setMenuOpenId={setMenuOpenId}
            setRename={setRenameValue}
            onRename={(c) => {
              setRenamingId(c.id);
              setRenameValue(c.title || "");
              setMenuOpenId(null);
            }}
            onRenameCommit={handleRename}
            onRenameCancel={() => setRenamingId(null)}
            onPin={handleTogglePin}
            onMultiSelect={() => {
              setMultiSelectMode(true);
              setMenuOpenId(null);
            }}
            onShare={handleShare}
            onDelete={handleDelete}
          />
        )}
      </div>

      {/* 侧边栏底部：个人资料入口（跳转「我的」页） */}
      <div className="mt-auto pt-2">
        <button
          onClick={() => {
            setActiveTab("profile");
            if (isMobile) setIsSidebarOpen(false);
          }}
          className="w-full flex items-center gap-2 rounded-lg bg-[#eef1f2] px-2 py-2 hover:bg-[#e3edf2] transition-colors duration-150 cursor-pointer"
        >
          <UserAvatar url={avatarUrl} name={profile?.username || "我"} />
          <div className="flex-1 min-w-0 text-left">
            <p className="text-xs text-slate-700 truncate font-medium">
              {profile?.username || "未设置昵称"}
            </p>
            <p className="text-xs text-slate-400">个人资料</p>
          </div>
        </button>
      </div>
    </>
  );

  // 认证检查中：显示加载占位，避免渲染半成品界面或误跳转
  if (authLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#fafaf8]">
        <div className="flex flex-col items-center gap-3">
          <span className="text-2xl font-bold text-[#5b8aa6]">Solace</span>
          <span className="text-sm text-slate-400">加载中…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-[#fafaf8] text-slate-800">
      {/* 顶部导航栏：左 Logo，右三个标签（固定在页面最上方） */}
      <header className="h-[60px] shrink-0 flex items-center justify-between px-4 border-b border-[#e8eae7] bg-gradient-to-r from-[#fafaf8] via-[#f2f7fa] to-[#e9f1f7]">
        <span className="text-xl font-bold tracking-wide text-[#5b8aa6] select-none">
          Solace
        </span>
        <nav className="flex items-center h-full">
          {[
            { id: "chat", icon: "💬", label: "聊天" },
            { id: "diary", icon: "📓", label: "日记" },
            { id: "firstaid", icon: "🏠", label: "治愈小屋" },
            { id: "profile", icon: "👤", label: "我的" },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`h-full px-4 flex items-center gap-1.5 text-sm border-b-2 transition-colors duration-150 ${
                activeTab === t.id
                  ? "text-slate-800 font-medium border-[#5b8aa6]"
                  : "text-slate-400 border-transparent hover:text-slate-600"
              }`}
            >
              <span>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {/* 主内容区：随顶部导航切换视图，占满顶栏以下全部空间 */}
      <div className="flex-1 min-h-0">
        {activeTab === "chat" && (
          <div className="h-full flex">
            {/* 左侧：会话列表（桌面内联，可折叠） */}
            {!isMobile && (
              <div
                className={`${
                  isSidebarOpen ? "w-64" : "w-0"
                } h-full shrink-0 overflow-hidden border-r border-[#e8eae7] bg-[#f7f7f4] transition-all duration-300`}
              >
                <div className="w-64 h-full p-2 flex flex-col">
                  {sidebarBody}
                </div>
              </div>
            )}

            {/* 左侧抽屉（小屏）：顶部 ☰ 按钮唤出 */}
            {isMobile && isSidebarOpen && (
              <>
                <div
                  className="fixed inset-0 bg-black/30 z-30"
                  onClick={() => setIsSidebarOpen(false)}
                />
                <div className="fixed left-0 top-[60px] bottom-0 w-64 z-40 overflow-y-auto border-r border-[#e8eae7] bg-[#f7f7f4] p-2 flex flex-col">
                  {sidebarBody}
                </div>
              </>
            )}

            {/* 中间：消息列表 + 输入框 */}
            <div className="flex-1 h-full flex flex-col min-w-0 relative">
              {/* 背景图层：独立一层（filter 只作用于图片，不模糊前景），
                  cover 铺满 + 轻微降饱和，避免抢眼 */}
              {chatBgUrl && (
                <div
                  className="absolute inset-0 pointer-events-none bg-center bg-cover"
                  style={{
                    backgroundImage: `url(${chatBgUrl})`,
                    filter: "blur(0.5px) saturate(0.9)",
                  }}
                />
              )}
              {/* 暖色（solace-cream）薄遮罩：0.45，让背景图醒目但色调统一；
                  可读性交给气泡自身的独立半透明背景，不靠加厚遮罩 */}
              {chatBgUrl && (
                <div className="absolute inset-0 pointer-events-none bg-[rgba(253,251,247,0.45)]" />
              )}
          <div className="relative flex items-center border-b border-[#e8eae7] px-3 py-2">
            <button
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              title={isSidebarOpen ? "收起侧边栏" : "展开侧边栏"}
              className={`${btnBase} px-2 py-1 mr-2 shrink-0`}
            >
              ☰
            </button>
            <span className="text-sm text-slate-500 truncate">
              {currentTitle || "Solace"}
            </span>
            {profile?.username ? (
              <span className="text-sm text-slate-600 truncate ml-auto">
                {displayName}
              </span>
            ) : (
              <span className="ml-auto" />
            )}
            {/* 自动播放语音开关：关闭=静音喇叭（带斜杠），开启=正常喇叭。点击区 ≥44px */}
            <button
              type="button"
              onClick={handleToggleAutoPlay}
              title={autoPlay ? "关闭自动播放语音" : "开启自动播放语音"}
              aria-label={autoPlay ? "关闭自动播放语音" : "开启自动播放语音"}
              aria-pressed={autoPlay}
              className={`${btnBase} w-11 h-11 sm:w-8 sm:h-8 p-0 ml-2 shrink-0 flex items-center justify-center ${
                autoPlay ? "text-[#7fa8c4]" : "text-slate-400"
              }`}
            >
              {autoPlay ? (
                <svg
                  className="w-4 h-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </svg>
              ) : (
                <svg
                  className="w-4 h-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              )}
            </button>
            {/* 设置按钮 */}
            <button
              onClick={() => setSettingsOpen(!settingsOpen)}
              title="设置"
              className={`${btnBase} w-11 h-11 sm:w-auto sm:h-auto sm:px-2 sm:py-1 p-0 ml-2 shrink-0 flex items-center justify-center`}
            >
              ⚙
            </button>
            {/* 设置面板：聊天背景 / AI 头像 */}
            {settingsOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setSettingsOpen(false)}
                />
                <div className="absolute right-2 top-full mt-1 z-50 w-72 bg-white rounded-2xl shadow-xl border border-[#e8eae7] p-4">
                  {/* 聊天背景图 */}
                  <div className="mb-4">
                    <p className="text-sm font-medium text-slate-700 mb-2">
                      聊天背景图
                    </p>
                    <div className="flex items-center gap-2">
                      <label
                        className={`border border-[#d5d9d7] bg-[#f1f3f2] text-slate-600 rounded-lg px-3 py-1.5 text-sm cursor-pointer hover:bg-[#e8eff2] transition-colors duration-150 ${
                          uploadingBg ? "opacity-60 pointer-events-none" : ""
                        }`}
                      >
                        {uploadingBg ? "上传中..." : "上传图片"}
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={handleBgFileChange}
                        />
                      </label>
                      {chatBgUrl && (
                        <button
                          onClick={() => handleResetSetting("bg")}
                          disabled={uploadingBg}
                          className="border border-[#d5d9d7] bg-[#f1f3f2] text-slate-500 rounded-lg px-3 py-1.5 text-sm hover:bg-[#e8eff2] transition-colors duration-150 disabled:opacity-50"
                        >
                          恢复默认
                        </button>
                      )}
                    </div>
                    {chatBgUrl && (
                      <img
                        src={chatBgUrl}
                        alt="当前背景"
                        className="mt-2 w-full h-16 object-cover rounded-lg border border-[#e8eae7]"
                      />
                    )}
                  </div>

                  {/* AI 头像 */}
                  <div>
                    <p className="text-sm font-medium text-slate-700 mb-2">
                      AI 头像
                    </p>
                    <div className="flex items-center gap-2">
                      <label
                        className={`border border-[#d5d9d7] bg-[#f1f3f2] text-slate-600 rounded-lg px-3 py-1.5 text-sm cursor-pointer hover:bg-[#e8eff2] transition-colors duration-150 ${
                          uploadingAvatar ? "opacity-60 pointer-events-none" : ""
                        }`}
                      >
                        {uploadingAvatar ? "上传中..." : "上传图片"}
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={handleAiAvatarFileChange}
                        />
                      </label>
                      {aiAvatarUrl && (
                        <button
                          onClick={() => handleResetSetting("aiAvatar")}
                          disabled={uploadingAvatar}
                          className="border border-[#d5d9d7] bg-[#f1f3f2] text-slate-500 rounded-lg px-3 py-1.5 text-sm hover:bg-[#e8eff2] transition-colors duration-150 disabled:opacity-50"
                        >
                          恢复默认
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

        <div className="relative flex-1 overflow-y-auto px-4 py-4">
          {/* 新对话模式的欢迎词：居中、比正文大一号、半透明深灰，
              叠加在背景图之上且不遮挡它（pointer-events-none）。
              打字期间仍显示；第一条消息发出（messages 出现气泡）后消失 */}
          {!currentId &&
            messages.length === 0 &&
            !streamingReply &&
            !diaryReading && (
              <div className="absolute inset-0 flex items-center justify-center px-6 pointer-events-none">
                <p className="text-[22px] leading-9 text-slate-800/50 text-center font-medium">
                  你来啦，今天打算和我分享什么？
                </p>
              </div>
            )}

          {messages.map((m) => {
            const isUser = m.role === "user";
            // ck 是临时气泡"转正"时保持不变的渲染 key，避免 DOM 卸载导致的闪烁
            const renderKey = m.ck || m.id;
            const highlighted = highlightId === m.id;
            // AI 消息按 \n 切成多段，模拟真人连发短消息
            const segments = isUser ? [] : splitAiSegments(m.content);
            const revealed = isUser ? 0 : revealedRef.current[renderKey] ?? segments.length;
            // 已完成分段 + 正在输入的分段（如果 revealed 还没到末尾）
            const visibleCount = Math.min(revealed + 1, segments.length);
            const showSegments = segments.slice(0, visibleCount);
            const isLastTyping = revealed < segments.length;
            return (
              <div
                key={renderKey}
                ref={(el) => {
                  messageRefs.current[m.id] = el;
                }}
                className={`flex items-start gap-2 mb-3 group ${
                  isUser ? "justify-end" : "justify-start"
                }`}
              >
                {!isUser && <AiAvatar url={profile?.ai_avatar_url} />}
                <div
                  className={`flex flex-col max-w-[70%] ${
                    isUser ? "items-end" : "items-start"
                  }`}
                >
                  {/* 用户消息：单气泡 */}
                  {isUser && (
                    <div
                      className={`max-w-full px-3 py-2 text-sm leading-6 whitespace-pre-wrap break-words rounded-2xl transition-shadow duration-300 bg-[#7fa8c4] text-white rounded-br-md ${highlighted ? "ring-2 ring-[#8fb3c7]" : ""}`}
                    >
                      {m.content}
                    </div>
                  )}

                  {/* AI 消息：按分段渲染多个气泡 */}
                  {!isUser && showSegments.length === 0 && !m.content && (m.id === regenId || String(m.id).startsWith("temp-")) && (
                    // 空临时气泡 / 重新生成中：显示思考点点
                    <div className={`${aiBubbleBg} px-3 py-2 rounded-2xl rounded-bl-md flex gap-1`}>
                      {[0, 150, 300].map((delay) => (
                        <span
                          key={delay}
                          className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce"
                          style={{ animationDelay: `${delay}ms` }}
                        />
                      ))}
                    </div>
                  )}

                  {!isUser && showSegments.map((seg, i) => (
                    <div
                      key={`${renderKey}-${i}`}
                      className={`max-w-full px-3 py-2 text-sm leading-6 break-words rounded-2xl ${aiBubbleBg} text-slate-800 rounded-bl-md ${
                        i < showSegments.length - 1 ? "mb-1" : ""
                      } shadow-sm ${highlighted ? "ring-2 ring-[#8fb3c7]" : ""}`}
                    >
                      {seg}
                    </div>
                  ))}

                  {/* 操作区：播放语音 + 重新生成。电脑端悬停才显示，移动端无 hover → 常显 */}
                  {!isUser && !String(m.id).startsWith("temp-") && m.content && (
                    <div className="mt-1 flex items-center gap-1 self-start opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity duration-150">
                      {/* 喇叭按钮：空闲喇叭 / 加载中旋转 / 播放中暂停；点击区 ≥44px */}
                      <button
                        type="button"
                        onClick={() => handleToggleTts(m.id, m.content, m.ck)}
                        title={
                          ttsPlayingId === m.id || ttsPlayingCk === m.ck
                            ? "暂停"
                            : "播放语音"
                        }
                        aria-label={
                          ttsPlayingId === m.id || ttsPlayingCk === m.ck
                            ? "暂停语音"
                            : "播放语音"
                        }
                        className="w-11 h-11 sm:w-7 sm:h-7 flex items-center justify-center text-slate-400 hover:text-[#7fa8c4] transition-colors duration-150"
                      >
                        {ttsLoadingId === m.id ? (
                          <svg
                            className="w-4 h-4 animate-spin"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                          >
                            <path d="M21 12a9 9 0 1 1-6.22-8.56" />
                          </svg>
                        ) : ttsPlayingId === m.id || ttsPlayingCk === m.ck ? (
                          <svg
                            className="w-4 h-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <rect x="6" y="4" width="4" height="16" rx="1" />
                            <rect x="14" y="4" width="4" height="16" rx="1" />
                          </svg>
                        ) : (
                          <svg
                            className="w-4 h-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                          </svg>
                        )}
                      </button>

                      <button
                        onClick={() => handleRegenerate(m.id)}
                        disabled={sending || m.id === regenId}
                        title="重新生成"
                        className="w-11 h-11 sm:w-auto sm:h-auto sm:px-1 flex items-center justify-center gap-1 text-xs text-slate-400 hover:text-[#7fa8c4] transition-colors duration-150 disabled:opacity-50"
                      >
                        <svg
                          className="w-3.5 h-3.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="23 4 23 10 17 10" />
                          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                        </svg>
                        <span className="hidden sm:inline">重新生成</span>
                      </button>
                    </div>
                  )}
                </div>
                {isUser && <UserAvatar url={avatarUrl} name={displayName} />}
              </div>
            );
          })}

          {/* AI 思考中气泡 */}
          {pendingReply && (
            <div className="flex items-start gap-2 mb-3 justify-start">
              <AiAvatar url={profile?.ai_avatar_url} />
              <div className={`${aiBubbleBg} px-3 py-2 rounded-2xl rounded-bl-md flex gap-1`}>
                {[0, 150, 300].map((delay) => (
                  <span
                    key={delay}
                    className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce"
                    style={{ animationDelay: `${delay}ms` }}
                  />
                ))}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        <div className="relative px-3 pb-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // 输入法选词中的回车不触发发送
                if (e.key === "Enter" && !e.nativeEvent.isComposing)
                  handleSend();
              }}
              placeholder="说点什么，说什么都可以"
              className={inputClass}
            />
            <button
              onClick={handleSend}
              disabled={sending}
              className={`${btnBase} px-4 shrink-0`}
            >
              {sending ? "…" : "发送"}
            </button>
          </div>
          <p className="text-xs text-slate-400 text-center mt-2">
            Solace 是你的情绪陪伴者，不能替代专业心理咨询。如果你正经历难以承受的痛苦，请试着联系你信任的人，或拨打全国心理援助热线
            400-161-9995。
          </p>
        </div>
      </div>
          </div>
        )}

        {/* 治愈小屋页：FirstAid + 性格探索 / 情绪自评，居中窄容器 */}
        {activeTab === "firstaid" && (
          <div className="h-full overflow-y-auto px-4 py-8 flex justify-center">
            <div className="w-full max-w-[700px]">
              <HealingCottage />
            </div>
          </div>
        )}

        {/* 日记页：头像 + 昵称 + 个性签名 + 新建 + 列表 */}
        {activeTab === "diary" && (
          <div className="h-full max-w-5xl mx-auto flex flex-col px-4 py-5">
            {/* 顶部个性化卡片：头像 + 昵称 + 个性签名 */}
            <div className="flex items-center gap-4 bg-white rounded-2xl shadow-sm border border-[#e8eae7] px-4 py-4 mb-4 shrink-0">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt="我"
                  className="w-[60px] h-[60px] rounded-full object-cover shrink-0"
                />
              ) : (
                <div className="w-[60px] h-[60px] rounded-full bg-gradient-to-br from-[#b6cdd9] to-[#9db5c3] flex items-center justify-center text-white text-xl font-bold shrink-0">
                  {(displayName || "我").charAt(0).toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                <p className="text-base font-bold text-slate-800 truncate">
                  {profile?.username || "未设置昵称"}
                </p>
                <p
                  onClick={openBioModal}
                  title="点击修改签名"
                  className="text-xs text-slate-400 truncate mt-0.5 cursor-pointer hover:text-slate-600 transition-colors duration-150"
                >
                  {profile?.bio || "写一句想说的话吧"}
                </p>
              </div>
            </div>

            {/* 双栏：左列表 35% / 右详情 65%，两栏内部独立滚动 */}
            <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-4">
              {/* 左栏：日记列表（小屏仅未选中日记且未在新建时显示） */}
              {(!isMobile || (!diaryView && !diaryCreating)) && (
                <div className="w-full lg:w-[35%] shrink-0 flex flex-col min-h-0">
                  <button
                    onClick={() => {
                      setDiaryTitle("");
                      setDiaryContent("");
                      setDiaryView(null);
                      setDiaryCreating(true);
                    }}
                    className="w-full shrink-0 border border-[#7fa8c4] bg-[#7fa8c4] text-white rounded-xl py-2.5 text-sm font-medium hover:bg-[#6b98b4] active:scale-[0.99] transition-all duration-150 mb-3"
                  >
                    ＋ 写日记
                  </button>

                  <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
                    {diaries.length === 0 && (
                      <p className="text-sm text-slate-400 py-2">
                        还没有日记，慢慢写一篇吧。
                      </p>
                    )}
                    {diaries.map((d) => {
                      const selected = diaryView?.id === d.id;
                      return (
                        <div
                          key={d.id}
                          onClick={() => {
                            setDiaryCreating(false);
                            handleOpenDiary(d);
                          }}
                          className={`group relative rounded-xl border px-3 py-2.5 cursor-pointer transition-colors duration-150 ${
                            selected
                              ? "bg-[#e3edf3] border-[#a9c6da]"
                              : "bg-white border-[#e8eae7] hover:bg-[#f1f5f7]"
                          }`}
                        >
                          <p className="text-sm text-slate-700 truncate font-medium pr-6">
                            {d.title}
                          </p>
                          <p className="text-xs text-slate-300 mt-1">
                            {formatDateCN(d.created_at)}
                          </p>
                          <p className="text-xs text-slate-400 truncate mt-0.5">
                            {(d.content || "").slice(0, 30) || "（空）"}
                            {(d.content || "").length > 30 ? "…" : ""}
                          </p>
                          {/* 悬停显示删除按钮 */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteDiary(d);
                            }}
                            title="删除这篇日记"
                            className="absolute top-2 right-2 w-6 h-6 rounded-md flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-opacity duration-150"
                          >
                            <svg
                              className="w-3.5 h-3.5"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M3 6h18" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                              <line x1="10" y1="11" x2="10" y2="17" />
                              <line x1="14" y1="11" x2="14" y2="17" />
                            </svg>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 右栏：详情 / 编辑 / 新建（小屏仅选中或新建时显示，右上角返回） */}
              {(!isMobile || diaryView || diaryCreating) && (
                <div className="w-full lg:flex-1 min-w-0 bg-white rounded-2xl shadow-sm border border-[#e8eae7] p-5 overflow-y-auto relative">
                  {isMobile && (
                    <button
                      onClick={() => {
                        setDiaryView(null);
                        setDiaryEdit(false);
                        setDiaryCreating(false);
                      }}
                      className="absolute top-3 right-3 z-10 text-xs text-slate-500 border border-[#e8eae7] bg-[#fafaf8] rounded-lg px-2.5 py-1.5 hover:bg-[#f0f4f6] transition-colors duration-150"
                    >
                      ← 返回
                    </button>
                  )}

                  {((!isMobile && !diaryView) || diaryCreating) ? (
                    /* 新建表单（桌面默认 / 小屏点「＋ 写日记」后） */
                    <div>
                      <h2 className="text-lg font-bold text-slate-800 mb-3">
                        写日记
                      </h2>
                      <input
                        type="text"
                        value={diaryTitle}
                        onChange={(e) => setDiaryTitle(e.target.value)}
                        placeholder="日记标题"
                        className={`${inputClass} mb-3`}
                      />
                      <textarea
                        value={diaryContent}
                        onChange={(e) => setDiaryContent(e.target.value)}
                        placeholder="今天发生了什么？慢慢写，我在。"
                        rows={10}
                        className={`${inputClass} mb-3 resize-none`}
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={() => handleSaveDiary(false)}
                          disabled={savingDiary}
                          className="border border-[#7fa8c4] bg-white text-[#5b8aa6] rounded-lg py-2.5 text-sm font-medium hover:bg-[#eef4f8] active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150"
                        >
                          {savingDiary ? "保存中..." : "保存日记"}
                        </button>
                        <button
                          onClick={() => handleSaveDiary(true)}
                          disabled={savingDiary}
                          className="border border-[#7fa8c4] bg-[#7fa8c4] text-white rounded-lg py-2.5 text-sm font-medium hover:bg-[#6b98b4] active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150"
                        >
                          {savingDiary ? "保存中..." : "保存并发送给 AI"}
                        </button>
                      </div>
                    </div>
                  ) : diaryView && diaryEdit ? (
                    /* 编辑态：标题和正文可编辑 */
                    <div>
                      <h2 className="text-lg font-bold text-slate-800 mb-3">
                        编辑日记
                      </h2>
                      <input
                        type="text"
                        value={diaryEditTitle}
                        onChange={(e) => setDiaryEditTitle(e.target.value)}
                        placeholder="日记标题"
                        className={`${inputClass} mb-3`}
                      />
                      <textarea
                        value={diaryEditContent}
                        onChange={(e) => setDiaryEditContent(e.target.value)}
                        rows={10}
                        className={`${inputClass} mb-3 resize-none`}
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={handleSaveEditDiary}
                          disabled={savingDiary}
                          className={`${btnBase} px-4 py-2`}
                        >
                          {savingDiary ? "保存中..." : "保存"}
                        </button>
                        <button
                          onClick={() => setDiaryEdit(false)}
                          className={`${btnBase} px-4 py-2`}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : diaryView ? (
                    /* 详情态：完整标题、日期、正文 */
                    <div>
                      <p className="text-xs text-slate-400 mb-1">
                        {formatDateCN(diaryView.created_at)}
                      </p>
                      <h2 className="text-xl font-bold text-slate-800 mb-3">
                        {diaryView.title}
                      </h2>
                      <div className="text-sm text-slate-700 leading-7 whitespace-pre-wrap break-words mb-4">
                        {diaryView.content}
                      </div>
                      <div className="flex flex-wrap gap-2 border-t border-[#e8eae7] pt-3">
                        <button
                          onClick={() => {
                            setDiaryEdit(true);
                            setDiaryEditTitle(diaryView.title || "");
                            setDiaryEditContent(diaryView.content || "");
                          }}
                          className={`${btnBase} px-3 py-1.5 text-sm`}
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => handleDeleteDiary()}
                          className={`${btnBase} px-3 py-1.5 text-sm text-red-500 hover:text-red-700`}
                        >
                          删除
                        </button>
                        <button
                          onClick={handleReadDiary}
                          disabled={diaryReading}
                          className="border border-[#7fa3b8] bg-[#eef4f6] text-slate-700 rounded-lg px-3 py-1.5 text-sm hover:bg-[#e0eaf0] disabled:opacity-50"
                        >
                          {diaryReading ? "正在读…" : "让AI读读这篇"}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 个人信息页：统计卡片 + 资料卡片 + 关于入口 */}
        {activeTab === "profile" && (
          <div className="h-full overflow-y-auto px-4 py-6 flex flex-col lg:flex-row items-start gap-4">
            {/* 左栏：个人资料卡片（约 40%） */}
            <div className="bg-white rounded-2xl shadow-xl border border-[#e8eae7] p-5 w-full lg:w-[40%] shrink-0 h-fit">
              <ProfileView
                user={user}
                profile={profile}
                onSaved={() => user && loadProfile(user.id)}
                bioValue={bioInput}
                onBioChange={setBioInput}
                onSaveBio={handleSaveBio}
                bioSaving={savingBio}
                bioMsg={bioMsg}
                hideSignOut
              />
            </div>

            {/* 右栏：统计 + 关于 + 退出（约 60%），块间 16px */}
            <div className="w-full lg:flex-1 flex flex-col gap-4">
              {/* 统计卡片：陪伴天数 / 日记篇数 / 今日对话数 */}
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
                      <p className="text-xs text-slate-400 mt-1">{s.label}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* 关于 Solace 入口 */}
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

              {/* 退出登录：红色文字，二次确认后退出 */}
              <button
                onClick={() => setSignOutConfirm(true)}
                className="bg-white rounded-2xl shadow-sm border border-[#e8eae7] py-3 w-full text-red-500 text-sm hover:bg-red-50 hover:border-red-200 transition-colors duration-150"
              >
                退出登录
              </button>
            </div>
          </div>
        )}

        {/* 退出登录二次确认弹窗 */}
        <ConfirmModal
          open={signOutConfirm}
          message="确定要退出当前账号吗？"
          confirmText="退出登录"
          onConfirm={async () => {
            setSignOutConfirm(false);
            await handleSignOut();
          }}
          onClose={() => setSignOutConfirm(false)}
        />
      </div>

      {/* 统一确认弹窗：删除对话 / 删除日记 */}
      <ConfirmModal
        open={!!confirmState}
        message={confirmState?.message}
        confirmText={confirmState?.confirmText}
        onConfirm={confirmState?.onConfirm}
        onClose={() => setConfirmState(null)}
      />

      {/* 聊天背景裁剪弹窗：可在横屏 16:9 / 竖屏 9:16 间切换，默认横屏 */}
      {bgCropSrc && (
        <ImageCropper
          imageSrc={bgCropSrc}
          cropShape="rect"
          title="裁剪聊天背景"
          maxSide={1280}
          busy={uploadingBg}
          aspectOptions={[
            { label: "横屏 16:9", value: 16 / 9 },
            { label: "竖屏 9:16", value: 9 / 16 },
          ]}
          onCancel={() => setBgCropSrc(null)}
          onConfirm={handleBgCropped}
        />
      )}

      {/* AI 头像裁剪弹窗：圆形 1:1 */}
      {aiAvatarCropSrc && (
        <ImageCropper
          imageSrc={aiAvatarCropSrc}
          aspect={1}
          cropShape="round"
          title="裁剪 AI 头像"
          maxSide={512}
          busy={uploadingAvatar}
          onCancel={() => setAiAvatarCropSrc(null)}
          onConfirm={handleAiAvatarCropped}
        />
      )}

      {/* 个性签名编辑弹窗（日记页顶部卡片唤出，保存逻辑共用 handleSaveBio） */}
      <BioModal
        open={bioModalOpen}
        value={bioInput}
        onChange={setBioInput}
        saving={savingBio}
        msg={bioMsg}
        onSave={handleSaveBio}
        onClose={() => setBioModalOpen(false)}
      />

      {/* 「关于 Solace」弹窗 */}
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </div>
  );
}
