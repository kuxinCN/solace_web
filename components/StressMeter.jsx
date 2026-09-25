"use client";

/**
 * 压力仪表盘 —— 右上角的小圆盘。
 *
 * ⚠️ 几个刻意的设计：
 *
 *  ① **它只是一个"读数"，不是一个评分**。
 *     界面上给的是"情绪档位"（后台配的中性词，如「有点累」），
 *     而不是"你得了 73 分" —— 数字只在用户主动点开时才展示趋势。
 *
 *  ② **可以整个关掉**。
 *     有些人看到自己的压力曲线会更有压力。所以右上角有个收起按钮，
 *     关掉之后本地记住（localStorage），不再显示。
 *
 *  ③ **颜色只做区分，不做评判**。
 *     用的是柔和的莫兰迪色系，不用刺眼的纯红纯绿 —— 这是陪伴类产品，
 *     不是监控面板。
 */
import { useCallback, useEffect, useMemo, useState } from "react";

/** 档位配色（按 max 分界，从低到高） */
const TONE_BY_LEVEL = [
  { max: 40, ring: "#8fbfa8", soft: "#eef6f1", text: "#5a8a74" }, // 稳
  { max: 65, ring: "#d9c48a", soft: "#f8f4e9", text: "#8a7a4a" }, // 一般
  { max: 85, ring: "#dbb08a", soft: "#f9f1e9", text: "#8a6a4a" }, // 偏高
  { max: 100, ring: "#c9969a", soft: "#f8eeee", text: "#8a5a5e" }, // 高
];

const STORAGE_KEY = "solace_stress_meter_hidden";

function toneOf(score) {
  const value = Math.max(0, Math.min(100, Number(score) || 0));
  return TONE_BY_LEVEL.find((item) => value <= item.max) || TONE_BY_LEVEL[TONE_BY_LEVEL.length - 1];
}

/** 圆环进度（SVG） */
function Ring({ score, tone, size = 56 }) {
  const stroke = 5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = Math.max(0, Math.min(100, Number(score) || 0)) / 100;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="#eceeec"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={tone.ring}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - ratio)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dashoffset 600ms ease" }}
      />
    </svg>
  );
}

/** 迷你趋势条 */
function Trend({ history }) {
  const values = (history || []).slice(-12).map((item) => Number(item.score) || 0);
  if (!values.length) return <p className="text-[11px] text-slate-400">还没有足够的数据</p>;

  return (
    <div className="flex h-10 items-end gap-1">
      {values.map((value, index) => {
        const tone = toneOf(value);
        return (
          <div
            key={index}
            className="w-2 rounded-sm"
            style={{ height: `${Math.max(8, value)}%`, background: tone.ring }}
            title={`${value}`}
          />
        );
      })}
    </div>
  );
}

export default function StressMeter({ api, onPendingPopup }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(true);
  const [loading, setLoading] = useState(false);

  // 读"用户是否收起了它"
  useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      setHidden(false);
    }
  }, []);

  const setHiddenPersist = useCallback((value) => {
    setHidden(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
    } catch {
      /* 存不了就算了，只是这次会话有效 */
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api("/api/stress/state");
      setData(result);
      // 把"该弹但没弹到"的弹窗交给父组件
      if (result?.pendingPopup && typeof onPendingPopup === "function") {
        onPendingPopup(result.pendingPopup);
      }
    } catch {
      /* 仪表盘拿不到数据不是错误，安静就好 */
    } finally {
      setLoading(false);
    }
  }, [api, onPendingPopup]);

  useEffect(() => {
    if (hidden) return;

    load();

    // ⚠️ 每 45 秒复查一次。
    //    聊天接口里的压力分析是 fire-and-forget（不能拖慢用户等回复），
    //    所以"算完了、该弹窗了"这个结论**得靠这里拉回来** ——
    //    这是聊天场景弹窗能出现的关键一环（日记场景则是随保存响应直接给）。
    const timer = window.setInterval(load, 45000);
    return () => window.clearInterval(timer);
  }, [hidden, load]);

  const tone = useMemo(() => toneOf(data?.score), [data?.score]);

  // 用户收起时：只留一个小圆点，点一下还能展开
  if (hidden) {
    return (
      <button
        type="button"
        onClick={() => setHiddenPersist(false)}
        title="显示压力读数"
        className="fixed right-4 top-4 z-30 h-8 w-8 rounded-full border border-[#e2e5e2] bg-white/80 text-[11px] text-slate-400 shadow-sm backdrop-blur transition hover:text-slate-600"
      >
        ·
      </button>
    );
  }

  return (
    <div className="fixed right-4 top-4 z-30 w-[212px]">
      <div className="rounded-2xl border border-[#e8eae7] bg-white/90 p-3 shadow-sm backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Ring score={data?.score ?? 0} tone={tone} />
            <span
              className="absolute inset-0 flex items-center justify-center text-[13px] font-semibold"
              style={{ color: tone.text }}
            >
              {Math.round(data?.score ?? 0)}
            </span>
          </div>

          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-slate-400">现在的状态</p>
            <p className="truncate text-sm font-semibold" style={{ color: tone.text }}>
              {data?.level?.label || (loading ? "…" : "暂无")}
            </p>
            {data?.level?.hint ? (
              <p className="mt-0.5 truncate text-[11px] text-slate-400">{data.level.hint}</p>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => setHiddenPersist(true)}
            title="不再显示"
            className="shrink-0 self-start text-xs text-slate-300 transition hover:text-slate-500"
          >
            ×
          </button>
        </div>

        {open ? (
          <div className="mt-3 border-t border-[#f2f4f2] pt-2">
            <p className="mb-1.5 text-[11px] text-slate-400">最近的变化</p>
            <Trend history={data?.history} />
            <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
              <span>
                {data?.trend > 0 ? "比之前紧了一些" : data?.trend < 0 ? "缓下来了一点" : "比较平稳"}
              </span>
              <button
                type="button"
                className="transition hover:text-slate-600"
                onClick={load}
                disabled={loading}
              >
                {loading ? "…" : "刷新"}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-2 w-full text-[11px] text-slate-400 transition hover:text-slate-600"
          >
            看看最近的变化
          </button>
        )}
      </div>
    </div>
  );
}
