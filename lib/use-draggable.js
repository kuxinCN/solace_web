"use client";

/**
 * 让一个 `fixed` 定位的浮标（小球 / 小图标）**可以被拖动，并记住位置**。
 *
 * ⚠️ 为什么抽成 hook：音乐播放器和压力读数都要这个能力，而"拖动"这件事
 *    的坑比看起来多 —— 下面每条注释都对应一个真实会踩到的问题。
 *
 * 用法：
 * ```jsx
 * const { ref, style, handlers, dragging, shouldIgnoreClick } = useDraggable({
 *   storageKey: "solace_music_ball",
 *   defaultRight: 16,
 *   defaultBottom: 96,
 * });
 *
 * <button
 *   ref={ref}
 *   style={style}
 *   {...handlers}
 *   onClick={() => { if (shouldIgnoreClick()) return; setExpanded(true); }}
 *   className={dragging ? "cursor-grabbing" : "cursor-grab"}
 * >…</button>
 * ```
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** 位移超过这么多像素才算"拖动"，否则算"点击" */
const DRAG_THRESHOLD = 4;

/** 离屏幕边缘至少留这么多像素 */
const MARGIN = 12;

export function useDraggable({
  storageKey,
  defaultRight = null,
  defaultBottom = null,
  defaultLeft = MARGIN,
  defaultTop = MARGIN,
}) {
  const ref = useRef(null);

  /** `null` = 位置还没算出来（首帧先隐藏，避免"先出现在角落再跳过去"的闪烁） */
  const [pos, setPos] = useState(null);
  const [dragging, setDragging] = useState(false);

  /** 拖动过程中的临时状态放到 ref —— 它每帧都变，走 state 会把组件重渲染爆 */
  const dragRef = useRef({
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
    startLeft: 0,
    startTop: 0,
    // ⚠️ 拖动过程中的**最新**坐标，给 finishDrag 落盘用。
    //    不能靠 `setPos` 的 updater 去写 localStorage —— updater 必须是**纯函数**：
    //    StrictMode 下 React 会双调用它，并发渲染下还可能根本不调用（更新被丢弃），
    //    那种时候位置就**静默丢了**。
    lastLeft: 0,
    lastTop: 0,
    // 拖动期间的元素尺寸 + rAF 合帧暂存（见 onPointerDown / onPointerMove）
    width: 44,
    height: 44,
    pendingLeft: 0,
    pendingTop: 0,
    rafId: null,
  });

  /** 把坐标夹进可视区 */
  const clamp = useCallback((left, top, width, height) => {
    const maxLeft = Math.max(MARGIN, window.innerWidth - width - MARGIN);
    const maxTop = Math.max(MARGIN, window.innerHeight - height - MARGIN);

    return {
      left: Math.min(Math.max(MARGIN, left), maxLeft),
      top: Math.min(Math.max(MARGIN, top), maxTop),
    };
  }, []);

  /** 量一下元素尺寸（量不到就给个兜底值，别让整条逻辑挂掉） */
  const measure = useCallback(() => {
    const rect = ref.current?.getBoundingClientRect();
    return { width: rect?.width || 44, height: rect?.height || 44 };
  }, []);

  // ① 挂载时定位置：优先用记住的，没有就用默认位
  useEffect(() => {
    let saved = null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Number.isFinite(parsed?.left) && Number.isFinite(parsed?.top)) {
          saved = { left: parsed.left, top: parsed.top };
        }
      }
    } catch {
      /* 读不出来就当没有 */
    }

    const { width, height } = measure();

    if (saved) {
      setPos(clamp(saved.left, saved.top, width, height));
      return;
    }

    const left =
      defaultRight != null ? window.innerWidth - width - defaultRight : defaultLeft;
    const top =
      defaultBottom != null ? window.innerHeight - height - defaultBottom : defaultTop;

    setPos(clamp(left, top, width, height));
  }, [storageKey, defaultLeft, defaultTop, defaultRight, defaultBottom, clamp, measure]);

  // ② 窗口尺寸变化时把球拉回可视区
  //
  // ⚠️ 不做这一步的话：用户在宽屏上把球拖到最右边 → 换个小窗口 →
  //    球在屏幕外，**永远点不到了**（而且位置记在 localStorage 里，刷新也回不来）。
  useEffect(() => {
    if (pos == null) return;

    const onResize = () => {
      const { width, height } = measure();
      setPos((current) => (current ? clamp(current.left, current.top, width, height) : current));
    };

    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [pos == null, clamp, measure]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 拖动进行中：更新位置。挂在 window 上由 onPointerDown 注册，finishDrag 移除。 */
  const onPointerMove = useCallback(
    (event) => {
      const state = dragRef.current;
      if (!state.active) return;

      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;

      // ⚠️ **阈值判断**：手抖 1-2px 不该算拖动 ——
      //    否则用户只想点一下，却被当成拖，连带 click 也被吃掉（"点了没反应"）。
      if (!state.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;

      if (!state.moved) {
        state.moved = true;
        setDragging(true);
      }

      // 尺寸用按下时量好的，不再每次 getBoundingClientRect（强制布局，手机上很伤）
      const next = clamp(state.startLeft + dx, state.startTop + dy, state.width, state.height);

      // ⚠️ 顺手把**最新坐标**记到 ref —— `finishDrag` 要拿它落盘，
      //    而不是在 `setState` 的 updater 里写 localStorage（updater 必须是纯函数）
      state.lastLeft = next.left;
      state.lastTop = next.top;

      // ⚠️ **拖动全程不走 setState**：触摸屏的 pointermove 最高 120Hz+，
      //    每个事件都 re-render 在手机上必然掉帧。这里只把最新坐标写进 ref，
      //    再用 rAF 合帧 —— 每帧最多直接写一次 style（绕过 React）。
      //    松手时 finishDrag 再用 setPos 一次性把最终位置同步回 React + localStorage。
      state.pendingLeft = next.left;
      state.pendingTop = next.top;
      if (state.rafId == null) {
        state.rafId = window.requestAnimationFrame(() => {
          state.rafId = null;
          const el = ref.current;
          if (!el) return;
          el.style.left = `${state.pendingLeft}px`;
          el.style.top = `${state.pendingTop}px`;
        });
      }
    },
    [clamp]
  );

  const onPointerDown = useCallback(
    (event) => {
      // 只响应主键（鼠标左键 / 触摸 / 笔）
      if (event.button != null && event.button !== 0) return;

      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;

      dragRef.current = {
        active: true,
        moved: false,
        startX: event.clientX,
        startY: event.clientY,
        startLeft: rect.left,
        startTop: rect.top,
        // 尺寸只在按下时量这一次，pointermove 里直接用（见 onPointerMove）
        width: rect.width || 44,
        height: rect.height || 44,
        pendingLeft: rect.left,
        pendingTop: rect.top,
        rafId: null,
      };

      // ⚠️ **不要** `setPointerCapture`：
      //    捕获会把之后的指针事件（含 pointerup 补发的 click）全部锁定到捕获元素，
      //    把手里的子按钮（如收起 ×）就永远收不到 click —— 表现为"点不动"。
      //    改用 **window 级 pointermove 监听**：指针移出把手也能继续拖，
      //    而且 click 会正常传播到子元素。
      window.addEventListener("pointermove", onPointerMove);
    },
    [onPointerMove]
  );

  const finishDrag = useCallback(
    (event) => {
      const state = dragRef.current;
      if (!state.active) return;

      state.active = false;
      setDragging(false);

      // 拖动已经改由 window 级监听驱动，这里只需把监听拆掉
      window.removeEventListener("pointermove", onPointerMove);

      // 收掉还没执行的 rAF：最终位置由下面的 setPos 一次性同步，避免两套写法打架
      if (state.rafId != null) {
        window.cancelAnimationFrame(state.rafId);
        state.rafId = null;
      }

      // 没真的动过 → 当作点击，位置不用存
      if (!state.moved) return;
      if (!Number.isFinite(state.lastLeft) || !Number.isFinite(state.lastTop)) return;

      // ⚠️ 落盘**不能放在 `setPos` 的 updater 里** —— updater 必须是纯函数：
      //    React 在 StrictMode 下会双调用它，并发渲染下还可能根本不调用（更新被丢弃），
      //    那种时候位置就**静默丢了**（用户下次打开，球莫名回到默认角落）。
      //    这里直接用拖动过程中记下的最终坐标。
      setPos({ left: state.lastLeft, top: state.lastTop });

      try {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify({ left: state.lastLeft, top: state.lastTop })
        );
      } catch {
        /* 存不了就算了，只是这次会话有效 */
      }
    },
    [storageKey, onPointerMove]
  );

  /**
   * ⚠️ **兜底收尾**：拖动用 window 级 pointermove 监听驱动，松手 / 取消总能在
   *    window 上收到 —— 即使指针滑出窗口、或某个环境吞掉了元素上的 pointerup，
   *    `finishDrag` 也会执行，不会出现"卡在拖动中"。
   */
  useEffect(() => {
    const onUp = () => {
      if (dragRef.current.active) finishDrag({});
    };

    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);

    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [finishDrag]);

  /**
   * 点击守卫。
   * ⚠️ 拖动结束时浏览器**仍会**补一个 click 事件（pointerup → click），
   *    所以 onClick 里必须先问一句"刚才是不是在拖"，否则一拖就会顺手展开面板。
   *
   * ⚠️ 读完**立刻复位**：用键盘（Enter / Space）触发 click 时不会走 pointerdown，
   *    上一次拖动留下的 `moved = true` 会**吞掉一次点击**（球点不开）。
   */
  const shouldIgnoreClick = useCallback(() => {
    const wasMoved = dragRef.current.moved;
    dragRef.current.moved = false;
    return wasMoved;
  }, []);

  /**
   * 重新夹一次边界。
   *
   * ⚠️ 用在"**容器尺寸会变**"的场景：音乐浮窗收起时是 40px 的小球、
   *    展开后是 320px 的面板。如果用户在收起态把球拖到屏幕右边再展开，
   *    面板会有一部分跑到屏幕外 —— 而那时小球已经变成面板了，
   *    **用户没东西可拖，位置就卡死了**。所以在展开 / 收起时各调一次。
   */
  const reclamp = useCallback(() => {
    const { width, height } = measure();
    setPos((current) => (current ? clamp(current.left, current.top, width, height) : current));
  }, [clamp, measure]);

  return {
    ref,
    dragging,
    shouldIgnoreClick,
    reclamp,
    // 位置算出来之前先藏起来：避免"先渲染在默认角落、下一帧才跳到记忆位置"的闪动
    style:
      pos == null
        ? { visibility: "hidden" }
        : { left: pos.left, top: pos.top, right: "auto", bottom: "auto" },
    handlers: {
      onPointerDown,
      // ⚠️ 没有 onPointerMove —— 拖动由 window 级监听驱动（见 onPointerDown），
      //    元素本身不监听 move；onPointerUp/Cancel 都指向 finishDrag，幂等无害。
      onPointerUp: finishDrag,
      onPointerCancel: finishDrag,
    },
  };
}
