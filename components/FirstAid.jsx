"use client";

import { useState, useEffect, useRef } from "react";

// 急救箱条目：呼吸放松 / 蝴蝶拍 触发动画弹窗，安全提示展开文字
const KIT_ITEMS = [
  { id: "breath", label: "呼吸放松" },
  { id: "butterfly", label: "蝴蝶拍" },
  {
    id: "safety",
    label: "安全提示",
    text: "如果你有伤害自己的念头，请立刻告诉身边你信任的人，或拨打全国心理援助热线 400-161-9995，或 110 / 120 求助。你不需要一个人扛着，也不是你的错。",
  },
];

const btnBase =
  "border border-[#d5d9d7] bg-[#fdfdfc] text-slate-700 rounded-xl hover:bg-[#eef4f6] hover:text-slate-900 hover:scale-[1.02] active:bg-[#dbe6ea] active:scale-[0.98] shadow-sm transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed";

// 呼吸圆圈动画：useState/useEffect 状态机 + setTimeout 驱动
// 吸气4秒放大 → 屏住2秒 → 呼气4秒缩回，循环3次；「开始」「关闭」两个按钮常驻
function BreathingAnimation({ onClose }) {
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState("idle"); // idle | inhale | hold | exhale | done
  const [round, setRound] = useState(1);
  const timerRef = useRef(null);

  // 卸载时清理计时器
  useEffect(() => () => clearTimeout(timerRef.current), []);

  // 状态机推进：吸气4秒、屏住2秒、呼气4秒
  useEffect(() => {
    if (!running || phase === "done") return;
    const duration = phase === "hold" ? 2000 : 4000;
    timerRef.current = setTimeout(() => {
      if (phase === "inhale") {
        setPhase("hold");
      } else if (phase === "hold") {
        setPhase("exhale");
      } else if (phase === "exhale") {
        if (round >= 3) {
          setPhase("done");
        } else {
          setRound((r) => r + 1);
          setPhase("inhale");
        }
      }
    }, duration);
    return () => clearTimeout(timerRef.current);
  }, [running, phase, round]);

  // 点击「关闭」按钮：
  // - 动画运行中 → 停止动画，圆圈恢复静止，文字重置，但不关闭弹窗，可重新开始
  // - 未开始(idle) 或 已完成(done) → 直接关闭弹窗
  const handleClose = () => {
    if (running && phase !== "done") {
      clearTimeout(timerRef.current);
      setRunning(false);
      setPhase("idle");
      setRound(1);
      return;
    }
    clearTimeout(timerRef.current);
    onClose();
  };

  // 点击弹窗外部空白区域：始终直接关闭弹窗
  const handleBackdrop = () => {
    clearTimeout(timerRef.current);
    onClose();
  };

  // 开始（或完成后重新开始）
  const start = () => {
    clearTimeout(timerRef.current);
    setRound(1);
    setPhase("inhale");
    setRunning(true);
  };

  // 圆圈缩放：吸气/屏住放大到 1.5，呼气/静止/完成回到 1
  const scale = phase === "inhale" || phase === "hold" ? 1.5 : 1;
  const transition =
    phase === "inhale" || phase === "exhale"
      ? "transform 4s ease-in-out"
      : "transform 0.3s ease";

  const phaseText = {
    idle: "准备好了吗？",
    inhale: "吸气…",
    hold: "屏住…",
    exhale: "呼气…",
    done: "完成，感觉好点了吗？",
  }[phase];

  return (
    <div
      className="modal-fade fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={handleBackdrop}
    >
      <div
        className="bg-white rounded-2xl shadow-xl border border-[#e8eae7] p-8 w-96 flex flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 圆圈（初始静止，浅蓝色） */}
        <div className="relative w-56 h-56 flex items-center justify-center mb-2">
          <div
            className="w-28 h-28 rounded-full bg-[#a9c6da] shadow-lg"
            style={{
              transform: `scale(${scale})`,
              transition,
            }}
          />
        </div>

        {/* 文字提示 */}
        <p className="text-base font-medium text-slate-700">{phaseText}</p>

        {running && phase !== "done" && (
          <p className="text-xs text-slate-400 mt-1">
            第 {round} / 3 轮
          </p>
        )}

        {/* 按钮区：开始 + 关闭 一直可见 */}
        <div className="flex gap-2 mt-5">
          <button
            onClick={start}
            disabled={running && phase !== "done"}
            className={`${btnBase} px-6 py-2`}
          >
            开始
          </button>
          <button onClick={handleClose} className={`${btnBase} px-6 py-2`}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

// 蝴蝶拍动画：两只手掌交替轻拍，左拍1秒、右拍1秒，循环进行直到关闭
// 按钮逻辑与呼吸放松完全一致
function ButterflyAnimation({ onClose }) {
  const [running, setRunning] = useState(false);
  // idle | leftUp | leftDown | rightUp | rightDown
  const [phase, setPhase] = useState("idle");
  const timerRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // 状态机：每个子阶段 500ms，左拍(上+下)=1秒，右拍(上+下)=1秒
  useEffect(() => {
    if (!running || phase === "idle") return;
    timerRef.current = setTimeout(() => {
      if (phase === "leftUp") setPhase("leftDown");
      else if (phase === "leftDown") setPhase("rightUp");
      else if (phase === "rightUp") setPhase("rightDown");
      else if (phase === "rightDown") setPhase("leftUp");
    }, 500);
    return () => clearTimeout(timerRef.current);
  }, [running, phase]);

  // 关闭按钮：运行中 → 停止动画、重置、不关闭弹窗；idle → 关闭弹窗
  const handleClose = () => {
    if (running) {
      clearTimeout(timerRef.current);
      setRunning(false);
      setPhase("idle");
      return;
    }
    clearTimeout(timerRef.current);
    onClose();
  };

  // 弹窗外部点击：始终直接关闭
  const handleBackdrop = () => {
    clearTimeout(timerRef.current);
    onClose();
  };

  const start = () => {
    clearTimeout(timerRef.current);
    setPhase("leftUp");
    setRunning(true);
  };

  // 左掌在 leftUp 时放大+上移，否则静止
  const leftActive = phase === "leftUp";
  const leftScale = leftActive ? 1.15 : 1;
  const leftTranslate = leftActive ? -6 : 0;

  // 右掌在 rightUp 时放大+上移，否则静止
  const rightActive = phase === "rightUp";
  const rightScale = rightActive ? 1.15 : 1;
  const rightTranslate = rightActive ? -6 : 0;

  const phaseText =
    phase === "leftUp" || phase === "leftDown"
      ? "左拍…"
      : phase === "rightUp" || phase === "rightDown"
      ? "右拍…"
      : "准备好了吗？";

  return (
    <div
      className="modal-fade fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={handleBackdrop}
    >
      <div
        className="bg-white rounded-2xl shadow-xl border border-[#e8eae7] p-8 w-96 flex flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 两只手掌：左掌 + 右掌（镜像） */}
        <div className="flex items-center justify-center gap-10 w-full h-40 mb-2">
          <div
            className="text-6xl select-none"
            style={{
              transform: `translateY(${leftTranslate}px) scale(${leftScale})`,
              transition: "transform 0.5s ease-in-out",
              opacity: leftActive ? 1 : 0.7,
            }}
          >
            🖐
          </div>
          <div
            className="text-6xl select-none"
            style={{
              transform: `translateY(${rightTranslate}px) scale(${rightScale}) scaleX(-1)`,
              transition: "transform 0.5s ease-in-out",
              opacity: rightActive ? 1 : 0.7,
            }}
          >
            🖐
          </div>
        </div>

        {/* 文字提示 */}
        <p className="text-base font-medium text-slate-700">{phaseText}</p>
        <p className="text-xs text-slate-400 mt-1">
          节奏放慢，对自己说「我现在是安全的」
        </p>

        {/* 按钮区：开始 + 关闭 一直可见 */}
        <div className="flex gap-2 mt-5">
          <button
            onClick={start}
            disabled={running}
            className={`${btnBase} px-6 py-2`}
          >
            开始
          </button>
          <button onClick={handleClose} className={`${btnBase} px-6 py-2`}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

export default function FirstAid({ initialMethod = "", allowedIds = null }) {
  const [activeId, setActiveId] = useState("");
  const [breathing, setBreathing] = useState(false);
  const [butterfly, setButterfly] = useState(false);

  // ⚠️ 这两个 prop 是给**压力弹窗**用的：它要"直接进某个方式"，
  //    而且只开放后台勾选的那几种。
  //    不传时行为**和以前完全一样** —— 「治愈小屋」里三种方式常驻，用户自己点。
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
    <div className="space-y-2">
      {KIT_ITEMS.map((item) => (
        <button
          key={item.id}
          onClick={() => handleClick(item.id)}
          className={`${btnBase} p-2.5 w-full text-left`}
        >
          {item.label}
        </button>
      ))}

      {/* 安全提示 文字 */}
      {activeId && (
        <div className="rounded-xl bg-[#eef4f6] border border-[#e8eae7] p-3 shadow-sm mt-2">
          <p className="text-sm text-slate-700 leading-6 whitespace-pre-wrap">
            {KIT_ITEMS.find((i) => i.id === activeId)?.text}
          </p>
        </div>
      )}

      {/* 呼吸圆圈动画 */}
      {breathing && (
        <BreathingAnimation
          onClose={() => {
            setBreathing(false);
          }}
        />
      )}

      {/* 蝴蝶拍动画 */}
      {butterfly && (
        <ButterflyAnimation
          onClose={() => {
            setButterfly(false);
          }}
        />
      )}
    </div>
  );
}
