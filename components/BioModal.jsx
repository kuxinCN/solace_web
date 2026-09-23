"use client";

// 个性签名编辑弹窗：日记页顶部卡片点击唤出
// 保存逻辑由父组件传入（与「我的」页共用 handleSaveBio），本组件只负责展示
export default function BioModal({
  open,
  value,
  onChange,
  saving,
  msg,
  onSave,
  onClose,
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-[#fdfdfc] rounded-2xl shadow-xl border border-[#e8eae7] p-5 w-96 max-w-[90vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-bold text-slate-800 mb-3">
          修改个性签名
        </h3>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // 输入法选词中的回车不触发保存
            if (e.key === "Enter" && !e.nativeEvent.isComposing) onSave();
          }}
          placeholder="写一句想说的话吧"
          maxLength={50}
          autoFocus
          className="w-full border border-[#d5d9d7] bg-white p-2 text-sm text-gray-800 placeholder-gray-400 rounded-lg transition-colors duration-150 focus:outline-none focus:border-[#8fb3c7] focus:ring-1 focus:ring-[#8fb3c7]"
        />
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            disabled={saving}
            className="border border-[#d5d9d7] bg-[#f1f3f2] text-slate-500 rounded-lg px-4 py-1.5 text-sm hover:bg-[#e8eff2] transition-all duration-150 disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="border border-[#7fa8c4] bg-[#7fa8c4] text-white rounded-lg px-4 py-1.5 text-sm hover:bg-[#6d99b5] active:scale-[0.98] transition-all duration-150 disabled:opacity-50"
          >
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
        {msg && (
          <p
            className={`text-xs mt-2 ${
              msg.startsWith("保存失败") ? "text-red-400" : "text-emerald-500"
            }`}
          >
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}
