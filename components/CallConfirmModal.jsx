"use client";

import { useState, useEffect } from "react";

/**
 * 危机干预热线温和二次确认弹窗：
 * 防止误触拨号，同时以极其温和安心的措辞陪伴用户，
 * 确认后通过 <a href="tel:..."> 或 window.location.href 直接呼出。
 */
export default function CallConfirmModal({ open, number, title, onClose }) {
  if (!open || !number) return null;

  const cleanNumber = number.replace(/[^0-9]/g, "");

  return (
    <div
      className="fixed inset-0 z-[10005] flex items-center justify-center p-4 bg-black/55 backdrop-blur-sm transition-all"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-3xl bg-[#FFFDFB] dark:bg-[#251F1C] border border-[#efe3d8] dark:border-[#42372F] shadow-2xl overflow-hidden p-6 text-slate-800 dark:text-[#F5DCD3] transition-colors"
        onClick={(e) => e.stopPropagation()}
        style={{
          boxShadow: "0 20px 60px -10px rgba(28, 25, 23, 0.45)",
        }}
      >
        <div className="flex items-center gap-3 pb-3 border-b border-[#f0e3db] dark:border-[#382F28]">
          <span className="w-10 h-10 rounded-2xl bg-[#FFF5EF] dark:bg-[#3A2A22] border border-[#f5dfd4] dark:border-[#533D32] flex items-center justify-center text-xl shrink-0">
            🛟
          </span>
          <div>
            <h3 className="text-base font-bold text-slate-800 dark:text-[#F5DCD3] tracking-tight">
              {title || "心理援助与危机干预热线"}
            </h3>
            <p className="text-xs text-slate-400 dark:text-[#A89890] mt-0.5">
              全国免费 · 24小时专业心理守护
            </p>
          </div>
        </div>

        <div className="my-5 space-y-3">
          <p className="text-xs text-slate-600 dark:text-[#D1BEB5] leading-relaxed">
            无论此刻情绪有多满、心里有多重，<strong>你都不需要一个人硬扛</strong>。电话那头是专业温和的心理倾听老师，全程免费且严格保密。
          </p>

          <div className="p-3.5 rounded-2xl bg-[#FFF7F2] dark:bg-[#2F2520] border border-[#f5ded3] dark:border-[#4B392F] flex items-center justify-between">
            <div>
              <span className="text-[11px] text-slate-400 dark:text-[#9F8F87] block">
                即将拨通
              </span>
              <span className="text-lg font-bold text-[#b85a3c] dark:text-[#EFA896] tracking-wide">
                {number}
              </span>
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#b85a3c]/10 dark:bg-[#EFA896]/15 text-[#b85a3c] dark:text-[#EFA896] font-medium">
              免费公益
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2.5 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-[#ebe0d8] dark:border-[#443830] bg-white dark:bg-[#201B18] text-xs font-medium text-slate-600 dark:text-[#C4B4AB] hover:bg-[#faf4ef] dark:hover:bg-[#2B231E] transition-colors cursor-pointer text-center"
          >
            我再想想
          </button>
          <a
            href={`tel:${cleanNumber}`}
            onClick={() => {
              setTimeout(onClose, 500);
            }}
            className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-[#c06b50] to-[#b85a3c] text-white text-xs font-semibold shadow-sm shadow-[#b85a3c]/25 hover:from-[#b05f45] hover:to-[#a84f33] active:scale-[0.98] transition-all cursor-pointer text-center flex items-center justify-center gap-1.5"
          >
            <span>📞</span>
            <span>立刻拨打</span>
          </a>
        </div>
      </div>
    </div>
  );
}

