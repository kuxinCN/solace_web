"use client";

/**
 * 后台「日记」页的任务面板。
 *
 * 为什么单独写一个、不复用 ContentReviewPanel：
 *   那个面板是"内容审核"的主界面，混着一堆审核专有的东西（字段分布、违规处置、
 *   图片预览……）。日记这边只关心两类任务 —— **情绪打标** 和 **AI 生成** ——
 *   而且**必须分开看**：打标是"给已有日记贴标签"，生成是"凭空造一篇日记"，
 *   把它们混在一个列表里根本看不出谁卡住了。
 *
 * 数据来源和「数据审核」是**同一个接口**（/api/admin/review），
 * 靠任务自带的 taskKind 在前端分流 —— 后端不用为日记再开一套接口。
 */
import { useCallback, useEffect, useMemo, useState } from "react";

/** 两类日记任务的显示名 */
const KIND_META = {
  diary_mood: {
    label: "情绪打标",
    hint: "给用户写的日记打情绪标签（不改动正文）",
    accent: "text-[#5b7fa6]",
    chip: "bg-[#eef4fa] text-[#4a6b8a]",
  },
  diary_generate: {
    label: "AI 生成日记",
    hint: "根据当天聊天记录生成一篇新日记（会标注「AI 生成」）",
    accent: "text-[#8a7aa8]",
    chip: "bg-[#f3f0f8] text-[#7a6a98]",
  },
};

const STATUS_STYLE = {
  pending: { label: "待提交", cls: "bg-amber-50 text-amber-700" },
  submitted: { label: "已提交", cls: "bg-sky-50 text-sky-700" },
  pass: { label: "已完成", cls: "bg-emerald-50 text-emerald-700" },
  reject: { label: "已丢弃", cls: "bg-rose-50 text-rose-700" },
  failed: { label: "失败", cls: "bg-rose-50 text-rose-700" },
  manual: { label: "等人工", cls: "bg-orange-50 text-orange-700" },
};

const BTN =
  "rounded-lg border border-[#e2e5e2] bg-white px-3 py-1.5 text-xs text-slate-600 transition hover:border-[#c9d2c9] hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-50";

function formatTime(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return String(value);
  }
}

