"use client";

/**
 * 通用量表测评 —— 渲染**任何"可上传题库"**的题目。
 *
 * ⚠️ 为什么单独写一个组件，而不是塞进 `HealingCottage.jsx`：
 *    那边的人格探索（24 题）/ PHQ-9 / GAD-7 是**硬编码且计分在前端**的，
 *    任务要求"不改现有题库计分逻辑" —— 所以一行都没动。
 *    这个组件走的是另一条路：**题目从接口拉、提交给服务端算分**。
 *    两套并存是刻意的，不是没来得及合并。
 *
 * ⚠️ 这个组件**不碰计分规则**：`scoring` 根本不下发到前端
 *    （见 `app/api/user/scales/route.js` 的 forClient）。
 *    它只负责"把题目渲染出来、把答案收集起来发回去"。
 */
import { useCallback, useEffect, useState } from "react";

const btnBase =
  "border border-[#d5d9d7] bg-[#fdfdfc] text-slate-700 rounded-xl hover:bg-[#eef4f6] hover:text-slate-900 hover:scale-[1.02] active:bg-[#dbe6ea] active:scale-[0.98] shadow-sm transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed";

const btnPrimary =
  "border border-[#7fa3b8] bg-[#7fa3b8] text-white rounded-xl hover:bg-[#6c93a8] active:scale-[0.98] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed";

