"use client";

// 「关于 Solace」弹窗：我的页入口唤出，仅展示文案
export default function AboutModal({ open, onClose }) {
  if (!open) return null;

  return (
    <div
      className="modal-fade fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-[#fdfdfc] rounded-3xl shadow-xl border border-[#e8eae7] p-6 w-96 max-w-[90vw] text-center"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src="/logo.png"
          alt="Solace Logo"
          className="w-12 h-12 object-contain mx-auto mb-2.5 drop-shadow-xs"
        />
        <h3 className="text-base font-bold text-slate-800 mb-2">关于 Solace</h3>
        <div className="text-xs sm:text-sm text-slate-600 leading-6 text-left whitespace-pre-line mb-5 bg-[#fafaf8] p-3.5 rounded-2xl border border-[#edf0ee]">
          {`Solace 是一个为你而生的情绪陪伴空间。
我们不试图治疗你，也不假装懂你。
我们只做一件事——
在你不想说话的时候，安静地陪着你。

它不是心理咨询，不能替代专业帮助。
但如果你愿意，可以把它当作深夜里的一盏灯。`}
        </div>
        <button
          onClick={onClose}
          className="w-full bg-gradient-to-r from-[#628ea8] to-[#557e96] text-white rounded-xl py-2.5 text-xs font-medium hover:from-[#58839d] hover:to-[#4b738a] active:scale-[0.98] transition-all duration-150"
        >
          知道了
        </button>
      </div>
    </div>
  );
}
