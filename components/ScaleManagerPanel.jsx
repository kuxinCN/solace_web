"use client";

/**
 * 后台「量表题库」面板。
 *
 * 干什么：
 *   * 看现在有哪些量表（含内置的 PSS-10）；
 *   * **实时启用 / 停用**（停用后用户端立刻不显示，已有的测评结果不受影响）；
 *   * **粘贴 JSON 上传新量表**（支持一次多份）；
 *   * 按答案**试算**一遍，验计分规则对不对；
 *   * 删除（⚠️ 内置题库只能停用，不能删）。
 *
 * ⚠️ 为什么上传要做成一个 textarea 粘 JSON，而不是只做文件选择：
 *    调题库的时候通常是"从文档里改一行、再传一遍"，
 *    粘文本比"存文件 → 选文件"快得多。文件选择也支持（拖进来会走同一个入口）。
 */
import { useCallback, useEffect, useRef, useState } from "react";

const BTN =
  "rounded-lg border border-[#e2e5e2] bg-white px-3 py-1.5 text-xs text-slate-600 transition hover:border-[#c9d2c9] hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-50";

const BTN_PRIMARY =
  "rounded-lg border border-[#7fa3b8] bg-[#7fa3b8] px-3 py-1.5 text-xs text-white transition hover:bg-[#6c93a8] disabled:cursor-not-allowed disabled:opacity-50";

const EMPTY_JSON = `{
  "id": "my-scale",
  "name": "我的量表",
  "description": "一句话说明",
  "version": "1.0",
  "enabled": true,
  "questions": [
    {
      "id": 1,
      "text": "题目文本",
      "options": [
        { "value": 0, "label": "选项一" },
        { "value": 1, "label": "选项二" },
        { "value": 2, "label": "选项三" },
        { "value": 3, "label": "选项四" }
      ],
      "reverse": false,
      "dimension": "维度名称"
    }
  ],
  "scoring": {
    "type": "sum",
    "maxScore": 3,
    "thresholds": [
      { "min": 0, "max": 1, "level": "低" },
      { "min": 2, "max": 3, "level": "高" }
    ]
  },
  "dimensions": ["维度名称"]
}`;

