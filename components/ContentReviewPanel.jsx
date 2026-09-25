"use client";

/**
 * 后台「数据审核」面板
 *
 * 它在整个审核闭环里的位置：
 *   用户改资料 → 立刻生效 + 打「未审核」tag → 攒在队列里
 *     → 点「立即提交」（或定时任务）交给 AI 判定
 *     → 点「拉取结果」把判定收回来：合规清标记 / 违规改回默认值
 *
 * 所以这个面板提供三个动作：
 *   ① 立即提交    把待审内容送上 AI
 *   ② 拉取结果    查批次状态、把完成的收回来并执行处置
 *   ③ 人工判定    对 AI 处理失败的那些，管理员直接点通过 / 驳回
 *
 * ⚠️ 列表接口**不返回正文**（图片是 base64，几十条就是几 MB），
 *    点某一条才单独拉详情。
 */
import { useCallback, useEffect, useState } from "react";

const STATUS_STYLE = {
  pending: { label: "待提交", cls: "bg-slate-100 text-slate-600" },
  submitted: { label: "已提交", cls: "bg-[#e8eff2] text-[#4a7a94]" },
  pass: { label: "合规", cls: "bg-emerald-50 text-emerald-600" },
  reject: { label: "违规·已处置", cls: "bg-red-50 text-red-600" },
  failed: { label: "失败·待人工", cls: "bg-amber-50 text-amber-700" },
  // 图片在批量模式下会直接标成这个状态（批量吃不下多模态消息体）
  manual: { label: "等人工", cls: "bg-violet-50 text-violet-600" },
};

const FIELD_LABEL = {
  username: "昵称",
  bio: "个性签名",
  avatar_url: "头像",
  ai_avatar_url: "AI 头像",
  chat_background_url: "聊天背景",
  diary_background_url: "我的页背景",
};

const BATCH_STATUS = {
  submitted: "进行中",
  completed: "已完成",
  failed: "失败",
};

/** 只允许真正的位图 data URL 进 img，挡掉 svg 这类可能带脚本的类型 */
function safeImageSrc(value) {
  const text = String(value || "");
  return /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(text) ? text : "";
}

