"use client";

/**
 * 后台浮动提示条（notice / error）。
 *
 * ## 为什么要浮在最上面
 *
 * 之前它渲染在页面内容流里（表单子页面的标题下面）。但设置页**很长** ——
 * 点完「保存」「测试连接」「提交」之后，提示出现在**屏幕外面的上方**，
 * 用户看不见，就会以为没反应、**再点一次**。
 *
 * 现在它 `fixed` 在视口顶部：**不管滚到哪里都在最上方**，
 * 像一个轻量的弹窗，但不用点确定。
 *
 * ## 三个交互决定
 *
 * | 行为 | 为什么 |
 * |---|---|
 * | **3 秒后自动消失** | 顺利的情况下不该让用户去关它 —— 看一眼就够 |
 * | **右侧有 X** | 等不及的（或者错误信息已经看懂了）直接点掉，不用等 |
 * | **鼠标悬停时暂停倒计时** | 正在读的时候它不该消失 —— 尤其错误信息经常要照着排查 |
 *
 * ⚠️ 错误**不自动消失**？—— 不，也 3 秒。因为后台的错误大多是"再试一次就好"，
 *    真正要排查的（部署、构建）不会走这条路（那些在服务器日志里）。
 *    3 秒 + X 已经够用，而且**用户明确要求了 3 秒**。
 */
import { useEffect, useRef, useState } from "react";

const TONE = {
  error: {
    box: "border-rose-200 bg-[#fdf6f5] text-rose-700",
    icon: "⚠️",
  },
  success: {
    box: "border-[#cfe0d6] bg-[#f3f9f5] text-[#4a7a60]",
    icon: "✓",
  },
  info: {
    box: "border-[#dbe6ee] bg-[#f5f9fc] text-[#4a7290]",
    icon: "ⓘ",
  },
};

/** 单条提示 */
function ToastItem({ tone = "info", text, onClose, durationMs = 3000 }) {
  const [left, setLeft] = useState(durationMs);
  const timer = useRef(null);
  const paused = useRef(false);

  useEffect(() => {
    // ⚠️ 用 100ms 的心跳而不是一次 setTimeout —— 这样悬停暂停 / 继续才做得干净
    timer.current = setInterval(() => {
      if (paused.current) return;
      setLeft((value) => {
        const next = value - 100;
        if (next <= 0) {
          clearInterval(timer.current);
          // ⚠️ 在下一帧再调 onClose：直接在 setState 的 updater 里调
          //    会踩到 React 的渲染期副作用警告
          queueMicrotask(() => onClose?.());
          return 0;
        }
        return next;
      });
    }, 100);

    return () => clearInterval(timer.current);
  }, [onClose]);

  const style = TONE[tone] || TONE.info;
  const pct = Math.max(0, Math.min(100, (left / durationMs) * 100));

  return (
    <div
      className={`pointer-events-auto overflow-hidden rounded-xl border shadow-lg backdrop-blur-sm ${style.box}`}
      onMouseEnter={() => {
        paused.current = true;
      }}
      onMouseLeave={() => {
        paused.current = false;
      }}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <span className="mt-px shrink-0 text-xs opacity-70">{style.icon}</span>
        {/* ⚠️ 长文本要能换行，别撑破 —— 提示里经常带错误原文 */}
        <p className="min-w-0 flex-1 break-words text-xs leading-5">{String(text || "")}</p>
        <button
          type="button"
          onClick={onClose}
          className="ml-1 shrink-0 text-slate-300 transition-colors hover:text-slate-500"
          title="关掉"
          aria-label="关掉提示"
        >
          ×
        </button>
      </div>

      {/* ⚠️ 一条进度线：让人知道"它还剩多久"，比突然消失好接受 */}
      <div className="h-0.5 bg-black/5">
        <div
          className="h-full bg-current opacity-25 transition-[width] duration-100 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * 浮在最上方的提示容器。
 *
 * ⚠️ `pointer-events-none` 挂在外层、单条上再开 `pointer-events-auto` ——
 *    这样没提示的时候整块区域**不吃鼠标事件**，不会挡住下面的按钮。
 */
export default function FloatingAlert({ error = "", notice = "", setError, setNotice }) {
  if (!error && !notice) return null;

  return (
    <div className="pointer-events-none fixed left-1/2 top-3 z-[80] w-[min(94%,720px)] -translate-x-1/2 space-y-2">
      {error ? (
        <ToastItem
          tone="error"
          text={error}
          onClose={() => setError?.("")}
        />
      ) : null}
      {notice ? (
        <ToastItem
          tone="success"
          text={notice}
          onClose={() => setNotice?.("")}
        />
      ) : null}
    </div>
  );
}
