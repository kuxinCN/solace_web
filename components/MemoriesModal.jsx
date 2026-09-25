"use client";

import { useState } from "react";

/**
 * 「记忆库」弹窗：查看 / 手动新增 / 删除长期记忆。
 *
 * props:
 *   open        是否显示
 *   memories    记忆数组（父组件持有，保证与后端状态一致）
 *   loading     列表加载中
 *   onClose     关闭回调
 *   onAdd(text) 新增，返回 Promise<boolean>（true = 成功，输入框会清空）
 *   onDelete(id) 删除
 */
export default function MemoriesModal({
  open,
  memories = [],
  loading = false,
  onClose,
  onAdd,
  onDelete,
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    const ok = await onAdd?.(value);
    setBusy(false);
    if (ok) setText("");
  }

  return (
    <>
      <style>{`
        @keyframes mem-veil-in { from { opacity: 0 } to { opacity: 1 } }
        @keyframes mem-card-in {
          from { opacity: 0; transform: translateY(12px) scale(0.985) }
          to { opacity: 1; transform: translateY(0) scale(1) }
        }
      `}</style>

      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        style={{
          // 与收藏 / 测评历史弹窗同一套暖色遮罩
          background:
            "radial-gradient(125% 105% at 50% 12%, rgba(58,68,74,0.30) 0%, rgba(30,38,43,0.56) 100%)",
          backdropFilter: "blur(8px) saturate(0.98)",
          WebkitBackdropFilter: "blur(8px) saturate(0.98)",
          animation: "mem-veil-in 180ms ease-out both",
        }}
        onClick={onClose}
      >
        <div
          className="bg-[#fbfaf7] rounded-2xl border border-[#e8eae7] w-[92%] max-w-lg max-h-[82vh] flex flex-col overflow-hidden"
          style={{
            boxShadow:
              "0 28px 70px -24px rgba(38,48,54,0.55), 0 2px 8px rgba(38,48,54,0.08)",
            animation: "mem-card-in 220ms cubic-bezier(0.22,1,0.36,1) both",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 标题栏 */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#e8eae7]">
            <div className="flex items-baseline gap-2">
              <h3 className="text-base font-bold text-slate-800">记忆库</h3>
              {memories.length > 0 && (
                <span className="text-xs text-slate-400">共 {memories.length} 条</span>
              )}
            </div>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 text-lg leading-none w-8 h-8 flex items-center justify-center rounded-full hover:bg-[#eef4f8] transition-colors"
            >
              ×
            </button>
          </div>

          {/* 新增：输入框 + 保存 */}
          <form
            onSubmit={handleSubmit}
            className="px-5 py-3 border-b border-[#e8eae7] flex items-center gap-2"
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 200))}
              placeholder="记一条想让 AI 记住的事…"
              maxLength={200}
              className="flex-1 min-w-0 border border-[#d5d9d7] bg-white px-3 py-2 text-sm text-gray-800 placeholder-gray-400 rounded-lg transition-colors duration-150 focus:outline-none focus:border-[#8fb3c7] focus:ring-1 focus:ring-[#8fb3c7]"
            />
            <button
              type="submit"
              disabled={!text.trim() || busy}
              className="shrink-0 border border-[#7fa8c4] bg-[#7fa8c4] text-white rounded-lg px-3.5 py-2 text-sm hover:bg-[#6b98b4] active:scale-[0.98] transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
            >
              {busy ? "保存中…" : "保存"}
            </button>
          </form>

          {/* 列表 */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {loading ? (
              <p className="text-sm text-slate-400 text-center py-10">加载中…</p>
            ) : memories.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-10 leading-6">
                还没有记忆，AI 会在聊天中慢慢了解你
              </p>
            ) : (
              <div className="space-y-2.5">
                {memories.map((m, i) => (
                  <div
                    key={m.id}
                    className="group rounded-xl border border-[#e8eae7] bg-white px-4 py-3 flex items-start gap-3"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-slate-400">
                        {formatMemoryDate(m.created_at, i, memories)}
                      </p>
                      <p className="text-sm text-slate-700 mt-1 leading-6 break-words whitespace-pre-wrap">
                        {m.content}
                      </p>
                    </div>
                    <button
                      onClick={() => onDelete?.(m.id)}
                      title="删除这条记忆"
                      className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors duration-150"
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
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** 日期显示：今天 HH:MM / 昨天 HH:MM / M月D日 / YYYY年M月D日 */
function formatMemoryDate(value, index, list) {
  // 手动新增后本地没有 created_at，用「刚刚」占位（下一次拉取即为真实时间）
  if (!value) return index === 0 ? "刚刚" : "";
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
