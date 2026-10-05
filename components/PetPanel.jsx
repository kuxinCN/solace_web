"use client";

/**
 * 后台「桌宠」面板。
 *
 * 干什么：
 *   * **形象库**：上传 / 外链新增 / 改名 / 启停 / **设为当前** / 删除（删当前那张会自动回退内置默认图）；
 *   * **情绪选项**：用户点开蝴蝶后看到的那排按钮 —— 增删改、启停、动画选择、是否低垂；
 *   * **回复话术**：每条情绪下挂多句，随机挑一句说出来（展开某条情绪就能增删改）。
 *
 * ⚠️ 页面顶部的「桌宠开关 / 显示边长 / 话术去重时间」不在这里，走上面的配置表单
 *    （`app/admin/page.js` 的 `FIELDS.pet`，即 `PUT /api/admin/settings` 的 pet 分组）。
 *    这里只管"内容列表"。
 *
 * ⚠️ 话术是**陪伴**，不是索取。写"你怎么才来""等你好久了"这类话会让用户有负担，
 *    对照表见 `docs/PET-DESIGN.md` §二。面板只做提示，不做硬校验 ——
 *    文案是运营的东西，工具不该替人拍板。
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

const ANIMS = [
  { value: "droop", label: "下垂慢扇（不开心）" },
  { value: "descend", label: "半闭翅下沉（好累）" },
  { value: "shake", label: "快速抖翅（心烦）" },
  { value: "spin", label: "原地转一圈（说不清）" },
  { value: "goto", label: "不做动画，直接去聊天（找人说话）" },
];

const ANIM_LABEL = Object.fromEntries(ANIMS.map((a) => [a.value, a.label.split("（")[0]]));

export default function PetPanel({ api, setError, setNotice, onSaved }) {
  const [images, setImages] = useState([]);
  const [activeImageId, setActiveImageId] = useState(0);
  const [disk, setDisk] = useState(null);
  const [moods, setMoods] = useState([]);
  const [limits, setLimits] = useState({ moods: 12, linesPerMood: 20 });

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [confirmBox, setConfirmBox] = useState(null);

  // 上传 / 外链新增
  const [uploadName, setUploadName] = useState("");
  const [linkName, setLinkName] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const fileRef = useRef(null);

  // 展开的情绪（同一时间只展开一条，避免面板太长）
  const [openMoodId, setOpenMoodId] = useState(0);
  const [lineDrafts, setLineDrafts] = useState({});
  const [nameDrafts, setNameDrafts] = useState({});
  const [showAddMood, setShowAddMood] = useState(false);
  const [newMood, setNewMood] = useState({
    key: "",
    label: "",
    anim: "droop",
    stay: 3000,
    droop: true,
  });

  const load = useCallback(
    async (silent) => {
      if (!silent) setLoading(true);
      try {
        const [imageData, moodData] = await Promise.all([
          api("/api/admin/pet/images"),
          api("/api/admin/pet/moods"),
        ]);
        setImages(Array.isArray(imageData?.images) ? imageData.images : []);
        setActiveImageId(Number(imageData?.activeImageId) || 0);
        setDisk(imageData?.disk || null);
        setMoods(Array.isArray(moodData?.moods) ? moodData.moods : []);
        if (moodData?.limits) setLimits(moodData.limits);
        if (imageData?.note || moodData?.note) {
          setError("桌子数据读取有异常：" + (imageData?.note || moodData?.note));
        }
      } catch (err) {
        setError("读取桌宠配置失败：" + err.message);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [api, setError]
  );

  useEffect(() => {
    load();
  }, [load]);

  /** 统一的请求包装：忙碌态 + 错误提示 + 重新拉取 */
  const run = useCallback(
    async (label, fn, okMessage) => {
      setBusy(label);
      setError("");
      setNotice("");
      try {
        const result = await fn();
        await load(true);
        if (okMessage) setNotice(okMessage);
        return result;
      } catch (err) {
        setError(err.message);
        return null;
      } finally {
        setBusy("");
      }
    },
    [load, setError, setNotice]
  );

  /* ---------------- 形象库 ---------------- */

  async function handleUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    fd.append("name", uploadName || file.name.replace(/\.[^.]+$/, ""));

    setBusy("upload");
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/admin/pet/images/upload", { method: "POST", body: fd });
      const result = await res.json().catch(() => null);
      if (!res.ok) throw new Error(result?.error || `上传失败（HTTP ${res.status}）`);
      setNotice(`已上传形象：${result.name}（${Math.round((result.bytes || 0) / 1024)}KB）`);
      setUploadName("");
      await load(true);
    } catch (err) {
      setError("上传失败：" + err.message);
    } finally {
      setBusy("");
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function addImageByUrl() {
    if (!linkUrl.trim()) {
      setError("外链地址不能为空");
      return;
    }
    return run(
      "add-image",
      () =>
        api("/api/admin/pet/images", {
          method: "POST",
          body: {
            name: linkName || "外链形象",
            url: linkUrl.trim(),
          },
        }),
      "已新增形象（记得点「设为当前」才会生效）"
    ).then((result) => {
      if (result) {
        setLinkName("");
        setLinkUrl("");
      }
    });
  }

  function setActive(id) {
    return run(
      "active",
      () => api("/api/admin/pet/images/active", { method: "POST", body: { id } }),
      id > 0 ? "已切换当前形象" : "已回退到内置默认形象"
    ).then((result) => {
      // activeImageId 存在 settings 里，让外层把配置也刷一遍
      if (result && typeof onSaved === "function") onSaved();
    });
  }

  function patchImage(id, body, okMessage) {
    return run("image-" + id, () => api("/api/admin/pet/images", { method: "PATCH", body: { id, ...body } }), okMessage);
  }

  function removeImage(image) {
    setConfirmBox({
      message: `确定删除形象「${image.name}」？${
        image.id === activeImageId ? "它当前正在使用，删除后会自动回退到内置默认形象。" : "上传的图片文件也会一起删掉。"
      }`,
      confirmText: "确认删除",
      onConfirm: async () => {
        setConfirmBox(null);
        // 删掉当前形象时，settings 里的 activeImageId 会在服务端归 0，这里也要刷一遍配置
        const result = await run(
          "image-" + image.id,
          () => api(`/api/admin/pet/images?id=${image.id}`, { method: "DELETE" }),
          "已删除形象"
        );
        if (result && typeof onSaved === "function") onSaved();
      },
    });
  }

  /* ---------------- 情绪选项 ---------------- */

  function addMood() {
    if (!newMood.key.trim() || !newMood.label.trim()) {
      setError("情绪键和选项文案都要填");
      return;
    }
    return run(
      "add-mood",
      () => api("/api/admin/pet/moods", { method: "POST", body: newMood }),
      "已新增情绪选项"
    ).then((result) => {
      if (result) {
        setNewMood({ key: "", label: "", anim: "droop", stay: 3000, droop: true });
        setShowAddMood(false);
      }
    });
  }

  function patchMood(mood, body, okMessage) {
    return run(
      "mood-" + mood.id,
      () => api("/api/admin/pet/moods", { method: "PATCH", body: { id: mood.id, ...body } }),
      okMessage
    );
  }

  function removeMood(mood) {
    setConfirmBox({
      message: `确定删除情绪「${mood.label}」？它挂着的 ${mood.lines?.length || 0} 句回复会一起删掉。`,
      confirmText: "确认删除",
      onConfirm: async () => {
        setConfirmBox(null);
        await run("mood-" + mood.id, () => api(`/api/admin/pet/moods?id=${mood.id}`, { method: "DELETE" }), "已删除情绪");
      },
    });
  }

  /* ---------------- 回复话术 ---------------- */

  function addLine(mood) {
    const text = (lineDrafts[mood.id] || "").trim();
    if (!text) {
      setError("回复话术不能为空");
      return;
    }
    return run(
      "line-add-" + mood.id,
      () =>
        api("/api/admin/pet/lines", {
          method: "POST",
          body: { moodId: mood.id, text, sortOrder: (mood.lines?.length || 0) * 10 },
        }),
      "已新增回复"
    ).then((result) => {
      if (result) setLineDrafts((prev) => ({ ...prev, [mood.id]: "" }));
    });
  }

  function patchLine(line, body, okMessage) {
    return run(
      "line-" + line.id,
      () => api("/api/admin/pet/lines", { method: "PATCH", body: { id: line.id, ...body } }),
      okMessage
    );
  }

  function removeLine(line) {
    return run("line-" + line.id, () => api(`/api/admin/pet/lines?id=${line.id}`, { method: "DELETE" }), "已删除回复");
  }

  /* ---------------- 渲染 ---------------- */

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-400">
          {loading
            ? "读取中…"
            : `形象 ${images.length} 张 ｜ 情绪选项 ${moods.length} / ${limits.moods} 条${
                disk ? ` ｜ public/pets 占用 ${disk.count} 个文件 / ${disk.mb}MB` : ""
              }`}
        </p>
        <button className={BTN} onClick={() => load()} disabled={loading || !!busy}>
          刷新
        </button>
      </div>

      {/* ---------------- 形象库 ---------------- */}
      <section className="rounded-xl border border-[#e8eae7] p-4">
        <h3 className="text-sm font-semibold text-slate-700">形象库</h3>
        <p className="mt-1 text-xs text-slate-400">
          可以放多张形象，<strong className="text-slate-500">用户端只展示被设为「当前」的那一张</strong>。上传的图存在
          <code className="mx-1 rounded bg-[#f4f6f4] px-1">public/pets/</code>
          下，不超过 2MB（桌宠显示边长最大 160px，原图太大纯属浪费）。
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            className="w-40 rounded-lg border border-[#e2e5e2] px-3 py-1.5 text-sm outline-none focus:border-[#7fa3b8]"
            placeholder="形象名称（可空）"
            value={uploadName}
            onChange={(e) => setUploadName(e.target.value)}
          />
          <input
            ref={fileRef}
            type="file"
            accept=".png,.jpg,.jpeg,.webp,.gif"
            className="hidden"
            onChange={handleUpload}
          />
          <button
            className={BTN_PRIMARY}
            onClick={() => fileRef.current?.click()}
            disabled={!!busy}
          >
            {busy === "upload" ? "上传中…" : "上传形象图"}
          </button>
          <span className="text-xs text-slate-300">或</span>
          <input
            className="w-40 rounded-lg border border-[#e2e5e2] px-3 py-1.5 text-sm outline-none focus:border-[#7fa3b8]"
            placeholder="外链名称（可空）"
            value={linkName}
            onChange={(e) => setLinkName(e.target.value)}
          />
          <input
            className="w-64 rounded-lg border border-[#e2e5e2] px-3 py-1.5 text-sm outline-none focus:border-[#7fa3b8]"
            placeholder="https://… 图片外链"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
          />
          <button className={BTN} onClick={addImageByUrl} disabled={!!busy}>
            加外链
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {images.map((image) => {
            const isActive = Number(image.id) === Number(activeImageId);
            return (
              <div
                key={image.id}
                className={`rounded-xl border p-3 ${
                  isActive ? "border-[#7fa3b8] bg-[#f6fafc]" : "border-[#e8eae7] bg-white"
                }`}
              >
                <div className="flex h-24 items-center justify-center rounded-lg bg-[#f7f9fb]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={encodeURI(image.url)}
                    alt=""
                    className="max-h-20 max-w-full object-contain"
                    style={{ opacity: Number(image.enabled) ? 1 : 0.35 }}
                  />
                </div>

                <input
                  className="mt-2 w-full rounded-lg border border-transparent bg-transparent px-1 py-0.5 text-xs text-slate-700 outline-none hover:border-[#e2e5e2] focus:border-[#7fa3b8]"
                  value={nameDrafts[image.id] ?? image.name}
                  onChange={(e) => setNameDrafts((prev) => ({ ...prev, [image.id]: e.target.value }))}
                  onBlur={() => {
                    const next = (nameDrafts[image.id] ?? image.name).trim();
                    if (next && next !== image.name) patchImage(image.id, { name: next }, "已改名");
                  }}
                />

                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {isActive ? (
                    <span className="rounded bg-[#7fa3b8] px-1.5 py-0.5 text-[10px] text-white">当前使用</span>
                  ) : null}
                  {Number(image.enabled) ? null : (
                    <span className="rounded bg-[#e6e6e6] px-1.5 py-0.5 text-[10px] text-slate-500">已停用</span>
                  )}
                  <span className="text-[10px] text-slate-300">#{image.id}</span>
                </div>

                <div className="mt-2 flex flex-wrap gap-1">
                  {isActive ? (
                    <button className={BTN} disabled={!!busy} onClick={() => setActive(0)}>
                      用默认图
                    </button>
                  ) : (
                    <button
                      className={BTN_PRIMARY}
                      disabled={!!busy || !Number(image.enabled)}
                      onClick={() => setActive(image.id)}
                    >
                      设为当前
                    </button>
                  )}
                  <button
                    className={BTN}
                    disabled={!!busy}
                    onClick={() =>
                      patchImage(image.id, { enabled: !Number(image.enabled) }, Number(image.enabled) ? "已停用" : "已启用")
                    }
                  >
                    {Number(image.enabled) ? "停用" : "启用"}
                  </button>
                  <button className={BTN_DANGER} disabled={!!busy} onClick={() => removeImage(image)}>
                    删除
                  </button>
                </div>
              </div>
            );
          })}
          {!images.length && !loading ? (
            <p className="col-span-full text-xs text-slate-400">
              形象库是空的 —— 用户端会直接用内置的蓝蝴蝶（/stickers/blue_butterfly.png）。
            </p>
          ) : null}
        </div>
      </section>

      {/* ---------------- 情绪选项 + 回复话术 ---------------- */}
      <section className="rounded-xl border border-[#e8eae7] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">情绪选项与回复话术</h3>
            <p className="mt-1 text-xs text-slate-400">
              用户点开蝴蝶看到的就是这些按钮；点中之后，桌宠会从这条情绪挂着的回复里
              <strong className="mx-1 text-slate-500">随机说一句</strong>
              （同一句在去重时间内不会连说两遍）。
            </p>
          </div>
          <button className={BTN} onClick={() => setShowAddMood((v) => !v)} disabled={!!busy}>
            {showAddMood ? "收起新增" : "新增情绪选项"}
          </button>
        </div>

        {showAddMood ? (
          <div className="mt-3 grid gap-2 rounded-xl bg-[#f8faf9] p-3 sm:grid-cols-2">
            <label className="text-xs text-slate-500">
              情绪键（小写英文，程序内用，不能改）
              <input
                className={INPUT + " mt-1"}
                placeholder="例如 lonely"
                value={newMood.key}
                onChange={(e) => setNewMood({ ...newMood, key: e.target.value })}
              />
            </label>
            <label className="text-xs text-slate-500">
              选项文案（用户看到的那句话）
              <input
                className={INPUT + " mt-1"}
                placeholder="例如 我有点孤单"
                value={newMood.label}
                onChange={(e) => setNewMood({ ...newMood, label: e.target.value })}
              />
            </label>
            <label className="text-xs text-slate-500">
              动画
              <select
                className={INPUT + " mt-1"}
                value={newMood.anim}
                onChange={(e) => setNewMood({ ...newMood, anim: e.target.value })}
              >
                {ANIMS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end gap-3">
              <label className="text-xs text-slate-500">
                气泡停留（毫秒）
                <input
                  type="number"
                  className={INPUT + " mt-1 w-28"}
                  value={newMood.stay}
                  disabled={newMood.anim === "goto"}
                  onChange={(e) => setNewMood({ ...newMood, stay: Number(e.target.value) })}
                />
              </label>
              <label className="flex items-center gap-1 pb-2 text-xs text-slate-500">
                <input
                  type="checkbox"
                  checked={newMood.droop}
                  disabled={newMood.anim === "goto"}
                  onChange={(e) => setNewMood({ ...newMood, droop: e.target.checked })}
                />
                选过之后低垂
              </label>
              <button className={BTN_PRIMARY} onClick={addMood} disabled={!!busy}>
                新增
              </button>
            </div>
            <p className="text-[11px] text-slate-400 sm:col-span-2">
              ⚠️ 动画只能是组件里已有的那几种（想加新动画要先改
              <code className="mx-1 rounded bg-[#f4f6f4] px-1">components/ButterflyEffect.jsx</code>
              的关键帧）；「直接去聊天」那一项不需要回复，点了就切到聊天页。
            </p>
          </div>
        ) : null}

        <div className="mt-3 space-y-2">
          {moods.map((mood) => {
            const lines = mood.lines || [];
            const isGoto = mood.anim === "goto";
            const open = openMoodId === Number(mood.id);
            return (
              <div key={mood.id} className="rounded-xl border border-[#e8eae7]">
                <div className="flex flex-wrap items-center gap-2 p-3">
                  <input
                    className="min-w-[10rem] flex-1 rounded-lg border border-transparent px-2 py-1 text-sm text-slate-700 outline-none hover:border-[#e2e5e2] focus:border-[#7fa3b8]"
                    defaultValue={mood.label}
                    key={`label-${mood.id}-${mood.label}`}
                    onBlur={(e) => {
                      const next = e.target.value.trim();
                      if (next && next !== mood.label) patchMood(mood, { label: next }, "已保存文案");
                    }}
                  />
                  <span className="rounded bg-[#f4f6f4] px-1.5 py-0.5 text-[10px] text-slate-500">
                    {mood.mood_key}
                  </span>
                  <span className="text-[11px] text-slate-400">{ANIM_LABEL[mood.anim] || mood.anim}</span>
                  <span className="text-[11px] text-slate-400">
                    {lines.length} 句回复{Number(mood.droop) ? " ｜ 低垂" : ""}
                  </span>

                  {!Number(mood.enabled) ? (
                    <span className="rounded bg-[#e6e6e6] px-1.5 py-0.5 text-[10px] text-slate-500">已停用</span>
                  ) : null}
                  {!isGoto && !lines.length ? (
                    <span className="rounded bg-[#fdf1e3] px-1.5 py-0.5 text-[10px] text-[#b07b3a]">
                      还没有回复：点了只会看动画
                    </span>
                  ) : null}

                  <button
                    className={BTN}
                    onClick={() => setOpenMoodId(open ? 0 : Number(mood.id))}
                    disabled={!!busy}
                  >
                    {open ? "收起话术" : "管理话术"}
                  </button>
                  <button
                    className={BTN}
                    disabled={!!busy}
                    onClick={() =>
                      patchMood(mood, { enabled: !Number(mood.enabled) }, Number(mood.enabled) ? "已停用" : "已启用")
                    }
                  >
                    {Number(mood.enabled) ? "停用" : "启用"}
                  </button>
                  <button className={BTN_DANGER} disabled={!!busy} onClick={() => removeMood(mood)}>
                    删除
                  </button>
                </div>

                {open ? (
                  <div className="border-t border-[#f0f2ef] bg-[#fbfcfb] p-3">
                    <div className="grid gap-2 sm:grid-cols-3">
                      <label className="text-xs text-slate-500">
                        动画
                        <select
                          className={INPUT + " mt-1"}
                          value={mood.anim}
                          onChange={(e) => patchMood(mood, { anim: e.target.value }, "已切换动画")}
                          disabled={!!busy}
                        >
                          {ANIMS.map((a) => (
                            <option key={a.value} value={a.value}>
                              {a.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="text-xs text-slate-500">
                        气泡停留（毫秒）
                        <input
                          type="number"
                          className={INPUT + " mt-1"}
                          defaultValue={mood.stay_ms}
                          key={`stay-${mood.id}-${mood.stay_ms}`}
                          disabled={isGoto || !!busy}
                          onBlur={(e) => {
                            const next = Number(e.target.value);
                            if (next !== Number(mood.stay_ms)) patchMood(mood, { stay: next }, "已保存停留时间");
                          }}
                        />
                      </label>
                      <label className="flex items-end gap-1 pb-2 text-xs text-slate-500">
                        <input
                          type="checkbox"
                          checked={Number(mood.droop) === 1}
                          disabled={isGoto || !!busy}
                          onChange={(e) => patchMood(mood, { droop: e.target.checked }, "已保存低垂设置")}
                        />
                        选过之后进入低垂状态
                      </label>
                    </div>

                    <p className="mt-2 text-[11px] text-slate-400">
                      话术建议：先接住情绪、再陪着，不要索取（别写「你怎么才来」「等你好久了」）。
                    </p>

                    <ul className="mt-2 space-y-1">
                      {lines.map((line) => (
                        <li key={line.id} className="flex items-center gap-2">
                          <input
                            className="flex-1 rounded-lg border border-transparent bg-white px-2 py-1 text-sm text-slate-700 outline-none hover:border-[#e2e5e2] focus:border-[#7fa3b8]"
                            defaultValue={line.text}
                            key={`line-${line.id}-${line.text}`}
                            onBlur={(e) => {
                              const next = e.target.value.trim();
                              if (next && next !== line.text) patchLine(line, { text: next }, "已保存回复");
                            }}
                          />
                          <button
                            className={BTN}
                            disabled={!!busy}
                            onClick={() =>
                              patchLine(
                                line,
                                { enabled: !Number(line.enabled) },
                                Number(line.enabled) ? "已停用这句" : "已启用这句"
                              )
                            }
                          >
                            {Number(line.enabled) ? "停用" : "启用"}
                          </button>
                          <button className={BTN_DANGER} disabled={!!busy} onClick={() => removeLine(line)}>
                            删除
                          </button>
                        </li>
                      ))}
                      {!lines.length ? (
                        <li className="text-xs text-slate-400">这条情绪还没有回复。</li>
                      ) : null}
                    </ul>

                    <div className="mt-2 flex items-center gap-2">
                      <input
                        className={INPUT}
                        placeholder={isGoto ? "（这一项点了直接去聊天，不需要回复）" : "新增一句回复，最多 60 字"}
                        value={lineDrafts[mood.id] || ""}
                        disabled={isGoto || !!busy || lines.length >= limits.linesPerMood}
                        onChange={(e) => setLineDrafts((prev) => ({ ...prev, [mood.id]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") addLine(mood);
                        }}
                      />
                      <button
                        className={BTN_PRIMARY}
                        onClick={() => addLine(mood)}
                        disabled={isGoto || !!busy || lines.length >= limits.linesPerMood}
                      >
                        加一句
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
          {!moods.length && !loading ? (
            <p className="text-xs text-slate-400">
              情绪选项是空的 —— 用户端的蝴蝶会回退到内置的 5 条（否则点了没反应，看着像坏了）。
            </p>
          ) : null}
        </div>
      </section>

      <ConfirmModal
        open={!!confirmBox}
        message={confirmBox?.message || ""}
        confirmText={confirmBox?.confirmText || "确认删除"}
        onConfirm={confirmBox?.onConfirm || (() => {})}
        onClose={() => setConfirmBox(null)}
      />
    </div>
  );
}
