"use client";

import { useState, useEffect } from "react";
import { BreathScene, ButterflyScene } from "@/components/HealingScene";
import CallConfirmModal from "@/components/CallConfirmModal";

// 急救箱条目：呼吸放松 / 蝴蝶拍 触发动画弹窗，安全提示展开文字
const KIT_ITEMS = [
  {
    id: "breath",
    label: "呼吸放松",
    icon: "🌬",
    hint: "跟着圆环吸气、停一停、慢慢呼气，让心跳慢下来",
  },
  {
    id: "butterfly",
    label: "蝴蝶拍",
    icon: "🦋",
    hint: "双手交替轻拍肩膀，像蝴蝶扇动翅膀，安抚紧绷的身体",
  },
  {
    id: "safety",
    label: "安全提示",
    icon: "🛟",
    hint: "情绪太满时，一句写给自己的安全提醒",
    text: "如果你有伤害自己的念头，请立刻告诉身边你信任的人，或拨打全国心理援助热线 12356（也可拨 400-161-9995），或 110 / 120 求助。你不需要一个人扛着，也不是你的错。",
  },
];

const btnBase =
  "border border-[#ebe3dc] dark:border-[#3A3029] bg-white/90 dark:bg-[#251F1C] text-slate-700 dark:text-[#F5DCD3] rounded-2xl hover:bg-[#FAF7F4] dark:hover:bg-[#302722] hover:text-slate-900 dark:hover:text-[#FFF5F0] hover:scale-[1.01] active:scale-[0.99] shadow-xs transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed";

export default function FirstAid({ initialMethod = "", onButterflyPatChange, onWantToTalk }) {
  const [activeId, setActiveId] = useState("");
  const [breathing, setBreathing] = useState(false);
  const [butterfly, setButterfly] = useState(false);
  const [callTarget, setCallTarget] = useState(null);

  useEffect(() => {
    if (initialMethod === "breathing") setBreathing(true);
    if (initialMethod === "butterfly") setButterfly(true);
  }, [initialMethod]);

  const handleClick = (id) => {
    if (id === "breath") {
      setBreathing(true);
      return;
    }
    if (id === "butterfly") {
      setButterfly(true);
      return;
    }
    setActiveId(activeId === id ? "" : id);
  };

  return (
    <div className="space-y-3">
      {/* 三个疗愈工具：图标 + 名称 + 一句话说明（手机竖排，桌面横排） */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        {KIT_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => handleClick(item.id)}
            className={`${btnBase} p-4 text-left cursor-pointer`}
          >
            <span className="block text-2xl leading-none">{item.icon}</span>
            <span className="mt-2 block text-sm font-bold text-slate-800 dark:text-[#F5DCD3]">
              {item.label}
            </span>
            <span className="mt-1 block text-xs leading-relaxed text-slate-400 dark:text-[#9E8E85]">
              {item.hint}
            </span>
          </button>
        ))}
      </div>

      {/* 安全提示 文字 */}
      {activeId === "safety" && (
        <div className="rounded-2xl bg-[#FFF5EF] dark:bg-[#29211D] border border-[#f5ded3] dark:border-[#46372E] p-4 shadow-sm text-slate-700 dark:text-[#E8D1C7] transition-all">
          <p className="text-sm leading-6">
            如果你有伤害自己的念头，请立刻告诉身边你信任的人，或拨打全国免费心理援助热线，或 110 / 120 求助。你不需要一个人扛着，也不是你的错。
          </p>
          <div className="mt-3 pt-3 border-t border-[#f0ded4] dark:border-[#3E322A] flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={() => setCallTarget({ number: "12356", title: "全国心理援助热线 12356" })}
              className="px-3.5 py-1.5 rounded-xl bg-white dark:bg-[#201B18] border border-[#f0ded4] dark:border-[#4B392F] text-xs font-semibold text-[#b85a3c] dark:text-[#EFA896] hover:bg-[#fff9f6] dark:hover:bg-[#342720] shadow-2xs flex items-center gap-1.5 cursor-pointer"
            >
              <span>📞</span>
              <span>呼叫 12356（免费热线）</span>
            </button>
            <button
              type="button"
              onClick={() => setCallTarget({ number: "400-161-9995", title: "全国心理危机干预热线" })}
              className="px-3.5 py-1.5 rounded-xl bg-white dark:bg-[#201B18] border border-[#f0ded4] dark:border-[#4B392F] text-xs font-semibold text-[#b85a3c] dark:text-[#EFA896] hover:bg-[#fff9f6] dark:hover:bg-[#342720] shadow-2xs flex items-center gap-1.5 cursor-pointer"
            >
              <span>📞</span>
              <span>呼叫 400-161-9995</span>
            </button>
          </div>
        </div>
      )}

      {/* 呼吸放松：全屏沉浸式场景 */}
      {breathing && (
        <BreathScene
          onWantToTalk={onWantToTalk}
          onClose={() => {
            setBreathing(false);
          }}
        />
      )}

      {/* 蝴蝶拍：全屏沉浸式场景 */}
      {butterfly && (
        <ButterflyScene
          onWantToTalk={onWantToTalk}
          onStateChange={onButterflyPatChange}
          onClose={() => {
            setButterfly(false);
          }}
        />
      )}

      {/* 危机干预热线二次确认弹窗 */}
      <CallConfirmModal
        open={!!callTarget}
        number={callTarget?.number}
        title={callTarget?.title}
        onClose={() => setCallTarget(null)}
      />
    </div>
  );
}
