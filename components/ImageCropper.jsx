"use client";

/**
 * 通用图片裁剪弹窗（基于 react-easy-crop）。
 * 支持拖拽移动、滚轮/双指缩放、底部滑块、90° 旋转；
 * 确认时用 canvas 按裁剪区域导出 JPEG（白底），交给父组件上传。
 *
 * Props:
 *   imageSrc      原图 data URL / object URL
 *   aspect        裁剪比例（头像 1；未提供 aspectOptions 时生效）
 *   cropShape     'round' | 'rect'
 *   title         弹窗标题
 *   busy          外部上传中（禁用按钮）
 *   maxSide       导出图片最长边像素（默认 1280）
 *   aspectOptions 可选比例列表，如 [{label:'横屏 16:9', value:16/9}, ...]
 *                 传入后顶部显示比例切换（默认选中第一个），供背景图适配横/竖屏
 *   onCancel      取消
 *   onConfirm     async (dataUrl) => void  上传并保存 URL
 */
import { useState } from "react";
import Cropper from "react-easy-crop";

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片读取失败"));
    img.src = url;
  });
}

// 按裁剪区域（含旋转）导出 canvas
async function drawCropped(imageSrc, area, rotation) {
  const img = await loadImage(imageSrc);
  const rad = (rotation * Math.PI) / 180;
  // 旋转后的外接矩形，避免裁掉边角
  const bw =
    Math.abs(Math.cos(rad) * img.width) + Math.abs(Math.sin(rad) * img.height);
  const bh =
    Math.abs(Math.sin(rad) * img.width) + Math.abs(Math.cos(rad) * img.height);

  const stage = document.createElement("canvas");
  stage.width = Math.round(bw);
  stage.height = Math.round(bh);
  const sctx = stage.getContext("2d");
  sctx.translate(bw / 2, bh / 2);
  sctx.rotate(rad);
  sctx.drawImage(img, -img.width / 2, -img.height / 2);

  const cw = Math.max(1, Math.round(Math.abs(area.width)));
  const ch = Math.max(1, Math.round(Math.abs(area.height)));
  // area.x/y 相对未旋转原图；stage 中原图左上角偏移为 (bw/2 - img.width/2)
  const ox = bw / 2 - img.width / 2 + area.x;
  const oy = bh / 2 - img.height / 2 + area.y;

  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  const octx = out.getContext("2d");
  // 白底：避免 PNG 透明区导成黑色
  octx.fillStyle = "#ffffff";
  octx.fillRect(0, 0, cw, ch);
  octx.drawImage(stage, ox, oy, cw, ch, 0, 0, cw, ch);
  return out;
}

// 最长边限制
function fitSize(canvas, maxSide) {
  const longest = Math.max(canvas.width, canvas.height);
  if (longest <= maxSide) return canvas;
  const s = maxSide / longest;
  const w = Math.max(1, Math.round(canvas.width * s));
  const h = Math.max(1, Math.round(canvas.height * s));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(canvas, 0, 0, w, h);
  return c;
}

// 逐步降质量，把 data URL 控制在后端体积上限内
function exportJpegUnder(canvas, maxBytes = 880 * 1024) {
  let quality = 0.9;
  let url = canvas.toDataURL("image/jpeg", quality);
  while (url.length > maxBytes && quality > 0.4) {
    quality -= 0.1;
    url = canvas.toDataURL("image/jpeg", quality);
  }
  return url;
}

