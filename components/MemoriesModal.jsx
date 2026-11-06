"use client";

import { Component, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";

// ⚠️ 图谱必须在客户端加载：three / WebGL 会碰到 window，
//    放到服务端渲染阶段会直接报错。dynamic(ssr:false) 把它整块推迟到浏览器。
const MemoryGraph3D = dynamic(() => import("@/components/MemoryGraph3D"), {
  ssr: false,
});

/**
 * 分类徽标（暗色底上的柔和色块）
 */
const CATEGORY_META = {
  event: { label: "事实 · 近况", cls: "bg-[#12202e] text-[#60A5FA] border-[#1e3a5f]" },
  preference: { label: "偏好", cls: "bg-[#2a1524] text-[#F9A8D4] border-[#4c1d3d]" },
  relation: { label: "关系", cls: "bg-[#201a35] text-[#C4B5FD] border-[#3b2d61]" },
  emotion: { label: "情绪", cls: "bg-[#14231c] text-[#86EFAC] border-[#1f4330]" },
  wish: { label: "心愿 · 愿望", cls: "bg-[#1c1b3a] text-[#A5B4FC] border-[#312e81]" },
  self: { label: "暖言记的", cls: "bg-[#141c29] text-[#94A3B8] border-[#293548]" },
  daily: { label: "每日汇总", cls: "bg-[#241f14] text-[#D6C08A] border-[#453b26]" },
  profile: { label: "印象总结", cls: "bg-[#0f2433] text-[#7DD3FC] border-[#164e63]" },
};
const FALLBACK_META = { label: "其他碎片", cls: "bg-[#161c28] text-[#94A3B8] border-[#293548]" };

const EDIT_CATEGORIES = [
  { value: "", label: "不分类" },
  { value: "wish", label: "心愿 · 愿望" },
  { value: "preference", label: "偏好" },
  { value: "event", label: "事实 · 近况" },
  { value: "relation", label: "关系" },
  { value: "emotion", label: "情绪" },
  { value: "profile", label: "印象总结" },
];

function metaOf(category) {
  return CATEGORY_META[category] || FALLBACK_META;
}

/** 陪伴寄语/心愿引言（赋予星芒温度） */
function whisperOf(category) {
  switch (category) {
    case "wish":
      return "✨ 在某个深夜，你悄悄许下的心愿…";
    case "preference":
      return "☕ 暖言用心记下的关于你的偏好…";
    case "event":
      return "🍃 你曾和我分享过的生活点滴…";
    case "emotion":
      return "💧 那一刻你流露出的真实心绪…";
    case "relation":
      return "🌿 你在乎与挂念的人和事…";
    case "profile":
      return "🌟 暖言眼中独一无二的你…";
    default:
      return "💡 藏在星芒里的一段记忆碎片…";
  }
}

const inputClass =
  "border border-[#243149] bg-[#0f1524] text-[#E2E8F0] placeholder-[#64748B] rounded-lg transition-colors duration-150 focus:outline-none focus:border-[#60A5FA] focus:ring-1 focus:ring-[#60A5FA]";

/**
 * 3D 图谱的异常边界（防崩溃保险丝）
 */
class GraphBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error("[MemoriesModal] 3D 视图出错，退回列表视图：", error);
    this.props.onFail?.();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const GRAPH_FALLBACK_NOTICE = {
  webgl: "当前设备不支持 3D WebGL 视图，已自动为你切换为列表模式。",
  error: "3D 视图暂时加载异常，已为你切换为列表模式。",
};

/**
 * 经典记忆列表视图组件（支持搜索、分类过滤、强度条、点击卡片交互）
 */
function MemoryListView({ memories, filter, query, selectedId, onSelect, notice }) {
  const rows = useMemo(() => {
    const keyword = String(query || "").trim().toLowerCase();
    return memories
      .filter((m) => {
        const superseded = Boolean(m.superseded_at);
        if (filter === "__superseded") {
          if (!superseded) return false;
        } else if (filter !== "all") {
          if (superseded || (m.category || "") !== filter) return false;
        }
        if (keyword && !String(m.content || "").toLowerCase().includes(keyword)) return false;
        return true;
      })
      .sort((a, b) => {
        const sa = a.superseded_at ? 1 : 0;
        const sb = b.superseded_at ? 1 : 0;
        if (sa !== sb) return sa - sb;
        return Number(b.strength ?? 100) - Number(a.strength ?? 100);
      });
  }, [memories, filter, query]);

  return (
    <div className="absolute inset-0 flex flex-col">
      {notice && (
        <div
          role="status"
          className="shrink-0 mx-4 mt-3 rounded-lg border border-[#243149] bg-[#0f1524] px-3 py-2 text-xs leading-5 text-[#94A3B8]"
        >
          {notice}
        </div>
      )}

      {/* 选中后底部会浮出详情卡，留出充足边距 */}
      <div className={`flex-1 min-h-0 overflow-y-auto px-4 pt-3 ${selectedId !== null ? "pb-60" : "pb-4"}`}>
        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-[#94A3B8]">
            <span className="text-2xl mb-2">🍃</span>
            <p className="text-sm">没有匹配的记忆碎片</p>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {rows.map((m) => {
              const meta = metaOf(m.category);
              const superseded = Boolean(m.superseded_at);
              const strength = Math.max(0, Math.min(100, Number(m.strength ?? 100)));
              const isSelected = Number(selectedId) === Number(m.id);
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() =>
                      onSelect(isSelected ? null : { id: m.id, content: m.content, category: m.category })
                    }
                    className={`w-full text-left rounded-xl border p-3 transition-all duration-150 cursor-pointer ${
                      isSelected
                        ? "border-[#60A5FA] bg-[#16203a] shadow-md shadow-[#2563EB]/15"
                        : "border-[#1c2638] bg-[#0f1524] hover:bg-[#131c30] hover:border-[#2b3a54]"
                    } ${superseded ? "opacity-60" : ""}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium border ${meta.cls}`}>
                        {meta.label}
                      </span>
                      <span className="text-[11px] text-[#64748B]">
                        {formatMemoryDate(m.created_at)}
                      </span>
                      <div className="ml-auto flex items-center gap-1.5">
                        {!superseded ? (
                          <>
                            <div className="w-12 h-1.5 rounded-full bg-[#1e293b] overflow-hidden">
                              <div
                                className="h-full rounded-full bg-gradient-to-r from-[#3b82f6] to-[#60a5fa]"
                                style={{ width: `${strength}%` }}
                              />
                            </div>
                            <span className="text-[11px] font-medium text-[#60A5FA]">
                              {strength}%
                            </span>
                          </>
                        ) : (
                          <span className="text-[11px] text-[#94A3B8]">已失效</span>
                        )}
                      </div>
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-[#E2E8F0] break-words line-clamp-2">
                      {m.content || "（空记忆）"}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * 「记忆库 / 记忆星云」弹窗组件
 * 包含：3D 星云与列表明细双模式、星芒/列表项微光心愿详情卡片、与日记/会话的深度交互
 */
export default function MemoriesModal({
  open,
  memories = [],
  loading = false,
  total = 0,
  truncated = false,
  onClose,
  onAdd,
  onUpdate,
  onRestore,
  onDelete,
  onTalkAboutMemory,
  onWriteDiaryFromMemory,
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState(null);

  // 模式切换："graph" = 3D 星云（默认）；"list" = 列表明细
  const [viewMode, setViewMode] = useState("graph");
  const [graphFailed, setGraphFailed] = useState(null);

  // 编辑态
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editBusy, setEditBusy] = useState(false);

  const selected = useMemo(
    () => memories.find((m) => Number(m.id) === Number(selectedId)) || null,
    [memories, selectedId]
  );

  useEffect(() => {
    if (!open) {
      setText("");
      setSearch("");
      setFilter("all");
      setSelectedId(null);
      setEditing(false);
      setGraphFailed((reason) => (reason === "error" ? null : reason));
    }
  }, [open]);

  useEffect(() => {
    if (selectedId !== null && !selected) {
      setSelectedId(null);
      setEditing(false);
    }
  }, [selected, selectedId]);

  if (!open) return null;

  // 分类筛选列表
  const counts = {};
  let supersededCount = 0;
  for (const m of memories) {
    if (m.superseded_at) {
      supersededCount += 1;
      continue;
    }
    const key = m.category || "";
    counts[key] = (counts[key] || 0) + 1;
  }
  const filters = [
    { value: "all", label: "全部", n: memories.length },
    ...Object.keys(CATEGORY_META)
      .filter((key) => counts[key])
      .map((key) => ({ value: key, label: CATEGORY_META[key].label, n: counts[key] })),
    ...(counts[""] ? [{ value: "", label: FALLBACK_META.label, n: counts[""] }] : []),
    ...(supersededCount
      ? [{ value: "__superseded", label: "已失效", n: supersededCount }]
      : []),
  ];

  async function handleSubmit(e) {
    e.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    const ok = await onAdd?.(value);
    setBusy(false);
    if (ok) setText("");
  }

  function startEdit() {
    if (!selected) return;
    setEditing(true);
    setEditText(String(selected.content || ""));
    setEditCategory(selected.category || "");
  }

  async function saveEdit() {
    if (!selected || editBusy) return;
    const value = editText.trim();
    if (!value) return;
    if (
      value === String(selected.content || "").trim() &&
      (editCategory || "") === (selected.category || "")
    ) {
      setEditing(false);
      return;
    }
    setEditBusy(true);
    const ok = await onUpdate?.(selected.id, value, editCategory);
    setEditBusy(false);
    if (ok) setEditing(false);
  }

  function handleSelect(node) {
    setSelectedId(node ? node.id : null);
    setEditing(false);
  }

  const meta = selected ? metaOf(selected.category) : null;
  const whisper = selected ? whisperOf(selected.category) : "";
  const strength = selected ? Math.max(0, Math.min(100, Number(selected.strength ?? 100))) : 0;

  return (
    <>
      <style>{`
        @keyframes mem-veil-in { from { opacity: 0 } to { opacity: 1 } }
        @keyframes mem-card-in {
          from { opacity: 0; transform: translateY(12px) scale(0.985) }
          to { opacity: 1; transform: translateY(0) scale(1) }
        }
        @keyframes pulse-subtle {
          0%, 100% { opacity: 0.9; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.02); }
        }
      `}</style>

      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        style={{
          background:
            "radial-gradient(125% 105% at 50% 12%, rgba(8,12,20,0.85) 0%, rgba(3,5,9,0.96) 100%)",
          backdropFilter: "blur(12px) saturate(0.9)",
          WebkitBackdropFilter: "blur(12px) saturate(0.9)",
          animation: "mem-veil-in 180ms ease-out both",
        }}
        onClick={onClose}
      >
        <div
          className="w-[94%] max-w-3xl h-[84vh] max-h-[800px] flex flex-col overflow-hidden rounded-2xl border border-[#1c2638] bg-[#0a0f1c] text-[#E2E8F0]"
          style={{
            boxShadow: "0 30px 80px -24px rgba(0,0,0,0.95), 0 0 0 1px rgba(96,165,250,0.08)",
            animation: "mem-card-in 220ms cubic-bezier(0.22,1,0.36,1) both",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 顶栏：标题 + 双模式切换器（3D星云 / 列表明细） + 关闭按钮 */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-[#1c2638]">
            <div className="flex items-baseline gap-2">
              <h3 className="text-base font-bold text-[#E2E8F0]">记忆星云</h3>
              <span className="text-xs text-[#94A3B8]">
                {loading ? "正在展开…" : `共 ${total || memories.length} 条`}
              </span>
            </div>

            {/* 核心功能：3D 星云与经典列表模式自由切换 */}
            <div className="flex items-center rounded-xl bg-[#0f1524] p-0.5 border border-[#243149]">
              <button
                type="button"
                onClick={() => !graphFailed && setViewMode("graph")}
                disabled={!!graphFailed}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-all duration-150 flex items-center gap-1.5 cursor-pointer ${
                  viewMode === "graph" && !graphFailed
                    ? "bg-[#2563EB] text-white shadow-xs"
                    : "text-[#94A3B8] hover:text-[#E2E8F0] disabled:opacity-40 disabled:cursor-not-allowed"
                }`}
                title={graphFailed ? "当前设备不支持 3D 渲染" : "切换为 3D 星云视图"}
              >
                <span>🌌</span>
                <span>3D 星云</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("list")}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-all duration-150 flex items-center gap-1.5 cursor-pointer ${
                  viewMode === "list" || graphFailed
                    ? "bg-[#2563EB] text-white shadow-xs"
                    : "text-[#94A3B8] hover:text-[#E2E8F0]"
                }`}
                title="切换为经典列表明细视图"
              >
                <span>📋</span>
                <span>列表明细</span>
              </button>
            </div>

            <button
              onClick={onClose}
              className="text-[#94A3B8] hover:text-[#E2E8F0] text-lg leading-none w-8 h-8 flex items-center justify-center rounded-full hover:bg-[#162033] transition-colors cursor-pointer"
            >
              ×
            </button>
          </div>

          {/* 新增输入条 */}
          <form
            onSubmit={handleSubmit}
            className="px-5 py-2.5 border-b border-[#1c2638] flex items-center gap-2"
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 200))}
              placeholder="记一条想让 AI 记住的事…"
              maxLength={200}
              className={`flex-1 min-w-0 px-3 py-2 text-sm ${inputClass}`}
            />
            <button
              type="submit"
              disabled={!text.trim() || busy}
              className="shrink-0 rounded-lg border border-[#3B82F6] bg-[#2563EB] px-3.5 py-2 text-sm text-white hover:bg-[#3B82F6] active:scale-[0.98] transition-all duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
            >
              {busy ? "保存中…" : "保存"}
            </button>
          </form>

          {/* 搜索 + 分类筛选 */}
          <div className="px-5 pt-2.5">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value.slice(0, 50))}
              placeholder={viewMode === "list" || graphFailed ? "搜索记忆关键词…" : "搜索记忆（命中的星芒会高亮亮起）…"}
              maxLength={50}
              className={`w-full px-3 py-1.5 text-xs ${inputClass}`}
            />
          </div>
          {!loading && memories.length > 0 && filters.length > 2 && (
            <div className="px-5 pt-2 flex gap-1.5 overflow-x-auto pb-1">
              {filters.map((f) => (
                <button
                  key={f.value || "none"}
                  onClick={() => setFilter(f.value)}
                  className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] transition-colors duration-150 cursor-pointer ${
                    filter === f.value
                      ? "border-[#60A5FA] bg-[#1e2a44] text-[#E2E8F0]"
                      : "border-[#243149] bg-[#0f1524] text-[#94A3B8] hover:bg-[#16203a]"
                  }`}
                >
                  {f.label} {f.n}
                </button>
              ))}
            </div>
          )}

          {/* 主展示区：3D 星云视图 / 经典列表明细视图 */}
          <div className="relative flex-1 min-h-0">
            {loading ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="flex flex-col items-center gap-3" aria-busy="true">
                  <div className="w-12 h-12 rounded-full bg-[#162033] animate-pulse" />
                  <span className="text-xs text-[#94A3B8]">正在展开你的记忆…</span>
                </div>
              </div>
            ) : memories.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center px-8">
                <p className="text-sm text-[#94A3B8] text-center leading-6">
                  还没有记忆，AI 会在日常陪伴聊天中慢慢了解并记住你
                </p>
              </div>
            ) : viewMode === "list" || graphFailed ? (
              <MemoryListView
                memories={memories}
                filter={filter}
                query={search}
                selectedId={selectedId}
                onSelect={handleSelect}
                notice={graphFailed ? GRAPH_FALLBACK_NOTICE[graphFailed] : null}
              />
            ) : (
              <GraphBoundary onFail={() => setGraphFailed("error")}>
                <MemoryGraph3D
                  memories={memories}
                  selectedId={selectedId}
                  filter={filter}
                  query={search}
                  onSelect={handleSelect}
                  onUnsupported={() => setGraphFailed("webgl")}
                />
              </GraphBoundary>
            )}

            {/* 核心交互：点击高亮星芒 / 列表项后浮现的心愿与记忆碎片卡片（具备与会话/日记的深度联动） */}
            {selected && !loading && (
              <div
                className="absolute inset-x-3 bottom-3 rounded-2xl border border-[#3b4b68] bg-[#0b1324]/95 px-5 py-4 text-[#E2E8F0] shadow-[0_20px_50px_rgba(0,0,0,0.95)] backdrop-blur-md"
                style={{ animation: "mem-card-in 200ms ease-out both" }}
              >
                {/* 卡片顶栏：陪伴引言 + 分类徽标 + 强度 + 日期 */}
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <span className="text-xs font-medium text-[#F5DCD3] tracking-wide">
                    {whisper}
                  </span>
                  <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium border ${meta.cls}`}>
                    {meta.label}
                  </span>
                  {selected.superseded_at ? (
                    <span className="rounded-full bg-[#1f2937] px-2 py-0.5 text-[11px] text-[#94A3B8]">
                      已失效 · 不再注入
                    </span>
                  ) : (
                    <span className="text-[11px] text-[#60A5FA] bg-[#122038] px-2 py-0.5 rounded-full border border-[#1e3458]">
                      记忆强度 {strength}%
                    </span>
                  )}
                  <span className="text-[11px] text-[#64748B] ml-auto">
                    {formatMemoryDate(selected.created_at)}
                  </span>
                  <button
                    onClick={() => setSelectedId(null)}
                    title="关闭卡片"
                    className="text-xs text-[#64748B] hover:text-[#E2E8F0] px-1.5 py-0.5 rounded hover:bg-[#162033] transition-colors cursor-pointer"
                  >
                    ✕
                  </button>
                </div>

                {/* 编辑模式 */}
                {editing ? (
                  <>
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value.slice(0, 200))}
                      maxLength={200}
                      rows={2}
                      className={`w-full resize-none px-3 py-2 text-sm ${inputClass}`}
                    />
                    <div className="mt-2.5 flex items-center gap-2">
                      <select
                        value={editCategory}
                        onChange={(e) => setEditCategory(e.target.value)}
                        className="border border-[#243149] bg-[#0f1524] px-2.5 py-1.5 text-xs text-[#CBD5E1] rounded-lg focus:outline-none focus:border-[#60A5FA]"
                      >
                        {EDIT_CATEGORIES.map((c) => (
                          <option key={c.value || "none"} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                      <span className="text-[11px] text-[#64748B]">
                        {editText.trim().length}/200
                      </span>
                      <div className="ml-auto flex items-center gap-1.5">
                        <button
                          onClick={saveEdit}
                          disabled={!editText.trim() || editBusy}
                          className="border border-[#3B82F6] bg-[#2563EB] text-white rounded-lg px-3.5 py-1.5 text-xs hover:bg-[#3B82F6] active:scale-[0.98] transition-all duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {editBusy ? "保存中…" : "保存修改"}
                        </button>
                        <button
                          onClick={() => setEditing(false)}
                          disabled={editBusy}
                          className="text-xs text-[#94A3B8] hover:text-[#E2E8F0] hover:bg-[#162033] px-2.5 py-1.5 rounded-lg transition-colors cursor-pointer"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    {/* 心愿/记忆正文展示 */}
                    <div className="relative pl-3 my-2 border-l-2 border-[#60A5FA]/60 bg-[#121b2d]/50 p-2 rounded-r-xl">
                      <p className="text-sm sm:text-base leading-relaxed text-[#F1F5F9] font-medium break-words whitespace-pre-wrap max-h-24 overflow-y-auto">
                        “{selected.content}”
                      </p>
                    </div>

                    {/* 深度交互按钮组：开启会话 / 写入日记 / 基础维护 */}
                    <div className="mt-3 flex items-center gap-2 flex-wrap pt-1 border-t border-[#1e2a40]">
                      {/* 联动 1：以此记忆开启深度陪伴对话 */}
                      <button
                        type="button"
                        onClick={() => onTalkAboutMemory?.(selected)}
                        className="flex items-center gap-1.5 rounded-xl border border-[#e2a68c]/50 bg-gradient-to-r from-[#c06b50] to-[#b85a3c] text-white px-3.5 py-1.5 text-xs font-semibold shadow-sm shadow-[#b85a3c]/20 hover:from-[#b05f45] hover:to-[#a84f33] active:scale-95 transition-all cursor-pointer"
                      >
                        <span>💬</span>
                        <span>聊聊这个心愿 / 记忆</span>
                      </button>

                      {/* 联动 2：以此记忆写入今日日记灵感 */}
                      <button
                        type="button"
                        onClick={() => onWriteDiaryFromMemory?.(selected)}
                        className="flex items-center gap-1.5 rounded-xl border border-[#3b82f6]/50 bg-[#1a2942] text-[#93c5fd] hover:bg-[#223656] hover:text-white px-3.5 py-1.5 text-xs font-semibold active:scale-95 transition-all cursor-pointer"
                      >
                        <span>📖</span>
                        <span>记入今日手账</span>
                      </button>

                      {/* 基础维护：编辑 / 恢复 / 删除 */}
                      <div className="ml-auto flex items-center gap-1.5">
                        {selected.superseded_at ? (
                          <button
                            onClick={() => onRestore?.(selected.id)}
                            className="rounded-lg border border-[#14532d] bg-[#0f2018] px-3 py-1.5 text-xs text-[#86EFAC] hover:bg-[#143024] transition-colors cursor-pointer"
                          >
                            恢复记忆
                          </button>
                        ) : (
                          <button
                            onClick={startEdit}
                            className="rounded-lg border border-[#243149] bg-[#0f1524] px-2.5 py-1.5 text-xs text-[#CBD5E1] hover:bg-[#162033] hover:text-[#E2E8F0] transition-colors cursor-pointer"
                          >
                            编辑
                          </button>
                        )}
                        <button
                          onClick={() => onDelete?.(selected.id)}
                          className="rounded-lg border border-[#5b1e1e] bg-[#1f1215] px-2.5 py-1.5 text-xs text-[#FCA5A5] hover:bg-[#2a171a] transition-colors cursor-pointer"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* 底部说明栏 */}
          <div className="px-5 py-2.5 border-t border-[#1c2638] flex items-center gap-2 text-[11px] text-[#94A3B8]">
            <span className="inline-block w-2 h-2 rounded-full bg-[#60A5FA] shadow-[0_0_6px_rgba(96,165,250,0.7)]" />
            <span>中心是暖言</span>
            <span className="text-[#334155]">·</span>
            <span>高亮星芒 = 愿望/偏好/重要画像</span>
            <span className="text-[#334155]">·</span>
            <span>点击星芒即可唤起记忆心愿并一键与 AI 畅聊或记入手账</span>
            {truncated && <span className="ml-auto text-[#64748B]">呈现最鲜活的 150 条</span>}
          </div>
        </div>
      </div>
    </>
  );
}

/** 日期显示：今天 HH:MM / 昨天 HH:MM / M月D日 / YYYY年M月D日 */
function formatMemoryDate(value) {
  if (!value) return "刚刚";
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  const now = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((startOfToday - target) / 86400000);
  if (diffDays === 0) return `今天 ${hhmm}`;
  if (diffDays === 1) return `昨天 ${hhmm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
