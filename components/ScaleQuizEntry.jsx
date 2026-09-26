"use client";

/**
 * 量表入口 —— **已开启的量表直接铺成卡片**，点一下就开始答题。
 *
 * ⚠️ 为什么不再是「更多量表」那种折叠入口：
 *    那个写法让用户必须先点一次才知道有什么可做，**白白多一层**。
 *    现在后台开着的量表直接在主区域列出来，简介也印在卡片上 ——
 *    用户扫一眼就知道"这里有个压力自评可以做"。
 *
 * ⚠️ 列表来自 `/api/user/scales`，它**只返回已启用的题库** ——
 *    所以渲染出来的每一张卡都是"现在就能做"的，不用再判断状态。
 *    后台把某个题库停用，这张卡自己就消失了。
 *
 * ⚠️ 自带状态（不往「治愈小屋」里塞 state）：
 *    那个组件一千行、状态一堆，为了加一个入口去动它的 state 不划算，
 *    而且容易碰到别的逻辑。
 */
import { useEffect, useState } from "react";
import ScaleQuiz from "@/components/ScaleQuiz";

export default function ScaleQuizEntry({ className = "" }) {
  const [scales, setScales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState("");

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const res = await fetch("/api/user/scales", { cache: "no-store" });
        const data = await res.json();
        if (alive) setScales(Array.isArray(data?.scales) ? data.scales : []);
      } catch {
        if (alive) setScales([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  // 没加载完、或者一个题库都没开 → 整块不显示（不留空壳）
  if (loading || !scales.length) return null;

  return (
    <>
      <div className={`space-y-2 ${className}`}>
        {scales.map((scale) => {
          const count = (scale.questions || []).length;
          // 一题按 15 秒估，向上取整到分钟 —— 给用户一个心理预期
          const minutes = Math.max(1, Math.ceil((count * 15) / 60));

          return (
            <button
              key={scale.id}
              type="button"
              onClick={() => {
                setActiveId(scale.id);
                setOpen(true);
              }}
              className="w-full rounded-lg border border-[#eef1f2] bg-[#fafcfb] px-3 py-2.5 text-left transition-colors duration-150 hover:border-[#cfd8dd] hover:bg-white"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-slate-700">{scale.name}</p>
                  {scale.description ? (
                    <p className="mt-1 text-[11px] leading-5 text-slate-400">{scale.description}</p>
                  ) : null}
                </div>
                <span className="shrink-0 text-[11px] text-[#7fa8c4]">
                  {count} 题 · 约 {minutes} 分钟
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/30 p-4 backdrop-blur-sm">
          <div className="my-8 w-full max-w-md rounded-2xl border border-[#e8eae7] bg-[#fbfcfb] p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between gap-3">
              <p className="text-sm font-bold text-slate-800">量表测评</p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-slate-300 transition-colors hover:text-slate-500"
                title="关闭"
              >
                ×
              </button>
            </div>

            {/* ⚠️ 传 initialScaleId —— 点哪张卡就直接进哪套题，不用再选一次。
                ⚠️ 这里**不传 onClose**（上面已经有 × 了），传了会出现两个关闭入口。 */}
            <ScaleQuiz initialScaleId={activeId} />
          </div>
        </div>
      ) : null}
    </>
  );
}
