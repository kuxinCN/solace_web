"use client";

/**
 * 「我的收藏」弹窗：列出所有已收藏（is_favorited = 1）的日记。
 * props:
 *   open         是否显示
 *   diaries      收藏的日记数组（由父组件过滤后传入，保证与列表状态实时一致）
 *   onClose      关闭回调
 *   onOpenDiary  点击某条查看全文（复用父组件的日记详情逻辑）
 */
export default function FavoritesModal({ open, diaries = [], onClose, onOpenDiary }) {
  if (!open) return null;

  return (
    <>
      <style>{`
        @keyframes fav-veil-in { from { opacity: 0 } to { opacity: 1 } }
        @keyframes fav-card-in {
          from { opacity: 0; transform: translateY(12px) scale(0.985) }
          to { opacity: 1; transform: translateY(0) scale(1) }
        }
      `}</style>

      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        style={{
          // 与测评历史弹窗同一套暖色遮罩：中心稍亮、四周压暗
          background:
            "radial-gradient(125% 105% at 50% 12%, rgba(58,68,74,0.30) 0%, rgba(30,38,43,0.56) 100%)",
          backdropFilter: "blur(8px) saturate(0.98)",
          WebkitBackdropFilter: "blur(8px) saturate(0.98)",
          animation: "fav-veil-in 180ms ease-out both",
        }}
        onClick={onClose}
      >
        <div
          className="bg-[#fbfaf7] rounded-2xl border border-[#e8eae7] w-[92%] max-w-lg max-h-[82vh] flex flex-col overflow-hidden"
          style={{
            boxShadow:
              "0 28px 70px -24px rgba(38,48,54,0.55), 0 2px 8px rgba(38,48,54,0.08)",
            animation: "fav-card-in 220ms cubic-bezier(0.22,1,0.36,1) both",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 标题栏 */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#e8eae7]">
            <h3 className="text-base font-bold text-slate-800">我的收藏</h3>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 text-lg leading-none w-8 h-8 flex items-center justify-center rounded-full hover:bg-[#eef4f8] transition-colors"
            >
              ×
            </button>
          </div>

          {/* 列表 */}
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {diaries.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-10">
                还没有收藏的日记
              </p>
            ) : (
              <div className="space-y-2.5">
                {diaries.map((d) => {
                  const text = d.content || "";
                  return (
                    <button
                      key={d.id}
                      onClick={() => onOpenDiary?.(d)}
                      className="w-full text-left rounded-xl border border-[#e8eae7] bg-white px-4 py-3 hover:border-[#c7d8e3] hover:bg-[#fafcfd] active:scale-[0.995] transition-all duration-150"
                    >
                      <div className="flex items-center gap-2">
                        <svg
                          className="w-3.5 h-3.5 text-[#c68b2e] shrink-0"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                        </svg>
                        <p className="text-sm font-medium text-slate-700 truncate flex-1 min-w-0">
                          {d.title}
                        </p>
                      </div>
                      <p className="text-xs text-slate-400 mt-1.5">
                        {formatDiaryDate(d.created_at)}
                      </p>
                      <p className="text-xs text-slate-500 mt-1 leading-5">
                        {text.slice(0, 70) || "（空）"}
                        {text.length > 70 ? "…" : ""}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** 日期显示：今天 / 昨天 / M月D日 / YYYY年M月D日 */
function formatDiaryDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((startOfToday - target) / 86400000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays > 1 && diffDays < 30) return `${diffDays} 天前`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
