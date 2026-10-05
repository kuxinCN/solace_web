"use client";

/**
 * 压力数据提供者 —— 不可见，只负责拉数据和轮询。
 *
 * 原来的悬浮面板 UI 和拖动逻辑已删除，压力信息合并进了蝴蝶桌宠的气泡里。
 * 本组件保留：
 *  - 45 秒轮询 /api/stress/state（聊天场景的 RelaxPopup 弹窗依赖这个轮询）
 *  - 档位配色、圆环进度、趋势条等纯 UI 子组件（供蝴蝶气泡复用）
 *  - 数据通过 onData 回调传给父组件，父组件再传给蝴蝶气泡
 */
import { useCallback, useEffect, useMemo } from "react";

/** 档位配色（按 max 分界，从低到高） */
const TONE_BY_LEVEL = [
  { max: 40, ring: "#8fbfa8", soft: "#eef6f1", text: "#5a8a74" }, // 稳
  { max: 65, ring: "#d9c48a", soft: "#f8f4e9", text: "#8a7a4a" }, // 一般
  { max: 85, ring: "#dbb08a", soft: "#f9f1e9", text: "#8a6a4a" }, // 偏高
  { max: 100, ring: "#c9969a", soft: "#f8eeee", text: "#8a5a5e" }, // 高
];

/** 无真实数据时的中性灰 */
const NO_DATA_TONE = { ring: "#d9ddda", soft: "#f5f7f5", text: "#9aa29e" };

export function toneOf(score) {
  const value = Math.max(0, Math.min(100, Number(score) || 0));
  return TONE_BY_LEVEL.find((item) => value <= item.max) || TONE_BY_LEVEL[TONE_BY_LEVEL.length - 1];
}

export { NO_DATA_TONE };

/** 圆环进度（SVG） */
export function StressRing({ score, tone, size = 56 }) {
  const stroke = 5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = Math.max(0, Math.min(100, Number(score) || 0)) / 100;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#eceeec" strokeWidth={stroke} />
      <circle
        cx={size / 2} cy={size / 2} r={radius} fill="none"
        stroke={tone.ring} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - ratio)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dashoffset 600ms ease" }}
      />
    </svg>
  );
}

/** 迷你趋势条 */
export function StressTrend({ history }) {
  const values = (history || []).slice(-12).map((item) => Number(item.score) || 0);
  if (!values.length) return <p className="text-[11px] text-slate-400">还没有足够的数据</p>;

  return (
    <div className="flex h-10 items-end gap-1">
      {values.map((value, index) => {
        const tone = toneOf(value);
        return (
          <div key={index} className="w-2 rounded-sm"
            style={{ height: `${Math.max(8, value)}%`, background: tone.ring }}
            title={`${value}`} />
        );
      })}
    </div>
  );
}

export default function StressMeter({ api, onPendingPopup, onData }) {
  const load = useCallback(async () => {
    try {
      const result = await api("/api/stress/state");
      onData?.(result);
      if (result?.pendingPopup && typeof onPendingPopup === "function") {
        onPendingPopup(result.pendingPopup);
      }
    } catch { /* 拿不到数据安静就好 */ }
  }, [api, onPendingPopup, onData]);

  // 45 秒轮询：聊天接口里的压力分析是 fire-and-forget，
  // "算完了、该弹窗了"这个结论得靠这里拉回来。
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 45000);
    return () => window.clearInterval(timer);
  }, [load]);

  return null; // 不可见组件
}
