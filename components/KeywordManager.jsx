"use client";

/**
 * 统一词表管理（**嵌在后台「内容安全与压力」页里**，和自伤/伤人/违法三张表同一处）。
 *
 * ⚠️ 为什么不另开一个页面：
 *    管理员要回答的问题只有一个 ——「什么话会被拦、什么话会算成压力」。
 *    拆成两个页面，改完一边还得去另一边确认，反而容易漏。
 *
 * ⚠️ 界面上**人看到的是短语，不是正则**：
 *    自伤倾向那张表编辑的是「上下文短语对」，底层编译成正则；
 *    管理员不需要（也不应该）碰正则。
 *
 * ⚠️ **调用 `api()` 时 body 传对象，不要自己 JSON.stringify** ——
 *    外层那个 `api(path, { body })` 已经 stringify 过了，再包一层的话
 *    服务端拿到的是"字符串的字符串"，`body.action` / `body.id` 全是 undefined。
 *    （这个坑踩过一次：「测试」和「保存」都报「缺少词表 id」。）
 */
import { useCallback, useEffect, useState } from "react";

const BTN =
  "rounded-lg border border-[#e2e5e2] bg-white px-2.5 py-1 text-[11px] text-slate-500 transition hover:border-[#c9d2c9] hover:text-slate-700 disabled:opacity-40";
const BTN_DANGER =
  "rounded-lg border border-rose-200 bg-white px-2.5 py-1 text-[11px] text-rose-500 transition hover:bg-rose-50 disabled:opacity-40";
const AREA =
  "w-full rounded-lg border border-[#e2e5e2] bg-white px-3 py-2 font-mono text-[11px] leading-6 text-slate-600 outline-none focus:border-[#b9c8bd]";

/* ------------------------------------------------------------------
   文本 ⇄ 结构化内容的转换
   ⚠️ 这里刻意用"人能写、也能读懂"的格式，而不是让人直接写 JSON：
      · 短语对：`想|要|准备 → 死|自杀`
      · 完整短语 / 普通词：一行一个
      · 以 # 开头的行是注释
   ------------------------------------------------------------------ */

function contentToText(group) {
  const content = Array.isArray(group.content) ? group.content : [];

  if (group.type === "contextPairs") {
    return content
      .map((item) => {
        if (Array.isArray(item?.phrase)) return item.phrase.join("\n");
        const prefix = (item?.prefix || []).join("|");
        const suffix = (item?.suffix || []).join("|");
        return `${prefix} → ${suffix}`;
      })
      .join("\n");
  }

  return content.join("\n");
}

function textToContent(group, text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  if (group.type !== "contextPairs") return lines;

  const pairs = [];
  const phrases = [];

  for (const line of lines) {
    const match = line.match(/^(.*?)\s*(?:→|->|=)\s*(.*)$/);

    if (!match) {
      phrases.push(line);
      continue;
    }

    const prefix = match[1]
      .split("|")
      .map((item) => item.trim())
      .filter(Boolean);
    const suffix = match[2]
      .split("|")
      .map((item) => item.trim())
      .filter(Boolean);

    // ⚠️ 只有一边有词 → 当成写错了，直接抛给人看，别静默丢掉
    if (!prefix.length || !suffix.length) {
      throw new Error(`「${line}」的前缀或后缀是空的 —— 前后缀必须成对出现`);
    }
    if (suffix.some((word) => word.length < 2 && word !== "死")) {
      throw new Error(
        `「${line}」的后缀里有单个字 —— 会误伤「笑死了」这类日常表达。单个字只能放在前缀里。`
      );
    }

    pairs.push({ prefix, suffix });
  }

  if (phrases.some((word) => word.length < 2)) {
    throw new Error("完整短语至少要两个字 —— 单个字会大面积误伤，请写完整的词");
  }

  if (phrases.length) pairs.push({ phrase: phrases });
  return pairs;
}

