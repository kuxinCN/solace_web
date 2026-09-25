"use client";

/**
 * 删除方式选择弹窗 —— 一个弹窗、三个按钮，不再用两段式确认。
 *
 *   [删除]      移入回收站（保留 3 天，可以恢复）
 *   [彻底删除]  直接从数据库删掉，不可恢复（红色）
 *   [取消]      什么都不做
 *
 * ⚠️ 不要用 window.confirm：浏览器原生弹窗样式和站内风格不一致，
 *    而且只能给两个选项，逼得我们要问两次 —— 用户会觉得"怎么点了三次确认"。
 */
export default function DeleteChoiceModal({
  open,
  /** 要删的东西叫什么，例如 "日记"、"对话"、"这条消息" */
  target = "内容",
  /** 具体名称（可选），会显示在正文里 */
  name = "",
  busy = false,
  onCancel,
  onTrash,
  onPermanent,
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/30 px-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
        <h3 className="text-sm font-bold text-slate-800">删除{target}</h3>
        <p className="mt-2 text-xs leading-relaxed text-slate-600">
          {name ? (
            <>
              确定要删除「<span className="text-slate-700">{name}</span>」吗？
            </>
          ) : (
            <>请选择删除方式：</>
          )}
        </p>

        <div className="mt-4 space-y-2">
          <button
            type="button"
            disabled={busy}
            onClick={onTrash}
            className="w-full rounded-lg border border-[#cfe0e8] bg-[#f2f7fa] px-3 py-2.5 text-left transition-colors hover:bg-[#e8eff2] disabled:opacity-50"
          >
            <span className="block text-sm text-slate-700">删除</span>
            <span className="mt-0.5 block text-[11px] text-slate-400">
              移入回收站，保留 3 天，期间可以恢复
            </span>
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={onPermanent}
            className="w-full rounded-lg border border-[#e5c9c9] bg-[#fdf6f6] px-3 py-2.5 text-left transition-colors hover:bg-[#fbecec] disabled:opacity-50"
          >
            <span className="block text-sm text-red-500">彻底删除</span>
            <span className="mt-0.5 block text-[11px] text-red-400">
              直接从数据库删除，无法恢复
            </span>
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="w-full rounded-lg border border-[#d5d9d7] px-3 py-2.5 text-sm text-slate-600 transition-colors hover:bg-[#f2f5f4] disabled:opacity-50"
          >
            取消
          </button>
        </div>

        {busy ? <p className="mt-3 text-center text-[11px] text-slate-400">处理中…</p> : null}
      </div>
    </div>
  );
}