export default function ScaleQuiz({ onClose, initialScaleId = "" }) {
  const [scales, setScales] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [active, setActive] = useState(null); // 正在做的题库
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  /**
   * 从卡片直接点进来时（`initialScaleId`），列表一加载完就进那套题。
   *
   * ⚠️ 不然用户点了卡片还要在列表里再选一次，等于白点一层 ——
   *    那就失去了"直接铺成卡片"的意义。
   *
   * ⚠️ 依赖里带上 `active` 和 `result`：用户从结果页退回列表后，
   *    不该被这个 effect 再次拽进同一套题里。
   */
  useEffect(() => {
    if (!initialScaleId || active || result) return;
    if (!Array.isArray(scales)) return;

    const found = scales.find((item) => item.id === initialScaleId);
    if (found) setActive(found);
  }, [initialScaleId, scales, active, result]);

  /* ---- 拉题库 ---- */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/user/scales", { cache: "no-store" });
        const data = await res.json();
        if (cancelled) return;

        if (!res.ok || !data?.ok) {
          setError(data?.error || "题库加载失败");
        } else {
          setScales(Array.isArray(data.scales) ? data.scales : []);
        }
      } catch (err) {
        if (!cancelled) setError(err?.message || "网络异常");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const start = useCallback((scale) => {
    setActive(scale);
    setStep(0);
    setAnswers({});
    setResult(null);
    setError("");
  }, []);

  const back = useCallback(() => {
    setActive(null);
    setResult(null);
    setError("");
  }, []);

  /** 选完答案：记下来 + 自动下一题（少一次点击） */
  const choose = useCallback(
    (questionId, value) => {
      setAnswers((prev) => ({ ...prev, [questionId]: value }));

      // 最后一题就不自动跳了，让用户看到自己的选择
      if (active && step < active.questions.length - 1) {
        window.setTimeout(() => setStep((s) => s + 1), 120);
      }
    },
    [active, step]
  );

  const submit = useCallback(async () => {
    if (!active) return;

    setSubmitting(true);
    setError("");

    try {
      const res = await fetch("/api/user/scales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scaleId: active.id, answers }),
      });
      const data = await res.json();

      if (!res.ok || !data?.ok) {
        setError(data?.error || "提交失败");
      } else {
        setResult(data.result || {});
      }
    } catch (err) {
      setError(err?.message || "网络异常");
    } finally {
      setSubmitting(false);
    }
  }, [active, answers]);

  /* ------------------------------------------------------------ 结果页 */
  if (result) {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-[#e8eae7] bg-white p-5">
          <p className="text-sm text-slate-500 mb-1">{active?.name}</p>
          <p className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-slate-800">{result.score}</span>
            <span className="text-sm text-slate-400">/ {result.maxScore}</span>
            {result.level ? (
              <span className="ml-2 rounded-full bg-[#eef4f6] px-2.5 py-0.5 text-xs text-[#5b8aa6]">
                {result.level}
              </span>
            ) : null}
          </p>

          {result.dimensions && Object.keys(result.dimensions).length ? (
            <div className="mt-4 space-y-1.5">
              {Object.entries(result.dimensions).map(([name, value]) => (
                <div key={name} className="flex items-center justify-between text-xs">
                  <span className="text-slate-500">{name}</span>
                  <span className="text-slate-700">
                    {value.score} / {value.maxScore}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {result.note ? (
            <p className="mt-4 rounded-xl bg-[#f7f9f7] p-3 text-xs leading-6 text-slate-500">
              {result.note}
            </p>
          ) : null}

          <p className="mt-3 text-[11px] text-slate-400">
            这个结果只用来让我更懂你的状态，不会展示给别人。
          </p>
        </div>

        <div className="flex gap-2">
          <button type="button" className={`${btnPrimary} flex-1 py-2.5`} onClick={back}>
            返回量表列表
          </button>
          {onClose ? (
            <button type="button" className={`${btnBase} px-4 py-2.5`} onClick={onClose}>
              关闭
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------ 答题页 */
  if (active) {
    const questions = active.questions || [];
    const question = questions[step];
    const total = questions.length;
    const answered = Object.keys(answers).length;
    const isLast = step === total - 1;

    return (
      <div className="space-y-4">
        {/* 进度 */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs text-slate-400">
            <span className="truncate">{active.name}</span>
            <span className="shrink-0">
              {step + 1} / {total}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[#eef1ef]">
            <div
              className="h-full rounded-full bg-[#7fa3b8] transition-all duration-300"
              style={{ width: `${((step + 1) / total) * 100}%` }}
            />
          </div>
        </div>

        <div className="rounded-2xl border border-[#e8eae7] bg-white p-5">
          <p className="mb-4 text-sm leading-7 text-slate-700">{question.text}</p>

          <div className="space-y-2">
            {(question.options || []).map((option) => {
              const selected = answers[question.id] === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => choose(question.id, option.value)}
                  className={`w-full rounded-xl border px-3 py-2.5 text-left text-sm transition-all duration-150 ${
                    selected
                      ? "border-[#a9c6da] bg-[#e3edf3] text-slate-800"
                      : "border-[#e8eae7] bg-white text-slate-600 hover:bg-[#f4f7f9]"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        {error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        ) : null}

        <div className="flex gap-2">
          <button
            type="button"
            className={`${btnBase} px-4 py-2.5`}
            onClick={() => (step > 0 ? setStep((s) => s - 1) : back())}
          >
            {step > 0 ? "上一题" : "返回"}
          </button>

          {isLast ? (
            <button
              type="button"
              className={`${btnPrimary} flex-1 py-2.5`}
              // ⚠️ 必须答完才能提交 —— 标准量表缺题会系统性低估分数
              disabled={submitting || answered < total}
              onClick={submit}
            >
              {submitting
                ? "提交中…"
                : answered < total
                  ? `还有 ${total - answered} 题没答`
                  : "提交"}
            </button>
          ) : (
            <button
              type="button"
              className={`${btnBase} flex-1 py-2.5`}
              disabled={answers[question.id] == null}
              onClick={() => setStep((s) => Math.min(s + 1, total - 1))}
            >
              下一题
            </button>
          )}
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------ 列表页 */
  return (
    <div className="space-y-3">
      {loading ? (
        <p className="py-6 text-center text-xs text-slate-400">正在加载量表…</p>
      ) : null}

      {error && !loading ? (
        <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      ) : null}

      {scales && !scales.length ? (
        <p className="py-6 text-center text-xs text-slate-400">
          还没有可用的量表（管理员可以在后台题库管理里上传）
        </p>
      ) : null}

      {(scales || []).map((scale) => (
        <button
          key={scale.id}
          type="button"
          onClick={() => start(scale)}
          className="w-full rounded-2xl border border-[#e8eae7] bg-white p-4 text-left transition-all duration-150 hover:border-[#a9c6da] hover:bg-[#f4f7f9]"
        >
          <p className="text-sm font-medium text-slate-700">{scale.name}</p>
          <p className="mt-1 text-xs leading-6 text-slate-400 line-clamp-2">
            {scale.description || "点击开始"}
          </p>
          <p className="mt-2 text-[11px] text-slate-300">
            共 {scale.questions?.length || 0} 题
          </p>
        </button>
      ))}

      {onClose ? (
        <button type="button" className={`${btnBase} w-full py-2.5`} onClick={onClose}>
          关闭
        </button>
      ) : null}
    </div>
  );
}