export default function KeywordManager({ api, setError, setNotice }) {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState("");
  const [testText, setTestText] = useState("");
  const [testResult, setTestResult] = useState(null);
  const [suspected, setSuspected] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api("/api/admin/keywords");
      setGroups(data?.groups || []);
      setSuspected(Array.isArray(data?.suspected) ? data.suspected : []);
    } catch (err) {
      setError?.(err?.message || "读词表失败");
    } finally {
      setLoading(false);
    }
  }, [api, setError]);

  useEffect(() => {
    load();
  }, [load]);

  const editing = groups.find((group) => group.id === editingId) || null;

  function startEdit(group) {
    setEditingId(group.id);
    setDraft(contentToText(group));
    setError?.("");
  }

  /** 保存 —— ⚠️ body 传对象，别自己 stringify（外层 api() 会做） */
  async function save(group) {
    let content;
    try {
      content = textToContent(group, draft);
    } catch (err) {
      setError?.(err.message);
      return;
    }

    if (group.safety && !content.length) {
      setError?.(`「${group.label}」是安全词表，不能清空。如果确实要临时关闭，请用「停用」。`);
      return;
    }

    // ⚠️ 删安全词要二次确认 —— 删掉的可能是唯一拦住某类表达的那条
    if (group.safety) {
      const before = (group.content || []).length;
      const after = content.length;
      if (after < before) {
        const ok = window.confirm(
          `「${group.label}」的条目会从 ${before} 条变成 ${after} 条。\n\n` +
            "⚠️ 删除后可能导致风险消息漏判 —— 确定要删吗？"
        );
        if (!ok) return;
      }
    }

    setBusy(group.id);
    try {
      const data = await api("/api/admin/keywords", {
        method: "POST",
        body: { action: "save", id: group.id, content },
      });
      setNotice?.(`「${group.label}」已保存（${data?.count ?? content.length} 条），立即生效`);
      setEditingId("");
      await load();
    } catch (err) {
      setError?.(err?.message || "保存失败");
    } finally {
      setBusy("");
    }
  }

  async function toggle(group) {
    // ⚠️ 停用安全词表风险很高，问一句
    if (group.safety && group.enabled) {
      const ok = window.confirm(
        `确定要停用「${group.label}」吗？\n\n停用后这类风险**不再识别**（不是"降低权重"，是完全不查）。`
      );
      if (!ok) return;
    }

    setBusy(group.id);
    try {
      await api("/api/admin/keywords", {
        method: "POST",
        body: { action: "toggle", id: group.id, enabled: !group.enabled },
      });
      await load();
    } catch (err) {
      setError?.(err?.message || "操作失败");
    } finally {
      setBusy("");
    }
  }

  async function reset(group) {
    const ok = window.confirm(`把「${group.label}」恢复成内置默认内容？当前内容会被覆盖。`);
    if (!ok) return;

    setBusy(group.id);
    try {
      await api("/api/admin/keywords", {
        method: "POST",
        body: { action: "reset", id: group.id },
      });
      setNotice?.(`「${group.label}」已恢复默认`);
      setEditingId("");
      await load();
    } catch (err) {
      setError?.(err?.message || "恢复失败");
    } finally {
      setBusy("");
    }
  }

  /** 试一句 —— 改完词表最想知道的就是"这句话现在会被判成什么" */
  async function runTest() {
    if (!testText.trim()) return;
    setBusy("__test__");
    try {
      const data = await api("/api/admin/keywords", {
        method: "POST",
        body: { action: "test", text: testText },
      });
      setTestResult(data?.result || null);
    } catch (err) {
      setError?.(err?.message || "试算失败");
    } finally {
      setBusy("");
    }
  }

  const safetyGroups = groups.filter((group) => group.safety);
  const stressGroups = groups.filter((group) => !group.safety);

  /** 一张词表卡片（⚠️ 紧凑排列：标题行 + 可选展开区，不再各占一个大盒子） */
  function renderGroup(group) {
    const isEditing = group.id === editingId;

    return (
      <div
        key={group.id}
        className={`rounded-lg border p-2.5 transition ${
          isEditing ? "border-[#c9d2c9] bg-[#fbfcfb]" : "border-[#eceeec] bg-white"
        }`}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-xs text-slate-700">{group.label}</span>

          {/* ⚠️ 把 id 显出来 —— 排查问题时能直接对着接口传参看 */}
          <code className="rounded bg-[#f5f7f5] px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
            {group.id}
          </code>

          {group.weight ? (
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                group.safety ? "bg-[#fdf3f0] text-[#a97a6b]" : "bg-[#eef4f6] text-[#5b8aa6]"
              }`}
            >
              +{group.weight}
            </span>
          ) : null}

          <span className="text-[11px] text-slate-400">
            {(group.content || []).length} 条
            {group.enabled ? "" : " · 已停用"}
          </span>

          <span className="ml-auto flex items-center gap-1">
            <button type="button" className={BTN} disabled={busy === group.id} onClick={() => toggle(group)}>
              {group.enabled ? "停用" : "启用"}
            </button>
            <button
              type="button"
              className={BTN}
              disabled={busy === group.id}
              onClick={() => (isEditing ? setEditingId("") : startEdit(group))}
            >
              {isEditing ? "收起" : "编辑"}
            </button>
            {group.builtin ? (
              <button
                type="button"
                className={BTN_DANGER}
                disabled={busy === group.id}
                onClick={() => reset(group)}
                title="恢复成出厂内容（内置词表不能删除，只能改内容或停用）"
              >
                恢复默认
              </button>
            ) : null}
          </span>
        </div>

        {/* ⚠️ 平时不占地方 —— 只有展开时才把说明和警示铺出来 */}
        {isEditing ? (
          <div className="mt-2.5 space-y-2">
            {group.warning ? (
              <p className="rounded-lg bg-[#fff9f0] px-3 py-2 text-[11px] leading-5 text-[#a8865a]">
                {group.warning}
              </p>
            ) : null}

            <textarea
              className={`${AREA} h-36 resize-y`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
            />

            <p className="text-[11px] leading-5 text-slate-400">
              {group.type === "contextPairs" ? (
                <>
                  每行一条。<span className="text-slate-600">前缀1|前缀2 → 后缀1|后缀2</span>
                  {"  "}表示前后缀要在 6 个字以内同时出现才算命中；不带{" "}
                  <span className="text-slate-600">→</span> 的行按「完整短语」处理。
                  <span className="text-slate-600">#</span> 开头的行是注释。
                </>
              ) : (
                <>一行一个词。含这些词的消息会按上面的分值加分。</>
              )}
            </p>

            <div className="flex items-center gap-2">
              <button type="button" className={BTN} disabled={busy === group.id} onClick={() => save(group)}>
                {busy === group.id ? "保存中…" : "保存（立即生效）"}
              </button>
              <button type="button" className={BTN} onClick={() => setEditingId("")}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <p className="mt-1 text-[11px] leading-5 text-slate-400">{group.hint}</p>
        )}
      </div>
    );
  }

  if (loading) return <p className="text-xs text-slate-400">正在读词表…</p>;

  return (
    <div className="space-y-3">
      {/* ---- 试一句：改完词表最想确认的事 ---- */}
      <div className="rounded-xl border border-[#eceeec] bg-white p-3">
        <p className="mb-2 text-sm font-semibold text-slate-700">试一句</p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="min-w-[240px] flex-1 rounded-lg border border-[#e2e5e2] bg-white px-3 py-1.5 text-xs text-slate-600 outline-none focus:border-[#b9c8bd]"
            value={testText}
            onChange={(event) => setTestText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") runTest();
            }}
            placeholder="比如：笑死了 / 我想死 / 想死了 / 我今晚准备跳楼"
          />
          <button type="button" className={BTN} disabled={busy === "__test__"} onClick={runTest}>
            {busy === "__test__" ? "检测中…" : "检测"}
          </button>
        </div>

        {testResult ? (
          <p
            className={`mt-2 rounded-lg px-3 py-2 text-[11px] leading-5 ${
              testResult.kind === "urgent"
                ? "bg-[#fdf3f0] text-[#a97a6b]"
                : testResult.kind === "safeMode"
                  ? "bg-[#f8f5ec] text-[#8a7a4a]"
                  : "bg-[#f5f7f5] text-slate-500"
            }`}
          >
            {testResult.label}
          </p>
        ) : null}
      </div>

      {/* ---- 安全词组（红色标识，组内紧凑）---- */}
      <div className="rounded-xl border border-[#f3ded8] bg-[#fefaf9] p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-[#c98b76]" />
          <p className="text-xs font-semibold text-[#a97a6b]">安全词表</p>
          <span className="text-[11px] text-[#c0a096]">
            命中后按风险处理：紧迫危机截断，其余走安全模式（正常回复 + 安全指令 + 热线兜底）
          </span>
        </div>
        <div className="space-y-1.5">{safetyGroups.map(renderGroup)}</div>
      </div>

      {/* ---- 压力词组（蓝色标识，组内紧凑）---- */}
      <div className="rounded-xl border border-[#dbe6ee] bg-[#fafcfe] p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-[#6f9cc0]" />
          <p className="text-xs font-semibold text-[#5b8aa6]">压力词表</p>
          <span className="text-[11px] text-[#93aec4]">
            只影响压力值测算，不参与安全判定
          </span>
        </div>
        <div className="space-y-1.5">{stressGroups.map(renderGroup)}</div>
        <p className="mt-2 text-[11px] leading-5 text-slate-400">
          ⚠️ 同一个词可以同时出现在安全词表和压力词表里 —— 两张表各算各的，重叠不冲突。
          这里是词表的**唯一**编辑入口：早期那三个「自定义追加词」文本框已经撤掉，
          里面填过的词会在启动时自动并进上面的表里，不用手动搬。
        </p>
      </div>

      {/* ---- 疑似误报词 ---- */}
      <div className="rounded-xl border border-[#eceeec] bg-white p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <p className="text-xs font-semibold text-slate-600">疑似误报词</p>
          <span className="text-[11px] text-slate-400">
            命中过词表、但语义上**可能是日常用法**的片段（比如「想死」出现在「想死磕这对 cp」里）
          </span>
        </div>

        {suspected.length === 0 ? (
          <p className="text-[11px] leading-5 text-slate-400">
            还没有记录。等有用户触发疑似命中，这里会攒出数据 ——
            攒够次数就能看出「哪个词该加进例外表了」，不用靠人肉回忆。
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] text-slate-600">
              <thead>
                <tr className="text-slate-400">
                  <th className="py-1 pr-3 text-left font-normal">片段</th>
                  <th className="py-1 pr-3 text-left font-normal">次数</th>
                  <th className="py-1 pr-3 text-left font-normal">AI 判定</th>
                  <th className="py-1 text-left font-normal">最近出现的句子</th>
                </tr>
              </thead>
              <tbody>
                {suspected.map((row) => {
                  const verdict = {
                    ai_no: { label: "日常用法", tone: "bg-[#eef6f1] text-[#5a8a74]" },
                    ai_yes: { label: "确认有风险", tone: "bg-[#fdf3f0] text-[#a97a6b]" },
                    no_tag: { label: "AI 没给标记", tone: "bg-[#f8f5ec] text-[#8a7a4a]" },
                  }[row.verdict] || { label: "未判定", tone: "bg-slate-100 text-slate-400" };

                  return (
                    <tr key={row.word} className="border-t border-[#f2f4f2] align-top">
                      <td className="py-1.5 pr-3 font-mono text-slate-700">{row.word}</td>
                      <td className="py-1.5 pr-3">{row.hits}</td>
                      <td className="py-1.5 pr-3">
                        <span className={`rounded-full px-1.5 py-0.5 ${verdict.tone}`}>
                          {verdict.label}
                        </span>
                      </td>
                      <td className="py-1.5 text-slate-400">{row.samples?.[0] || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-2 text-[11px] leading-5 text-slate-400">
          ⚠️ 「AI 判定 = 日常用法」且**次数高**的词，就是该加进例外表的候选 ——
          例外表目前在代码里（<span className="font-mono">lib/lexicon-store.js</span> 的{" "}
          <span className="font-mono">DEATH_COMPOUND</span>）。
          这里只记录，**不会自动改词表** —— 自动改就意味着某天会静默漏掉一个真危机。
        </p>
      </div>
    </div>
  );
}