/** 把 MySQL 的 DATETIME 字符串换算成"多久以前"，用来显示批次等了多久 */
function elapsedSince(value) {
  if (!value) return "-";
  const time = new Date(String(value).replace(" ", "T")).getTime();
  if (!Number.isFinite(time)) return "-";

  const ms = Date.now() - time;
  if (ms < 0) return "刚刚";

  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;

  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

/** 已等待的毫秒数（用来判断要不要标黄提醒） */
function elapsedMs(value) {
  const time = new Date(String(value || "").replace(" ", "T")).getTime();
  return Number.isFinite(time) ? Date.now() - time : 0;
}

function StatCard({ label, value, tone = "" }) {
  return (
    <div className="rounded-xl border border-[#e8eae7] bg-white px-3 py-2">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold ${tone || "text-slate-800"}`}>{value}</div>
    </div>
  );
}

export default function ContentReviewPanel({ api, setError, setNotice }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(""); // submit / poll / manual
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [filter, setFilter] = useState("all");
  // 批量接口诊断（会真的跑一遍「上传 → 创建批次」）
  const [batchTest, setBatchTest] = useState(null);
  const [batchTesting, setBatchTesting] = useState(false);

  /**
   * 诊断批量接口。
   *
   * ⚠️ 它是**真的跑一遍**，不只是探活：
   *    上传一个只有 1 条极简请求的 JSONL，然后创建一个批次 ——
   *    这样能把「地址对不对 / Key 对不对 / 参数对不对 / 内容有没有问题」分开。
   *    上游失败时只会回一句 internal_error，不真跑的话根本分不清是哪一环。
   */
  async function testBatchApi() {
    setBatchTesting(true);
    setBatchTest(null);
    setError("");
    try {
      const result = await api("/api/admin/review", {
        method: "POST",
        body: { action: "testBatch" },
      });
      setBatchTest(result);
    } catch (err) {
      setBatchTest({ ok: false, hint: err.message });
    } finally {
      setBatchTesting(false);
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api("/api/admin/review");
      setData(result);
    } catch (err) {
      setError("读取审核状态失败：" + err.message);
    } finally {
      setLoading(false);
    }
  }, [api, setError]);

  useEffect(() => {
    load();
  }, [load]);

  async function runAction(action, label) {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const result = await api("/api/admin/review", { method: "POST", body: { action } });

      if (action === "submit") {
        if (!result.ok) throw new Error(result.error || "提交失败");

        // 现在提交是「点完就返回、后台继续跑」——
        // 因为降级成逐条时可能要一条条调一两分钟 AI，等着的话界面一直转圈
        if (result.started) {
          setNotice(result.message || "已开始提交，稍后点「刷新」看结果");
        } else if (!result.taskCount) {
          setNotice("没有待审核的内容");
        } else {
          setNotice(
            `已提交 ${result.taskCount} 条（${result.provider}${
              result.batchId ? ` · 批次 ${result.batchId}` : ""
            }）${
              result.fallback ? `；批量推理不可用，已自动降级为逐条模式（${result.batchError}）` : ""
            }${result.rejectCount ? `；其中 ${result.rejectCount} 条判定违规，已改回默认值` : ""}`
          );
        }
      } else if (action === "poll") {
        setNotice(
          `检查了 ${result.checked || 0} 个批次，完成 ${result.completed || 0} 个`
        );
      } else {
        // 其它动作（扫描存量数据等）：直接用后端给的说明文案
        setNotice(result?.message || "完成");
      }

      await load();
    } catch (err) {
      setError(`${label}失败：${err.message}`);
    } finally {
      setBusy("");
    }
  }

  async function openDetail(taskId) {
    setDetailLoading(true);
    setDetail(null);
    try {
      const result = await api("/api/admin/review", {
        method: "POST",
        body: { action: "detail", taskId },
      });
      setDetail(result.task);
    } catch (err) {
      setError("读取内容失败：" + err.message);
    } finally {
      setDetailLoading(false);
    }
  }

  async function judge(taskId, approve) {
    setBusy("manual");
    setError("");
    setNotice("");
    try {
      const result = await api("/api/admin/review", {
        method: "POST",
        body: { action: "manual", taskId, approve },
      });
      if (!result.ok) throw new Error(result.error || "操作失败");
      setNotice(approve ? "已通过" : "已驳回，该字段已改回默认值");
      setDetail(null);
      await load();
    } catch (err) {
      setError("操作失败：" + err.message);
    } finally {
      setBusy("");
    }
  }

  if (loading && !data) {
    return (
      <div className="rounded-xl border border-[#e8eae7] bg-white p-4 text-sm text-slate-400">
        正在读取审核状态…
      </div>
    );
  }

  const stats = data?.stats || {};
  const config = data?.config;
  const tasks = (data?.tasks || []).filter((item) => {
    if (filter === "all") return true;
    if (filter === "todo") return item.status === "pending" || item.status === "submitted";
    // "待人工" = AI 处理失败的 + 图片在批量模式下被标成等人工的
    if (filter === "manual") return item.status === "failed" || item.status === "manual";
    return item.status === filter;
  });

  return (
    <div className="space-y-4">
      {/* 顶部：状态概览 + 两个动作按钮 */}
      <div className="rounded-xl border border-[#e8eae7] bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-800">审核运行状态</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
              {config
                ? `模式：${config.mode === "batch" ? "批量推理" : "逐条调用"} · 模型：${
                    config.model || "(未填)"
                  } · API Key：${config.apiKeyConfigured ? "已配置" : "未配置"} · 图片送审：${
                    config.reviewImages ? "开" : "关"
                  } · ${
                    config.autoSubmit
                      ? `自动提交：每 ${config.submitIntervalMinutes} 分钟`
                      : "自动提交：已关闭（要手动点「立即提交」）"
                  }`
                : "读取配置失败"}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="rounded-lg border border-[#d5d9d7] px-3 py-1.5 text-xs text-slate-600 transition-colors hover:bg-[#f2f5f4] disabled:opacity-50"
            >
              {loading ? "刷新中…" : "刷新"}
            </button>
            <button
              type="button"
              onClick={() => runAction("scan", "扫描存量数据")}
              disabled={Boolean(busy)}
              className="rounded-lg border border-[#d5d9d7] bg-[#fdfdfc] px-3 py-1.5 text-xs text-slate-700 transition-colors hover:bg-[#f2f5f4] disabled:opacity-50"
              title="把老用户已有的昵称 / 签名 / 头像 / 背景补进审核队列 —— 审核是后加的功能，这些内容之前从没进过队列，所以「待提交」一直是 0"
            >
              {busy === "scan" ? "扫描中…" : "扫描存量数据"}
            </button>
            <button
              type="button"
              onClick={testBatchApi}
              disabled={Boolean(busy) || batchTesting}
              className="rounded-lg border border-[#d5d9d7] bg-[#fdfdfc] px-3 py-1.5 text-xs text-slate-700 transition-colors hover:bg-[#f2f5f4] disabled:opacity-50"
              title="真的跑一遍「上传 → 创建批次」，把批量接口整条链路验证一次"
            >
              {batchTesting ? "测试中…" : "测试批量接口"}
            </button>
            <button
              type="button"
              onClick={() => runAction("poll", "拉取结果")}
              disabled={Boolean(busy)}
              className="rounded-lg border border-[#cfe0e8] bg-[#f2f7fa] px-3 py-1.5 text-xs text-slate-700 transition-colors hover:bg-[#e8eff2] disabled:opacity-50"
              title="查一遍已提交的批次，把判定结果收回来并执行处置"
            >
              {busy === "poll" ? "拉取中…" : "拉取结果"}
            </button>
            <button
              type="button"
              onClick={() => runAction("submit", "立即提交")}
              disabled={Boolean(busy)}
              className="rounded-lg bg-[#7a9fb5] px-3 py-1.5 text-xs text-white transition-colors hover:bg-[#6b8fa5] disabled:opacity-50"
              title="把当前所有「待提交」的内容立刻上传给审核 AI"
            >
              {busy === "submit" ? "提交中…" : "立即提交"}
            </button>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <StatCard label="待提交" value={stats.pending || 0} />
          <StatCard label="已提交（等结果）" value={stats.submitted || 0} tone="text-[#4a7a94]" />
          <StatCard label="合规" value={stats.pass || 0} tone="text-emerald-600" />
          <StatCard label="违规已处置" value={stats.reject || 0} tone="text-red-600" />
          <StatCard label="失败·待人工" value={stats.failed || 0} tone="text-amber-700" />
        </div>

        {batchTest ? (
          <div
            className={`mt-3 rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
              batchTest.ok
                ? "border-[#c8e0cc] bg-[#f2f9f3] text-slate-700"
                : "border-[#e8cccc] bg-[#fdf4f4] text-slate-700"
            }`}
          >
            <p className="font-medium text-slate-800">
              {batchTest.ok ? "✅ 批量接口整条链路都通了" : "❌ 批量接口有问题"}
            </p>
            {batchTest.hint ? <p className="mt-0.5 break-words">{batchTest.hint}</p> : null}
            {batchTest.error ? (
              <p className="mt-0.5 break-all text-slate-600">{batchTest.error}</p>
            ) : null}
            {Array.isArray(batchTest.steps) && batchTest.steps.length ? (
              <div className="mt-1.5 space-y-1 border-t border-black/5 pt-1.5">
                {batchTest.steps.map((item, index) => (
                  <p key={index} className="break-all text-slate-500">
                    {item.step}：{item.status ?? ""} {item.raw || item.error || ""}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {data?.warn ? (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-700">
            {data.warn}
          </p>
        ) : null}

        <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
          提示：批量推理是<strong>延迟返回</strong>的，提交后不会立刻有结果 —— 过几分钟点「拉取结果」，
          或者让它交给定时任务（<code className="rounded bg-[#f2f5f4] px-1">scripts/review-submit.mjs</code>）自动收。
        </p>
      </div>

      {/* 批次记录 */}
      {data?.batches?.length ? (
        <div className="rounded-xl border border-[#e8eae7] bg-white p-4">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-bold text-slate-800">最近的批次</h3>
            <p className="text-[11px] text-slate-400">
              批量推理是<strong>闲时调度</strong>：提交后由上游挑空闲时跑，等几分钟到几小时都正常。
              超过半小时还没完成的会标成<span className="text-amber-600">橙色</span>。
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-400">
                  <th className="py-1 pr-3 font-normal">批次</th>
                  <th className="py-1 pr-3 font-normal">方式</th>
                  <th className="py-1 pr-3 font-normal">状态</th>
                  <th className="py-1 pr-3 font-normal">条数</th>
                  <th className="py-1 pr-3 font-normal">结果</th>
                  <th className="py-1 pr-3 font-normal">已等待</th>
                  <th className="py-1 font-normal">提交时间</th>
                </tr>
              </thead>
              <tbody>
                {data.batches.map((batch) => {
                  const pending = batch.status === "submitted";
                  const waitedLong = pending && elapsedMs(batch.submittedAt) > 30 * 60 * 1000;
                  return (
                    <tr key={batch.id} className="border-t border-[#f2f5f4]">
                      <td className="py-1.5 pr-3 font-mono text-[11px] text-slate-500">
                        {batch.remoteId || `#${batch.id}`}
                      </td>
                      <td className="py-1.5 pr-3 text-slate-600">
                        {batch.provider === "mimo-batch" ? "批量" : "逐条"}
                      </td>
                      <td className="py-1.5 pr-3">
                        <span
                          className={
                            batch.status === "completed"
                              ? "text-emerald-600"
                              : batch.status === "failed"
                                ? "text-red-600"
                                : "text-[#4a7a94]"
                          }
                        >
                          {BATCH_STATUS[batch.status] || batch.status}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 text-slate-600">{batch.taskCount}</td>
                      <td className="py-1.5 pr-3 text-slate-500">
                        通过 {batch.passCount} · 违规 {batch.rejectCount} · 失败 {batch.failedCount}
                      </td>
                      <td className="py-1.5 pr-3">
                        <span
                          className={waitedLong ? "font-medium text-amber-600" : "text-slate-500"}
                          title={
                            pending
                              ? "上游还在调度或执行。想知道最新状态就点「拉取结果」"
                              : "批次已结束"
                          }
                        >
                          {elapsedSince(batch.submittedAt)}
                        </span>
                        {batch.expiresAt ? (
                          <span
                            className="block text-[10px] text-slate-300"
                            title="上游给的过期时间 —— 判断「最长等待时间」设置有没有生效，就看它是不是你设的那个长度"
                          >
                            至 {String(batch.expiresAt).slice(5, 16)}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-1.5 text-slate-400">{batch.submittedAt || "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.batches.some((batch) => batch.error) ? (
            <div className="mt-2 space-y-1">
              {data.batches
                .filter((batch) => batch.error)
                .slice(0, 3)
                .map((batch) => (
                  <p
                    key={batch.id}
                    className="rounded-lg bg-red-50 px-3 py-2 text-[11px] leading-relaxed break-all text-red-600"
                  >
                    批次 {batch.remoteId || `#${batch.id}`}：{batch.error}
                  </p>
                ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 任务列表 */}
      <div className="rounded-xl border border-[#e8eae7] bg-white p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-800">审核记录</h3>
          <div className="flex gap-1">
            {[
              { id: "all", label: "全部" },
              { id: "todo", label: "未完成" },
              { id: "manual", label: "待人工" },
              { id: "reject", label: "违规" },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
                  filter === tab.id
                    ? "bg-[#e8eff2] text-slate-800"
                    : "text-slate-400 hover:bg-[#f2f5f4]"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {!tasks.length ? (
          <p className="py-6 text-center text-xs text-slate-400">
            没有记录。用户修改头像、背景、昵称、签名后，这里会出现待审内容。
          </p>
        ) : (
          <div className="space-y-1.5">
            {tasks.map((task) => {
              const style = STATUS_STYLE[task.status] || {
                label: task.status,
                cls: "bg-slate-100 text-slate-600",
              };
              return (
                <div
                  key={task.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-[#f2f5f4] px-3 py-2 transition-colors hover:bg-[#fafaf8]"
                >
                  <span className="font-mono text-[11px] text-slate-400">#{task.id}</span>
                  <span className="text-xs text-slate-700">
                    {FIELD_LABEL[task.field] || task.field}
                  </span>
                  <span className={`rounded-md px-1.5 py-0.5 text-[10px] ${style.cls}`}>
                    {style.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-slate-400">
                    {task.username || task.email || `用户 #${task.userId}`}
                    {task.reason ? ` · ${task.reason}` : ""}
                  </span>

                  <button
                    type="button"
                    onClick={() => openDetail(task.id)}
                    className="rounded-md border border-[#d5d9d7] px-2 py-0.5 text-[11px] text-slate-600 transition-colors hover:bg-[#f2f5f4]"
                  >
                    查看内容
                  </button>

                  {task.status !== "pass" && task.status !== "reject" ? (
                    <>
                      <button
                        type="button"
                        disabled={busy === "manual"}
                        onClick={() => judge(task.id, true)}
                        className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50"
                      >
                        通过
                      </button>
                      <button
                        type="button"
                        disabled={busy === "manual"}
                        onClick={() => judge(task.id, false)}
                        className="rounded-md border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] text-red-600 transition-colors hover:bg-red-100 disabled:opacity-50"
                        title="会把该字段改回「默认值配置」里的值"
                      >
                        驳回
                      </button>
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 详情弹窗 */}
      {detailLoading || detail ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30 px-4">
          <div className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-800">
                {detail ? FIELD_LABEL[detail.field] || detail.field : "读取中…"}
              </h3>
              <button
                type="button"
                onClick={() => setDetail(null)}
                className="text-xs text-slate-400 hover:text-slate-600"
              >
                关闭
              </button>
            </div>

            {detail ? (
              <>
                <p className="mt-1 text-[11px] text-slate-400">
                  {detail.username || detail.email || `用户 #${detail.userId}`} ·{" "}
                  {detail.createdAt || ""}
                </p>

                <div className="mt-3 rounded-xl border border-[#e8eae7] bg-[#fdfdfc] p-3">
                  {detail.isImage ? (
                    safeImageSrc(detail.content) ? (
                      <img
                        src={safeImageSrc(detail.content)}
                        alt="待审内容"
                        className="max-h-72 w-auto max-w-full rounded-lg border border-[#e8eae7]"
                      />
                    ) : (
                      <p className="text-xs text-slate-500">
                        图片格式异常或不是位图（可能是外部链接），无法在这里预览。
                        原文开头：{String(detail.content).slice(0, 120)}
                      </p>
                    )
                  ) : (
                    <p className="break-words whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
                      {detail.content || "（空）"}
                    </p>
                  )}
                </div>

                {detail.reason ? (
                  <p className="mt-2 rounded-lg bg-[#f2f5f4] px-3 py-2 text-[11px] leading-relaxed text-slate-600">
                    判定理由：{detail.reason}
                  </p>
                ) : null}

                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    disabled={busy === "manual"}
                    onClick={() => judge(detail.id, true)}
                    className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50"
                  >
                    通过
                  </button>
                  <button
                    type="button"
                    disabled={busy === "manual"}
                    onClick={() => judge(detail.id, false)}
                    className="rounded-lg bg-red-500 px-3 py-1.5 text-xs text-white transition-colors hover:bg-red-600 disabled:opacity-50"
                    title="会把该字段改回「默认值配置」里的值"
                  >
                    驳回并改回默认值
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
