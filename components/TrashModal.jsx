"use client";

/**
 * 回收站弹窗（「我的」页面用）
 *
 * 规则：
 *   * 每条不超过 512KB —— 超了服务端会截断正文并标记
 *   * 保留 3 天 —— 到期由清理任务自动删除，列表里显示剩余时间
 *   * 分类：聊天记录 / 日记 / 习惯（习惯功能还没上线，tab 先留好）
 *
 * 交互（按需求定的，改之前先看清楚）：
 *   * **默认不是多选状态** —— 卡片左侧没有复选框
 *   * **左键单击**某条 → 弹窗展示该条内容
 *       - 聊天记录：标题 + 完整对话气泡
 *       - 日记：标题 + 正文（排版和日记页一致）
 *       - 习惯：内容和添加时间
 *   * **右键单击**某条 → 弹出三个选项：恢复 / 删除 / 多选
 *       - 选「多选」才进入多选状态，这时卡片左侧出现复选框
 *   * 多选状态下左键 = 勾选；批量恢复 / 批量删除都要二次确认
 *   * 顶部「全部恢复」「全部删除」针对当前分类
 */
import { useCallback, useEffect, useMemo, useState } from "react";

/** 剩余时间 → 人话 */
function formatRemain(ms) {
  if (!ms || ms <= 0) return "即将清理";
  const hours = Math.floor(ms / 3600000);
  if (hours >= 24) return `还剩 ${Math.floor(hours / 24)} 天`;
  if (hours >= 1) return `还剩 ${hours} 小时`;
  return `还剩 ${Math.max(1, Math.floor(ms / 60000))} 分钟`;
}

