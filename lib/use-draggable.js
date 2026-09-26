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

  const onPointerDown = useCallback((event) => {
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
    };

    // ⚠️ `setPointerCapture`：指针移出小球之后**仍然能收到 move 事件**。
    //    不捕获的话，快速拖动时指针一离开元素，拖动就"掉"了（球粘在原地）。
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* 个别环境不支持，忽略 —— 慢一点拖还是能用的 */
    }
  }, []);

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

      const { width, height } = measure();
      const next = clamp(state.startLeft + dx, state.startTop + dy, width, height);

      // ⚠️ 顺手把**最新坐标**记到 ref —— `finishDrag` 要拿它落盘，
      //    而不是在 `setState` 的 updater 里写 localStorage（updater 必须是纯函数）
      state.lastLeft = next.left;
      state.lastTop = next.top;

      setPos(next);
    },
    [clamp, measure]
  );

  const finishDrag = useCallback(
    (event) => {
      const state = dragRef.current;
      if (!state.active) return;

      state.active = false;
      setDragging(false);

      try {
        event?.currentTarget?.releasePointerCapture?.(event.pointerId);
      } catch {
        /* 同上 */
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
    [storageKey]
  );

  /**
   * ⚠️ **兜底**：`setPointerCapture` 在个别环境下会失败（我们上面用 try/catch 忽略了）。
   *    那种时候指针一移出元素就收不到 `pointerup`，`finishDrag` 永远不执行 ——
   *    `dragging` 会**永久停在 true**（光标卡在 grabbing，看着像卡死）。
   *    所以在 window 上再听一对 pointerup / pointercancel，它总能收到。
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
      onPointerMove,
      onPointerUp: finishDrag,
      onPointerCancel: finishDrag,
    },
  };
}
