"use client";

import { useEffect, useRef, useState } from "react";
import HealingCottage from "@/components/HealingCottage";
import ConfirmModal from "@/components/ConfirmModal";
import ProfileView from "@/components/ProfileView";
import BioModal from "@/components/BioModal";
import AboutModal from "@/components/AboutModal";

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
6. 回复要短，通常两三句话就够，不要长篇大论。`;

// 读日记时的额外指令（只发给 AI，不存进数据库）
const DIARY_INSTRUCTION = `（你刚刚阅读了用户的日记，请以陪伴者身份自然回应，不要机械开场，不要复述内容，回复不超过 40 字。）`;

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

// 把图片文件压缩成 base64 data URL（限制最长边、逐步降质量），
// 供后端 /api/user/upload 在体积上限内接收
function compressImageToDataUrl(file, maxSize = 1280) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let width = img.naturalWidth || img.width;
        let height = img.naturalHeight || img.height;
        const scale = Math.min(1, maxSize / Math.max(width, height));
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        // 白底，避免 PNG 透明区域导出为黑色
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        let quality = 0.85;
        let out = canvas.toDataURL("image/jpeg", quality);
        while (out.length > 850 * 1024 && quality > 0.4) {
          quality -= 0.1;
          out = canvas.toDataURL("image/jpeg", quality);
        }
        resolve(out);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
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
  const timeLabel = (() => {
    if (!c.created_at) return "";
    const d = new Date(c.created_at);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  })();

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
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

  // 按时间轴标签分组
  const groups = {};
  for (const c of unpinned) {
    const label = timeGroupLabel(c.created_at);
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
  const [conversations, setConversations] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingReply, setPendingReply] = useState(false);
  const [regenId, setRegenId] = useState(null); // 正在重新生成的 AI 气泡 id
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
  // 乐观新建对话时，tempId → 真实对话 id 的 Promise（供"新建后立即发送"等待）
  const pendingConvRef = useRef({});

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
    async function init() {
      const session = await apiRequest("/api/auth/session");
      if (!session.user) {
        window.location.href = "/";
        return;
      }
      setUser(session.user);
      await loadProfile(session.user.id);
      await loadConversations(session.user.id);
      await loadMessageIndex(session.user.id);
      await loadDiaries(session.user.id);
    }
    init().catch(() => {
      window.location.href = "/";
    });
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

  // 新建对话：界面立即切换（乐观 UI），数据库写入在后台完成
  async function handleNewConversation() {
    const isFresh =
      currentId && messages.length === 0 && currentId === conversations[0]?.id;
    if (isFresh) {
      showHint("已在最新的对话中");
      return;
    }
    if (!user) return;

    // 1) 立即在本地创建临时对话并切换，用户点击瞬间看到空窗口
    const tempId = "temp-conv-" + Date.now();
    const tempConv = {
      id: tempId,
      user_id: user.id,
      title: "新对话",
      created_at: new Date().toISOString(),
    };
    setHint("");
    setConversations((prev) => [tempConv, ...prev]);
    setCurrentId(tempId);
    setMessages([]);

    // 2) 后台写入数据库（不再阻塞界面切换）；promise 供"新建后立即发送"等待
    const convPromise = (async () => {
      try {
        const res = await apiRequest("/api/user/conversations", {
          method: "POST",
          body: { title: "新对话" },
        });
        const created = res.conversation;
        if (!created) throw new Error("创建对话失败");
        // 3) 用真实记录就地替换临时对话（不做全量 loadConversations，省一次往返）
        setConversations((prev) =>
          prev.map((c) => (c.id === tempId ? created : c))
        );
        setCurrentId((cur) => (cur === tempId ? created.id : cur));
        return created.id;
      } catch (err) {
        // 失败：回滚临时对话
        setConversations((prev) => prev.filter((c) => c.id !== tempId));
        setCurrentId((cur) => (cur === tempId ? null : cur));
        showHint("新建对话失败，请重试");
        return null;
      }
    })();
    pendingConvRef.current[tempId] = convPromise;
    convPromise.finally(() => {
      delete pendingConvRef.current[tempId];
    });
  }

  async function handleSelect(id) {
    setHint("");
    setScrollTarget(null);
    setHighlightId("");
    setCurrentId(id);
    await loadMessages(id);
  }

  // 打开搜索结果：切换对话并定位到命中的那条消息
  async function handleOpenResult(result) {
    const id = result.conversation.id;
    setHint("");
    setCurrentId(id);

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

  // 时间轴分组标签：今天 / 昨天 / X天前 / 七天内 / 年月
  function timeGroupLabel(dateStr) {
    if (!dateStr) return "更早";
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "更早";
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((today - that) / 86400000);
    if (diffDays <= 0) return "今天";
    if (diffDays === 1) return "昨天";
    if (diffDays <= 6) return `${diffDays}天前`;
    if (diffDays <= 29) return "七天内";
    if (diffDays <= 30) return "三十天内";
    return `${d.getFullYear()}年${d.getMonth() + 1}月`;
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
                setMessages((prev) =>
                  prev.map((m) =>
                    m.ck === aiCk ? { ...m, content: fullReply } : m
                  )
                );
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
    if (!text || !currentId || sending) return;
    if (!user) return;

    // 若对话刚乐观新建、数据库还没返回，先等真实对话 id（避免无效外键）
    let convId = currentId;
    if (String(convId).startsWith("temp-conv-")) {
      const pending = pendingConvRef.current[convId];
      convId = pending ? await pending : null;
      if (!convId) {
        showHint("对话还在创建中，请稍等");
        return;
      }
    }

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

    let userMsg = null;
    try {
      const res = await apiRequest("/api/user/messages", {
        method: "POST",
        body: { conversationId: convId, role: "user", content: text },
      });
      userMsg = res.message;
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
    setPendingReply(false);
    setMessages((prev) => [
      ...prev,
      { id: tempAiId, ck: aiCk, role: "assistant", content: "" },
    ]);

    const reply = await askAI(history, (full) => {
      setMessages((prev) =>
        prev.map((m) => (m.ck === aiCk ? { ...m, content: full } : m))
      );
    });

    // 流结束（含中途断开）：最终文本落库，再把气泡就地转正
    let aiMsg = null;
    try {
      const res = await apiRequest("/api/user/messages", {
        method: "POST",
        body: { conversationId: convId, role: "assistant", content: reply },
      });
      aiMsg = res.message;
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

      // 4. 流式重写该气泡（复用 askAI）
      reply = await askAI(history, (full) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === msgId ? { ...m, content: full } : m))
        );
      });

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

  // 设置面板：上传聊天背景 / AI 头像（前端压缩成 data URL 后存后端）
  async function handleSettingUpload(file, kind) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showHint("请选择图片文件");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showHint("图片不能超过 5MB");
      return;
    }
    const userId = await getCurrentUserId();
    if (!userId) {
      window.location.href = "/";
      return;
    }
    const isBg = kind === "bg";
    const column = isBg ? "chat_background_url" : "ai_avatar_url";
    const setUploading = isBg ? setUploadingBg : setUploadingAvatar;
    setUploading(true);
    try {
      const dataUrl = await compressImageToDataUrl(file);
      const upRes = await apiRequest("/api/user/upload", {
        method: "POST",
        body: { kind: isBg ? "background" : "aiAvatar", dataUrl },
      });
      const url = upRes.url || dataUrl;
      // 本地同步，实时生效无需刷新
      setProfile((prev) => ({ ...(prev || {}), [column]: url }));
      showHint(isBg ? "背景已更新" : "AI 头像已更新");
    } catch (err) {
      console.error("上传失败:", err);
      showHint("上传失败，请重试");
    } finally {
      setUploading(false);
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
            <div
              className="flex-1 h-full flex flex-col min-w-0 relative"
              style={
                chatBgUrl
                  ? {
                      backgroundImage: `url(${chatBgUrl})`,
                      backgroundSize: "cover",
                      backgroundPosition: "center",
                    }
                  : undefined
              }
            >
              {/* 半透明白色遮罩：背景图上保证文字可读 */}
              {chatBgUrl && (
                <div className="absolute inset-0 bg-white/[0.85] pointer-events-none" />
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
            {/* 设置按钮 */}
            <button
              onClick={() => setSettingsOpen(!settingsOpen)}
              title="设置"
              className={`${btnBase} px-2 py-1 ml-2 shrink-0`}
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
                          onChange={(e) => {
                            handleSettingUpload(e.target.files?.[0], "bg");
                            e.target.value = "";
                          }}
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
                          onChange={(e) => {
                            handleSettingUpload(
                              e.target.files?.[0],
                              "aiAvatar"
                            );
                            e.target.value = "";
                          }}
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
          {!currentId && !streamingReply && !diaryReading && (
            <p className="text-sm text-slate-400 text-center mt-10">
              选择或新建一个对话，慢慢说，我在。
            </p>
          )}

          {messages.map((m) => {
            const isUser = m.role === "user";
            // ck 是临时气泡"转正"时保持不变的渲染 key，避免 DOM 卸载导致的闪烁
            const renderKey = m.ck || m.id;
            const highlighted = highlightId === m.id;
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
                  <div
                    className={`max-w-full px-3 py-2 text-sm leading-6 whitespace-pre-wrap break-words rounded-2xl transition-shadow duration-300 ${
                      isUser
                        ? "bg-[#7fa8c4] text-white rounded-br-md"
                        : "bg-[#f1f3f2] text-slate-800 rounded-bl-md"
                    } ${highlighted ? "ring-2 ring-[#8fb3c7]" : ""}`}
                  >
                    {!m.content &&
                    (m.id === regenId || String(m.id).startsWith("temp-")) ? (
                      // 空临时气泡 / 重新生成中：显示思考点点
                      <div className="flex gap-1">
                        {[0, 150, 300].map((delay) => (
                          <span
                            key={delay}
                            className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce"
                            style={{ animationDelay: `${delay}ms` }}
                          />
                        ))}
                      </div>
                    ) : (
                      m.content
                    )}
                  </div>
                  {/* 重新生成：悬停 AI 气泡时显示 */}
                  {!isUser && !String(m.id).startsWith("temp-") && m.content && (
                    <button
                      onClick={() => handleRegenerate(m.id)}
                      disabled={sending || m.id === regenId}
                      title="重新生成"
                      className="mt-1 text-xs text-slate-400 hover:text-[#7fa8c4] transition-all duration-150 opacity-0 group-hover:opacity-100 disabled:opacity-50 self-start flex items-center gap-1"
                    >
                      <svg
                        className="w-3 h-3"
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
                      重新生成
                    </button>
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
              <div className="bg-[#f1f3f2] px-3 py-2 rounded-2xl rounded-bl-md flex gap-1">
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
              disabled={sending || !currentId}
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
