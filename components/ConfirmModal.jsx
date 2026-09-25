"use client";

// 统一的自定义确认弹窗：替代 window.confirm
// props: open(是否显示)、message(提示文字)、confirmText(确认按钮文字，默认"确认删除")
//       cancelText(取消按钮文字，默认"取消")、onConfirm(确认回调)、onClose(取消/关闭回调)
export default function ConfirmModal({
  open,
  message,
  confirmText = "确认删除",
  cancelText = "取消",
  onConfirm,
  onClose,
}) {
  if (!open) return null;

  return (
    <div
      className="modal-fade fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl border border-[#e8eae7] p-5 w-80 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm text-slate-700 leading-6 mb-5 whitespace-pre-wrap">
          {message}
        </p>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="border border-[#d5d9d7] bg-[#fdfdfc] text-slate-500 rounded-lg px-4 py-2 text-sm hover:bg-[#eef1f2] hover:text-slate-700 hover:scale-[1.02] active:scale-[0.98] transition-all duration-150"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className="border border-[#e8b4a0] bg-[#f5b8a0] text-white rounded-lg px-4 py-2 text-sm hover:bg-[#f0a48a] hover:scale-[1.02] active:scale-[0.98] shadow-sm transition-all duration-150"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