export default function ScaleManagerPanel({ api, setError, setNotice }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [json, setJson] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [rejected, setRejected] = useState([]);
  const [preview, setPreview] = useState(null);
  const fileRef = useRef(null);

  const load = useCallback(
    async (silent) => {
      if (!silent) setLoading(true);
      try {
        const result = await api("/api/admin/scales");
        setData(result);
      } catch (err) {
        setError("读取题库失败：" + err.message);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [api, setError]
  );

  useEffect(() => {
    load();
  }, [load]);

  const post = useCallback(
    async (body, label) => {
      setBusy(label);
      setError("");
      setNotice("");
      try {
        const result = await api("/api/admin/scales", { method: "POST", body });
        await load(true);
        return result;
      } catch (err) {
        setError(`${label}失败：${err.message}`);
        return null;
      } finally {
        setBusy("");
      }
    },
    [api, load, setError, setNotice]
  );

  /* ---- 上传 ---- */
  const upload = useCallback(async () => {
    const text = json.trim();
    if (!text) {
      setError("先把题库 JSON 粘进来");
      return;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      // ⚠️ 前端先 parse 一次：把"你贴的 JSON 本身有语法错"和
      //    "字段不对"区分开 —— 后端的报错会更具体
      setError(`JSON 语法有问题：${err.message}`);
      return;
    }

    setRejected([]);
    const result = await post({ action: "upload", scale: parsed, overwrite }, "上传");

    if (result) {
      setRejected(result.rejected || []);
      if (result.accepted?.length) {
        setNotice(result.message || "已入库");
        if (!overwrite) setJson("");
      } else {
        setError(result.message || "没有入库任何题库");
      }
    }
  }, [json, overwrite, post, setError, setNotice]);

  const scales = data?.scales || [];

  return (
    <div className="space-y-3">
      {/* ---- 现有题库 ---- */}
      <div className="rounded-xl border border-[#eceeec] bg-white p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-slate-700">
            现有量表
            <span className="ml-2 text-[11px] font-normal text-slate-400">
              共 {scales.length} 份 · 启用的会在用户端「更多量表」里出现
            </span>
          </p>
          <button type="button" className={BTN} disabled={loading} onClick={() => load()}>
            {loading ? "读取中…" : "刷新"}
          </button>
        </div>

        {scales.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead>
                <tr className="text-slate-400">
                  <th className="py-1.5 pr-3 font-normal">名称</th>
                  <th className="py-1.5 pr-3 font-normal">id</th>
                  <th className="py-1.5 pr-3 font-normal">题数</th>
                  <th className="py-1.5 pr-3 font-normal">状态</th>
                  <th className="py-1.5 font-normal">操作</th>
                </tr>
              </thead>
              <tbody>
                {scales.map((scale) => (
                  <tr key={scale.id} className="border-t border-[#f2f4f2] align-top">
                    <td className="py-2 pr-3 text-slate-700">
                      {scale.name}
                      {scale.builtin ? (
                        <span className="ml-1.5 rounded-full bg-[#eef4f6] px-1.5 py-0.5 text-[10px] text-[#5b8aa6]">
                          内置
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 font-mono text-[11px] text-slate-400">{scale.id}</td>
                    <td className="py-2 pr-3 text-slate-500">{scale.questions?.length || 0}</td>
                    <td className="py-2 pr-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] ${
                          scale.enabled
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {scale.enabled ? "已启用" : "已停用"}
                      </span>
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          className={BTN}
                          disabled={busy === "toggle-" + scale.id}
                          onClick={() =>
                            post(
                              { action: "toggle", id: scale.id, enabled: !scale.enabled },
                              "切换"
                            )
                          }
                        >
                          {scale.enabled ? "停用" : "启用"}
                        </button>
                        <button
                          type="button"
                          className={BTN}
                          disabled={busy === "preview-" + scale.id}
                          onClick={async () => {
                            const result = await post(
                              { action: "preview", id: scale.id },
                              "试算"
                            );
                            if (result) setPreview({ id: scale.id, ...result });
                          }}
                          title="每题都选第一个选项，算一遍看结果"
                        >
                          试算
                        </button>
                        {!scale.builtin ? (
                          <button
                            type="button"
                            className={BTN}
                            disabled={busy === "delete-" + scale.id}
                            onClick={() => {
                              if (
                                !window.confirm(
                                  `删除量表「${scale.name}」？\n\n已有的测评结果不会受影响（它们是快照）。`
                                )
                              )
                                return;
                              post({ action: "delete", id: scale.id }, "删除");
                            }}
                          >
                            删除
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="py-4 text-center text-xs text-slate-400">
            {loading ? "读取中…" : "还没有题库"}
          </p>
        )}

        {preview ? (
          <div className="mt-3 rounded-lg bg-[#f7f9f7] p-3 text-[11px] text-slate-600">
            <p className="mb-1 font-medium text-slate-700">试算结果（{preview.id}）</p>
            <p>
              总分 <span className="font-semibold">{preview.result?.total}</span> /{" "}
              {preview.result?.maxScore}
              ，等级 <span className="font-semibold">{preview.result?.level || "（没匹配上）"}</span>
              <span className="ml-2 text-slate-400">
                已答 {preview.answered} / {preview.total} 题
              </span>
            </p>
            {preview.result?.dimensions && Object.keys(preview.result.dimensions).length ? (
              <p className="mt-1 text-slate-500">
                {Object.entries(preview.result.dimensions)
                  .map(([name, value]) => `${name} ${value.score}/${value.maxScore}`)
                  .join(" ｜ ")}
              </p>
            ) : null}
            <button
              type="button"
              className="mt-2 text-slate-400 hover:text-slate-600"
              onClick={() => setPreview(null)}
            >
              收起
            </button>
          </div>
        ) : null}
      </div>

      {/* ---- 上传 ---- */}
      <div className="rounded-xl border border-[#eceeec] bg-white p-4">
        <p className="mb-1 text-sm font-semibold text-slate-700">上传新量表</p>
        <p className="mb-3 text-[11px] leading-5 text-slate-400">
          粘贴 JSON（也可以选文件）。格式要求：{data?.formatHint || "加载中…"}
        </p>

        <textarea
          value={json}
          onChange={(e) => setJson(e.target.value)}
          rows={10}
          spellCheck={false}
          placeholder={EMPTY_JSON}
          className="w-full rounded-lg border border-[#d5d9d7] bg-[#fdfdfc] p-3 font-mono text-[11px] leading-5 text-slate-700 placeholder:text-slate-300 focus:border-[#8fb3c7] focus:outline-none focus:ring-1 focus:ring-[#8fb3c7]"
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={busy === "上传" || !json.trim()}
            onClick={upload}
          >
            {busy === "上传" ? "上传中…" : "上传"}
          </button>

          <button type="button" className={BTN} onClick={() => fileRef.current?.click()}>
            选文件…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              try {
                setJson(await file.text());
                setNotice(`已读入 ${file.name}，检查一下再点上传`);
              } catch (err) {
                setError("读文件失败：" + err.message);
              }
            }}
          />

          <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              className="h-3.5 w-3.5 accent-[#7fa3b8]"
            />
            允许覆盖同 id 的题库
          </label>

          {json.trim() ? (
            <button type="button" className={BTN} onClick={() => setJson("")}>
              清空
            </button>
          ) : null}
        </div>

        {rejected.length ? (
          <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-[11px] leading-5 text-rose-700">
            <p className="mb-1 font-medium">这些没入库：</p>
            {rejected.map((item, index) => (
              <p key={index}>
                · <span className="font-mono">{item.id}</span> —— {item.error}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
