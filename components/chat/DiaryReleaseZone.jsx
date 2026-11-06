"use client";

import React, { useRef, useState, useEffect } from "react";
import ConfirmModal from "@/components/ConfirmModal";

const RELEASE_ARM_PX = 20;      // 首次激活阈值
const RELEASE_TOTAL_PX = 1350;  // 累计这么多滑动距离才到进度 100（约 9-10 次来回）

/** 进度 → 四段视觉分级（直接给 style 属性） */
export function progressToStyle(p) {
  let blur, opacity, translateY;
  if (p < 30) {
    const t = p / 30;
    blur = t * 2;              // 0 → 2
    opacity = 1;
    translateY = 0;
  } else if (p < 60) {
    const t = (p - 30) / 30;
    blur = 2 + t * 3;          // 2 → 5
    opacity = 1 - t * 0.15;    // 1 → 0.85
    translateY = 0;
  } else if (p < 90) {
    const t = (p - 60) / 30;
    blur = 5 + t * 4;          // 5 → 9
    opacity = 0.85 - t * 0.15; // 0.85 → 0.7
    translateY = -t * 5;       // 0 → -5
  } else {
    const t = (p - 90) / 10;
    blur = 9 + t * 1;          // 9 → 10
    opacity = 0.7 - t * 0.2;   // 0.7 → 0.5
    translateY = -5 - t * 3;   // -5 → -8
  }
  return {
    filter: `blur(${blur.toFixed(2)}px)`,
    opacity: opacity.toFixed(3),
    transform: `translateY(${translateY.toFixed(2)}px)`,
  };
}

const CHAR_VARIANTS = 16; // 飘散 keyframe 变体池

/** 预生成 16 个两段式飘散变体（暖色化 → 上浮飘散），注入一次复用 */
export function buildCharVariantKeyframes() {
  let css = "";
  for (let i = 0; i < CHAR_VARIANTS; i++) {
    const dx = ((Math.random() - 0.5) * 60).toFixed(1);   // -30 ~ +30
    const rot = ((Math.random() - 0.5) * 30).toFixed(1);  // -15 ~ +15deg
    const lift = (-(60 + Math.random() * 40)).toFixed(1); // -60 ~ -100
    css += `
@keyframes diary-release-chv-${i} {
  0%   { opacity: 1; color: inherit; transform: translate(0,0) rotate(0deg); filter: blur(0); }
  33%  { opacity: 0.78; color: #C98BA4; transform: translate(0,0) rotate(0deg); filter: blur(0); }
  100% { opacity: 0; color: #C98BA4; transform: translate(${dx}px, ${lift}px) rotate(${rot}deg); filter: blur(2px); }
}`;
  }
  return css;
}

export const DIARY_RELEASE_BRAND_KEYFRAME = `
@keyframes diary-release-brand {
  0%   { opacity: 0; transform: translateY(6px); }
  60%  { opacity: 1; transform: translateY(0); }
  80%  { opacity: 1; transform: translateY(0); }
  100% { opacity: 0; transform: translateY(-4px); }
}`;

// ≤150 字逐字；150-400 逐词；>400 逐行
const RELEASE_CHAR_MAX = 150;
const RELEASE_WORD_MAX = 400;
const RELEASE_LINE_HARD = 44;

