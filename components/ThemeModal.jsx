"use client";

import { useEffect, useState } from "react";
import {
  THEME_MODES,
  DEFAULT_SCHEDULE,
  getStoredTheme,
  applyTheme,
  resolveIsEspresso,
} from "@/lib/theme";

export default function ThemeModal({ open, onClose }) {
  const [mode, setMode] = useState("day");
  const [schedule, setSchedule] = useState(DEFAULT_SCHEDULE);
  const [isEspressoActive, setIsEspressoActive] = useState(false);

  // 打开时同步当前持久化状态
  useEffect(() => {
    if (!open) return;
    const { mode: m, schedule: s } = getStoredTheme();
    setMode(m);
    setSchedule(s);
    setIsEspressoActive(resolveIsEspresso(m, s));
  }, [open]);

  // 监听模式变更并立即应用
  function handleSelectMode(newMode) {
    setMode(newMode);
    const active = applyTheme(newMode, schedule);
    setIsEspressoActive(active);
  }

  function handleScheduleChange(field, val) {
    const updated = { ...schedule, [field]: val };
    setSchedule(updated);
    if (mode === "schedule") {
      const active = applyTheme("schedule", updated);
      setIsEspressoActive(active);
    } else {
      try {
        localStorage.setItem("solace_theme_schedule", JSON.stringify(updated));
      } catch {}
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[10001] flex items-center justify-center p-4 bg-black/45 backdrop-blur-sm transition-all"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-3xl bg-[#FFFDFB] dark:bg-[#231F1C] border border-[#efe3d8] dark:border-[#3D352E] shadow-2xl overflow-hidden p-6 text-slate-800 dark:text-[#F5DCD3] transition-colors"
        onClick={(e) => e.stopPropagation()}
        style={{
          boxShadow: "0 24px 60px -15px rgba(28, 25, 23, 0.4), 0 2px 10px rgba(0, 0, 0, 0.08)",
        }}
      >
        {/* 顶部标题栏 */}
        <div className="flex items-center justify-between pb-4 border-b border-[#f0e3db] dark:border-[#38312B]">
          <div className="flex items-center gap-2.5">
            <span className="text-2xl leading-none">☕</span>
            <div>
              <h3 className="text-base font-bold text-slate-800 dark:text-[#F5DCD3] tracking-tight">
                氛围光效调节
              </h3>
              <p className="text-xs text-slate-400 dark:text-[#A89890] mt-0.5">
                温和暗光模式 · 专为熄灯后倾诉打造
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-[#F5DCD3] hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer text-base"
          >
            ✕
          </button>
        </div>

        {/* 当前生效状态提示条 */}
        <div className="my-4 flex items-center justify-between px-3.5 py-2.5 rounded-2xl bg-[#FFF5EF] dark:bg-[#2F2621] border border-[#f5dfd4] dark:border-[#4A3B33] text-xs">
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                isEspressoActive
                  ? "bg-[#D97C62] animate-pulse shadow-sm shadow-[#D97C62]"
                  : "bg-emerald-500"
              }`}
            />
            <span className="text-slate-600 dark:text-[#E8D1C7]">
              当前生效：
              <strong className="text-[#b85a3c] dark:text-[#EFA896] ml-1 font-semibold">
                {isEspressoActive ? "深宵暖咖（温和暗光）" : "晨光浅杏（明亮日间）"}
              </strong>
            </span>
          </div>
          <span className="text-[10px] text-slate-400 dark:text-[#9E8E85]">实时沉浸切换</span>
        </div>

        {/* 四大模式选项卡片 */}
        <div className="space-y-2.5">
          {THEME_MODES.map((item) => {
            const isSelected = mode === item.id;
            return (
              <div
                key={item.id}
                onClick={() => handleSelectMode(item.id)}
                className={`p-3.5 rounded-2xl border transition-all duration-150 cursor-pointer ${
                  isSelected
                    ? "bg-[#FFF9F6] dark:bg-[#2C241F] border-[#b85a3c] dark:border-[#D97C62] shadow-xs ring-1 ring-[#b85a3c]/30"
                    : "bg-white dark:bg-[#201C19] border-[#ede3dc] dark:border-[#38312B] hover:border-[#dfd3cb] dark:hover:border-[#4A4038]"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <span className="text-xl leading-none mt-0.5">{item.icon}</span>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-slate-800 dark:text-[#F5DCD3]">
                          {item.title}
                        </span>
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                            isSelected
                              ? "bg-[#FFF5EF] dark:bg-[#3D2E27] text-[#b85a3c] dark:text-[#EFA896] border border-[#f5dfd4] dark:border-[#574238]"
                              : "bg-black/[0.04] dark:bg-white/[0.06] text-slate-400 dark:text-[#8D7F78]"
                          }`}
                        >
                          {item.badge}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 dark:text-[#9E8E85] mt-1 leading-relaxed">
                        {item.subtitle}
                      </p>
                    </div>
                  </div>

                  {/* 单选标记 */}
                  <span
                    className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 mt-1 transition-all ${
                      isSelected
                        ? "border-[#b85a3c] bg-[#b85a3c] dark:border-[#D97C62] dark:bg-[#D97C62]"
                        : "border-[#d8ccc4] dark:border-[#52463E] bg-white dark:bg-[#26221F]"
                    }`}
                  >
                    {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                  </span>
                </div>

                {/* 定时刻度专属展开的时间调节面板 */}
                {item.id === "schedule" && isSelected && (
                  <div
                    className="mt-3 pt-3 border-t border-[#f0ded4] dark:border-[#3E332B] flex items-center justify-between gap-3 text-xs"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="text-slate-500 dark:text-[#A89890]">自动生效时段：</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="time"
                        value={schedule.start}
                        onChange={(e) => handleScheduleChange("start", e.target.value)}
                        className="px-2.5 py-1 rounded-xl border border-[#ebe0d8] dark:border-[#4A3F37] bg-white dark:bg-[#241F1C] text-slate-700 dark:text-[#F5DCD3] text-xs outline-none focus:border-[#b85a3c]"
                      />
                      <span className="text-slate-400">至</span>
                      <input
                        type="time"
                        value={schedule.end}
                        onChange={(e) => handleScheduleChange("end", e.target.value)}
                        className="px-2.5 py-1 rounded-xl border border-[#ebe0d8] dark:border-[#4A3F37] bg-white dark:bg-[#241F1C] text-slate-700 dark:text-[#F5DCD3] text-xs outline-none focus:border-[#b85a3c]"
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 底部关闭确认 */}
        <div className="mt-5 pt-3 border-t border-[#f0e3db] dark:border-[#38312B] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="w-full py-2.5 rounded-2xl bg-gradient-to-r from-[#c06b50] to-[#b85a3c] text-white text-xs font-semibold shadow-sm shadow-[#b85a3c]/20 hover:from-[#b05f45] hover:to-[#a84f33] active:scale-[0.98] transition-all cursor-pointer text-center"
          >
            完成并保留当前光效
          </button>
        </div>
      </div>
    </div>
  );
}

