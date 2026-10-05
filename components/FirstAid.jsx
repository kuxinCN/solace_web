"use client";

import { useState, useEffect, useRef } from "react";

// 急救箱条目：呼吸放松 / 蝴蝶拍 触发动画弹窗，安全提示展开文字
// ⚠️ 每个工具都带一句"看得懂"的说明 —— 光有名字用户不知道蝴蝶拍是干嘛的
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

  // 状态机推进：吸气4秒、屏住2秒、呼气6秒
  useEffect(() => {
    if (!running || phase === "done") return;
    const duration = phase === "hold" ? 2000 : phase === "exhale" ? 6000 : 4000;
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

  // 圆圈缩放：吸气/屏住放大到 1.5，呼气/静止/完成回到 1。
  // transform 只挂在 .breath-circle 这一层，A 涟漪和 B 边缘波动都不能共用它。
  const scale = phase === "inhale" || phase === "hold" ? 1.5 : 1;
  const transition =
    phase === "inhale"
      ? "transform 4s ease-in-out"
      : phase === "exhale"
      ? "transform 6s ease-in-out"
      : "transform 0.3s ease";

  // A/B 两组水波纹只在"运行中（未完成）"挂载动画；暂停 / 结束 / 未开始时整体静止
  const effectsActive = running && phase !== "done";

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
        {/* 呼吸引导：A 外围涟漪（兄弟层，只做 scale/opacity）+
            B 边缘波动（呼吸圈子层，只做 border-radius）+
            呼吸圈本体缩放（transform 只在 .breath-circle）。三层 DOM 解耦。 */}
        <div className="relative w-56 h-56 flex items-center justify-center mb-2">
          <div
            className={`breath-wrap${effectsActive ? " is-active" : ""}`}
            style={{ "--breath-cycle": "12s" }}
          >
            <div className="ripple ripple-1" />
            <div className="ripple ripple-2" />
            <div className="ripple ripple-3" />
            <div
              className="breath-circle rounded-full bg-[#a9c6da] shadow-lg"
              style={{
                transform: `scale(${scale})`,
                transition,
              }}
            >
              <div className="breath-wave" />
            </div>
          </div>
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

// 蝴蝶拍动画：原来的两只手掌已删除，节拍由全局桌宠蝴蝶承担
// 按钮逻辑与呼吸放松完全一致
function ButterflyAnimation({ onClose, onStateChange }) {
  const [running, setRunning] = useState(false);
  // idle | leftUp | leftDown | rightUp | rightDown
  const [phase, setPhase] = useState("idle");
  const timerRef = useRef(null);

  // 向父组件上报状态
  const report = (r, p) => {
    onStateChange?.({ open: true, running: r, phase: p });
  };

  useEffect(() => {
    report(false, "idle"); // 打开时 idle
    return () => onStateChange?.({ open: false, running: false, phase: "idle" });
  }, []); // eslint-disable-line

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

  // phase 变化时上报
  useEffect(() => {
    report(running, phase);
  }, [running, phase]); // eslint-disable-line

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
        data-butterfly-pat-card
        className="bg-white rounded-2xl shadow-xl border border-[#e8eae7] p-8 w-96 flex flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 使用方法说明（删掉手掌后空出的位置）—— 开始后瞬间清空，无过渡 */}
        {!running && (
          <div className="w-full min-h-[100px] flex items-center justify-center mb-2">
            <p className="text-sm leading-6 text-slate-600 text-center px-2">
              双手交叉抱在胸前，左手放在右肩，右手放在左肩。<br />
              左右交替轻轻拍打，像蝴蝶扇动翅膀一样。<br />
              一边拍一边深呼吸，慢慢来。
            </p>
          </div>
        )}
        {running && <div className="w-full min-h-[100px] mb-2" />}

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

export default function FirstAid({ initialMethod = "", allowedIds = null, onButterflyPatChange }) {
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
      {/* 三个疗愈工具：图标 + 名称 + 一句话说明（手机竖排，桌面横排） */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {KIT_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => handleClick(item.id)}
            className={`${btnBase} p-3 text-left`}
          >
            <span className="block text-xl leading-none">{item.icon}</span>
            <span className="mt-1 block text-sm font-semibold text-slate-700">
              {item.label}
            </span>
            <span className="mt-1 block text-[11px] leading-4 text-slate-400">
              {item.hint}
            </span>
          </button>
        ))}
      </div>

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
          onStateChange={onButterflyPatChange}
          onClose={() => {
            setButterfly(false);
          }}
        />
      )}
    </div>
  );
}
