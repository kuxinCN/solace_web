"use client";

/**
 * 量表入口 —— **已开启的量表直接铺成卡片**，点一下就开始答题。
 *
 * ⚠️ 列表来自 `/api/user/scales`，它**只返回已启用的题库** ——
 *    所以渲染出来的每一张卡都是"现在就能做"的。
 *    后台把某个题库停用，这张卡自己就消失了。
 *
 * ⚠️ 卡片上的「已测评 / 最近一次」状态来自后端
 *    `/api/user/assessments?type=scales-latest`（每个已启用量表的最新一条结果），
 *    绝不读本地缓存。提交测评成功（onSubmitted）或在历史弹窗删除记录后立即重拉，
 *    保证状态与数据库记录条数实时一致——删光后卡片立刻回到「还没有测试过」。
 */
import { useCallback, useEffect, useState } from "react";
import ScaleQuiz from "@/components/ScaleQuiz";
import ConfirmModal from "@/components/ConfirmModal";

// created_at（MySQL datetime 或 ISO）→ "2026/10/2" 短日期
function fmtDate(raw) {
  if (!raw) return "";
  const d = new Date(typeof raw === "string" ? raw.replace(" ", "T") : raw);
  if (Number.isNaN(d.getTime())) return String(raw).slice(0, 10);
  return d.toLocaleDateString("zh-CN");
}