/** 逐词模式 */
export function releaseWordChunks(str, out) {
  const re = /\s+|[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*|[\u4e00-\u9fff]|[^A-Za-z0-9\s\u4e00-\u9fff]/g;
  const cjk = [];
  const flush = () => {
    while (cjk.length) {
      const n = cjk.length === 3 ? 3 : cjk.length >= 5 ? 3 : 2;
      out.push({ text: cjk.splice(0, n).join("") });
    }
  };
  let m;
  while ((m = re.exec(str))) {
    const tok = m[0];
    if (/^\s+$/.test(tok)) {
      flush();
      out.push({ ws: true, text: tok });
    } else if (/[\u4e00-\u9fff]/.test(tok)) {
      cjk.push(tok);
    } else if (/^[A-Za-z0-9]/.test(tok)) {
      flush();
      out.push({ text: tok });
    } else {
      if (cjk.length) cjk[cjk.length - 1] += tok;
      else if (out.length && !out[out.length - 1].ws) out[out.length - 1].text += tok;
      else out.push({ text: tok });
    }
  }
  flush();
}

/** 逐行模式 */
export function releaseLineChunks(str, out) {
  const lines = str.split("\n");
  lines.forEach((line, li) => {
    if (li > 0) out.push({ ws: true, text: "\n" });
    if (!line) return;
    if (line.length <= RELEASE_LINE_HARD) {
      out.push({ text: line });
      return;
    }
    const segs = line.match(/[^。！？；!?;]+[。！？；!?;]*/g) || [line];
    for (const s of segs) {
      for (let i = 0; i < s.length; i += RELEASE_LINE_HARD) {
        out.push({ text: s.slice(i, i + RELEASE_LINE_HARD) });
      }
    }
  });
}

/** 按总字数选择拆分粒度 */
export function releaseBuildChunks(textNodes) {
  let total = 0;
  for (const n of textNodes) total += n.nodeValue.length;
  const mode = total <= RELEASE_CHAR_MAX ? "char" : total <= RELEASE_WORD_MAX ? "word" : "line";
  const perNode = textNodes.map((n) => {
    const str = n.nodeValue;
    const items = [];
    if (mode === "char") {
      for (const ch of str) items.push({ text: ch });
    } else if (mode === "word") {
      releaseWordChunks(str, items);
    } else {
      releaseLineChunks(str, items);
    }
    return items;
  });
  return { mode, perNode };
}

/** 剥离残留 HTML 标签后判断是否为空白 */
export function releaseIsBlank(value) {
  const text = String(value ?? "")
    .replace(/<br\s*\/?>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text === "";
}

/**
 * 日记涂抹情绪释放交互容器组件
 */
export default function DiaryReleaseZone({
  children,
  hint = "烦躁的时候，按住编辑区任意位置涂抹，让它随风走",
  onRelease,
  isEmpty,
}) {
  const zoneRef = useRef(null);
  const wrapRef = useRef(null);
  const overlayRef = useRef(null);
  const progressRef = useRef(0);
  const gestureRef = useRef({ down: false, armed: false, startX: 0, startY: 0, lastX: 0, lastY: 0 });
  const cleanupTimerRef = useRef(null);
  const triggeredRef = useRef(false);
  const animStyleRef = useRef(null);

  const [tipText, setTipText] = useState("");
  const tipTimerRef = useRef(null);
  function flashTip(text, ms = 1900) {
    if (!text) return;
    setTipText(text);
    if (tipTimerRef.current) window.clearTimeout(tipTimerRef.current);
    tipTimerRef.current = window.setTimeout(() => setTipText(""), ms);
  }

  const isEmptyRef = useRef(isEmpty);
  useEffect(() => { isEmptyRef.current = isEmpty; }, [isEmpty]);

  const [gestureOn, setGestureOn] = useState(false);
  const onReleaseRef = useRef(onRelease);
  useEffect(() => {
    onReleaseRef.current = onRelease;
  }, [onRelease]);

  useEffect(
    () => () => {
      if (cleanupTimerRef.current) window.clearTimeout(cleanupTimerRef.current);
      if (tipTimerRef.current) window.clearTimeout(tipTimerRef.current);
      animStyleRef.current?.remove();
      overlayRef.current?.remove();
    },
    []
  );

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onInput = () => {
      if (triggeredRef.current) return;
      if (progressRef.current > 0) {
        progressRef.current = 0;
        clearVisualStyles();
        askedRef.current = false;
        confirmedRef.current = false;
      }
    };
    wrap.addEventListener("input", onInput);
    return () => wrap.removeEventListener("input", onInput);
  }, []);

  function clearVisualStyles() {
    const wrap = wrapRef.current;
    if (!wrap) return;
    wrap.style.filter = "";
    wrap.style.opacity = "";
    wrap.style.transform = "";
    wrap.style.userSelect = "";
    wrap.style.visibility = "";
  }

  function clearOverlay() {
    if (overlayRef.current) {
      overlayRef.current.remove();
      overlayRef.current = null;
    }
  }

  function triggerDispersal() {
    const zone = zoneRef.current;
    const wrap = wrapRef.current;
    if (!zone || !wrap) return;
    triggeredRef.current = true;
    const rect = wrap.getBoundingClientRect();

    wrap.style.visibility = "hidden";
    wrap.style.pointerEvents = "none";

    clearOverlay();
    animStyleRef.current?.remove();

    const clone = wrap.cloneNode(true);
    Object.assign(clone.style, {
      filter: "",
      opacity: "",
      transform: wrap.style.transform || "",
      userSelect: "",
      visibility: "visible",
      position: "absolute",
      left: "0",
      top: "0",
      margin: "0",
      width: rect.width + "px",
      height: rect.height + "px",
      pointerEvents: "none",
    });
    clone.setAttribute("aria-hidden", "true");

    const liveFields = wrap.querySelectorAll("input, textarea");
    const cloneFields = clone.querySelectorAll("input, textarea");
    cloneFields.forEach((cf, i) => {
      const src = liveFields[i];
      const div = document.createElement("div");
      div.textContent = src ? String(src.value ?? "") : "";
      if (src) {
        const cs = window.getComputedStyle(src);
        Object.assign(div.style, {
          font: cs.font,
          lineHeight: cs.lineHeight,
          letterSpacing: cs.letterSpacing,
          color: cs.color,
          background: "transparent",
          padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
          margin: `${cs.marginTop} ${cs.marginRight} ${cs.marginBottom} ${cs.marginLeft}`,
          borderWidth: cs.borderWidth,
          borderStyle: "solid",
          borderColor: "transparent",
          borderRadius: cs.borderRadius,
          minHeight: cs.height,
          width: "100%",
          boxSizing: "border-box",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflow: "hidden",
        });
      }
      cf.replaceWith(div);
    });

    clone.querySelectorAll("button").forEach((btn) => {
      btn.style.background = "transparent";
      btn.style.borderColor = "transparent";
      btn.style.boxShadow = "none";
    });

    const styleEl = document.createElement("style");
    styleEl.textContent = buildCharVariantKeyframes();
    document.head.appendChild(styleEl);
    animStyleRef.current = styleEl;

    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    const { mode, perNode } = releaseBuildChunks(textNodes);
    const queue = [];
    textNodes.forEach((node, i) => {
      const container = document.createElement("span");
      container.style.cssText = "display:inline;white-space:pre-wrap;";
      for (const it of perNode[i]) {
        queue.push({
          container,
          ws: !!it.ws,
          text: it.text,
          len: it.text.length,
        });
      }
      node.parentNode.replaceChild(container, node);
    });

    Object.assign(clone.style, {
      position: "fixed",
      left: rect.left + "px",
      top: rect.top + "px",
      zIndex: "60",
    });
    document.body.appendChild(clone);
    overlayRef.current = clone;

    let qi = 0;
    let maxEnd = performance.now();
    const spanWhite = mode === "line" ? "pre-wrap" : "pre";
    function launchFrame(now) {
      let budget = 20;
      while (qi < queue.length && budget > 0) {
        const job = queue[qi++];
        if (job.ws) {
          job.container.appendChild(document.createTextNode(job.text));
          continue;
        }
        budget -= job.len;
        const variant = Math.floor(Math.random() * CHAR_VARIANTS);
        const delay = Math.random() * 300;
        const span = document.createElement("span");
        span.textContent = job.text;
        span.style.cssText =
          `display:inline-block;white-space:${spanWhite};will-change:transform,opacity;` +
          `animation:diary-release-chv-${variant} 1800ms cubic-bezier(.2,.7,.2,1) ${delay.toFixed(0)}ms forwards;`;
        span.addEventListener(
          "animationend",
          () => { span.style.willChange = ""; },
          { once: true }
        );
        job.container.appendChild(span);
        maxEnd = Math.max(maxEnd, now + 1800 + delay);
      }
      if (qi < queue.length) {
        requestAnimationFrame(launchFrame);
      } else {
        const wait = Math.max(0, maxEnd - performance.now()) + 50;
        cleanupTimerRef.current = window.setTimeout(finishDispersal, wait);
      }
    }

    async function finishDispersal() {
      clearOverlay();
      animStyleRef.current?.remove();
      animStyleRef.current = null;

      showBrandAnchor(rect);

      cleanupTimerRef.current = window.setTimeout(async () => {
        let ret;
        try {
          ret = await Promise.resolve(onReleaseRef.current?.());
        } catch {
          ret = "操作没完成，请再试一次";
        }
        restoreAfterRelease();
        if (typeof ret === "string") flashTip(ret, 2200);
      }, 2600);
    }

    requestAnimationFrame(launchFrame);
  }

  function restoreAfterRelease() {
    progressRef.current = 0;
    triggeredRef.current = false;
    askedRef.current = false;
    confirmedRef.current = false;
    const wrap = wrapRef.current;
    if (!wrap) return;
    wrap.style.visibility = "";
    wrap.style.pointerEvents = "";
    wrap.style.filter = "";
    wrap.style.opacity = "";
    wrap.style.transform = "";
    wrap.style.userSelect = "";
  }

  function showBrandAnchor(rect) {
    if (!rect) return;
    const el = document.createElement("div");
    el.textContent = "交给 Solace吧";
    Object.assign(el.style, {
      position: "fixed",
      left: rect.left + "px",
      top: rect.top + "px",
      width: rect.width + "px",
      height: rect.height + "px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      textAlign: "center",
      fontSize: "34px",
      fontWeight: "600",
      color: "#C98BA4",
      letterSpacing: "0.08em",
      pointerEvents: "none",
      zIndex: "61",
      animation: "diary-release-brand 2500ms ease-in-out forwards",
    });
    if (!document.getElementById("diary-release-brand-style")) {
      const s = document.createElement("style");
      s.id = "diary-release-brand-style";
      s.textContent = DIARY_RELEASE_BRAND_KEYFRAME;
      document.head.appendChild(s);
    }
    document.body.appendChild(el);
    window.setTimeout(() => el.remove(), 2600);
  }

  const [askConfirm, setAskConfirm] = useState(false);
  const askRef = useRef(false);
  const askedRef = useRef(false);
  const confirmedRef = useRef(false);

  function handleConfirmCancel() {
    askRef.current = false;
    setAskConfirm(false);
    askedRef.current = false;
    confirmedRef.current = false;
    progressRef.current = 0;
    clearVisualStyles();
    const wrapEl = wrapRef.current;
    if (wrapEl) wrapEl.style.userSelect = "";
  }

  function handleConfirmOk() {
    askRef.current = false;
    setAskConfirm(false);
    confirmedRef.current = true;
  }

  function handlePointerDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (triggeredRef.current) return;

    gestureRef.current = {
      down: true,
      armed: false,
      dead: false,
      path: 0,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
    };
    setGestureOn(true);
  }

  useEffect(() => {
    if (!gestureOn) return;
    const g = gestureRef.current;

    function onMove(e) {
      if (!g.down || triggeredRef.current) return;
      if (g.dead) return;

      const dx = e.clientX - g.lastX;
      const dy = e.clientY - g.lastY;
      const pathInc = Math.abs(dx) + Math.abs(dy);

      g.lastX = e.clientX;
      g.lastY = e.clientY;
      g.path = (g.path || 0) + pathInc;

      if (!g.armed) {
        if (g.path < RELEASE_ARM_PX) return;

        if (isEmptyRef.current?.()) {
          g.dead = true;
          progressRef.current = 0;
          clearVisualStyles();
          try { window.getSelection()?.removeAllRanges(); } catch { /* 忽略 */ }
          flashTip("你还没有写日记呢");
          return;
        }

        g.armed = true;
        const wrapEl = wrapRef.current;
        if (wrapEl) {
          wrapEl.style.userSelect = "none";
          try { e.target?.style?.setProperty?.("touch-action", "none"); } catch { /* 忽略 */ }
        }
        try {
          window.getSelection()?.removeAllRanges();
        } catch {
          /* 忽略 */
        }
      }

      e.preventDefault();

      if (askRef.current) return;

      progressRef.current = Math.min(100, progressRef.current + (pathInc / RELEASE_TOTAL_PX) * 100);
      const p = progressRef.current;

      if (p >= 30 && !askedRef.current && !confirmedRef.current) {
        askedRef.current = true;
        askRef.current = true;
        setAskConfirm(true);
        return;
      }

      const wrap = wrapRef.current;
      if (wrap) {
        const s = progressToStyle(p);
        wrap.style.filter = s.filter;
        wrap.style.opacity = s.opacity;
        wrap.style.transform = s.transform;
      }

      if (p >= 100 && !triggeredRef.current) {
        g.down = false;
        setGestureOn(false);
        triggerDispersal();
      }
    }

    function onUp() {
      g.down = false;
      setGestureOn(false);
      if (!g.armed) return;
      const wrapEl = wrapRef.current;
      if (wrapEl) wrapEl.style.userSelect = "";
    }

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [gestureOn]);

  return (
    <div>
      <div ref={zoneRef} style={{ position: "relative" }}>
        <div
          ref={wrapRef}
          onPointerDown={handlePointerDown}
          className="touch-none [&_input]:touch-none [&_textarea]:touch-none"
        >
          {children}
        </div>
        <ConfirmModal
          open={askConfirm}
          message="确定要删除这段记忆吗？"
          confirmText="确定"
          cancelText="取消"
          onConfirm={handleConfirmOk}
          onClose={handleConfirmCancel}
        />
      </div>
      {hint ? (
        <p className="mt-1 mb-3 text-[11px] leading-4 text-slate-300 dark:text-[#7D6E66] select-none">{hint}</p>
      ) : null}

      {tipText ? (
        <div
          key={tipText}
          className="fixed left-1/2 bottom-[18%] -translate-x-1/2 z-[80] pointer-events-none
                     px-5 py-2.5 rounded-full bg-[#FFF8F5]/95 dark:bg-[#2A221E] shadow-[0_6px_20px_rgba(91,60,60,0.16)]
                     border border-[#f0e2dc] dark:border-[#4B372D] text-[#3D3535] dark:text-[#F5DCD3] text-sm tracking-wide
                     animate-[diary-empty-tip_1900ms_ease-in-out_forwards]
                     max-w-[82vw] text-center"
        >
          {tipText}
        </div>
      ) : null}
    </div>
  );
}

