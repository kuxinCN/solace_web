"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { parseStickerMark } from "./chat/MessageRow";
import { stripTtsTags } from "@/lib/tts-tags";

/**
 * 格式化日期为有温度的中文时间标签
 */
function formatCardDate(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  if (isNaN(d.getTime())) return "暖言时刻 · 温暖陪伴";
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = d.getHours();
  let timePeriod = "深夜";
  if (hours >= 5 && hours < 9) timePeriod = "清晨";
  else if (hours >= 9 && hours < 12) timePeriod = "上午";
  else if (hours >= 12 && hours < 14) timePeriod = "午后";
  else if (hours >= 14 && hours < 18) timePeriod = "傍晚";
  else if (hours >= 18 && hours < 23) timePeriod = "夜幕";

  return `${year}年${month}月${day}日 · ${timePeriod}`;
}

/**
 * 原生 Canvas 文本换行计算（按段落和字符测量宽度）
 */
function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  const paragraphs = String(text || "").split(/\r?\n/);
  for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
    const para = paragraphs[pIdx];
    if (!para) {
      if (pIdx > 0 && pIdx < paragraphs.length - 1) lines.push("");
      continue;
    }
    let currentLine = "";
    for (let i = 0; i < para.length; i++) {
      const char = para[i];
      const testLine = currentLine + char;
      const width = ctx.measureText(testLine).width;
      if (width > maxWidth && currentLine.length > 0) {
        lines.push(currentLine);
        currentLine = char;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);
  }
  return lines;
}

/**
 * 辅助绘制圆角矩形
 */
function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * 对话切片导出为“暖心明信片 / 拍立得卡片”弹窗
 */
