"use client";

import { useEffect, useState } from "react";

/**
 * 格式化简短日期
 */
function getLocalDateStr(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 晨间“暖言小记”唤醒仪式感提示浮标
 * 当检测到昨晚/近24小时内后台 AI 替用户总结并生成了暖言小记时，温和浮现提醒
 */
export default function MorningDiaryPrompt({
  diaries,
  activeTab,
  onOpenMorningDiary,
}) {
  const [diaryToPrompt, setDiaryToPrompt] = useState(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // 若当前正在日记页面，则不打扰提示
    if (activeTab === "diary") {
      setVisible(false);
      return;
    }

    if (!Array.isArray(diaries) || diaries.length === 0) return;

    // 找到所有由 AI 生成的暖言日记
    const aiDiaries = diaries.filter(
      (d) => d.source === "ai" || d.author === "ai"
    );
    if (aiDiaries.length === 0) return;

    // 取最新的一篇
    const latest = aiDiaries[0];
    if (!latest?.id) return;

    // 计算今天与昨天
    const now = new Date();
    const todayStr = getLocalDateStr(now);
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayStr = getLocalDateStr(yesterday);

    // 检查这篇日记是否属于昨晚或今天生成的最新小记
    const diaryDate = latest.diary_date || getLocalDateStr(latest.created_at);
    const isRecent = diaryDate === todayStr || diaryDate === yesterdayStr;

    // 如果创建时间在 36 小时以内也视为新鲜小记
    const createdTime = latest.created_at ? new Date(latest.created_at).getTime() : 0;
    const isWithin36h = Date.now() - createdTime < 36 * 60 * 60 * 1000;

    if (!isRecent && !isWithin36h) return;

    // 检查今日是否已经提示过该日记
    const storageKey = `solace_morning_diary_prompt_${latest.id}`;
    try {
      if (localStorage.getItem(storageKey)) {
        return; // 今天已提示或已读过
      }
    } catch {}

    // 延时 1.5 秒后温和浮现，给用户一个刚进站的平稳呼吸感
    const timer = setTimeout(() => {
      setDiaryToPrompt(latest);
      setVisible(true);

      // 同步向桌宠派发温柔耳语
      try {
        window.dispatchEvent(
          new CustomEvent("warm-say", {
            detail: { text: "昨晚为你写了一篇小记哦，今天也要好好的 ☕" },
          })
        );
      } catch {}
    }, 1500);

    return () => clearTimeout(timer);
  }, [diaries, activeTab]);

  if (!visible || !diaryToPrompt) return null;

  // 点击查看小记
  const handleView = () => {
    try {
      localStorage.setItem(`solace_morning_diary_prompt_${diaryToPrompt.id}`, "1");
    } catch {}
    setVisible(false);
    if (typeof onOpenMorningDiary === "function") {
      onOpenMorningDiary(diaryToPrompt);
    }
  };

  // 点击稍后再看
  const handleDismiss = () => {
    try {
      localStorage.setItem(`solace_morning_diary_prompt_${diaryToPrompt.id}`, "1");
    } catch {}
    setVisible(false);
  };

  return (
    <aside
      aria-label="晨间暖言小记提醒"
      className="fixed top-16 right-4 sm:right-6 z-[80] max-w-sm w-[calc(100vw-32px)] animate-slide-down pointer-events-auto"
    >
      <div className="relative rounded-2xl p-4 bg-white/95 dark:bg-[#231F1C]/95 backdrop-blur-md border border-[#ebd8ce] dark:border-[#42352E] shadow-xl shadow-[#b85a3c]/10 flex items-start gap-3.5 transition-all">
        {/* 左侧温光图标 */}
        <div className="w-10 h-10 shrink-0 rounded-xl bg-gradient-to-br from-[#FFF3EC] to-[#FCE5D8] dark:from-[#3D2920] dark:to-[#2B1D16] border border-[#f5dfd4] dark:border-[#523A2E] flex items-center justify-center text-lg shadow-xs">
          <span className="animate-pulse">🌅</span>
        </div>

        {/* 中间文字内容 */}
        <div className="flex-1 min-w-0 pr-4">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-bold text-[#b85a3c] dark:text-[#EAA896]">
              晨间仪式
            </span>
            <span className="text-[10px] text-slate-400 dark:text-[#8C7970]">
              · 暖言小记
            </span>
          </div>

          <p className="text-sm font-medium text-slate-800 dark:text-[#F5DCD3] mt-0.5 leading-snug">
            昨晚为你写了一篇小记，去看看吗？
          </p>

          <p className="text-xs text-slate-500 dark:text-[#A89890] truncate mt-1">
            {diaryToPrompt.title || "记录昨日那些微小心绪与碎碎念"}
          </p>

          {/* 按钮操作区 */}
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={handleView}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-gradient-to-r from-[#d97c62] to-[#b85a3c] hover:opacity-95 shadow-xs shadow-[#b85a3c]/20 transition-all flex items-center gap-1"
            >
              <span>📖 翻开小记</span>
            </button>
            <button
              onClick={handleDismiss}
              className="px-2.5 py-1.5 rounded-lg text-xs font-normal text-slate-400 hover:text-slate-600 dark:text-[#8C7970] dark:hover:text-[#D1C0B6] transition-colors"
            >
              稍后再看
            </button>
          </div>
        </div>

        {/* 右上角极简关闭叉号 */}
        <button
          onClick={handleDismiss}
          className="absolute top-2.5 right-2.5 w-6 h-6 rounded-full flex items-center justify-center text-slate-300 hover:text-slate-500 dark:text-[#66544B] dark:hover:text-[#A89890] transition-colors"
          title="关闭"
        >
          ✕
        </button>
      </div>
    </aside>
  );
}

