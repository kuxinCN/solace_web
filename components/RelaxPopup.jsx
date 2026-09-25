"use client";

/**
 * 压力提醒弹窗 —— **右上角滑下来的一张卡片**。
 *
 * ⚠️ 为什么不是居中的模态框：
 *    居中 + 遮罩 = "你必须先处理我"。而压力高的用户最需要的**不是**被打断，
 *    而是一个可以**无视**的温和提醒。所以它从右上角出现、不挡任何内容、
 *    随时可以关掉 —— 关掉就真的不再提（还会自动抬高阈值）。
 *
 * ⚠️ **必须把"读到多少分、什么状态"讲出来**（用户明确要求）：
 *    只弹一句"要不要放松"会让人莫名其妙，甚至有点被冒犯 ——
 *    "凭什么觉得我需要放松？"。把读数摊开来说，用户才有判断依据。
 *
 * 两个阶段：
 *   ① 提示卡：说明读数 + 提供放松方式 + 取消
 *   ② 放松层：用户选了一种之后，全屏承载 FirstAid（呼吸 / 蝴蝶拍）
 */
import { useCallback, useEffect, useState } from "react";
import FirstAid from "@/components/FirstAid";

/** 方式 id → FirstAid 里对应的条目 id */
const METHOD_TO_KIT = {
  breathing: "breath",
  butterfly: "butterfly",
};

export default function RelaxPopup({ popup, onRespond, onDone, api }) {
  /** "" = 提示阶段；否则是正在做的方式 */
  const [activeMethod, setActiveMethod] = useState("");
  const [sessionId, setSessionId] = useState(0);
  const [busy, setBusy] = useState("");
  const [leaving, setLeaving] = useState(false);

  // 换了新弹窗就重置
  useEffect(() => {
    setActiveMethod("");
    setLeaving(false);
  }, [popup]);

  const close = useCallback(() => {
    setLeaving(true);
    // 等退场动画走完再通知父组件移除
    window.setTimeout(() => {
      onRespond?.({ action: "decline", score: popup?.score, source: popup?.source });
    }, 180);
  }, [onRespond, popup?.score, popup?.source]);

  const start = useCallback(
    async (method) => {
      setBusy(method);
      try {
        const result = await onRespond?.({
          action: "accept",
          method,
          score: popup?.score,
          source: popup?.source,
        });
        if (result?.sessionId) setSessionId(result.sessionId);
        setActiveMethod(method);
      } finally {
        setBusy("");
      }
    },
    [onRespond, popup?.score, popup?.source]
  );

  /** 放松做完了：补一条完成回执（后台才能统计"有没有用"） */
  const finishRelax = useCallback(async () => {
    setActiveMethod("");
    try {
      if (sessionId && api) {
        await api("/api/stress/popup-response", {
          method: "PATCH",
          body: { sessionId },
        });
      }
    } catch {
      /* 回执失败不影响用户 */
    }
    onDone?.();
  }, [api, sessionId, onDone]);

  if (!popup) return null;

  /* ------------------------------ 阶段②：全屏放松层 ------------------------------ */
  if (activeMethod) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/25 p-4 backdrop-blur-sm">
        <div className="w-full max-w-md rounded-2xl border border-[#e8eae7] bg-white p-5 shadow-xl">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-700">
                {activeMethod === "butterfly" ? "蝴蝶拍" : "呼吸放松"}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-400">
                慢慢来，不用急。做完直接关掉就好。
              </p>
            </div>
            <button
              type="button"
              onClick={finishRelax}
              className="shrink-0 rounded-lg border border-[#e2e5e2] bg-white px-3 py-1.5 text-xs text-slate-600 transition hover:border-[#c9d2c9] hover:text-slate-800"
            >
              做完了
            </button>
          </div>

          {/* ⚠️ 复用「治愈小屋」里的那套动画组件 —— 不重写一份 */}
          <FirstAid
            initialMethod={activeMethod}
            allowedIds={Object.values(METHOD_TO_KIT)}
          />
        </div>
      </div>
    );
  }

  /* ------------------------------ 阶段①：右上角提示卡 ------------------------------ */
  const methods = Array.isArray(popup.methods) ? popup.methods : [];
  const crisis = Boolean(popup.crisis);

  return (
    <div
      className={`fixed right-4 top-4 z-40 w-[320px] transition-all duration-200 ${
        leaving ? "translate-x-3 opacity-0" : "translate-x-0 opacity-100"
      }`}
      role="status"
      aria-live="polite"
    >
      <div
        className={`rounded-2xl border p-4 shadow-lg backdrop-blur ${
          crisis
            ? "border-[#e6c9cc] bg-[#fdf5f5]/95"
            : "border-[#e8eae7] bg-white/95"
        }`}
      >
        {/* 读数：⚠️ 用户要求"必须告知当前压力值和对应情绪" */}
        <div className="mb-2 flex items-start justify-between gap-2">
          <div className="flex-1">
            <p className="text-xs text-slate-400">{crisis ? "我需要先陪着你" : "我读到的状态"}</p>
            {!crisis ? (
              <p className="mt-1 flex items-baseline gap-1.5">
                <span
                  className="text-2xl font-semibold leading-none"
                  style={{ color: "#8a6a4a" }}
                >
                  {Math.round(popup.score ?? 0)}
                </span>
                <span className="text-xs text-slate-400">/ 100</span>
                <span className="ml-1 text-sm font-medium text-slate-600">
                  {popup.levelLabel}
                </span>
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={close}
            title="关闭"
            className="shrink-0 text-slate-300 transition hover:text-slate-500"
          >
            ×
          </button>
        </div>

        <p className="text-sm leading-6 text-slate-600">{popup.message}</p>

        {popup.levelHint && !crisis ? (
          <p className="mt-1 text-[11px] text-slate-400">{popup.levelHint}</p>
        ) : null}

        {/* 放松方式（后台可勾选开放哪些） */}
        {methods.length && !crisis ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {methods.map((method) => (
              <button
                key={method.id}
                type="button"
                disabled={Boolean(busy)}
                onClick={() => start(method.id)}
                title={method.desc}
                className="flex-1 rounded-xl border border-[#d5d9d7] bg-[#fdfdfc] px-3 py-2 text-xs text-slate-700 transition hover:bg-[#eef4f6] hover:text-slate-900 active:scale-[0.98] disabled:opacity-50"
              >
                {busy === method.id ? "打开中…" : method.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={close}
            className="text-xs text-slate-400 transition hover:text-slate-600"
          >
            {crisis ? "我知道了" : "先不用，谢谢"}
          </button>
          <button
            type="button"
            onClick={() => onRespond?.({ action: "never", score: popup.score, source: popup.source })}
            className="text-[11px] text-slate-300 transition hover:text-slate-500"
            title="之后不再自动提醒（可以随时在设置里打开）"
          >
            不再提醒
          </button>
        </div>
      </div>
    </div>
  );
}
