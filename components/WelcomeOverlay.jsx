"use client";

import { useState } from "react";

// 登录成功后的全屏欢迎过渡页：
// 米白/淡蓝渐变背景 + 漂浮气泡 + 逐行淡入文字，点击箭头按钮淡出后由父组件跳转 /chat
export default function WelcomeOverlay({ onFinish }) {
  const [leaving, setLeaving] = useState(false);

  // 漂浮气泡配置：淡蓝 / 米色 / 浅粉，大小与周期不一，延迟错开。
  // 色值比背景明显深一档，配合下面的透明度，保证在浅色渐变上依然看得见。
  const bubbles = [
    { size: 150, left: "5%", top: "10%", color: "#9cc3dd", dur: "9s", delay: "0s" },
    { size: 70, left: "16%", top: "62%", color: "#e3cdaa", dur: "7.5s", delay: "1.2s" },
    { size: 110, left: "12%", top: "34%", color: "#e7b9c2", dur: "11s", delay: "0.6s" },
    { size: 55, left: "28%", top: "82%", color: "#a9cde3", dur: "6.5s", delay: "2s" },
    { size: 90, left: "78%", top: "14%", color: "#ded0a8", dur: "8.5s", delay: "0.9s" },
    { size: 130, left: "86%", top: "52%", color: "#9cc3dd", dur: "10s", delay: "1.6s" },
    { size: 65, left: "70%", top: "76%", color: "#e7b9c2", dur: "7s", delay: "0.3s" },
    { size: 45, left: "55%", top: "8%", color: "#a9cde3", dur: "6s", delay: "1.8s" },
    { size: 80, left: "42%", top: "88%", color: "#d9bda3", dur: "9.5s", delay: "0.5s" },
    { size: 100, left: "90%", top: "30%", color: "#e4c2b3", dur: "12s", delay: "2.4s" },
  ];

  // 点击进入：整体淡出 0.5s 后跳转；期间忽略重复点击
  function handleEnter() {
    if (leaving) return;
    setLeaving(true);
    setTimeout(onFinish, 500);
  }

  return (
    <div
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center transition-opacity duration-500 ${
        leaving ? "opacity-0 pointer-events-none" : "opacity-100"
      }`}
      style={{
        background:
          "linear-gradient(160deg, #f7f4ed 0%, #eef4f8 55%, #e2edf4 100%)",
        // 中文优先的系统字体栈，避免落到 Arial
        fontFamily:
          '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif',
      }}
    >
      <style>{`
        @keyframes welcome-float {
          0%, 100% { transform: translate(0, 0); }
          25% { transform: translate(8px, -14px); }
          50% { transform: translate(-6px, -26px); }
          75% { transform: translate(10px, -12px); }
        }
        @keyframes welcome-breathe {
          0%, 100% { transform: scale(1) translateY(0); }
          50% { transform: scale(1.08) translateY(-4px); }
        }
        @keyframes welcome-fade-line {
          from { opacity: 0; transform: translateY(14px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* 漂浮气泡：半透明，边缘柔化，颜色比之前明显一档（浅色渐变上也能看清） */}
      {bubbles.map((b, i) => (
        <span
          key={i}
          className="absolute rounded-full pointer-events-none"
          style={{
            width: b.size,
            height: b.size,
            left: b.left,
            top: b.top,
            // 径向渐变：中心实、边缘散开，避免生硬的圆边
            background: `radial-gradient(circle at 34% 30%, ${b.color} 0%, ${b.color} 52%, ${b.color}00 100%)`,
            opacity: 0.5,
            animation: `welcome-float ${b.dur} ease-in-out ${b.delay} infinite`,
          }}
        />
      ))}

      {/* 中央文字：逐行淡入（衬线 display 字体，安静而有文气） */}
      <div className="relative z-10 text-center px-6">
        <h1
          className="font-display text-3xl md:text-4xl font-bold text-[#525c68] mb-5"
          style={{
            animation: "welcome-fade-line 1s ease-out both",
            textShadow: "0 1px 10px rgba(255,255,255,0.9)",
          }}
        >
          欢迎来到Solace
        </h1>
        <p
          className="font-display text-lg text-[#68737f] mb-2"
          style={{
            animation: "welcome-fade-line 1s ease-out 0.6s both",
            textShadow: "0 1px 8px rgba(255,255,255,0.9)",
          }}
        >
          在这里，我们倾听一切
        </p>
        <p
          className="font-display text-lg text-[#68737f] mb-12"
          style={{
            animation: "welcome-fade-line 1s ease-out 1.2s both",
            textShadow: "0 1px 8px rgba(255,255,255,0.9)",
          }}
        >
          夜再深，也有一盏灯为你而亮
        </p>

        {/* 进入按钮：圆形箭头，呼吸感，悬停放大变色 */}
        <button
          onClick={handleEnter}
          className="group flex flex-col items-center gap-2 mx-auto cursor-pointer bg-transparent border-0 p-0"
        >
          <span
            className="w-14 h-14 rounded-full bg-[#7fa8c4] text-white flex items-center justify-center text-2xl shadow-md transition-all duration-300 group-hover:bg-[#6d99b5] group-hover:scale-110"
            style={{ animation: "welcome-breathe 2.6s ease-in-out infinite" }}
          >
            ↓
          </span>
          <span className="text-xs text-[#8a94a0] tracking-widest transition-colors duration-300 group-hover:text-[#5b8aa6]">
            开始我们的故事
          </span>
        </button>
      </div>
    </div>
  );
}
