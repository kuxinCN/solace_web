"use client";

/**
 * 后台「内容安全与压力」页的**压力诊断**面板。
 *
 * ⚠️ 它存在的唯一目的：回答"压力明明很高，为什么没弹窗？"
 *
 *    这个问题的原因有五六种（总开关没开 / 分数没到 / 还差一次 / 在冷却 /
 *    上次放松没结束 / 用户自己关了），从界面上完全看不出来。
 *    所以这里把**能自动判断的部分**摆出来，并用大白话给出结论。
 *
 * ⚠️ 口径是**聚合的**：只显示"多少条、最高几分、超阈值几次、实际提醒几次"、
 *    以及"有多少条卡住的会话" —— 足够定位问题，但看不出具体是谁。
 *    压力数据比聊天记录还敏感，不该做成"逐人查看"。
 */
import { useCallback, useEffect, useState } from "react";

const BTN =
  "rounded-lg border border-[#e2e5e2] bg-white px-3 py-1.5 text-xs text-slate-600 transition hover:border-[#c9d2c9] hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-50";

/** 一句结论的样式：error=红、warn=橙、info=灰 */
const NOTE_STYLE = {
  error: "border-rose-200 bg-rose-50 text-rose-700",
  warn: "border-amber-200 bg-amber-50 text-amber-800",
  info: "border-[#e5e7e4] bg-[#f7f9f7] text-slate-600",
};

/** 把 note 里用 **加粗** 包住的部分渲染成 <strong> */
function RichText({ text }) {
  const parts = String(text || "").split(/\*\*(.+?)\*\*/g);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <strong key={index} className="font-semibold">
            {part}
          </strong>
        ) : (
          <span key={index}>{part}</span>
        )
      )}
    </>
  );
}

export default function StressDiagnosePanel({ api, setError, setNotice }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fixing, setFixing] = useState(false);

  const load = useCallback(
    async (silent) => {
      if (!silent) setLoading(true);
      try {
        const result = await api("/api/admin/stress");
        setData(result);
      } catch (err) {
        setError("读取压力诊断失败：" + err.message);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [api, setError]
  );

  useEffect(() => {
    load();
  }, [load]);

  const fix = useCallback(async () => {
    setFixing(true);
    setError("");
    setNotice("");
    try {
      const result = await api("/api/admin/stress", {
        method: "POST",
        body: { action: "fix" },
      });
      setNotice(result?.message || "已清理");
      await load(true);
    } catch (err) {
      setError("清理失败：" + err.message);
    } finally {
      setFixing(false);
    }
  }, [api, load, setError, setNotice]);

  const stats = data?.stats || {};
  const enabled = Boolean(data?.enabled);

  return (
    <div className="space-y-3">
      {/* ---- 一行现状 ---- */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-[#eceeec] bg-white p-4">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${enabled ? "bg-emerald-500" : "bg-slate-300"}`}
          />
          <span className="text-sm text-slate-600">
            {enabled ? "压力评估已开启" : "压力评估未开启"}
          </span>
        </div>

        <div className="text-xs text-slate-400">
          当前阈值 <span className="font-semibold text-slate-600">{data?.threshold ?? "—"}</span>
          <span className="ml-1">（后台配置值 {data?.configThreshold ?? "—"}）</span>
        </div>

        <div className="text-xs text-slate-400">
          跟踪中的用户 <span className="font-semibold text-slate-600">{data?.trackingUsers ?? 0}</span>
        </div>

        <button
          type="button"
          className={`${BTN} ml-auto`}
          disabled={loading}
          onClick={() => load()}
        >
          {loading ? "读取中…" : "刷新"}
        </button>
      </div>

      {/* ---- 最近 24 小时 ---- */}
      <div className="rounded-xl border border-[#eceeec] bg-white p-4">
        <p className="mb-3 text-sm font-semibold text-slate-700">最近 24 小时</p>

        <div className="grid grid-cols-2 gap-3 text-center md:grid-cols-5">
          {[
            { label: "压力记录", value: stats.total ?? 0, cls: "text-slate-700" },
            { label: "最高分", value: stats.maxScore ?? 0, cls: "text-slate-700" },
            { label: "达到阈值", value: stats.aboveThreshold ?? 0, cls: "text-amber-600" },
            { label: "实际提醒", value: stats.triggered ?? 0, cls: "text-emerald-600" },
            { label: "危机命中", value: stats.crisis ?? 0, cls: "text-rose-600" },
          ].map((item) => (
            <div key={item.label}>
              <p className={`text-xl font-semibold ${item.cls}`}>{item.value}</p>
              <p className="text-[11px] text-slate-400">{item.label}</p>
            </div>
          ))}
        </div>

        <p className="mt-3 text-[11px] leading-5 text-slate-400">
          ⚠️ 重点看「达到阈值」和「实际提醒」这两个数：
          <br />· **达到阈值 &gt; 0，但实际提醒 = 0** → 说明被某个条件挡住了（下面会说明是哪个）
          <br />· **压力记录 = 0** → 说明聊天时压根没跑分析（多半是总开关没开）
        </p>

        {stats.error ? (
          <p className="mt-2 text-[11px] text-rose-500">查询出错：{stats.error}</p>
        ) : null}
      </div>

      {/* ---- 卡住的会话 ---- */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[#eceeec] bg-white p-4">
        <div>
          <p className="text-sm font-semibold text-slate-700">卡住的放松会话</p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            用户点过「现在做」但一直没点「做完了」。
            它们超过 {data?.stuckSessionHours ?? 2} 小时会**自动失效**（不会永久堵住提醒），
            这里可以立即清掉。
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span
            className={`text-lg font-semibold ${
              Number(data?.stuckSessions) > 0 ? "text-amber-600" : "text-slate-400"
            }`}
          >
            {data?.stuckSessions ?? 0}
          </span>
          <button type="button" className={BTN} disabled={fixing} onClick={fix}>
            {fixing ? "清理中…" : "修复"}
          </button>
        </div>
      </div>

      {/* ---- 结论 ---- */}
      {Array.isArray(data?.notes) && data.notes.length ? (
        <div className="space-y-2">
          {data.notes.map((note, index) => (
            <div
              key={index}
              className={`rounded-xl border px-3 py-2 text-xs leading-6 ${
                NOTE_STYLE[note.level] || NOTE_STYLE.info
              }`}
            >
              <RichText text={note.text} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