export default function CompanionCardModal({ isOpen, onClose, qaData }) {
  const [themeMode, setThemeMode] = useState("paper"); // "paper"（温润素笺）| "espresso"（深宵微光）
  const [includeUserPrompt, setIncludeUserPrompt] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [cardImgUrl, setCardImgUrl] = useState("");
  const [copiedTip, setCopiedTip] = useState(false);
  const canvasRef = useRef(null);

  // 纯文本清理（去除表情包标记和 TTS 标签）
  const cleanAiText = useCallback(() => {
    if (!qaData?.aiContent) return "";
    const parsed = parseStickerMark(qaData.aiContent).text;
    return stripTtsTags(parsed);
  }, [qaData?.aiContent]);

  const cleanUserText = useCallback(() => {
    return String(qaData?.userContent || "").trim();
  }, [qaData?.userContent]);

  // 生成卡片 Canvas 绘制
  useEffect(() => {
    if (!isOpen || !qaData) return;
    setGenerating(true);

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setGenerating(false);
      return;
    }

    const aiText = cleanAiText();
    const userText = cleanUserText();
    const hasUser = includeUserPrompt && !!userText;

    // 拍立得卡片基准宽度 750px (Retina 2x 导出)
    const CARD_W = 750;
    const PADDING_H = 50; // 两侧内衬边距
    const CONTENT_W = CARD_W - PADDING_H * 2;

    // 测算文本行数与所需总高度
    ctx.font = "24px 'PingFang SC', 'Microsoft YaHei', sans-serif";
    const userLines = hasUser ? wrapLines(ctx, userText, CONTENT_W - 48) : [];

    ctx.font = "500 28px 'PingFang SC', 'Microsoft YaHei', sans-serif";
    const aiLines = wrapLines(ctx, aiText, CONTENT_W - 20);

    const userBlockHeight = hasUser ? 46 + userLines.length * 38 + 24 : 0;
    const aiBlockHeight = 80 + aiLines.length * 48 + 24;

    // 顶部 Logo + 日期高度：130px
    // 拍立得经典加厚底部底座高度：190px
    const HEADER_H = 130;
    const FOOTER_H = 190;
    const CARD_H = HEADER_H + userBlockHeight + (hasUser ? 24 : 0) + aiBlockHeight + FOOTER_H;

    canvas.width = CARD_W;
    canvas.height = CARD_H;

    // 预加载 Logo 图片
    const logoImg = new Image();
    logoImg.crossOrigin = "anonymous";
    logoImg.src = "/logo.png";

    const drawCard = () => {
      const isEspresso = themeMode === "espresso";

      // 1. 绘制最底层投影与相纸外边框
      ctx.clearRect(0, 0, CARD_W, CARD_H);

      // 背景渐变填充
      if (!isEspresso) {
        // 温润素笺风格：羊脂米白纸质底色 + 暖色光晕
        const bgGrad = ctx.createLinearGradient(0, 0, 0, CARD_H);
        bgGrad.addColorStop(0, "#FDFBF7");
        bgGrad.addColorStop(1, "#F7F1E9");
        ctx.fillStyle = bgGrad;
        roundRect(ctx, 0, 0, CARD_W, CARD_H, 28);
        ctx.fill();

        // 柔和微外边框
        ctx.strokeStyle = "#E8DDD2";
        ctx.lineWidth = 2;
        roundRect(ctx, 0, 0, CARD_W, CARD_H, 28);
        ctx.stroke();

        // 拍立得顶部轻微暖陶红呼吸装饰弧
        const topGlow = ctx.createRadialGradient(CARD_W / 2, 40, 0, CARD_W / 2, 40, 260);
        topGlow.addColorStop(0, "rgba(217, 124, 98, 0.08)");
        topGlow.addColorStop(1, "rgba(217, 124, 98, 0)");
        ctx.fillStyle = topGlow;
        ctx.fillRect(0, 0, CARD_W, 200);
      } else {
        // 深宵微光风格：深咖炭黑底 + 暖琥珀光晕
        const bgGrad = ctx.createLinearGradient(0, 0, 0, CARD_H);
        bgGrad.addColorStop(0, "#231F1C");
        bgGrad.addColorStop(1, "#191614");
        ctx.fillStyle = bgGrad;
        roundRect(ctx, 0, 0, CARD_W, CARD_H, 28);
        ctx.fill();

        ctx.strokeStyle = "#3D342E";
        ctx.lineWidth = 2;
        roundRect(ctx, 0, 0, CARD_W, CARD_H, 28);
        ctx.stroke();

        const topGlow = ctx.createRadialGradient(CARD_W / 2, 40, 0, CARD_W / 2, 40, 280);
        topGlow.addColorStop(0, "rgba(224, 137, 105, 0.12)");
        topGlow.addColorStop(1, "rgba(224, 137, 105, 0)");
        ctx.fillStyle = topGlow;
        ctx.fillRect(0, 0, CARD_W, 200);
      }

      // 2. 绘制顶部 Logo、品牌名称与日期
      const logoSize = 52;
      const logoX = PADDING_H;
      const logoY = 44;

      try {
        if (logoImg.complete && logoImg.naturalWidth > 0) {
          ctx.drawImage(logoImg, logoX, logoY, logoSize, logoSize);
        } else {
          ctx.fillStyle = isEspresso ? "#D97C62" : "#B85A3C";
          ctx.beginPath();
          ctx.arc(logoX + logoSize / 2, logoY + logoSize / 2, logoSize / 2, 0, Math.PI * 2);
          ctx.fill();
        }
      } catch {
        // 兜底绘制
      }

      // 品牌字：Solace 暖言
      ctx.fillStyle = isEspresso ? "#F5DCD3" : "#3D312A";
      ctx.font = "bold 32px 'PingFang SC', 'Microsoft YaHei', sans-serif";
      ctx.fillText("Solace · 暖言陪伴", logoX + logoSize + 16, logoY + 36);

      // 右侧日期标签胶囊
      const dateText = formatCardDate(qaData.timestamp);
      ctx.font = "22px 'PingFang SC', 'Microsoft YaHei', sans-serif";
      const dateWidth = ctx.measureText(dateText).width;
      const dateBadgeW = dateWidth + 30;
      const dateBadgeH = 38;
      const dateBadgeX = CARD_W - PADDING_H - dateBadgeW;
      const dateBadgeY = logoY + 7;

      ctx.fillStyle = isEspresso ? "rgba(245, 220, 211, 0.08)" : "rgba(184, 90, 60, 0.08)";
      roundRect(ctx, dateBadgeX, dateBadgeY, dateBadgeW, dateBadgeH, 19);
      ctx.fill();

      ctx.fillStyle = isEspresso ? "#D1B8AE" : "#A65840";
      ctx.fillText(dateText, dateBadgeX + 15, dateBadgeY + 26);

      // 顶部分割虚线
      ctx.strokeStyle = isEspresso ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(PADDING_H, 116);
      ctx.lineTo(CARD_W - PADDING_H, 116);
      ctx.stroke();
      ctx.setLineDash([]); // 还原实线

      let curY = 146;

      // 3. 用户提问区（若勾选）
      if (hasUser) {
        ctx.fillStyle = isEspresso ? "rgba(45, 38, 33, 0.85)" : "#EFE6DD";
        roundRect(ctx, PADDING_H, curY, CONTENT_W, userBlockHeight, 18);
        ctx.fill();

        // 提问小标
        ctx.fillStyle = isEspresso ? "#E5A995" : "#B85A3C";
        ctx.font = "bold 22px 'PingFang SC', 'Microsoft YaHei', sans-serif";
        ctx.fillText("💬 你的心声", PADDING_H + 24, curY + 36);

        // 提问文本
        ctx.fillStyle = isEspresso ? "#E6D4CC" : "#55463D";
        ctx.font = "24px 'PingFang SC', 'Microsoft YaHei', sans-serif";
        userLines.forEach((line, idx) => {
          ctx.fillText(line, PADDING_H + 24, curY + 74 + idx * 38);
        });

        curY += userBlockHeight + 26;
      }

      // 4. AI 暖言回复区（大字号、舒展留白）
      // 暖言回应标题微标
      ctx.fillStyle = isEspresso ? "#E08969" : "#B85A3C";
      ctx.font = "bold 24px 'PingFang SC', 'Microsoft YaHei', sans-serif";
      ctx.fillText("✨ 暖言回应", PADDING_H + 6, curY + 28);

      curY += 76; // 宽裕垂直留白，确保与正文首行有 48px 以上清晰间隔

      // AI 回复核心正文
      ctx.fillStyle = isEspresso ? "#FAF2ED" : "#2E241F";
      ctx.font = "500 28px 'PingFang SC', 'Microsoft YaHei', sans-serif";
      aiLines.forEach((line, idx) => {
        ctx.fillText(line, PADDING_H + 6, curY + idx * 48);
      });

      // 5. 拍立得下巴留白区域（Footer）
      const footerY = CARD_H - FOOTER_H;

      // 底部装饰金线
      ctx.strokeStyle = isEspresso ? "rgba(224, 137, 105, 0.25)" : "rgba(184, 90, 60, 0.2)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(PADDING_H, footerY + 18);
      ctx.lineTo(CARD_W - PADDING_H, footerY + 18);
      ctx.stroke();

      // 右侧专属椭圆防伪印鉴徽章（位于上方右侧，高度 46px）
      const sealW = 176;
      const sealH = 46;
      const sealX = CARD_W - PADDING_H - sealW;
      const sealY = footerY + 36;

      ctx.strokeStyle = isEspresso ? "rgba(224, 137, 105, 0.4)" : "rgba(184, 90, 60, 0.35)";
      ctx.lineWidth = 1.5;
      roundRect(ctx, sealX, sealY, sealW, sealH, 10);
      ctx.stroke();

      ctx.fillStyle = isEspresso ? "#D97C62" : "#B85A3C";
      ctx.font = "bold 15px 'PingFang SC', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("SOLACE CARD", sealX + sealW / 2, sealY + 21);
      ctx.font = "12px 'PingFang SC', sans-serif";
      ctx.fillText("暖心对话切片留存", sealX + sealW / 2, sealY + 37);
      ctx.textAlign = "start"; // 还原对齐

      // 左侧落款温情名言（与右侧印章水平并列，垂直对齐，最大宽度不超 sealX）
      ctx.fillStyle = isEspresso ? "#C7B3A9" : "#7A675C";
      ctx.font = "italic 22px 'PingFang SC', 'Microsoft YaHei', serif";
      ctx.fillText("“生活细碎，万物成诗 · 暖言常在”", PADDING_H, footerY + 66);

      // 下方底线小字（位于印章下方充足安全距离处，完全错开，彻底杜绝重叠）
      ctx.fillStyle = isEspresso ? "#8C7970" : "#99857A";
      ctx.font = "17px 'PingFang SC', 'Microsoft YaHei', sans-serif";
      ctx.fillText("给每一个不想说话的灵魂，一点慰藉 · 心理关怀热线 12356", PADDING_H, footerY + 130);

      // 导出高保真图片 Data URL
      try {
        const dataUrl = canvas.toDataURL("image/png");
        setCardImgUrl(dataUrl);
      } catch (err) {
        console.error("生成卡片图片失败", err);
      }
      setGenerating(false);
    };

    if (logoImg.complete) {
      drawCard();
    } else {
      logoImg.onload = drawCard;
      logoImg.onerror = drawCard;
    }
  }, [isOpen, qaData, themeMode, includeUserPrompt, cleanAiText, cleanUserText]);

  if (!isOpen || !qaData) return null;

  // 触发本地保存下载
  const handleDownload = () => {
    if (!cardImgUrl) return;
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      try { navigator.vibrate([12, 40, 15]); } catch {} // 细腻双段触觉敲击（模拟快门与存照落定感）
    }
    const a = document.createElement("a");
    a.href = cardImgUrl;
    a.download = `solace-companion-card-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // 复制金句文本
  const handleCopyText = async () => {
    const text = cleanAiText();
    if (!text) return;
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      try { navigator.vibrate(10); } catch {}
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTip(true);
      setTimeout(() => setCopiedTip(false), 2000);
    } catch {
      // 兼容不支持 clipboard 的场景
    }
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-3 sm:p-5 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div
        className="relative w-full max-w-lg max-h-[92vh] flex flex-col rounded-3xl bg-[#FFFDFB] dark:bg-[#201C19] border border-[#f0eae3] dark:border-[#382F28] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 弹窗顶栏 */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3.5 border-b border-[#eee3d8] dark:border-[#382F28] bg-white/70 dark:bg-[#251F1C]/70 backdrop-blur-md">
          <div className="flex items-center gap-2">
            <span className="text-lg">💌</span>
            <span className="font-bold text-slate-800 dark:text-[#F5DCD3] text-sm sm:text-base">
              生成陪伴卡片 · 拍立得切片
            </span>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-[#F5DCD3] hover:bg-slate-100 dark:hover:bg-[#332A24] transition-colors"
          >
            ✕
          </button>
        </div>

        {/* 调节控制栏 */}
        <div className="shrink-0 px-5 py-2.5 bg-[#FAF6F2] dark:bg-[#28211D] border-b border-[#ebdcd0] dark:border-[#382F28] flex flex-wrap items-center justify-between gap-3 text-xs">
          {/* 风格切换 */}
          <div className="flex items-center gap-1.5 bg-[#ede1d5] dark:bg-[#382D26] p-1 rounded-xl">
            <button
              onClick={() => setThemeMode("paper")}
              className={`px-2.5 py-1 rounded-lg font-medium transition-all ${
                themeMode === "paper"
                  ? "bg-white dark:bg-[#45372F] text-[#b85a3c] dark:text-[#EAA896] shadow-xs"
                  : "text-slate-600 dark:text-[#A89890] hover:text-slate-900"
              }`}
            >
              🌸 温润素笺
            </button>
            <button
              onClick={() => setThemeMode("espresso")}
              className={`px-2.5 py-1 rounded-lg font-medium transition-all ${
                themeMode === "espresso"
                  ? "bg-white dark:bg-[#45372F] text-[#b85a3c] dark:text-[#EAA896] shadow-xs"
                  : "text-slate-600 dark:text-[#A89890] hover:text-slate-900"
              }`}
            >
              🌙 深宵微光
            </button>
          </div>

          {/* 提问开关 */}
          {cleanUserText() && (
            <label className="flex items-center gap-1.5 cursor-pointer text-slate-600 dark:text-[#BFAFA7] select-none">
              <input
                type="checkbox"
                checked={includeUserPrompt}
                onChange={(e) => setIncludeUserPrompt(e.target.checked)}
                className="rounded accent-[#b85a3c]"
              />
              <span>包含我的提问</span>
            </label>
          )}
        </div>

        {/* 卡片高保真预览展示区 */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 flex flex-col items-center justify-center bg-[#F4EDE5]/60 dark:bg-[#181412]/80">
          {generating ? (
            <div className="py-20 flex flex-col items-center gap-3">
              <div className="w-8 h-8 rounded-full border-2 border-[#b85a3c] border-t-transparent animate-spin" />
              <p className="text-xs text-slate-500 dark:text-[#9A8B83]">正在手揉纸感与微光卡片…</p>
            </div>
          ) : cardImgUrl ? (
            <div className="flex flex-col items-center w-full">
              <div className="relative group max-w-sm rounded-2xl shadow-xl overflow-hidden transition-transform duration-200 hover:scale-[1.01]">
                <img
                  src={cardImgUrl}
                  alt="Solace 陪伴明信片"
                  className="w-full h-auto block select-none pointer-events-auto"
                />
              </div>
              <p className="mt-3 text-[11px] text-slate-400 dark:text-[#887971] text-center">
                ✨ 提示：手机端可直接长按上方卡片，存入手机相册或分享给好友
              </p>
            </div>
          ) : null}
        </div>

        {/* 底部操作工具栏 */}
        <div className="shrink-0 px-5 py-3.5 border-t border-[#eee3d8] dark:border-[#382F28] bg-white/95 dark:bg-[#201C19] flex items-center justify-between gap-3">
          <button
            onClick={handleCopyText}
            className="px-3.5 py-2 rounded-xl text-xs font-medium border border-[#ebd8ce] dark:border-[#382F28] text-slate-700 dark:text-[#F5DCD3] hover:bg-[#FAF6F2] dark:hover:bg-[#28211D] transition-colors flex items-center gap-1.5"
          >
            <span>{copiedTip ? "✓ 已复制金句" : "📋 复制金句"}</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-medium text-slate-500 dark:text-[#A89890] hover:text-slate-800 dark:hover:text-white transition-colors"
            >
              关闭
            </button>
            <button
              onClick={handleDownload}
              disabled={!cardImgUrl}
              className="px-4 py-2 rounded-xl text-xs font-medium text-white bg-gradient-to-r from-[#d97c62] to-[#b85a3c] hover:opacity-95 shadow-sm shadow-[#b85a3c]/20 transition-all flex items-center gap-1.5 disabled:opacity-50"
            >
              <span>📥 保存相片海报</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

