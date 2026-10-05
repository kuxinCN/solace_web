"use client";

/**
 * 后台「表情包」面板。
 *
 * 干什么：
 *   * **分类（= 情绪）**：增删改、启停、关键词词表、优先级、深夜放宽、是否纳入 AI 判定、
 *     是否"可主动发图"。引擎现在读的就是这些字段（`lib/sticker-engine.js` 改为注入 spec）。
 *   * **素材**：按分类展开，上传新图 / 启停单张 / 删除（连带删磁盘文件）/「重新扫描」目录。
 *
 * ⚠️ 页面顶部的「表情包总开关」不在这里，走上面的配置表单（`FIELDS.sticker`，
 *    即 `PUT /api/admin/settings` 的 sticker 分组）。这里只管"分类与素材"。
 *
 * ⚠️ 两个名字（情绪键 / 素材目录名）建好之后不许改，面板里显示成只读：
 *    目录名就是 `[sticker:xxx]` 标记名，**已经写进历史消息**了，改名会让旧消息里的
 *    贴纸指向一个不存在的目录（用户看到的是一个空白位置）。
 *
 * ⚠️ 词表遵循"少而准"：宁可漏判（走 AI 兜底）也不要把闲聊误判成情绪 ——
 *    多则误发、少则漏判。一句话同时命中两个分类时，最终发哪张由优先级决定，
 *    所以这里对**重复关键词**做提示（不拦，只是让管理员看得见）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import ConfirmModal from "@/components/ConfirmModal";

const BTN =
  "rounded-lg border border-[#e2e5e2] bg-white px-3 py-1.5 text-xs text-slate-600 transition hover:border-[#c9d2c9] hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-50";

const BTN_PRIMARY =
  "rounded-lg border border-[#7fa3b8] bg-[#7fa3b8] px-3 py-1.5 text-xs text-white transition hover:bg-[#6c93a8] disabled:cursor-not-allowed disabled:opacity-50";

const BTN_DANGER =
  "rounded-lg border border-[#e8cccc] bg-white px-3 py-1.5 text-xs text-[#a86060] transition hover:bg-[#fdf4f4] disabled:cursor-not-allowed disabled:opacity-50";

const INPUT =
  "w-full rounded-lg border border-[#e2e5e2] px-3 py-1.5 text-sm text-slate-700 outline-none transition focus:border-[#7fa3b8]";

const CHECK = "h-4 w-4 accent-[#7fa3b8]";

export default function StickerPanel({ api, setError, setNotice, onSaved }) {
  const [categories, setCategories] = useState([]);
  const [limits, setLimits] = useState({ categories: 12, keywords: 200 });
  const [disk, setDisk] = useState({});

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [confirmBox, setConfirmBox] = useState(null);
  const [conflicts, setConflicts] = useState([]);

  // 展开的分类（同一时间只展开一个，避免面板太长）+ 该分类的素材
  const [openId, setOpenId] = useState(0);
  const [stickers, setStickers] = useState([]);
  const [stickersLoading, setStickersLoading] = useState(false);
  const [keywordDrafts, setKeywordDrafts] = useState({});
  const [labelDrafts, setLabelDrafts] = useState({});

  const [showAddCategory, setShowAddCategory] = useState(false);
  const [newCategory, setNewCategory] = useState({
    catKey: "",
    stickerKey: "",
    label: "",
    keywords: "",
    priority: 100,
    lateNight: false,
    aiDetect: true,
    triggerable: true,
  });

  const uploadRefs = useRef({});

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const list = await api("/api/admin/stickers/categories");
        setCategories(Array.isArray(list?.categories) ? list.categories : []);
        setLimits({
          categories: Number(list?.limit) || 12,
          keywords: Number(list?.keywordLimit) || 200,
        });
      } catch (err) {
        setError?.(err?.message || "读取表情包分类失败");
      } finally {
        setLoading(false);
      }
    },
    [api, setError]
  );

  /** 统一的"做一件事"包装：忙标记 + 出错弹红条 + 成功弹绿条 + 重新拉列表 */
  const run = useCallback(
    async (label, fn, okMessage) => {
      setBusy(label);
      try {
        const result = await fn();
        if (okMessage) setNotice?.(okMessage);
        await load(true);
        return result;
      } catch (err) {
        setError?.(err?.message || "操作失败");
        return null;
      } finally {
        setBusy("");
      }
    },
    [load, setError, setNotice]
  );

  useEffect(() => {
    load();
  }, [load]);

  /** 展开某个分类时按需拉它的素材（一次最多 500 条，够用） */
  const loadStickers = useCallback(
    async (stickerKey) => {
      setStickersLoading(true);
      try {
        const data = await api(`/api/admin/stickers?category=${encodeURIComponent(stickerKey)}`);
        setStickers(Array.isArray(data?.stickers) ? data.stickers : []);
        setDisk(data?.disk || {});
      } catch (err) {
        setError?.(err?.message || "读取素材失败");
        setStickers([]);
      } finally {
        setStickersLoading(false);
      }
    },
    [api, setError]
  );

  function toggleOpen(row) {
    const nextId = openId === row.id ? 0 : row.id;
    setOpenId(nextId);
    setConflicts([]);
    if (nextId) loadStickers(row.sticker_key);
  }

  /* ------------------------------------------------------------ 分类操作 */

  async function saveCategory(row) {
    const result = await run(
      `save-cat-${row.id}`,
      () =>
        api("/api/admin/stickers/categories", {
          method: "PATCH",
          body: {
            id: row.id,
            label: labelDrafts[row.id] !== undefined ? labelDrafts[row.id] : row.label,
            keywords: keywordDrafts[row.id] !== undefined ? keywordDrafts[row.id] : row.keywords,
            priority: row.priority,
            lateNight: Number(row.late_night) === 1,
            aiDetect: Number(row.ai_detect) === 1,
            triggerable: Number(row.triggerable) === 1,
            enabled: Number(row.enabled) === 1,
            sortOrder: row.sort_order,
          },
        }),
      "分类已保存，用户端刷新即生效"
    );
    setConflicts(Array.isArray(result?.conflicts) ? result.conflicts : []);
    if (result) {
      setLabelDrafts((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
    }
    onSaved?.();
  }

  async function patchCategory(row, patch, okMessage) {
    await run(`patch-cat-${row.id}-${Object.keys(patch).join()}`, () =>
      api("/api/admin/stickers/categories", {
        method: "PATCH",
        body: {
          id: row.id,
          // ⚠️ 优先用草稿：管理员可能刚改完名称/关键词还没点保存，就顺手点了某个勾选框 ——
          //    这时候发 row 上的旧值会把他的编辑悄悄覆盖掉
          label: labelDrafts[row.id] !== undefined ? labelDrafts[row.id] : row.label,
          keywords: keywordDrafts[row.id] !== undefined ? keywordDrafts[row.id] : row.keywords,
          priority: row.priority,
          lateNight: Number(row.late_night) === 1,
          aiDetect: Number(row.ai_detect) === 1,
          triggerable: Number(row.triggerable) === 1,
          sortOrder: row.sort_order,
          ...patch,
        },
      }),
      okMessage
    );
    onSaved?.();
  }

  async function addCategory() {
    const payload = {
      catKey: newCategory.catKey.trim().toLowerCase(),
      stickerKey: (newCategory.stickerKey || newCategory.catKey).trim().toLowerCase(),
      label: newCategory.label.trim(),
      keywords: newCategory.keywords,
      priority: Number(newCategory.priority) || 100,
      lateNight: newCategory.lateNight,
      aiDetect: newCategory.aiDetect,
      triggerable: newCategory.triggerable,
    };
    if (!payload.catKey || !payload.label) {
      setError?.("情绪键和分类名称都要填");
      return;
    }

    const result = await run("add-cat", () =>
      api("/api/admin/stickers/categories", { method: "POST", body: payload })
    );
    if (result) {
      setNotice?.(
        result.dirCreated
          ? "分类已新增，素材目录也建好了，可以直接传图"
          : "分类已新增（素材目录会在上传时自动创建）"
      );
      setConflicts(Array.isArray(result.conflicts) ? result.conflicts : []);
      setNewCategory({
        catKey: "",
        stickerKey: "",
        label: "",
        keywords: "",
        priority: 100,
        lateNight: false,
        aiDetect: true,
        triggerable: true,
      });
      setShowAddCategory(false);
      onSaved?.();
    }
  }

  function removeCategory(row) {
    setConfirmBox({
      message: `删除分类「${row.label}」？\n（分类下还有素材时会被拦下 —— 素材在 public/stickers/${row.sticker_key}/）`,
      confirmText: "删除",
      onConfirm: async () => {
        setConfirmBox(null);
        await run(`del-cat-${row.id}`, () =>
          api(`/api/admin/stickers/categories?id=${row.id}`, { method: "DELETE" })
        );
        setNotice?.("分类已删除");
        onSaved?.();
      },
    });
  }

  /* ------------------------------------------------------------ 素材操作 */

  async function uploadSticker(stickerKey, file) {
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    form.append("category", stickerKey);

    setBusy(`upload-${stickerKey}`);
    try {
      // ⚠️ 上传走原生 fetch：`api()` 会带上 JSON 的 Content-Type，multipart 必须让浏览器自己定边界
      const res = await fetch("/api/admin/stickers/upload", { method: "POST", body: form });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error || `上传失败（${res.status}）`);
      setNotice?.(data.renamed ? `已上传（重名，存为 ${data.filename}）` : "素材已上传");
      await loadStickers(stickerKey);
      await load(true);
      onSaved?.();
    } catch (err) {
      setError?.(err?.message || "上传失败");
    } finally {
      setBusy("");
      const input = uploadRefs.current[stickerKey];
      if (input) input.value = "";
    }
  }

  async function scanCategory(row) {
    const result = await run(`scan-${row.id}`, () =>
      api("/api/admin/stickers/scan", { method: "POST", body: { category: row.sticker_key } })
    );
    if (result) {
      setNotice?.(
        result.added
          ? `扫描到 ${result.scanned} 张，新登记 ${result.added} 张`
          : `扫描到 ${result.scanned} 张，没有新的素材`
      );
      await loadStickers(row.sticker_key);
      await load(true);
    }
  }

  async function patchSticker(stickerKey, id, patch, okMessage) {
    await run(`patch-sticker-${id}`, () =>
      api("/api/admin/stickers", { method: "PATCH", body: { id, ...patch } })
    , okMessage);
    await loadStickers(stickerKey);
    await load(true);
    onSaved?.();
  }

  function removeSticker(stickerKey, item) {
    setConfirmBox({
      message: `删除这张素材？\n${item.filename}\n（磁盘文件会一起删掉，历史消息里已发出的这张图会变成空白）`,
      confirmText: "删除",
      onConfirm: async () => {
        setConfirmBox(null);
        await run(`del-sticker-${item.id}`, () =>
          api(`/api/admin/stickers?id=${item.id}`, { method: "DELETE" })
        );
        setNotice?.("素材已删除");
        await loadStickers(stickerKey);
        await load(true);
      },
    });
  }

  /* ------------------------------------------------------------ 渲染 */

  return (
    <div className="mt-6 rounded-2xl border border-[#e6e9e6] bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-slate-700">表情包分类与素材</h3>
          <p className="mt-1 text-xs leading-5 text-slate-400">
            分类即情绪：关键词命中的那一类会参与&quot;第 2 句 40%、第 3 句 100% 保底&quot;的触发。
            「只判定不触发」的分类（daily）永不主动发图。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className={BTN} onClick={() => load()} disabled={loading}>
            {loading ? "读取中…" : "刷新"}
          </button>
          <button
            className={BTN_PRIMARY}
            onClick={() => setShowAddCategory((v) => !v)}
            disabled={busy !== "" || categories.length >= limits.categories}
          >
            {showAddCategory ? "取消" : "新增分类"}
          </button>
        </div>
      </div>

      <p className="mt-2 text-xs text-slate-400">
        已有 {categories.length} / {limits.categories} 个分类。素材目录：
        public/stickers/&lt;目录名&gt;/
      </p>

      {conflicts.length > 0 && (
        <div className="mt-3 rounded-xl border border-[#f0e0c8] bg-[#fdfaf4] p-3 text-xs leading-5 text-[#8a7040]">
          ⚠️ 有 {conflicts.length} 个关键词和别的分类重复，同时命中时按优先级决定发哪张：
          {conflicts.slice(0, 6).map((c) => (
            <span key={`${c.word}-${c.with}`} className="mr-2 inline-block">
              「{c.word}」也在 {c.label}
            </span>
          ))}
        </div>
      )}

      {showAddCategory && (
        <div className="mt-4 rounded-xl border border-[#e6e9e6] bg-[#fafbfa] p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs text-slate-500">情绪键（程序内用，英文，建好不可改）</span>
              <input
                className={`${INPUT} mt-1`}
                value={newCategory.catKey}
                placeholder="例如 anxious"
                onChange={(e) => setNewCategory((p) => ({ ...p, catKey: e.target.value }))}
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">素材目录名（= [sticker:xxx] 标记名，留空则同情绪键）</span>
              <input
                className={`${INPUT} mt-1`}
                value={newCategory.stickerKey}
                placeholder="留空 = 同上"
                onChange={(e) => setNewCategory((p) => ({ ...p, stickerKey: e.target.value }))}
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">分类名称（会出现在 AI 兜底提示词里）</span>
              <input
                className={`${INPUT} mt-1`}
                value={newCategory.label}
                placeholder="例如 焦虑"
                onChange={(e) => setNewCategory((p) => ({ ...p, label: e.target.value }))}
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">优先级（数字小的先发；建议 10 的倍数）</span>
              <input
                className={`${INPUT} mt-1`}
                type="number"
                value={newCategory.priority}
                onChange={(e) => setNewCategory((p) => ({ ...p, priority: e.target.value }))}
              />
            </label>
          </div>
          <label className="mt-3 block">
            <span className="text-xs text-slate-500">关键词（一行一个；&quot;少而准&quot;——宁可漏判也别把闲聊误判成情绪）</span>
            <textarea
              className={`${INPUT} mt-1 h-24 font-mono text-xs`}
              value={newCategory.keywords}
              onChange={(e) => setNewCategory((p) => ({ ...p, keywords: e.target.value }))}
            />
          </label>
          <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-slate-600">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                className={CHECK}
                checked={newCategory.triggerable}
                onChange={(e) => setNewCategory((p) => ({ ...p, triggerable: e.target.checked }))}
              />
              可以主动发图
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                className={CHECK}
                checked={newCategory.aiDetect}
                onChange={(e) => setNewCategory((p) => ({ ...p, aiDetect: e.target.checked }))}
              />
              关键词判不出时交给 AI 判
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                className={CHECK}
                checked={newCategory.lateNight}
                onChange={(e) => setNewCategory((p) => ({ ...p, lateNight: e.target.checked }))}
              />
              深夜（23:00-06:00）放宽为第 1 句就能发
            </label>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button className={BTN_PRIMARY} onClick={addCategory} disabled={busy !== ""}>
              {busy === "add-cat" ? "新增中…" : "确认新增"}
            </button>
            <span className="text-xs text-slate-400">
              新增后目录会自动建好，接着就能传图。
            </span>
          </div>
        </div>
      )}

      <div className="mt-4 space-y-3">
        {categories.length === 0 && !loading && (
          <p className="rounded-xl border border-dashed border-[#e2e5e2] p-4 text-center text-xs text-slate-400">
            还没有分类。点右上角「新增分类」建第一个（内置四个分类会在首次部署时自动播种）。
          </p>
        )}

        {categories.map((row) => {
          const total = Number(row.stickerCount?.total || 0);
          const enabledCount = Number(row.stickerCount?.enabled || 0);
          const open = openId === row.id;
          const isTriggerable = Number(row.triggerable) === 1;

          return (
            <div key={row.id} className="rounded-xl border border-[#e6e9e6] bg-white">
              <div className="flex flex-wrap items-center gap-3 p-3">
                <button
                  className="flex-1 text-left"
                  onClick={() => toggleOpen(row)}
                  type="button"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-slate-700">{row.label}</span>
                    <span className="rounded bg-[#f2f5f2] px-1.5 py-0.5 font-mono text-[11px] text-slate-500">
                      {row.cat_key} → {row.sticker_key}
                    </span>
                    {!isTriggerable && (
                      <span className="rounded bg-[#f6f2e8] px-1.5 py-0.5 text-[11px] text-[#8a7040]">
                        只判定不触发
                      </span>
                    )}
                    {Number(row.late_night) === 1 && (
                      <span className="rounded bg-[#eef3f8] px-1.5 py-0.5 text-[11px] text-[#5b7d94]">
                        深夜放宽
                      </span>
                    )}
                    {Number(row.late_night) !== 1 && Number(row.ai_detect) !== 1 && (
                      <span className="rounded bg-[#f2f5f2] px-1.5 py-0.5 text-[11px] text-slate-500">
                        不交给 AI
                      </span>
                    )}
                    <span className="text-[11px] text-slate-400">
                      优先级 {row.priority} ｜ 素材 {enabledCount}/{total}
                      {total === 0 ? "（没有素材 = 不会发图）" : ""}
                    </span>
                  </div>
                </button>
                <span className={`text-xs ${Number(row.enabled) === 1 ? "text-[#6c93a8]" : "text-slate-400"}`}>
                  {Number(row.enabled) === 1 ? "启用中" : "已停用"}
                </span>
                <button
                  className={BTN}
                  disabled={busy !== ""}
                  onClick={() =>
                    patchCategory(
                      row,
                      { enabled: Number(row.enabled) !== 1 },
                      Number(row.enabled) === 1 ? `「${row.label}」已停用` : `「${row.label}」已启用`
                    )
                  }
                >
                  {Number(row.enabled) === 1 ? "停用" : "启用"}
                </button>
                <button className={BTN_DANGER} disabled={busy !== ""} onClick={() => removeCategory(row)}>
                  删除
                </button>
              </div>

              {open && (
                <div className="border-t border-[#eef0ee] p-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="text-xs text-slate-500">分类名称</span>
                      <input
                        className={`${INPUT} mt-1`}
                        value={labelDrafts[row.id] !== undefined ? labelDrafts[row.id] : row.label}
                        onChange={(e) => setLabelDrafts((p) => ({ ...p, [row.id]: e.target.value }))}
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs text-slate-500">优先级（数字小的先发）</span>
                      <input
                        className={`${INPUT} mt-1`}
                        type="number"
                        value={row.priority}
                        onChange={(e) =>
                          setCategories((prev) =>
                            prev.map((c) => (c.id === row.id ? { ...c, priority: e.target.value } : c))
                          )
                        }
                      />
                    </label>
                  </div>

                  <label className="mt-3 block">
                    <span className="text-xs text-slate-500">
                      关键词（一行一个，逗号/顿号也能分隔；当前{" "}
                      {String(keywordDrafts[row.id] ?? row.keywords ?? "")
                        .split(/[\n,，、]+/)
                        .map((w) => w.trim())
                        .filter(Boolean).length}{" "}
                      个）
                    </span>
                    <textarea
                      className={`${INPUT} mt-1 h-32 font-mono text-xs`}
                      value={keywordDrafts[row.id] !== undefined ? keywordDrafts[row.id] : row.keywords}
                      onChange={(e) => setKeywordDrafts((p) => ({ ...p, [row.id]: e.target.value }))}
                    />
                  </label>

                  <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-slate-600">
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        className={CHECK}
                        checked={isTriggerable}
                        onChange={(e) => patchCategory(row, { triggerable: e.target.checked })}
                      />
                      可以主动发图
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        className={CHECK}
                        checked={Number(row.ai_detect) === 1}
                        onChange={(e) => patchCategory(row, { aiDetect: e.target.checked })}
                      />
                      关键词判不出时交给 AI 判
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        className={CHECK}
                        checked={Number(row.late_night) === 1}
                        onChange={(e) => patchCategory(row, { lateNight: e.target.checked })}
                      />
                      深夜放宽
                    </label>
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    <button className={BTN_PRIMARY} disabled={busy !== ""} onClick={() => saveCategory(row)}>
                      {busy === `save-cat-${row.id}` ? "保存中…" : "保存名称与关键词"}
                    </button>
                    <span className="text-xs text-slate-400">改完用户端刷新即生效，不用重启。</span>
                  </div>

                  {/* ---------------- 素材 ---------------- */}
                  <div className="mt-5 border-t border-[#eef0ee] pt-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs text-slate-500">
                        素材 {enabledCount}/{total}
                        {disk[row.sticker_key]?.count ? ` ｜ 目录里 ${disk[row.sticker_key].count} 个文件` : ""}
                      </span>
                      <div className="flex items-center gap-2">
                        <input
                          ref={(el) => {
                            uploadRefs.current[row.sticker_key] = el;
                          }}
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          className="hidden"
                          onChange={(e) => uploadSticker(row.sticker_key, e.target.files?.[0])}
                        />
                        <button
                          className={BTN}
                          disabled={busy !== ""}
                          onClick={() => uploadRefs.current[row.sticker_key]?.click()}
                        >
                          {busy === `upload-${row.sticker_key}` ? "上传中…" : "上传图片"}
                        </button>
                        <button className={BTN} disabled={busy !== ""} onClick={() => scanCategory(row)}>
                          {busy === `scan-${row.id}` ? "扫描中…" : "重新扫描目录"}
                        </button>
                      </div>
                    </div>

                    <p className="mt-1 text-[11px] leading-5 text-slate-400">
                      上传：≤2MB，png / jpg / webp / gif（会校验真实文件头）。同名不覆盖，自动加时间戳。
                      「重新扫描」用于按老流程手工丢进 public/stickers/{row.sticker_key}/ 的图。
                    </p>

                    {stickersLoading && <p className="mt-3 text-xs text-slate-400">读取素材中…</p>}

                    {!stickersLoading && stickers.length === 0 && (
                      <p className="mt-3 rounded-lg border border-dashed border-[#e2e2e2] p-3 text-center text-xs text-slate-400">
                        这个分类还没有素材 —— 引擎不会发空标记，补上素材才会开始发图。
                      </p>
                    )}

                    <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {stickers.map((item) => (
                        <div key={item.id} className="rounded-lg border border-[#e6e9e6] p-2">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={encodeURI(item.url)}
                            alt={item.filename}
                            className={`h-24 w-full rounded object-cover ${Number(item.enabled) === 1 ? "" : "opacity-40"}`}
                          />
                          <p className="mt-1 truncate text-[11px] text-slate-500" title={item.filename}>
                            {item.filename}
                          </p>
                          <div className="mt-1 flex items-center justify-between gap-1">
                            <button
                              className="text-[11px] text-[#6c93a8] hover:underline disabled:opacity-50"
                              disabled={busy !== ""}
                              onClick={() =>
                                patchSticker(
                                  row.sticker_key,
                                  item.id,
                                  { enabled: Number(item.enabled) !== 1 },
                                  Number(item.enabled) === 1 ? "这张已停用" : "这张已启用"
                                )
                              }
                            >
                              {Number(item.enabled) === 1 ? "停用" : "启用"}
                            </button>
                            <button
                              className="text-[11px] text-[#a86060] hover:underline disabled:opacity-50"
                              disabled={busy !== ""}
                              onClick={() => removeSticker(row.sticker_key, item)}
                            >
                              删除
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <ConfirmModal
        open={!!confirmBox}
        message={confirmBox?.message || ""}
        confirmText={confirmBox?.confirmText || "确定"}
        onConfirm={confirmBox?.onConfirm}
        onClose={() => setConfirmBox(null)}
      />
    </div>
  );
}
