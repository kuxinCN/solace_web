"use client";

// 「关于 Solace」弹窗：我的页入口唤出，仅展示文案
export default function AboutModal({ open, onClose }) {
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
        <h3 className="text-base font-bold text-slate-800 mb-3">关于 Solace</h3>
        <div className="text-sm text-slate-600 leading-7 whitespace-pre-line mb-4">
          {`Solace 是一个为你而生的情绪陪伴空间。
我们不试图治疗你，也不假装懂你。
我们只做一件事——
在你不想说话的时候，安静地陪着你。

它不是心理咨询，不能替代专业帮助。
但如果你愿意，可以把它当作深夜里的一盏灯。`}
        </div>
        <button
          onClick={onClose}
          className="w-full border border-[#7fa8c4] bg-[#7fa8c4] text-white rounded-lg py-2 text-sm hover:bg-[#6d99b5] active:scale-[0.98] transition-all duration-150"
        >
          知道了
        </button>
      </div>
    </div>
  );
}