export default function ImageCropper({
  imageSrc,
  aspect = 1,
  cropShape = "rect",
  title = "裁剪图片",
  busy = false,
  maxSide = 1280,
  aspectOptions = null,
  onCancel,
  onConfirm,
}) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [area, setArea] = useState(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  // 当前比例：有可选项时默认第一个（横屏 16:9），否则用传入的固定 aspect
  const [aspectIndex, setAspectIndex] = useState(0);
  const currentAspect = aspectOptions
    ? aspectOptions[aspectIndex].value
    : aspect;

  // 切换比例：裁剪框实时变形；重置取景到居中、缩放归 1，
  // react-easy-crop 会按新比例自动重新适配取景范围
  function changeAspect(i) {
    if (i === aspectIndex) return;
    setAspectIndex(i);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setArea(null);
  }

  async function handleConfirm() {
    if (!area) {
      setError("图片还在加载，请稍等");
      return;
    }
    setWorking(true);
    setError("");
    try {
      const raw = await drawCropped(imageSrc, area, rotation);
      const fitted = fitSize(raw, maxSide);
      const dataUrl = exportJpegUnder(fitted);
      await onConfirm?.(dataUrl);
    } catch (err) {
      setError(err.message || "裁剪失败，请重试");
    } finally {
      setWorking(false);
    }
  }

  const disabled = busy || working;

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/50 flex items-stretch sm:items-center justify-center sm:px-4"
      onClick={() => !disabled && onCancel?.()}
    >
      <div
        className="bg-white sm:rounded-2xl shadow-xl border border-[#e8eae7] w-full sm:w-[420px] max-w-full p-4 flex flex-col h-full sm:h-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-bold text-slate-800 mb-3">{title}</h2>

        {/* 比例切换（仅背景图等传入 aspectOptions 时显示）：
            胶囊分段控件，按钮 ≥44px 方便手指点按 */}
        {aspectOptions && (
          <div className="flex bg-[#f1f3f2] rounded-xl p-1 mb-3">
            {aspectOptions.map((opt, i) => (
              <button
                key={opt.label}
                type="button"
                disabled={disabled}
                onClick={() => changeAspect(i)}
                className={`flex-1 min-h-[44px] rounded-lg text-sm font-medium transition-all duration-150 disabled:opacity-50 ${
                  i === aspectIndex
                    ? "bg-white text-[#5d88a3] shadow-sm"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}

        {/* 裁剪区域：深灰底，不抢眼；移动端高度自适应留出操作空间。
            touch-none 防止拖拽时页面滚动；react-easy-crop 内部接管单指/双指手势 */}
        <div className="relative w-full h-[52vh] sm:h-72 rounded-xl overflow-hidden bg-[#3a3f44] touch-none">
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            rotation={rotation}
            aspect={currentAspect}
            cropShape={cropShape}
            minZoom={1}
            maxZoom={3}
            showGrid={false}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={(_, areaPixels) => setArea(areaPixels)}
          />
        </div>

        {/* 控制行：旋转按钮 + 缩放滑块；按钮 ≥44px 触控 */}
        <div className="flex items-center gap-3 mt-3">
          <button
            type="button"
            title="旋转 90°"
            disabled={disabled}
            onClick={() => setRotation((v) => (v + 90) % 360)}
            className="shrink-0 w-11 h-11 sm:w-9 sm:h-9 rounded-lg border border-[#d5d9d7] bg-[#f1f3f2] text-slate-500 hover:bg-[#e8eff2] hover:text-[#5d88a3] transition-colors disabled:opacity-50 flex items-center justify-center text-lg"
          >
            ↻
          </button>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            disabled={disabled}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="flex-1 h-11 accent-[#7fa3b8] cursor-pointer disabled:opacity-50"
            aria-label="缩放"
          />
        </div>

        {error && (
          <p className="mt-2 text-xs text-red-600 leading-5">{error}</p>
        )}

        {/* 底部按钮：米白/淡蓝治愈风，≥44px 高方便触控 */}
        <div className="flex justify-end gap-2 mt-auto sm:mt-4 pt-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={disabled}
            className="border border-[#d5d9d7] bg-[#fdfdfc] text-slate-500 rounded-lg px-5 min-h-[44px] text-sm hover:bg-[#eef1f2] hover:text-slate-700 active:scale-[0.98] transition-all duration-150 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={disabled}
            className="border border-[#bcd0dc] bg-[#e8eff4] text-[#5d88a3] rounded-lg px-5 min-h-[44px] text-sm hover:bg-[#d9e6ee] hover:scale-[1.02] active:scale-[0.98] shadow-sm transition-all duration-150 disabled:opacity-50 disabled:hover:scale-100"
          >
            {working ? "处理中" : busy ? "上传中" : "确认"}
          </button>
        </div>
      </div>
    </div>
  );
}