function formatTime(value) {
  if (!value) return "";
  try {
    const date = new Date(value);
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
      date.getHours()
    )}:${pad(date.getMinutes())}`;
  } catch {
    return "";
  }
}

/** 二次确认弹窗（自己实现，和站内其他确认框风格一致） */
function ConfirmDialog({ open, title, message, confirmText, danger, busy, onCancel, onConfirm }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30 px-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
        <h3 className="text-sm font-bold text-slate-800">{title}</h3>
        <p className="mt-2 text-xs leading-relaxed whitespace-pre-line text-slate-600">{message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-lg border border-[#d5d9d7] px-3 py-1.5 text-xs text-slate-600 transition-colors hover:bg-[#f2f5f4] disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`rounded-lg px-3 py-1.5 text-xs text-white transition-colors disabled:opacity-60 ${
              danger ? "bg-red-500 hover:bg-red-600" : "bg-[#7a9fb5] hover:bg-[#6b8fa5]"
            }`}
          >
            {busy ? "处理中…" : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 右键菜单：恢复 / 删除 / 多选 */
function ContextMenu({ x, y, onRestore, onDelete, onMulti, onClose }) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [onClose]);

  const items = [
    { label: "恢复", onClick: onRestore, className: "text-slate-700 hover:bg-[#f1f5f7]" },
    { label: "删除", onClick: onDelete, className: "text-red-500 hover:bg-[#fbecec]" },
    { label: "多选", onClick: onMulti, className: "text-slate-700 hover:bg-[#f1f5f7]" },
  ];

  return (
    <div
      className="fixed z-[85] w-28 overflow-hidden rounded-xl border border-[#e6e8e6] bg-white py-1 shadow-xl"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          onClick={item.onClick}
          className={`block w-full px-3 py-2 text-left text-xs transition-colors ${item.className}`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** 内容预览弹窗：按类型渲染 */
function PreviewModal({ item, loading, error, onClose }) {
  if (!loading && !error && !item) return null;

  const payload = item?.payload || {};
  const type = item?.itemType;

  return (
    <div className="fixed inset-0 z-[82] flex items-center justify-center bg-black/30 px-4">
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-[#eef1ef] px-5 py-3.5">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-bold text-slate-800">
              {loading ? "加载中…" : item?.title || "内容"}
            </h3>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {type === "conversation"
                ? "聊天记录"
                : type === "diary"
                ? "日记"
                : type === "memory"
                ? "记忆"
                : "消息"}
              {item ? ` · ${formatTime(item.deletedAt)} 删除 · ${formatRemain(item.remainMs)}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-2 text-lg leading-none text-slate-400 transition-colors hover:text-slate-600"
            title="关闭"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <p className="py-8 text-center text-xs text-slate-400">加载中…</p>
          ) : error ? (
            <p className="py-8 text-center text-xs text-red-500">{error}</p>
          ) : type === "conversation" ? (
            /* 聊天记录：标题 + 对话气泡（和聊天界面同一套配色） */
            <div className="space-y-3">
              {Array.isArray(payload.messages) && payload.messages.length ? (
                payload.messages.map((msg, idx) => {
                  const isUser = msg.role === "user";
                  return (
                    <div key={msg.id || idx} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                      <div
                        className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                          isUser
                            ? "bg-[#dfeaf1] text-slate-800"
                            : "bg-[#f4f6f5] text-slate-700"
                        }`}
                      >
                        {String(msg.content || "")}
                      </div>
                    </div>
                  );
                })
              ) : (
                <p className="py-6 text-center text-xs text-slate-400">这段对话没有可显示的消息</p>
              )}
              {payload.truncated ? (
                <p className="pt-2 text-center text-[11px] text-amber-600">
                  内容过大，回收站只保留了部分消息
                </p>
              ) : null}
            </div>
          ) : type === "diary" ? (
            /* 日记：排版尽量和日记页一致 */
            <div className="rounded-xl bg-[#fdfdfc] px-4 py-4">
              <h4 className="text-base font-medium text-slate-800">{payload.title || "无题"}</h4>
              <p className="mt-1 text-[11px] text-slate-400">
                {formatTime(payload.createdAt)}
                {payload.mood ? ` · ${payload.mood}` : ""}
              </p>
              <div className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-slate-700">
                {payload.content || "（没有内容）"}
              </div>
              {payload.truncated ? (
                <p className="mt-3 text-[11px] text-amber-600">内容过大，只保留了前面一部分</p>
              ) : null}
            </div>
          ) : type === "memory" ? (
            /* 记忆库：内容 + 分类 + 添加时间 */
            <div className="rounded-xl bg-[#fdfdfc] px-4 py-4">
              <div className="whitespace-pre-wrap break-words text-sm leading-7 text-slate-700">
                {payload.content || "（没有内容）"}
              </div>
              <p className="mt-3 border-t border-[#eef1ef] pt-2 text-[11px] text-slate-400">
                {payload.category ? `分类：${payload.category} · ` : ""}
                添加时间：{formatTime(payload.createdAt)}
              </p>
            </div>
          ) : (
            /* 单条消息 */
            <div
              className={`whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                payload.role === "user" ? "bg-[#dfeaf1] text-slate-800" : "bg-[#f4f6f5] text-slate-700"
              }`}
            >
              {payload.content || "（没有内容）"}
            </div>
          )}
        </div>

        <div className="flex justify-end border-t border-[#eef1ef] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[#d5d9d7] px-3 py-1.5 text-xs text-slate-600 transition-colors hover:bg-[#f2f5f4]"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

export default function TrashModal({ open, onClose, apiRequest }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [category, setCategory] = useState("chat");
  const [selected, setSelected] = useState([]);
  const [hoverId, setHoverId] = useState(null);
  /** 多选模式：默认关闭，右键选「多选」或点顶部按钮才打开 */
  const [multiMode, setMultiMode] = useState(false);
  const [menu, setMenu] = useState(null); // { x, y, item }
  const [preview, setPreview] = useState(null); // { item, loading, error }
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  const items = useMemo(() => data?.items || [], [data]);
  const categories = useMemo(
    () =>
      data?.categories || [
        { id: "chat", label: "聊天记录", count: 0 },
        { id: "diary", label: "日记", count: 0 },
        { id: "memory", label: "记忆", count: 0 },
      ],
    [data]
  );

  const load = useCallback(
    async (nextCategory = category) => {
      setLoading(true);
      setError("");
      try {
        const result = await apiRequest(`/api/user/trash?category=${encodeURIComponent(nextCategory)}`);
        setData(result);
        setSelected([]);
      } catch (err) {
        setError(err.message || "加载失败");
      } finally {
        setLoading(false);
      }
    },
    [apiRequest, category]
  );

  useEffect(() => {
    if (open) {
      setNotice("");
      setError("");
      setSelected([]);
      setMultiMode(false);
      setMenu(null);
      setPreview(null);
      load(category);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, category]);

  if (!open) return null;

  const allSelected = items.length > 0 && selected.length === items.length;

  function toggleOne(id) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleAll() {
    setSelected(allSelected ? [] : items.map((item) => item.id));
  }

  /** 左键单击：多选模式下是勾选，否则打开预览 */
  function handleItemClick(item) {
    if (multiMode) {
      toggleOne(item.id);
      return;
    }
    openPreview(item);
  }

  /** 右键：弹出三个选项 */
  function handleContextMenu(event, item) {
    event.preventDefault();
    const menuWidth = 120;
    const menuHeight = 120;
    setMenu({
      x: Math.min(event.clientX, window.innerWidth - menuWidth - 8),
      y: Math.min(event.clientY, window.innerHeight - menuHeight - 8),
      item,
    });
  }

  /** 打开预览：拉单条详情（列表接口不返回 payload） */
  async function openPreview(item) {
    setPreview({ item: null, loading: true, error: "" });
    try {
      const result = await apiRequest(`/api/user/trash?id=${encodeURIComponent(item.id)}`);
      if (!result?.item) throw new Error("取不到内容");
      setPreview({ item: result.item, loading: false, error: "" });
    } catch (err) {
      setPreview({ item: null, loading: false, error: err.message || "取不到内容" });
    }
  }

  // ---------- 恢复 ----------
  function askRestore(targets, label) {
    if (!targets.length) return;
    setConfirm({
      title: "恢复确认",
      message:
        targets.length === 1
          ? `确定要恢复「${targets[0].title}」吗？\n恢复后会回到原来的位置。`
          : `确定要恢复这 ${targets.length} 条${label || ""}吗？`,
      confirmText: "恢复",
      danger: false,
      action: async () => {
        const body = targets === "all" ? { all: true, category } : { ids: targets.map((i) => i.id) };
        const result = await apiRequest("/api/user/trash", { method: "POST", body });
        const failed = result?.failed || [];
        setNotice(
          failed.length
            ? `已恢复 ${result?.restoredCount || 0} 条，${failed.length} 条失败：${failed
                .map((f) => f.reason)
                .join("；")}`
            : `已恢复 ${result?.restoredCount || 0} 条`
        );
        await load();
      },
    });
  }

  // ---------- 彻底删除 ----------
  function askDelete(targets, label) {
    if (!targets.length) return;
    setConfirm({
      title: "彻底删除确认",
      message:
        targets === "all"
          ? `确定要清空当前分类的${label || "全部"}内容吗？\n\n删除后无法恢复。`
          : targets.length === 1
          ? `确定要彻底删除「${targets[0].title}」吗？\n\n删除后无法恢复。`
          : `确定要彻底删除这 ${targets.length} 条吗？\n\n删除后无法恢复。`,
      confirmText: "彻底删除",
      danger: true,
      action: async () => {
        if (targets === "all") {
          const result = await apiRequest(
            `/api/user/trash?all=1&category=${encodeURIComponent(category)}`,
            { method: "DELETE" }
          );
          setNotice(`已删除 ${result?.deletedCount || 0} 条`);
        } else {
          const ids = targets.map((i) => i.id).join(",");
          const result = await apiRequest(`/api/user/trash?ids=${ids}`, { method: "DELETE" });
          setNotice(`已删除 ${result?.deletedCount || 0} 条`);
        }
        await load();
      },
    });
  }

  async function runConfirm() {
    if (!confirm?.action) return;
    setBusy(true);
    setError("");
    try {
      await confirm.action();
    } catch (err) {
      setError(err.message || "操作失败");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  const currentLabel = categories.find((i) => i.id === category)?.label || "";
  const selectedItems = items.filter((i) => selected.includes(i.id));

  return (
    <>
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 px-4">
        <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
          {/* 头部 */}
          <div className="flex items-center justify-between border-b border-[#eef1ef] px-5 py-3.5">
            <div>
              <h2 className="text-sm font-bold text-slate-800">回收站</h2>
              <p className="mt-0.5 text-[11px] text-slate-400">
                保留 {data?.days || 3} 天，单条上限 {data?.maxPayloadKb || 512}KB
                {multiMode ? " · 多选模式：点击卡片勾选" : " · 单击查看内容，右键更多操作"}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="px-2 text-lg leading-none text-slate-400 transition-colors hover:text-slate-600"
              title="关闭"
            >
              ×
            </button>
          </div>

          {/* 分类 tab */}
          <div className="flex items-center gap-1.5 border-b border-[#eef1ef] px-5 py-2.5">
            {categories.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setCategory(item.id);
                  setMultiMode(false);
                }}
                className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${
                  category === item.id
                    ? "bg-[#e8eff2] text-slate-800"
                    : "text-slate-500 hover:bg-[#f4f6f5]"
                }`}
              >
                {item.label}
                {typeof item.count === "number" ? `（${item.count}）` : ""}
              </button>
            ))}
          </div>

          {error ? (
            <div className="mx-5 mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>
          ) : null}
          {notice ? (
            <div className="mx-5 mt-3 rounded-lg bg-[#eef4f1] px-3 py-2 text-xs text-slate-700">
              {notice}
            </div>
          ) : null}

          {/* 操作栏 */}
          <div className="flex flex-wrap items-center gap-2 px-5 py-3">
            <button
              type="button"
              disabled={!items.length}
              onClick={() => {
                setMultiMode((v) => !v);
                setSelected([]);
              }}
              className={`rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${
                multiMode
                  ? "border-[#a9c6da] bg-[#e3edf3] text-slate-800"
                  : "border-[#d5d9d7] text-slate-600 hover:bg-[#f2f5f4]"
              }`}
              title="也可以在任意一条上点右键选「多选」"
            >
              多选
            </button>

            {multiMode ? (
              <>
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    disabled={!items.length}
                    className="h-3.5 w-3.5 accent-[#7a9fb5]"
                  />
                  全选
                </label>
                <button
                  type="button"
                  disabled={!selected.length}
                  onClick={() => askRestore(selectedItems, currentLabel)}
                  className="rounded-lg border border-[#cfe0e8] bg-[#f2f7fa] px-2.5 py-1 text-xs text-slate-700 transition-colors hover:bg-[#e8eff2] disabled:opacity-40"
                >
                  恢复所选（{selected.length}）
                </button>
                <button
                  type="button"
                  disabled={!selected.length}
                  onClick={() => askDelete(selectedItems, currentLabel)}
                  className="rounded-lg border border-[#e5c9c9] bg-[#fdf6f6] px-2.5 py-1 text-xs text-red-500 transition-colors hover:bg-[#fbecec] disabled:opacity-40"
                >
                  删除所选（{selected.length}）
                </button>
              </>
            ) : null}

            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                disabled={!items.length}
                onClick={() => askRestore("all", currentLabel)}
                className="rounded-lg border border-[#cfe0e8] bg-[#f2f7fa] px-2.5 py-1 text-xs text-slate-700 transition-colors hover:bg-[#e8eff2] disabled:opacity-40"
              >
                全部恢复
              </button>
              <button
                type="button"
                disabled={!items.length}
                onClick={() => askDelete("all", currentLabel)}
                className="rounded-lg border border-[#e5c9c9] bg-[#fdf6f6] px-2.5 py-1 text-xs text-red-500 transition-colors hover:bg-[#fbecec] disabled:opacity-40"
              >
                全部删除
              </button>
            </div>
          </div>

          {/* 列表 */}
          <div className="flex-1 overflow-y-auto border-t border-[#eef1ef] px-5 py-3">
            {loading ? (
              <p className="py-8 text-center text-xs text-slate-400">加载中…</p>
            ) : !items.length ? (
              <p className="py-10 text-center text-xs text-slate-400">
                这个分类里没有内容
                <br />
                <span className="text-[11px]">
                  删除的{currentLabel}会在这里保留 {data?.days || 3} 天
                </span>
              </p>
            ) : (
              <ul className="space-y-2">
                {items.map((item) => {
                  const checked = selected.includes(item.id);
                  const hovered = hoverId === item.id;
                  return (
                    <li
                      key={item.id}
                      onMouseEnter={() => setHoverId(item.id)}
                      onMouseLeave={() => setHoverId(null)}
                      onClick={() => handleItemClick(item)}
                      onContextMenu={(e) => handleContextMenu(e, item)}
                      className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                        checked
                          ? "border-[#bfd4de] bg-[#f6fafc]"
                          : "border-[#e9ecea] hover:bg-[#fafbfa]"
                      }`}
                    >
                      {/* 只在多选模式显示复选框 */}
                      {multiMode ? (
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleOne(item.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="h-3.5 w-3.5 shrink-0 accent-[#7a9fb5]"
                        />
                      ) : null}

                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-slate-700">{item.title}</p>
                        <p className="mt-0.5 text-[11px] text-slate-400">
                          {formatTime(item.deletedAt)} 删除 · {formatRemain(item.remainMs)} · 约{" "}
                          {item.sizeKb}KB
                        </p>
                      </div>

                      {/* 悬浮时右侧出现两个图标（多选模式下隐藏，避免和勾选冲突） */}
                      {!multiMode ? (
                        <div
                          className={`flex shrink-0 items-center gap-1 transition-opacity ${
                            hovered ? "opacity-100" : "opacity-0"
                          }`}
                        >
                          <button
                            type="button"
                            title="恢复"
                            onClick={(e) => {
                              e.stopPropagation();
                              askRestore([item]);
                            }}
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-[#e8eff2] hover:text-[#5b7f95]"
                          >
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="h-4 w-4"
                            >
                              <path d="M3 12a9 9 0 1 0 3-6.7" />
                              <path d="M3 4v5h5" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            title="彻底删除"
                            onClick={(e) => {
                              e.stopPropagation();
                              askDelete([item]);
                            }}
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-[#fbecec] hover:text-red-500"
                          >
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="h-4 w-4"
                            >
                              <path d="M3 6h18" />
                              <path d="M8 6V4h8v2" />
                              <path d="M19 6l-1 14H6L5 6" />
                              <path d="M10 11v6M14 11v6" />
                            </svg>
                          </button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* 底部 */}
          <div className="flex items-center justify-between border-t border-[#eef1ef] px-5 py-3">
            <p className="text-[11px] text-slate-400">
              共 {items.length} 条
              {multiMode ? ` · 选中 ${selected.length} 条` : ""}
            </p>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-[#d5d9d7] px-3 py-1.5 text-xs text-slate-600 transition-colors hover:bg-[#f2f5f4]"
            >
              关闭
            </button>
          </div>
        </div>
      </div>

      {/* 右键菜单 */}
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onRestore={() => {
            askRestore([menu.item]);
            setMenu(null);
          }}
          onDelete={() => {
            askDelete([menu.item]);
            setMenu(null);
          }}
          onMulti={() => {
            setMultiMode(true);
            setSelected([menu.item.id]);
            setMenu(null);
          }}
        />
      ) : null}

      {/* 内容预览 */}
      <PreviewModal
        item={preview?.item}
        loading={preview?.loading}
        error={preview?.error}
        onClose={() => setPreview(null)}
      />

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.title || ""}
        message={confirm?.message || ""}
        confirmText={confirm?.confirmText || "确定"}
        danger={Boolean(confirm?.danger)}
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={runConfirm}
      />
    </>
  );
}