function StatusChip({ status }) {
  const style = STATUS_STYLE[status] || {
    label: status || "未知",
    cls: "bg-slate-100 text-slate-500",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] ${style.cls}`}>{style.label}</span>
  );
}

/** 一类任务的统计卡（待提交 / 进行中 / 已完成 / 需处理） */
function StatCard({ kind, stats }) {
  const meta = KIND_META[kind];
  const pending = Number(stats?.pending || 0);
  const running = Number(stats?.submitted || 0);
  const done = Number(stats?.pass || 0);
  const problem = Number(stats?.failed || 0) + Number(stats?.reject || 0);

  return (
    <div className="rounded-xl border border-[#eceeec] bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className={`text-sm font-semibold ${meta.accent}`}>{meta.label}</p>
          <p className="mt-0.5 text-[11px] text-slate-400">{meta.hint}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${meta.chip}`}>
          {pending + running} 进行中
        </span>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2 text-center">
        {[
          { label: "待提交", value: pending, cls: "text-amber-600" },
          { label: "已提交", value: running, cls: "text-sky-600" },
          { label: "已完成", value: done, cls: "text-emerald-600" },
          { label: "需处理", value: problem, cls: "text-rose-600" },
        ].map((item) => (
          <div key={item.label}>
            <p className={`text-lg font-semibold ${item.cls}`}>{item.value}</p>
            <p className="text-[11px] text-slate-400">{item.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 一类任务的历史列表 */
function TaskList({ kind, tasks, onOpenDetail, detailBusy }) {
  const meta = KIND_META[kind];
  const isGenerate = kind === "diary_generate";

  return (
    <div className="rounded-xl border border-[#eceeec] bg-white p-4">
      <div className="mb-2 flex items-center gap-2">
        <p className={`text-sm font-semibold ${meta.accent}`}>{meta.label}</p>
        <span className="text-[11px] text-slate-400">
          {tasks.length ? `最近 ${tasks.length} 条` : ""}
        </span>
      </div>

      {tasks.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-xs">
            <thead>
              <tr className="text-slate-400">
                <th className="py-1.5 pr-3 font-normal">用户</th>
                <th className="py-1.5 pr-3 font-normal">{isGenerate ? "日期" : "日记"}</th>
                <th className="py-1.5 pr-3 font-normal">状态</th>
                <th className="py-1.5 pr-3 font-normal">结果 / 说明</th>
                <th className="py-1.5 pr-3 font-normal">时间</th>
                <th className="py-1.5 font-normal"> </th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id} className="border-t border-[#f2f4f2] align-top">
                  <td className="py-2 pr-3 text-slate-600">
                    {task.username || `#${task.userId}`}
                  </td>
                  <td className="py-2 pr-3 text-slate-500">
                    {isGenerate ? String(task.createdAt || "").slice(0, 10) : `#${task.targetId || "—"}`}
                  </td>
                  <td className="py-2 pr-3">
                    <StatusChip status={task.status} />
                  </td>
                  <td className="max-w-[260px] py-2 pr-3 text-slate-500">
                    <span className="line-clamp-2">{task.reason || "—"}</span>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-slate-400">
                    {formatTime(task.reviewedAt || task.submittedAt || task.createdAt)}
                  </td>
                  <td className="py-2">
                    <button
                      type="button"
                      className={BTN}
                      disabled={detailBusy === task.id}
                      onClick={() => onOpenDetail(task)}
                    >
                      {detailBusy === task.id ? "…" : "看原文"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="py-4 text-center text-xs text-slate-400">还没有{meta.label}任务</p>
      )}
    </div>
  );
}

export default function DiaryTaskPanel({ api, setError, setNotice }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [detail, setDetail] = useState(null);
  const [detailBusy, setDetailBusy] = useState(0);

  const list = useCallback(
    async (silent) => {
      if (!silent) setLoading(true);
      try {
        const result = await api("/api/admin/review");
        setData(result);
        if (result?.warn) setError(String(result.warn));
      } catch (err) {
        setError("读取日记任务失败：" + err.message);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [api, setError]
  );

  useEffect(() => {
    list();
  }, [list]);

  // 按 taskKind 分流（老数据没有这个字段，当成 review 忽略掉）
  const byKind = useMemo(() => {
    const all = Array.isArray(data?.tasks) ? data.tasks : [];
    return {
      diary_mood: all.filter((task) => task.taskKind === "diary_mood"),
      diary_generate: all.filter((task) => task.taskKind === "diary_generate"),
    };
  }, [data]);

  const statsByKind = data?.statsByKind || {};

  /** 提交 / 拉取：和「数据审核」页是同一套动作，只是这里不切换页面 */
  const runAction = useCallback(
    async (action, label) => {
      setBusy(action);
      setError("");
      setNotice("");
      try {
        const result = await api("/api/admin/review", { method: "POST", body: { action } });

        if (action === "submit") {
          setNotice(
            result?.started
              ? "已开始提交，稍候刷新查看结果（批量推理要等几分钟）"
              : result?.message || "没有待提交的日记任务"
          );
        } else if (action === "poll") {
          if (Array.isArray(result?.detail) && result.detail.length) {
            setNotice(result.detail.join(" ｜ "));
          } else {
            setNotice(result?.message || "暂无已完成的结果");
          }
        } else {
          setNotice(result?.message || `${label}完成`);
        }

        await list(true);
      } catch (err) {
        setError(`${label}失败：` + err.message);
      } finally {
        setBusy("");
      }
    },
    [api, list, setError, setNotice]
  );

  const openDetail = useCallback(
    async (task) => {
      setDetailBusy(task.id);
      setError("");
      try {
        const result = await api("/api/admin/review", {
          method: "POST",
          body: { action: "detail", taskId: task.id },
        });
        // ⚠️ 内容在 result.task.content 里 —— **不是** result.content。
        //    之前写成 result.content，取到的永远是 undefined，
        //    于是弹窗里一行"（没有内容）"，看起来像任务没存正文。
        setDetail({ task, content: result?.task?.content || "" });
      } catch (err) {
        setError("读取原文失败：" + err.message);
      } finally {
        setDetailBusy(0);
      }
    },
    [api, setError]
  );

  return (
    <div className="space-y-3">
      {/* ---- 两类任务的统计 ---- */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <StatCard kind="diary_mood" stats={statsByKind.diary_mood} />
        <StatCard kind="diary_generate" stats={statsByKind.diary_generate} />
      </div>

      {/* ---- 动作 ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={BTN}
          disabled={busy === "submit"}
          onClick={() => runAction("submit", "提交")}
        >
          {busy === "submit" ? "提交中…" : "立即提交"}
        </button>
        <button
          type="button"
          className={BTN}
          disabled={busy === "poll"}
          onClick={() => runAction("poll", "拉取结果")}
        >
          {busy === "poll" ? "拉取中…" : "拉取结果"}
        </button>
        <button type="button" className={BTN} disabled={loading} onClick={() => list()}>
          {loading ? "刷新中…" : "刷新"}
        </button>
        <span className="text-[11px] text-slate-400">
          和「数据审核」共用同一个批量队列 —— 在那边点提交也一样
        </span>
      </div>

      {/* ---- 两个列表 ---- */}
      <TaskList
        kind="diary_mood"
        tasks={byKind.diary_mood}
        onOpenDetail={openDetail}
        detailBusy={detailBusy}
      />
      <TaskList
        kind="diary_generate"
        tasks={byKind.diary_generate}
        onOpenDetail={openDetail}
        detailBusy={detailBusy}
      />

      {/* ---- 原文弹窗 ---- */}
      {detail ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-slate-700">
                {detail.task.taskKind === "diary_generate" ? "聊天记录原文" : "日记原文"}
                <span className="ml-2 text-[11px] font-normal text-slate-400">
                  {detail.task.username || `#${detail.task.userId}`}
                </span>
              </p>
              <button type="button" className={BTN} onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>
            <pre className="whitespace-pre-wrap break-words rounded-lg bg-[#f7f9f7] p-3 text-xs text-slate-600">
              {detail.content || "（没有内容）"}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