// 弹窗内完整日期：YYYY/M/D HH:MM
function fmtDateTime(raw) {
  if (!raw) return "未知时间";
  const d = new Date(typeof raw === "string" ? raw.replace(" ", "T") : raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const EMPTY_HISTORY = {
  open: false,
  scaleId: "",
  scaleName: "",
  records: [],
  loading: false,
  selectMode: false,
  selectedIds: [],
  deleting: false,
  confirmOpen: false,
  msg: "",
};

export default function ScaleQuizEntry({ className = "" }) {
  const [scales, setScales] = useState([]);
  const [latest, setLatest] = useState({}); // { [scaleId]: { score, level, date } }
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  // 量表测评历史弹窗（每张量表卡各自的历史，一次只看一套）
  const [historyModal, setHistoryModal] = useState(EMPTY_HISTORY);

  // 拉题库 + 每个题库的最近一次结果（数据库为准）
  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const [scaleRes, latestRes] = await Promise.all([
          fetch("/api/user/scales", { cache: "no-store" })
            .then((r) => r.json())
            .catch(() => null),
          fetch("/api/user/assessments?type=scales-latest", { cache: "no-store" })
            .then((r) => r.json())
            .catch(() => null),
        ]);
        if (!alive) return;
        setScales(Array.isArray(scaleRes?.scales) ? scaleRes.scales : []);

        const map = {};
        if (latestRes?.ok && Array.isArray(latestRes.scales)) {
          for (const item of latestRes.scales) {
            if (!item?.type || !item.data) continue;
            map[item.type] = {
              score: item.data.score,
              level: item.data.level || "",
              date: fmtDate(item.created_at),
            };
          }
        }
        setLatest(map);
      } catch {
        if (alive) setScales([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [refreshKey]);

  // 提交成功 / 删除成功 → bump 触发重拉（卡片「已测评」状态与数据库对齐）
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  /* ---------------- 历史记录弹窗 ---------------- */

  const patchModal = useCallback((patch) => {
    setHistoryModal((m) => ({ ...m, ...patch }));
  }, []);

  // 打开某套量表的历史：拉后端记录（type = 题库 id）
  const openHistory = useCallback(async (scale) => {
    const base = { ...EMPTY_HISTORY, open: true, scaleId: scale.id, scaleName: scale.name, loading: true };
    setHistoryModal(base);
    try {
      const res = await fetch(`/api/user/assessments?type=${encodeURIComponent(scale.id)}`, {
        cache: "no-store",
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || "加载失败");
      setHistoryModal((m) => ({
        ...m,
        records: Array.isArray(json.records) ? json.records : [],
        loading: false,
      }));
    } catch (err) {
      setHistoryModal((m) => ({ ...m, records: [], loading: false, msg: err.message || "加载失败" }));
    }
  }, []);

  const closeHistory = useCallback(() => setHistoryModal(EMPTY_HISTORY), []);

  const toggleSelectMode = useCallback(() => {
    setHistoryModal((m) => ({
      ...m,
      selectMode: !m.selectMode,
      selectedIds: [],
      confirmOpen: false,
      msg: "",
    }));
  }, []);

  const toggleSelectRecord = useCallback((id) => {
    setHistoryModal((m) => ({
      ...m,
      msg: "",
      selectedIds: m.selectedIds.includes(id)
        ? m.selectedIds.filter((x) => x !== id)
        : [...m.selectedIds, id],
    }));
  }, []);

  const toggleSelectAll = useCallback(() => {
    setHistoryModal((m) => {
      const all = m.records.length > 0 && m.selectedIds.length === m.records.length;
      return { ...m, selectedIds: all ? [] : m.records.map((r) => r.id) };
    });
  }, []);

  // 删除选中记录：成功后更新弹窗列表 + 重拉卡片状态（删光 → 卡片回「还没有测试过」）
  const deleteSelectedRecords = useCallback(async () => {
    const ids = historyModal.selectedIds;
    if (!ids.length) return;
    patchModal({ deleting: true, confirmOpen: false, msg: "" });
    try {
      const res = await fetch("/api/user/assessments", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "删除失败");
      setHistoryModal((m) => ({
        ...m,
        records: m.records.filter((r) => !ids.includes(r.id)),
        selectedIds: [],
        selectMode: false,
        deleting: false,
      }));
      bump(); // 同步卡片「已测评 / 还没有测试过」
    } catch (err) {
      patchModal({ deleting: false, msg: err.message || "删除失败，请重试" });
    }
  }, [historyModal.selectedIds, patchModal, bump]);

  // 没加载完、或者一个题库都没开 → 整块不显示（不留空壳）
  if (loading || !scales.length) return null;

  return (
    <>
      <div className={`space-y-2 ${className}`}>
        {scales.map((scale) => {
          const count = (scale.questions || []).length;
          // 一题按 15 秒估，向上取整到分钟 —— 给用户一个心理预期
          const minutes = Math.max(1, Math.ceil((count * 15) / 60));
          const last = latest[scale.id] || null;

          return (
            <div
              key={scale.id}
              className="w-full rounded-lg border border-[#eef1f2] bg-[#fafcfb] px-3 py-2.5 transition-colors duration-150 hover:border-[#cfd8dd] hover:bg-white"
            >
              <button
                type="button"
                onClick={() => {
                  setActiveId(scale.id);
                  setOpen(true);
                }}
                className="w-full text-left"
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

                {/* 已测评状态：以后端记录条数为准；无记录显示「还没有测试过」 */}
                <div className="mt-2 border-t border-[#f0f3f4] pt-2">
                  {last ? (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="rounded-full bg-[#eef4f6] px-2 py-0.5 text-[11px] text-[#5b8aa6]">
                        已测评
                      </span>
                      <span className="text-[11px] text-slate-500">
                        {typeof last.score === "number" ? `${last.score} 分` : ""}
                        {last.level ? ` · ${last.level}` : ""}
                      </span>
                      <span className="text-[11px] text-slate-400">{last.date}</span>
                    </div>
                  ) : (
                    <p className="text-[11px] text-slate-300">还没有测试过</p>
                  )}
                </div>
              </button>

              {/* 历史记录入口（与性格/情绪卡片同款文字链接） */}
              <button
                type="button"
                onClick={() => openHistory(scale)}
                className="mt-1.5 text-[11px] text-[#5b8aa6] hover:text-[#7fa8c4] transition-colors duration-150"
              >
                查看历史记录
              </button>
            </div>
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

            <ScaleQuiz initialScaleId={activeId} onSubmitted={bump} />
          </div>
        </div>
      ) : null}

      {/* ---------------- 历史记录弹窗（风格与治愈小屋另两套测评一致） ---------------- */}
      {historyModal.open ? (
        <>
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{
              background:
                "radial-gradient(125% 105% at 50% 12%, rgba(58,68,74,0.30) 0%, rgba(30,38,43,0.56) 100%)",
              backdropFilter: "blur(8px) saturate(0.98)",
              WebkitBackdropFilter: "blur(8px) saturate(0.98)",
            }}
            onClick={closeHistory}
          >
            <div
              className="bg-[#fbfaf7] rounded-2xl border border-[#e8eae7] w-[92%] max-w-lg max-h-[82vh] flex flex-col overflow-hidden"
              style={{ boxShadow: "0 28px 70px -24px rgba(38,48,54,0.55), 0 2px 8px rgba(38,48,54,0.08)" }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* 标题栏 */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-[#e8eae7]">
                <h3 className="text-base font-bold text-slate-800">
                  {historyModal.scaleName} · 历史
                </h3>
                <div className="flex items-center gap-1">
                  {historyModal.records.length > 0 && (
                    <button
                      onClick={toggleSelectMode}
                      className="text-xs text-[#5b8aa6] hover:text-[#3f6d8a] px-2.5 py-1.5 rounded-md hover:bg-[#eef4f8] active:scale-[0.98] transition-all duration-150"
                    >
                      {historyModal.selectMode ? "取消" : "多选"}
                    </button>
                  )}
                  <button
                    onClick={closeHistory}
                    className="text-slate-400 hover:text-slate-600 text-lg leading-none w-8 h-8 flex items-center justify-center rounded-full hover:bg-[#eef4f8] transition-colors"
                  >
                    ×
                  </button>
                </div>
              </div>

              {/* 列表 */}
              <div className="flex-1 overflow-y-auto px-5 py-4">
                {historyModal.loading ? (
                  <p className="text-sm text-slate-400 text-center py-8">加载中…</p>
                ) : historyModal.records.length === 0 ? (
                  <p className="text-sm text-slate-400 text-center py-8">
                    还没有记录，做完一次测评后就会出现在这里。
                  </p>
                ) : (
                  <div className="space-y-3">
                    {historyModal.records.map((r) => {
                      const d = r.data || {};
                      const selected = historyModal.selectedIds.includes(r.id);
                      const dims =
                        d.dimensions && typeof d.dimensions === "object"
                          ? Object.entries(d.dimensions)
                          : [];
                      return (
                        <div
                          key={r.id}
                          onClick={
                            historyModal.selectMode ? () => toggleSelectRecord(r.id) : undefined
                          }
                          className={`rounded-xl border px-4 py-3 transition-all duration-150 ${
                            historyModal.selectMode
                              ? selected
                                ? "cursor-pointer border-[#7fa8c4] bg-[#f3f8fb] ring-1 ring-[#7fa8c4]/25"
                                : "cursor-pointer border-[#e8eae7] bg-white hover:border-[#c7d8e3] hover:bg-[#fafcfd]"
                              : "border-[#e8eae7] bg-white"
                          }`}
                        >
                          <div className="flex items-start gap-3">
                            {historyModal.selectMode && (
                              <span
                                className={`mt-0.5 w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center shrink-0 transition-all duration-150 ${
                                  selected
                                    ? "border-[#7fa8c4] bg-[#7fa8c4]"
                                    : "border-[#cfd8dd] bg-white"
                                }`}
                              >
                                {selected && (
                                  <svg
                                    className="w-3 h-3 text-white"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="3.5"
                                  >
                                    <path
                                      d="M20 6L9 17l-5-5"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    />
                                  </svg>
                                )}
                              </span>
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-slate-400 mb-1.5">
                                {fmtDateTime(r.created_at)}
                              </p>
                              <div className="flex flex-wrap items-baseline gap-x-2">
                                <span className="text-lg font-bold text-slate-800">
                                  {typeof d.score === "number" ? d.score : "—"}
                                </span>
                                {typeof d.maxScore === "number" ? (
                                  <span className="text-xs text-slate-400">/ {d.maxScore}</span>
                                ) : null}
                                {d.level ? (
                                  <span className="rounded-full bg-[#eef4f6] px-2 py-0.5 text-[11px] text-[#5b8aa6]">
                                    {d.level}
                                  </span>
                                ) : null}
                              </div>
                              {dims.length ? (
                                <div className="mt-2 space-y-1">
                                  {dims.map(([name, v]) => (
                                    <div
                                      key={name}
                                      className="flex items-center justify-between text-[11px]"
                                    >
                                      <span className="text-slate-500">{name}</span>
                                      <span className="text-slate-600">
                                        {v?.score}
                                        {typeof v?.maxScore === "number" ? ` / ${v.maxScore}` : ""}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 行内错误提示 */}
              {historyModal.msg ? (
                <div className="px-5 py-2 border-t border-[#f0d9d0] bg-[#fdf4f0]">
                  <p className="text-xs text-[#c0653f]">{historyModal.msg}</p>
                </div>
              ) : null}

              {/* 多选操作栏 */}
              {historyModal.selectMode ? (
                <div className="px-5 py-3 border-t border-[#e8eae7] bg-[#faf9f6] flex items-center gap-3">
                  <button
                    onClick={toggleSelectAll}
                    className="text-xs text-[#5b8aa6] hover:text-[#3f6d8a] transition-colors"
                  >
                    {historyModal.records.length > 0 &&
                    historyModal.selectedIds.length === historyModal.records.length
                      ? "取消全选"
                      : "全选"}
                  </button>
                  <span className="text-xs text-slate-400">
                    已选 {historyModal.selectedIds.length} 条
                  </span>
                  <button
                    onClick={() => patchModal({ confirmOpen: true, msg: "" })}
                    disabled={historyModal.selectedIds.length === 0 || historyModal.deleting}
                    className="ml-auto border border-[#e8b4a0] bg-[#f5b8a0] text-white rounded-lg px-3.5 py-1.5 text-xs hover:bg-[#f0a48a] active:scale-[0.98] shadow-sm transition-all duration-150 disabled:opacity-45 disabled:cursor-not-allowed disabled:active:scale-100"
                  >
                    {historyModal.deleting ? "删除中…" : "删除"}
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          {/* 删除二次确认（复用全局自定义弹窗） */}
          <ConfirmModal
            open={historyModal.confirmOpen}
            message={`确定删除选中的 ${historyModal.selectedIds.length} 条测评记录吗？删除后无法恢复。`}
            confirmText={historyModal.deleting ? "删除中…" : "确认删除"}
            onConfirm={deleteSelectedRecords}
            onClose={() => patchModal({ confirmOpen: false })}
          />
        </>
      ) : null}
    </>
  );
}
