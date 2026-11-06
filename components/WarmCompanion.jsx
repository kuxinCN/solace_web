"use client";

import { useEffect, useRef, useState } from "react";
import { toneOf, NO_DATA_TONE, StressRing } from "@/components/StressMeter";
import ThemeModal from "@/components/ThemeModal";
import { getStoredTheme, THEME_MODES } from "@/lib/theme";

/**
 * 2D 人形桌宠「暖言」：单图 sprite + 纯 CSS 动画（接替蓝蝴蝶，原 ButterflyEffect.jsx 保留未删）。
 *
 * 交互模型（三段式连击）：
 *   点本体 → clickBounce（0.2s 压缩回弹）
 *   第 1 次 → 气泡「你好，我在。」
 *   第 5 次 → 气泡「你点我干嘛呢？是不是想我了？想我就跟我聊天吧～」
 *   第 10 次 → 假生气 3.5 秒：angry 帧 + 头顶蒸汽 + 💢 浮动 + 生气文案，期间点击完全无视
 *   2 秒内没再点 → 计数器自动清零（重置定时器）
 *   3.5 秒到 → 平滑淡回待机帧、隐藏蒸汽、计数彻底清零、恢复眨眼
 *   没有任何情绪按钮，也不监听对话情绪事件，桌宠自身不发任何请求。
 *
 * 四层结构（transform 各占一层，互不覆盖）：
 *   外层 = 位置层：transform=translate(pos)，拖拽直接改 DOM，边界夹取，位置记忆 localStorage
 *   中层 = 动作层：clickBounce（直接改 DOM 重播，不重建节点）
 *   内层 = 呼吸层：warm-breathe 3s 无限浮动（animation 独占这一层 transform）
 *   视差层 = 探头层：perspective + rotateX/rotateZ + translateX，transform-origin: bottom center，
 *            鼠标移动时直接改 DOM style（rAF 合帧），离开窗口平滑归零
 *
 * 单图 sprite（帧：0=待机睁眼 1=半闭 2=全闭 3=生气 4=睡觉）：
 *   5 帧拼成一张图、src 恒定，切帧只改 translateX 做裁切 —— 位图常驻，不换图不解码，
 *   慢速眨眼、生气与睡觉切换都不会白闪；元素恒为 1 个，不可能叠罗汉。
 *
 * 眨眼帧动画（睁眼 → 半闭 → 全闭 → 半闭 → 睁眼，共约 860ms）：
 *   idle 140ms → half 200ms → blink 300ms → half 220ms → idle
 *   间隔 4~7 秒随机；生气中、睡觉中、贴边时暂停（从待机拖走不打断眨眼——拖拽只改位置）。
 *
 * 休眠模式（待机 60 秒自动睡着）：
 *   任何交互（点击 / 拖拽 / 鼠标移动 / 键盘 / 气泡操作）都会重置 60 秒计时；
 *   计时到 → 切睡觉帧、停呼吸与眨眼、改用更慢更小的 sleeping-breath、右上角飘 Zzz；
 *   睡觉中触碰本体 → 立刻醒、恢复待机呼吸与眨眼、重新计时；
 *   生气期间不会睡着，睡觉期间不做探头视差（画面保持安静）。
 *
 * 贴边睡眠（气泡「我去休息啦」；父组件也可传 tuckToEdge 走同一套飞入/飞出）：
 *   立刻切睡觉帧 + Zzz + 睡眠呼吸（停掉待机呼吸与眨眼），平滑飞到右边缘只露左半边；
 *   按下只记起点，抬手按位移分流：单击（<5px）→ 唤醒、飞回隐藏前位置、回待机帧；
 *   拖拽（≥5px）→ 保持睡觉图，可把她从边缘拖出来，松手停在原地继续睡；
 *   期间不计连击、不会生气、不眨眼、不被外部点击/键盘叫醒。
 *   聊天 Tab 切走时父组件把 tuckToEdge 置 true，复用本段飞入，不另开一套位置逻辑；
 *   切回聊天再置 false，若这次贴边是 Tab 触发的（不是用户点「我去休息啦」），再飞回原位。
 *
 * 犯困 → 打哈欠 → 入睡（60 秒全自动流水线）：
 *   无交互 58.45s（60s − 哈欠全程 1550ms）→ 自动 playYawn()：8 帧 150ms/帧，末帧停 500ms；
 *   哈欠播完正好 60s → 无缝 enterSleep()：切睡觉帧 + Zzz + 睡眠呼吸（pose 切换自带淡入）；
 *   任何交互（点击/拖拽/键盘/聊天状态变化）→ 打断哈欠回待机帧、计时归零重算；
 *   帧图独立成 warm_yawn_N.png（单图模式），挂载时全量预载，播放不闪白。
 */
const SPRITE = "/stickers/warm_pet_sprite.png?v=5"; // 带版本号，换了 sprite 不会被浏览器旧缓存挡住
const FRAME_INDEX = { idle: 0, half: 1, blink: 2, angry: 3, sleep: 4 };
const FRAME_COUNT = 5;

// ── 打哈欠序列帧：入睡流水线的前置阶段。分步图按 150ms/帧 顺序播放，末帧停留 500ms ──
// 帧数按 public/stickers 里实际的 warm_yawn_N.png 数量走；增删图片只改这里的数字
const YAWN_FRAME_COUNT = 8;
const YAWN_FRAMES = Array.from({ length: YAWN_FRAME_COUNT }, (_, i) => `/stickers/warm_yawn_${i + 1}.png`);
const YAWN_FRAME_MS = 150;
const YAWN_HOLD_MS = 500; // 最后一帧停留时长
const YAWN_TOTAL_MS = (YAWN_FRAME_COUNT - 1) * YAWN_FRAME_MS + YAWN_HOLD_MS; // 哈欠全程 1550ms

// ── 尺寸可调：默认 150px，滑块 80~200，持久化到 localStorage ──
const DEFAULT_SIZE = 150;
const MIN_SIZE = 80;
const MAX_SIZE = 200;
const SIZE_KEY = "solace_warm_companion_size";
// ≡ 菜单键显隐：隐藏后只能靠右键点她重新叫出来（防止一直挂个按钮挡脸）
const MENU_VISIBLE_KEY = "warm_menu_visible";
// 「我去休息啦」隐藏：贴右边缘只露一半身子；飞入/飞出过渡时长
const HIDE_FLY_MS = 450;

const HEIGHT = DEFAULT_SIZE; // 容器默认高度 150px；宽度同样默认，切帧时脚底对齐、位置不跳
const WIDTH = DEFAULT_SIZE;
const RIGHT_GAP = 8; // 默认落点贴右缘，把「发送」键的水平位置让出来
const INPUT_CLEARANCE = 20; // 输入条 / 发送键上方留白，避免默认坐标压住按钮
const FALLBACK_BOTTOM_GAP = 160; // 拿不到输入框时的兜底下边距（含输入条高度 + 留白）
const INPUT_BAR_SELECTOR = "[data-chat-input-bar]";
const SEND_SELECTOR = "[data-chat-send]";
const POS_KEY = "solace_warm_companion_pos"; // 位置记忆

const FADE_MS = 300; // 生完气淡回待机的时长
const BOUNCE_MS = 200; // 点击回弹时长

const BLINK_MIN_MS = 4000; // 眨眼间隔下限（慢眨眼不宜太频繁）
const BLINK_MAX_MS = 7000; // 眨眼间隔上限

// 三段式连击：每点一次 +1，2 秒内没有下一次点击就清零；满 10 次假生气 3.5 秒
const CLICK_RESET_MS = 2000;
const ANGRY_THRESHOLD = 10;
const ANGRY_DURATION_MS = 3500; // 生气持续 3.5 秒，期间点击全部无视
const LINE_FIRST = "你好，我在。"; // 第 1 次（含断连后的第一次）
const LINE_FIVE = "你点我干嘛呢？是不是想我了？想我就跟我聊天吧～"; // 第 5 次
const ANGRY_LINE = "哎呀，别戳啦，再戳我要生气了！"; // 第 10 次

// ── 用户输入唤醒：输入框聚焦/打字时强制结束生气、睡眠、哈欠等特殊状态 ──
const INPUT_WAKE_LINE = "今天要聊点什么呢？";
const INPUT_BUBBLE_MS = 4000; // 这条气泡 4 秒自动消失（用户发出消息会提前收掉）
// 外部让桌宠说话（生日祝福等）：气泡停留时间长一点，6 秒
const SAY_BUBBLE_MS = 6000;

// ── 压力波动感知：与「看看现在的状态」同源（stressData prop），分数变化 ≥5 时主动说话 ──
// 基线存 localStorage（刷新不重弹、跨刷新也能感知）；两个方向各自 2h 冷却（防反复刷测评变复读机）。
// ⚠️ 基线每次都跟着最新读数走 —— 冷却只挡气泡，不挡基线。
const PRESSURE_BASELINE_KEY = "solace_warm_pressure_baseline";
const PRESSURE_UP_CD_KEY = "solace_warm_pressure_up_cd";
const PRESSURE_DOWN_CD_KEY = "solace_warm_pressure_down_cd";
const PRESSURE_DELTA = 5; // 触发阈值：|本次 - 上次| ≥ 5 分
const PRESSURE_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 小时
const PRESSURE_UP_LINE = "感受到你刚刚情绪波动很大，我在这里，一直在陪着你。"; // 飙升（含危机跳到 95）
const PRESSURE_DOWN_LINE = "最近状态看起来不错呢！看到你好转，我也跟着开心啦～"; // 回落

// 休眠：60 秒没有任何交互就睡着；睡眠中的呼吸更慢更小
const SLEEP_IDLE_MS = 60000;
const NEUTRAL_TILT = "perspective(600px) rotateX(0deg) rotateZ(0deg) translateX(0px)";

/**
 * 眨眼帧序列：[帧序号, 该帧停留毫秒]。
 * 慢速眨眼，全程约 860ms：
 *   睁眼 140 → 半闭 200（眼睑缓慢落下）→ 全闭 300（闭住停一下）→ 半睁 220 → 睁眼
 */
const BLINK_FRAMES = [
  [FRAME_INDEX.idle, 140],
  [FRAME_INDEX.half, 200],
  [FRAME_INDEX.blink, 300],
  [FRAME_INDEX.half, 220],
];

function readSavedPos() {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) return p;
  } catch {}
  return null;
}

function clampPos(x, y, w, h) {
  return {
    x: Math.max(0, Math.min(window.innerWidth - w, x)),
    y: Math.max(0, Math.min(window.innerHeight - h, y)),
  };
}

function rectsOverlap(x, y, w, h, r) {
  return x < r.right && x + w > r.left && y < r.bottom && y + h > r.top;
}

/** 无记忆位置时的默认锚点：聊天输入条上方、偏右下，若与「发送」相交就再上移 / 左让。 */
function defaultAnchor(w, h) {
  const bar = document.querySelector(INPUT_BAR_SELECTOR);
  const barTop = bar ? bar.getBoundingClientRect().top : 0;
  const useBar = barTop > window.innerHeight * 0.5;
  let x = window.innerWidth - w - RIGHT_GAP;
  let y = useBar ? barTop - h - INPUT_CLEARANCE : window.innerHeight - h - FALLBACK_BOTTOM_GAP;
  const send = document.querySelector(SEND_SELECTOR);
  if (send) {
    const s = send.getBoundingClientRect();
    if (rectsOverlap(x, y, w, h, s)) {
      y = s.top - h - INPUT_CLEARANCE;
    }
    if (rectsOverlap(x, y, w, h, s)) {
      x = s.left - w - 8;
    }
  }
  return clampPos(x, y, w, h);
}

export default function WarmCompanion({ stressData, aiThinking = false, tuckToEdge = false }) {
  // ── 拖动 ──
  const elRef = useRef(null);
  const imgRef = useRef(null);
  const bounceLayerRef = useRef(null); // 点击回弹层（AI 回应点头也复用它）
  const tiltRef = useRef(null); // 探头视差层（以脚底为轴微倾）
  const tiltRafRef = useRef(0);
  const movedRef = useRef(false);
  const startPosRef = useRef({ x: 0, y: 0 }); // pointerdown 起点，用于区分点击 / 拖动
  const offsetRef = useRef({ x: 0, y: 0 });
  const sizeRef = useRef({ w: WIDTH, h: HEIGHT }); // 挂载后按实测更新
  const [pos, setPos] = useState(null);

  // ── 动作仲裁器：所有动作状态统一为 currentState 字符串 ──
  //   优先级：dragging > angry > sleeping > listening > idle
  //   dragging  拖拽中，暂停其他一切
  //   angry     连击 10 次触发，持续 3.5s，期间无视聊天状态
  //   sleeping  60s 待机超时；点击或聊天变 listening 立刻唤醒
  //   listening AI 流式输出期间（aiThinking=true）
  //   idle      默认：呼吸 + 眨眼
  // hidden 是「贴边睡眠」模态：退到屏幕右边缘只露一半，动作状态固定 sleeping；
  // 单击唤醒飞回、拖拽拖出继续睡（不走 dragging 状态机，睡觉帧/Zzz/睡眠呼吸全程保持）
  const [currentState, setCurrentStateRaw] = useState("idle");
  const currentStateRef = useRef("idle"); // 事件回调读它，避免闭包旧值
  const preDragStateRef = useRef(null); // 拖拽进入前的状态：拖拽全程保持该姿态，松手回去
  function setState(next) {
    if (currentStateRef.current === next) return;
    currentStateRef.current = next;
    setCurrentStateRaw(next);
  }
  // 派生布尔：JSX / 渲染期使用，事件回调请用 currentStateRef.current
  const isDragging = currentState === "dragging";
  const isListening = currentState === "listening";
  const isThinking = isListening; // 与原变量名对齐
  // ⚠️ 拖拽是纯粹的位置改变，绝不干涉情绪状态机：
  // 视觉姿态（帧 / 呼吸 / Zzz / 蒸汽）一律看 poseState —— 拖拽中 = 拖拽前的状态
  const poseState = isDragging ? (preDragStateRef.current || "idle") : currentState;
  const poseAngry = poseState === "angry";
  const poseSleeping = poseState === "sleeping";

  // ── 气泡 / 眨眼 ──
  const [bubbleOpen, setBubbleOpen] = useState(false);
  const [bubbleText, setBubbleText] = useState(null);
  const [blinkFrame, setBlinkFrame] = useState(null); // 眨眼中的帧序号；null = 不在眨眼中
  const bubbleOpenRef = useRef(false); // 事件回调里读（避免闭包旧值）
  const bubbleTextRef = useRef(null); // 4 秒自动收气泡时判断"还是不是那条输入唤醒气泡"
  const inputBubbleTimerRef = useRef(null); // 输入唤醒气泡的 4 秒定时器
  // ── 压力波动感知：待弹的气泡文案（busy 时排队）；上次读数的 session 内缓存 ──
  const [pendingStress, setPendingStress] = useState(null);
  const lastStressScoreRef = useRef(null);
  // ── 功能面板（从气泡解耦出来的设置类操作）──
  const [panelOpen, setPanelOpen] = useState(false);
  const panelRef = useRef(null); // 判断点击面板内部不关闭
  const settingsBtnRef = useRef(null); // 判断点击 ≡ 按钮本身
  const panelHoverRef = useRef(false); // 鼠标悬停在面板上 → 暂停探头视差（拖滑块时她不乱转）
  // 拖动尺寸滑块期间冻结面板位置（快照 {left, top, transform}）：尺寸变化会改 pos，
  // 而面板锚在 pos 上，不冻结的话拖滑块时面板会跟着桌宠上下跑动
  const [panelFrozen, setPanelFrozen] = useState(null);
  // ≡ 菜单键显隐：默认显示，隐藏后靠右键点桌宠叫回来；初值固定 true（服务端无 localStorage，
  // 读它会导致 hydration mismatch），挂载后再从 localStorage 恢复
  const [isMenuBtnVisible, setIsMenuBtnVisible] = useState(true);
  const menuBtnVisibleRef = useRef(true); // 事件回调里读（避免闭包旧值）
  // ── 打哈欠 ──
  const [yawnSrc, setYawnSrc] = useState(null); // 非 null = 正在播放哈欠序列帧（值为当前帧 src），img 从 sprite 模式切到单图模式
  const yawnTimersRef = useRef([]); // 序列帧定时器组（排程由 idleTimer 统一负责）
  // ── 压力状态展开（移植自蝴蝶的「看看现在的状态」）──
  const [stressOpen, setStressOpen] = useState(false);
  // ── 氛围光效调节（温和暗光模式）──
  const [themeModalOpen, setThemeModalOpen] = useState(false);
  const [currentThemeMode, setCurrentThemeMode] = useState("day");

  useEffect(() => {
    const { mode } = getStoredTheme();
    setCurrentThemeMode(mode);

    const handleThemeChange = (e) => {
      if (e?.detail?.mode) {
        setCurrentThemeMode(e.detail.mode);
      }
    };
    window.addEventListener("solace-theme-change", handleThemeChange);
    return () => window.removeEventListener("solace-theme-change", handleThemeChange);
  }, []);

  // ── 尺寸可调 / 临时隐藏 ──
  const [petSize, setPetSize] = useState(DEFAULT_SIZE); // 用户可调 80~200，挂载后从 localStorage 恢复
  const [isHidden, setIsHidden] = useState(false); // 「我去休息啦」：贴右边缘只露一半
  const [flyTransition, setFlyTransition] = useState(false); // 飞入/飞出时给 transform 加平滑过渡
  const hiddenRef = useRef(false); // 事件回调里读（避免闭包旧值）
  const hiddenFromPosRef = useRef(null); // 隐藏前的位置，恢复时回去
  const flyTimeoutRef = useRef(null); // 飞行结束后关掉 transition，避免拖拽也跟着过渡
  const hiddenDragRef = useRef(null); // 贴边睡眠中的按下/拖拽判定：{startX,startY,offsetX,offsetY,moved,lastX,lastY}
  const dragCleanupRef = useRef(null); // 当前拖拽挂在 window 上的监听器清理函数（卸载/异常收尾用）
  const autoTuckRef = useRef(false); // 这次贴边是 Tab 切走触发的（用户自己藏起来的不在切回时唤醒）

  // ── Clicker 计数 ──
  const clickCountRef = useRef(0); // 连续点击次数
  const clickResetTimerRef = useRef(null); // 2 秒未再点击则清零
  const angryTimerRef = useRef(null);
  const longPressTimerRef = useRef(null); // 3.5 秒恢复定时器

  // ── 休眠计时 ──
  const idleTimerRef = useRef(null); // 60 秒无交互 → 睡着

  // 预加载 sprite + 打哈欠序列帧：之后所有切帧/换图都是内存命中，不闪白
  useEffect(() => {
    const img = new Image();
    img.src = SPRITE;
    img.decode?.().catch(() => {});
    YAWN_FRAMES.forEach((src) => {
      const f = new Image();
      f.src = src;
      f.decode?.().catch(() => {});
    });
  }, []);

  // 只有 idle 且未隐藏才眨眼；帧序号：生气→angry / 睡觉→sleep / 其他（idle/listening）→idle
  // ⚠️ 全看 poseState：拖拽中保持进入前的姿态（生气图/睡觉图不跌回待机帧，idle 拖走也不打断眨眼）
  const blinkEnabled = poseState === "idle" && !isHidden && !yawnSrc; // 打哈欠时不插播眨眼
  const frameIndex = blinkFrame ?? (
    poseAngry ? FRAME_INDEX.angry : poseSleeping ? FRAME_INDEX.sleep : FRAME_INDEX.idle
  );

  // ── AI「思考中」状态：主聊天链路在流式输出时把 aiThinking=true 传进来 ──
  // 仲裁：
  //   上升沿：idle / sleeping → listening（sleeping 被打断 = 唤醒）
  //           angry / dragging / hidden 不动（angry 优先级高于 listening，拖拽更高）
  //   下降沿：仅当仍处于 listening 才回 idle 并点头；angry/dragging/hidden 已被其他事件接管，不抢
  const prevAiThinkingRef = useRef(false);

  useEffect(() => {
    const was = prevAiThinkingRef.current;
    prevAiThinkingRef.current = aiThinking;

    if (aiThinking && !was) {
      const cur = currentStateRef.current;
      if (!hiddenRef.current && (cur === "idle" || cur === "sleeping")) {
        setState("listening");
      }
      return;
    }
    if (!aiThinking && was) {
      const cur = currentStateRef.current;
      if (cur === "listening") {
        setState("idle");
        if (!hiddenRef.current) playNod();
        resetIdleTimer(); // AI 回复完，重新开始 60s 待机计时
      } else if (cur === "dragging" && preDragStateRef.current === "listening") {
        // 拖拽错过了 listening 下降沿：把 preDrag 改成 idle，让 onPointerUp 拖完回 idle
        preDragStateRef.current = "idle";
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- playNod/resetIdleTimer 是稳定的
  }, [aiThinking]);

  /** AI 回应时的轻微点头：scale 0.95 → 1，带一点 overshoot，不重建节点 */
  function playNod() {
    const el = bounceLayerRef.current;
    if (!el) return;
    el.style.animation = "none";
    void el.offsetWidth; // 强制 reflow，让动画能重新播
    el.style.animation = "warm-nod 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)";
  }

  // 进入生气 / 睡着：瞬时硬切到新帧，再用淡入让它柔和上屏；醒来同样淡入回待机
  // ⚠️ 依赖 poseAngry/poseSleeping 而非状态机值：进入/结束拖拽时姿态不变，不重放淡入
  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;
    el.style.animation = "none";
    void el.offsetWidth; // 强制 reflow，让动画能从 0 重新开始
    el.style.animation = poseAngry
      ? "none" // 生气要"瞬间"上脸，不淡入
      : `warm-fade-in ${FADE_MS}ms ease forwards`;
  }, [poseAngry, poseSleeping]);

  // ── 眨眼调度：每 4~7 秒随机触发一次，按帧序列切 sprite 位移 ──
  useEffect(() => {
    if (!blinkEnabled) {
      setBlinkFrame(null); // 生气/拖拽：立刻停帧，回到当前基础帧
      return;
    }
    let cancelled = false;
    const timers = [];

    // 走帧：依次设置帧序号，每帧停留对应毫秒，结束后回待机帧
    const runFrames = (i) => {
      if (cancelled) return;
      if (i >= BLINK_FRAMES.length) {
        setBlinkFrame(null); // 睁眼
        scheduleNext();
        return;
      }
      const [frame, hold] = BLINK_FRAMES[i];
      setBlinkFrame(frame);
      timers.push(setTimeout(() => runFrames(i + 1), hold));
    };

    const scheduleNext = () => {
      if (cancelled) return;
      const delay = BLINK_MIN_MS + Math.random() * (BLINK_MAX_MS - BLINK_MIN_MS);
      timers.push(setTimeout(() => runFrames(0), delay));
    };

    scheduleNext();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [blinkEnabled]);

  // 挂载后定位：优先恢复记忆位置（夹取到可视区），否则右下角输入框上方
  useEffect(() => {
    const place = () => {
      const el = elRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      sizeRef.current = { w: r.width, h: r.height };
      const { w, h } = sizeRef.current;
      const clamp = (x, y) => ({
        x: Math.max(0, Math.min(window.innerWidth - w, x)),
        y: Math.max(0, Math.min(window.innerHeight - h, y)),
      });
      const saved = readSavedPos();
      if (saved) { setPos(clamp(saved.x, saved.y)); return; }
      setPos(defaultAnchor(w, h));
    };
    place();
    const raf = requestAnimationFrame(place); // 输入框可能晚一帧挂载，补一次
    return () => cancelAnimationFrame(raf);
  }, []);

  // 挂载后从 localStorage 恢复用户自定义尺寸
  // 注意：useState 初值始终是 DEFAULT_SIZE，不能在这里直接读 —— 服务端/静态预渲染没有 localStorage，
  // 读它会触发 hydration mismatch；挂载后再读，浏览器绘制前同步生效，用户看不到中间帧。
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SIZE_KEY);
      const n = Number(raw);
      if (Number.isFinite(n) && n >= MIN_SIZE && n <= MAX_SIZE) {
        setPetSize(Math.round(n));
      }
    } catch {}
  }, []);

  // 挂载后从 localStorage 恢复 ≡ 菜单键显隐（默认显示；存 "0" 才是隐藏）
  useEffect(() => {
    try {
      const hidden = localStorage.getItem(MENU_VISIBLE_KEY) === "0";
      setIsMenuBtnVisible(!hidden);
      menuBtnVisibleRef.current = !hidden;
    } catch {}
  }, []);

  // 面板关闭时解冻（下次打开重新按桌宠位置计算锚点）。
  // 注意：拖动滑块松手【不】解冻 —— 面板一旦因拖滑块冻结，就钉在打开时的位置直到面板关闭
  useEffect(() => {
    if (!panelOpen) setPanelFrozen(null);
  }, [panelOpen]);

  // 尺寸变化时：同步 sizeRef；没拖过的重新按"输入框上方"算默认位置（不挡发送按钮），
  // 拖过的 clamp 到可视区。隐藏中也保持贴右边缘露一半。
  useEffect(() => {
    sizeRef.current = { w: petSize, h: petSize };
    if (hiddenRef.current) {
      setPos((p) => ({
        x: window.innerWidth - petSize / 2,
        y: Math.max(0, Math.min(window.innerHeight - petSize, p?.y ?? window.innerHeight - petSize - 100)),
      }));
      return;
    }
    const saved = readSavedPos();
    if (!saved) {
      setPos(defaultAnchor(petSize, petSize));
      return;
    }
    setPos((p) => {
      if (!p) return p;
      const x = Math.max(0, Math.min(window.innerWidth - petSize, p.x));
      const y = Math.max(0, Math.min(window.innerHeight - petSize, p.y));
      return x === p.x && y === p.y ? p : { x, y };
    });
  }, [petSize]);

  // 窗口变化时拉回可视区；隐藏中保持贴右边缘露一半
  useEffect(() => {
    function onResize() {
      const el = elRef.current; if (!el) return;
      const { w, h } = sizeRef.current;
      if (hiddenRef.current) {
        setPos((p) => ({
          x: window.innerWidth - w / 2,
          y: Math.max(0, Math.min(window.innerHeight - h, p?.y ?? window.innerHeight - h - 100)),
        }));
        return;
      }
      const r = el.getBoundingClientRect();
      const x = Math.max(0, Math.min(window.innerWidth - r.width, r.left));
      const y = Math.max(0, Math.min(window.innerHeight - r.height, r.top));
      el.style.transform = `translate(${x}px,${y}px)`;
      setPos({ x, y });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ── 探头视差：鼠标相对本体的位置 → 以脚底为轴的微倾 ──
  // 直接改 DOM style（不 setState），pointermove 用 rAF 合帧；离开窗口时平滑归零。睡觉时暂停。
  useEffect(() => {
    const NEUTRAL = NEUTRAL_TILT;

    function onMove(e) {
      if (currentStateRef.current === "sleeping") return; // 睡着：画面保持安静，不做探头
      if (currentStateRef.current === "dragging") return; // 拖拽只改位置，不做探头
      if (hiddenRef.current) return; // 隐藏中：画面保持安静，不做探头
      if (panelHoverRef.current) return; // 鼠标在面板上（拖滑块等）：画面保持静止，不跟着转
      // 兜底：拖滑块时浏览器会把指针捕获到 input 上，hover 状态可能不可靠，
      // 但事件 target 一定还在面板里 —— 按 target 判断最稳
      if (panelRef.current?.contains(e.target)) return;
      if (tiltRafRef.current) return; // 同一帧内只算一次
      const cx0 = e.clientX;
      const cy0 = e.clientY;
      tiltRafRef.current = requestAnimationFrame(() => {
        tiltRafRef.current = 0;
        const el = tiltRef.current;
        const root = elRef.current;
        if (!el || !root) return;
        const r = root.getBoundingClientRect();
        // 鼠标相对本体中心的距离，按半屏归一化后夹到 ±1
        const dx = Math.max(-1, Math.min(1, (cx0 - (r.left + r.width / 2)) / (window.innerWidth / 2)));
        const dy = Math.max(-1, Math.min(1, (cy0 - (r.top + r.height / 2)) / (window.innerHeight / 2)));
        // 幅度刻意压很小，才像"微微探头"；大了就变成不倒翁
        const rz = dx * 2.5; // 左右倾斜 ±2.5deg
        const rx = -dy * 2; // 上下俯仰 ±2deg（鼠标在下 → 低头）
        const tx = dx * 3; // 轻微平移 ±3px
        el.style.transform =
          `perspective(600px) rotateX(${rx.toFixed(2)}deg) rotateZ(${rz.toFixed(2)}deg) translateX(${tx.toFixed(2)}px)`;
      });
    }

    function onLeave() {
      const el = tiltRef.current;
      if (el) el.style.transform = NEUTRAL;
    }

    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("mouseleave", onLeave);
    document.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("mouseleave", onLeave);
      document.removeEventListener("pointerleave", onLeave);
      if (tiltRafRef.current) cancelAnimationFrame(tiltRafRef.current);
      tiltRafRef.current = 0;
    };
  }, []);

  // ── 打哈欠序列帧控制器（入睡流水线的前置阶段）──
  // 排程在 resetIdleTimer：无交互 58.45s（SLEEP_IDLE_MS − YAWN_TOTAL_MS）触发 playYawn；
  // 播完正好 60s，无缝 enterSleep。任何状态离开 idle（点击/拖拽进 dragging、生气、
  // listening、贴边）都会触发下面的 effect 立刻中断哈欠、切回待机帧。

  /** 中断哈欠：清掉序列帧定时器，立刻切回待机帧（sprite 模式） */
  function cancelYawn() {
    yawnTimersRef.current.forEach(clearTimeout);
    yawnTimersRef.current = [];
    setYawnSrc(null);
  }

  /** 播放哈欠：150ms/帧顺序切图，末帧停留 500ms，播完无缝进入睡眠 */
  function playYawn() {
    if (currentStateRef.current !== "idle" || hiddenRef.current) return;
    cancelYawn(); // 防重入
    YAWN_FRAMES.forEach((src, i) => {
      yawnTimersRef.current.push(setTimeout(() => setYawnSrc(src), i * YAWN_FRAME_MS));
    });
    yawnTimersRef.current.push(setTimeout(() => {
      setYawnSrc(null);
      enterSleep(); // 60s 节点到：切睡觉帧 + Zzz + 睡眠呼吸（pose 切换自带淡入）
    }, YAWN_TOTAL_MS));
  }

  // 哈欠打断 effect：只要不在 idle（或贴边），立刻中断哈欠回待机帧
  useEffect(() => {
    if (currentState !== "idle" || isHidden) cancelYawn();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cancelYawn 是稳定的
  }, [currentState, isHidden]);

  // ── 功能面板点击空白处关闭 ──
  useEffect(() => {
    if (!panelOpen) return;
    function onDocClick(e) {
      const t = e.target;
      if (!t) return;
      if (panelRef.current && panelRef.current.contains(t)) return; // 点面板内部不关
      // 点 ≡ 按钮本身时不在此关闭（按钮 onClick 会处理切换）
      if (settingsBtnRef.current && settingsBtnRef.current.contains(t)) return;
      setPanelOpen(false);
    }
    document.addEventListener("mousedown", onDocClick, { capture: true });
    return () => document.removeEventListener("mousedown", onDocClick, { capture: true });
  }, [panelOpen]);

  /** 切换功能面板：打开时先叫醒 sleeping / 关闭 bubble（两者互斥） */
  function togglePanel() {
    if (panelOpen) {
      setPanelOpen(false);
      return;
    }
    // 先叫醒 sleeping 状态（正常站着才能调设置）
    if (currentStateRef.current === "sleeping") wakeUp();
    setBubbleOpen(false); // 互斥：开面板就关对话气泡
    setPanelOpen(true);
  }

  /** 设置 ≡ 菜单键显隐并持久化（隐藏时顺手关面板，不然会留下一个打不开的面板） */
  function setMenuVisible(v) {
    setIsMenuBtnVisible(v);
    menuBtnVisibleRef.current = v;
    try { localStorage.setItem(MENU_VISIBLE_KEY, v ? "1" : "0"); } catch {}
    if (!v) setPanelOpen(false);
  }

  /**
   * 右键点桌宠：屏蔽浏览器默认菜单，并把 ≡ 按钮叫回来。
   * 只动 UI 显隐 —— 不改 currentState（睡觉就继续睡，按钮浮在睡觉图上，点 ≡ 时 togglePanel 会叫醒）；
   * 不碰 clickCountRef（右键不计数），也不进拖拽（onPointerDown 已过滤 button !== 0）。
   */
  function onContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!menuBtnVisibleRef.current) setMenuVisible(true);
  }

  /** 睡着：切睡觉帧、停眨眼、收起气泡、视差归零。仅 idle 可进入（由 resetIdleTimer 保证）。 */
  function enterSleep() {
    if (currentStateRef.current !== "idle" || hiddenRef.current) return;
    setBlinkFrame(null); // 若正眨到一半，先回正，避免切睡觉帧时卡在半闭眼
    setState("sleeping");
    setBubbleOpen(false);
    setBubbleText(null);
    clickCountRef.current = 0;
    clearTimeout(clickResetTimerRef.current);
    if (tiltRef.current) tiltRef.current.style.transform = NEUTRAL_TILT;
  }

  /** 醒来：从 sleeping 回 idle，呼吸与眨眼由 blinkEnabled / 帧序号自动恢复 */
  function wakeUp() {
    if (currentStateRef.current !== "sleeping") return;
    setState("idle");
  }

  /** 输入唤醒气泡：4 秒后自动收（只收"还是这条文案"的情况，免得把新气泡提前关掉） */
  function showInputBubble() {
    clearTimeout(inputBubbleTimerRef.current);
    setBubbleText(INPUT_WAKE_LINE);
    setBubbleOpen(true);
    inputBubbleTimerRef.current = setTimeout(() => {
      inputBubbleTimerRef.current = null;
      if (bubbleTextRef.current !== INPUT_WAKE_LINE) return; // 已被别的文案顶替
      setBubbleOpen(false);
      setBubbleText(null);
    }, INPUT_BUBBLE_MS);
  }

  /**
   * 用户在输入框聚焦 / 开始打字 → 强制结束一切特殊状态，回待机。
   *
   * ⚠️ 这是**唯一**能从外部打断生气 / 睡眠 / 打哈欠的入口，刻意做成最高优先级：
   *    生气倒计时、连击计数、哈欠序列帧、排队中的压力气泡全部清掉，蒸汽💢 / Zzz 随姿态一起消失，
   *    img 靠 poseAngry/poseSleeping 变化平滑淡回待机帧，呼吸与眨眼自动恢复。
   *
   * ⚠️ 拖拽中不打断：此时指针还按在本体上，强行改状态会让 pointerup 的点击/拖拽判定错乱。
   *    （实际上聚焦输入框和拖着她也不可能同时发生，这只是防御。）
   */
  function forceWakeForInput() {
    if (currentStateRef.current === "dragging") return;

    clearTimeout(angryTimerRef.current);
    angryTimerRef.current = null;
    clearTimeout(clickResetTimerRef.current);
    clickCountRef.current = 0;

    cancelYawn(); // 哈欠序列帧 + 它的"播完就睡"收尾定时器一起清
    clearIdleTimer();
    setPendingStress(null); // 用户已经在打字了，排队中的搭话不再插嘴
    setBlinkFrame(null); // 眨到一半先回正，避免切帧时闪一帧闭眼
    setStressOpen(false);
    if (tiltRef.current) tiltRef.current.style.transform = NEUTRAL_TILT;

    if (hiddenRef.current) {
      showPet(); // 贴边睡眠：飞回原位（内部已 setState("idle") + 重排待机计时）
    } else {
      setState("idle");
      resetIdleTimer();
    }
    showInputBubble();
  }

  /**
   * 外部让暖言说一句话（warm-say 事件）：只换气泡文案，不动状态机。
   * ⚠️ 不复用 showInputBubble：那条的 4 秒定时器认死 INPUT_WAKE_LINE，
   *    这里必须认"自己这条文案"，否则会把刚弹出来的新气泡提前收掉。
   */
  function showSayBubble(text) {
    clearTimeout(inputBubbleTimerRef.current);
    setBubbleText(text);
    setBubbleOpen(true);
    inputBubbleTimerRef.current = setTimeout(() => {
      inputBubbleTimerRef.current = null;
      if (bubbleTextRef.current !== text) return; // 已被别的文案顶替
      setBubbleOpen(false);
      setBubbleText(null);
    }, SAY_BUBBLE_MS);
  }

  // ── 输入唤醒的接收端 ──
  //   user-input-focused   输入框聚焦 / 开始打字（父组件带 3 分钟冷却派发）
  //   user-message-sent    消息真的发出去了 → 那条"今天要聊点什么呢"立刻收掉
  useEffect(() => {
    function onUserInput() {
      // 普通搭话气泡正显示着（idle 且没在睡/打哈欠）→ 忽略，别把已有气泡反复替换掉。
      // 生气 / 睡觉 / 哈欠的气泡不在此列 —— 那些正是要被"治愈"掉的。
      if (
        currentStateRef.current === "idle" &&
        !hiddenRef.current &&
        bubbleOpenRef.current
      ) {
        return;
      }
      forceWakeForInput();
    }
    function onMessageSent() {
      clearTimeout(inputBubbleTimerRef.current);
      inputBubbleTimerRef.current = null;
      if (bubbleTextRef.current !== INPUT_WAKE_LINE) return;
      setBubbleOpen(false);
      setBubbleText(null);
    }
    // 外部让它说一句（生日祝福）：只弹气泡，不改状态机 —— 睡着 / 生气时也一样显示
    function onWarmSay(e) {
      const text = String(e?.detail?.text || "").trim();
      if (!text) return;
      showSayBubble(text);
    }
    window.addEventListener("user-input-focused", onUserInput);
    window.addEventListener("user-message-sent", onMessageSent);
    window.addEventListener("warm-say", onWarmSay);
    return () => {
      window.removeEventListener("user-input-focused", onUserInput);
      window.removeEventListener("user-message-sent", onMessageSent);
      window.removeEventListener("warm-say", onWarmSay);
      clearTimeout(inputBubbleTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- forceWakeForInput / showPet 都只读 ref
  }, []);

  // 让事件回调读到最新的气泡状态
  useEffect(() => {
    bubbleOpenRef.current = bubbleOpen;
    bubbleTextRef.current = bubbleText;
  }, [bubbleOpen, bubbleText]);

  /** 调整大小：滑块实时触发，夹取到 80~200 并写入 localStorage */
  function handleSizeChange(n) {
    const v = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(Number(n) || DEFAULT_SIZE)));
    setPetSize(v);
    try { localStorage.setItem(SIZE_KEY, String(v)); } catch {}
  }

  /** 「我去休息啦」：切睡觉帧贴到屏幕右边缘只露一半；单击唤醒飞回，拖拽可拖出来继续睡 */
  function hidePet() {
    if (hiddenRef.current) return;
    hiddenRef.current = true;
    setIsHidden(true);
    hiddenFromPosRef.current = pos; // 先记住当前位置，恢复时回去

    // 收尾：气泡、连击、计时器全部清掉，直接切睡觉（睡觉帧 + Zzz + 睡眠呼吸，待机呼吸与眨眼自停）
    setBubbleOpen(false);
    setBubbleText(null);
    setStressOpen(false);
    setBlinkFrame(null);
    setState("sleeping");
    clearTimeout(angryTimerRef.current);
    clearTimeout(clickResetTimerRef.current);
    clickCountRef.current = 0;
    clearIdleTimer();
    if (tiltRef.current) tiltRef.current.style.transform = NEUTRAL_TILT;

    // 飞行目标：x 贴右边缘只露一半，y 维持当前（夹取防出屏）
    const w = petSize;
    const targetX = window.innerWidth - w / 2;
    const currentY = pos?.y ?? window.innerHeight - w - 100;
    const targetY = Math.max(0, Math.min(window.innerHeight - w, currentY));

    // 开启动画再改 pos，下一帧 transform 变化触发过渡
    setFlyTransition(true);
    setPos({ x: targetX, y: targetY });
    clearTimeout(flyTimeoutRef.current);
    flyTimeoutRef.current = setTimeout(() => setFlyTransition(false), HIDE_FLY_MS + 50);
  }

  /** 从贴边睡眠唤醒：飞回隐藏前的位置（已被 resize / 尺寸变化夹取过的话，用夹取后的），回待机帧 */
  function showPet() {
    if (!hiddenRef.current) return;
    hiddenRef.current = false;
    setIsHidden(false);
    setState("idle"); // 唤醒：睡觉帧 → 待机帧，待机呼吸与眨眼随之恢复
    const back = hiddenFromPosRef.current;
    hiddenFromPosRef.current = null;

    const w = petSize;
    const bx = back?.x ?? window.innerWidth - w - RIGHT_GAP;
    const by = back?.y ?? window.innerHeight - w - 100;
    const x = Math.max(0, Math.min(window.innerWidth - w, bx));
    const y = Math.max(0, Math.min(window.innerHeight - w, by));

    setFlyTransition(true);
    setPos({ x, y });
    clearTimeout(flyTimeoutRef.current);
    flyTimeoutRef.current = setTimeout(() => setFlyTransition(false), HIDE_FLY_MS + 50);

    resetIdleTimer(); // 回来了，重新计 60 秒待机
  }

  // 聊天 Tab 切走 → 复用「我去休息啦」飞到右缘；切回 → 仅当这次是 Tab 触发的贴边才飞回。
  // 只调现有 hidePet / showPet，不改 currentState 优先级、也不碰点击 / 拖拽分流。
  useEffect(() => {
    if (tuckToEdge) {
      if (!hiddenRef.current) {
        autoTuckRef.current = true;
        setPanelOpen(false);
        hidePet();
      }
      return;
    }
    if (autoTuckRef.current) {
      autoTuckRef.current = false;
      if (hiddenRef.current) showPet();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只跟 Tab 贴边开关，hide/show 用当时闭包里的位置
  }, [tuckToEdge]);

  function clearIdleTimer() {
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = null;
  }

  /** 重置待机计时：无交互 58.45s 触发打哈欠，哈欠播完正好 60s 无缝入睡。
   *  只有 idle 且未隐藏时才真的排程（其他状态由各自的进入/退出函数管理）；
   *  任何交互都会先 clear 再重排 —— 倒计时从 0 重算。 */
  function resetIdleTimer() {
    clearIdleTimer();
    // ⚠️ 任何一次真实交互都要**作废正在播放的哈欠**：
    //    以前这里只清 idleTimer，不清 yawnTimers —— 哈欠播到一半时点一下页面空白处 /
    //    点侧边栏（状态仍是 idle），1.5 秒后那个"播完就睡"的收尾定时器照样触发，
    //    表现就是"我刚点过，她突然睡了"。交互意味着"我还在"，哈欠必须重头再来。
    cancelYawn();
    if (currentStateRef.current !== "idle" || hiddenRef.current) return;
    idleTimerRef.current = setTimeout(playYawn, SLEEP_IDLE_MS - YAWN_TOTAL_MS);
  }

  // 全局交互监听：点击 / 鼠标移动 / 键盘都会重置待机计时，鼠标移动做 1 秒节流
  useEffect(() => {
    resetIdleTimer();
    let lastMove = 0;
    function onInteract(e) {
      if (e?.type === "pointermove") {
        const now = Date.now();
        if (now - lastMove < 1000) return; // 高频移动不必每帧重排定时器
        lastMove = now;
      } else if (currentStateRef.current === "sleeping" && !hiddenRef.current) {
        // 点本体时不在这里叫醒——由 onPointerUp 按点击/拖动判定后再叫醒；
        // 点别处或敲键盘时，正常叫醒她。
        // 贴边睡眠（hidden）不被外部点击/键盘叫醒——只能点她本体唤醒或拖拽。
        if (!(elRef.current && e.target && elRef.current.contains(e.target))) {
          wakeUp();
        }
      }
      resetIdleTimer();
    }
    window.addEventListener("pointerdown", onInteract, { passive: true });
    window.addEventListener("pointermove", onInteract, { passive: true });
    window.addEventListener("keydown", onInteract);
    return () => {
      window.removeEventListener("pointerdown", onInteract);
      window.removeEventListener("pointermove", onInteract);
      window.removeEventListener("keydown", onInteract);
      clearIdleTimer(); // 卸载必须清掉，避免内存泄漏 / 卸载后 setState
    };
  }, []);

  /** 点击回弹：直接重置 animation 再强制 reflow 重播，不重建节点，连点也不会卡住 */
  function playBounce() {
    const el = bounceLayerRef.current;
    if (!el) return;
    el.style.animation = "none";
    void el.offsetWidth;
    el.style.animation = `warm-click-bounce ${BOUNCE_MS}ms ease-out`;
  }

  /** 进入生气：切帧 + 蒸汽 + 气泡；3.5 秒后自动恢复并彻底清零计数 */
  function triggerAngry() {
    clickCountRef.current = 0;
    clearTimeout(clickResetTimerRef.current); // 生气期间不再计连击
    setBlinkFrame(null); // 若正眨到一半，立即回正，避免切生气帧时闪一帧闭眼
    setState("angry");
    clearIdleTimer(); // 生气期间不计 60s 待机
    setBubbleText(ANGRY_LINE);
    setBubbleOpen(true);
    clearTimeout(angryTimerRef.current);
    angryTimerRef.current = setTimeout(() => {
      const cur = currentStateRef.current;
      if (cur === "angry") {
        setState("idle");
        setBubbleOpen(false);
        setBubbleText(null);
        clickCountRef.current = 0;
        resetIdleTimer(); // 气消了，重新开始待机计时
        return;
      }
      // ⚠️ 生气中被拖拽：倒计时不暂停、不重置；耗完把 preDrag 改成 idle ——
      // 松手回 idle，而不是回到一个"已经没有计时器"的 angry（否则会永远卡在生气态）
      if (cur === "dragging" && preDragStateRef.current === "angry") {
        preDragStateRef.current = "idle";
        setBubbleOpen(false);
        setBubbleText(null);
        clickCountRef.current = 0;
      }
      // 隐藏已由 hidePet 清过计时器，走不到这里
    }, ANGRY_DURATION_MS);
  }

  // ── 拖拽（直接改 DOM，抬手时才 setState + 记忆位置）──
  // 仲裁：dragging 优先级最高，从任何动作状态都可进入；
  // 拖动结束回到 preDragState（睡觉被拖动继续睡、倾听被拖动拖完继续听）；
  // 点击（<5px）才视作交互：睡觉唤醒 / 连击 +1 / angry 期间无视
  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    // 贴边睡眠中：按下只记起点，抬手时按移动距离判定——
    // 单击（<5px）唤醒飞回；拖拽（≥5px）保持睡觉图，把她从边缘拖出来。
    // 全程不进 dragging 状态机、不计连击、不走 showPet 立刻唤醒。
    if (hiddenRef.current) {
      const r = elRef.current.getBoundingClientRect();
      sizeRef.current = { w: r.width, h: r.height };
      hiddenDragRef.current = {
        startX: e.clientX, startY: e.clientY,
        offsetX: e.clientX - r.left, offsetY: e.clientY - r.top,
        moved: false, lastX: r.left, lastY: r.top,
      };
      // ⚠️ 把清理函数存进 ref：监听器是"这次渲染"里的闭包实例，
      //    拖拽期间每帧 setPos 都会重渲染，卸载时拿新函数 remove 旧监听是删不掉的。
      const cleanup = () => {
        window.removeEventListener("pointermove", onHiddenDragMove);
        window.removeEventListener("pointerup", onHiddenDragUp);
        window.removeEventListener("pointercancel", onHiddenDragUp);
      };
      dragCleanupRef.current = cleanup;
      window.addEventListener("pointermove", onHiddenDragMove);
      window.addEventListener("pointerup", onHiddenDragUp);
      window.addEventListener("pointercancel", onHiddenDragUp);
      return;
    }
    preDragStateRef.current = currentStateRef.current;
    setState("dragging");
    clearIdleTimer(); // 拖拽中不计 60s 待机
    movedRef.current = false;
    clearTimeout(longPressTimerRef.current);
    if (e.pointerType === "touch" || !e.pointerType) {
      longPressTimerRef.current = setTimeout(() => {
        if (!movedRef.current && !menuBtnVisibleRef.current) {
          setMenuVisible(true);
          if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
            try { navigator.vibrate([15, 30, 20]); } catch {}
          }
        }
      }, 550);
    }
    startPosRef.current = { x: e.clientX, y: e.clientY };
    const r = elRef.current.getBoundingClientRect();
    sizeRef.current = { w: r.width, h: r.height };
    offsetRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    // 不用 setPointerCapture：监听挂 window 已覆盖鼠标/触摸，capture 会把后续事件锁死在本体上
  }
  function onPointerMove(e) {
    clearTimeout(longPressTimerRef.current);
    if (currentStateRef.current !== "dragging") return;
    movedRef.current = true;
    const { w, h } = sizeRef.current;
    const x = Math.max(0, Math.min(window.innerWidth - w, e.clientX - offsetRef.current.x));
    const y = Math.max(0, Math.min(window.innerHeight - h, e.clientY - offsetRef.current.y));
    elRef.current.style.transform = `translate(${x}px, ${y}px)`;
    setPos({ x, y });
  }
  function onPointerUp(e) {
    // 用按下那一刻存下的清理函数：拖拽过程中每次 setPos 都会重渲染，
    // 直接用 h 里的 removeEventListener 删的是"新函数"，旧监听会残留。
    const cleanup = dragCleanupRef.current;
    dragCleanupRef.current = null;
    if (typeof cleanup === "function") cleanup();
    if (currentStateRef.current !== "dragging") return;

    const preDrag = preDragStateRef.current || "idle";
    preDragStateRef.current = null;

    // 按移动距离区分点击 / 拖动：< 5px 视为点击，≥ 5px 视为拖动
    const dx = (e?.clientX ?? startPosRef.current.x) - startPosRef.current.x;
    const dy = (e?.clientY ?? startPosRef.current.y) - startPosRef.current.y;
    const isClick = Math.hypot(dx, dy) < 5;
    if (!isClick) {
      // 真拖动：回到 preDrag 状态（睡觉继续睡、倾听继续听、生气继续生）
      setState(preDrag);
      if (preDrag === "idle") resetIdleTimer();
      try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch {}
      return;
    }

    // 点击：angry 3.5 秒内无视一切点击（拖回 angry 等定时器自然结束）
    if (preDrag === "angry") {
      setState("angry");
      return;
    }

    // 其他 preDrag（idle / sleeping / listening）：点击 → 回 idle + 正常连击
    // sleeping 在此被唤醒（点击才唤醒，拖动不唤醒）；listening 被用户点击打断回 idle
    setState("idle");
    playBounce();

    // 触觉反馈（模拟 iOS Taptic Engine 细腻微敲击感，随连击轻微增强）
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      try {
        const tapHaptic = Math.min(22, 10 + (clickCountRef.current || 0) * 2);
        navigator.vibrate(tapHaptic);
      } catch {}
    }

    // 连击计数：每点一次 +1；重置定时器 2 秒，期间没再点就清零
    const n = clickCountRef.current + 1;
    clickCountRef.current = n;
    clearTimeout(clickResetTimerRef.current);
    clickResetTimerRef.current = setTimeout(() => {
      clickCountRef.current = 0;
    }, CLICK_RESET_MS);

    if (n >= ANGRY_THRESHOLD) {
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        try { navigator.vibrate([25, 40, 35]); } catch {}
      }
      triggerAngry();
      return;
    }
    // 三段式反馈：只有第 1 次和第 5 次更新气泡文案
    if (n === 1) {
      setBubbleText(LINE_FIRST);
      setBubbleOpen(true);
    } else if (n === 5) {
      setBubbleText(LINE_FIVE);
      setBubbleOpen(true);
    }
    resetIdleTimer(); // 点击后重新计 60s 待机
  }

  // ── 贴边睡眠的按下/拖拽：不走 dragging 状态机，睡觉帧 / Zzz / 睡眠呼吸全程保持 ──
  function onHiddenDragMove(e) {
    const d = hiddenDragRef.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) >= 5) d.moved = true;
    if (!d.moved) return;
    const { w, h } = sizeRef.current;
    // x 上限放宽到「半露出」位置：从边缘拖出来或拖回去都跟随手指、不跳变
    const x = Math.max(0, Math.min(window.innerWidth - w / 2, e.clientX - d.offsetX));
    const y = Math.max(0, Math.min(window.innerHeight - h, e.clientY - d.offsetY));
    d.lastX = x; d.lastY = y;
    elRef.current.style.transform = `translate(${x}px, ${y}px)`;
    setPos({ x, y });
  }
  function onHiddenDragUp() {
    const cleanup = dragCleanupRef.current;
    dragCleanupRef.current = null;
    if (typeof cleanup === "function") cleanup();
    const d = hiddenDragRef.current;
    hiddenDragRef.current = null;
    if (!d) return;
    if (!d.moved) {
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        try { navigator.vibrate(12); } catch {}
      }
      showPet(); // 单击：唤醒 + 平滑飞回隐藏前的位置
      return;
    }
    // 拖拽：停在原地继续睡。还探出右边缘 → 保持贴边睡眠；拖进屏幕 → 转为普通睡眠（点本体仍可唤醒）
    const { w } = sizeRef.current;
    if (d.lastX > window.innerWidth - w) return;
    hiddenRef.current = false;
    setIsHidden(false);
    hiddenFromPosRef.current = null;
    try { localStorage.setItem(POS_KEY, JSON.stringify({ x: d.lastX, y: d.lastY })); } catch {}
  }

  // ── 点外面关气泡 ──
  useEffect(() => {
    if (!bubbleOpen) return;
    function close(e) {
      if (elRef.current?.contains(e.target)) return;
      if (e.target.closest?.("[data-warm-bubble]")) return;
      setBubbleOpen(false);
    }
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [bubbleOpen]);

  // ── 压力波动感知：读数变化 → 排队；空闲时弹出 ──
  // 分数来源 = stressData prop（与「看看现在的状态」同一份，父组件在流式结束后会立即刷新它）
  useEffect(() => {
    const raw = stressData?.score;
    if (raw == null || !Number.isFinite(Number(raw))) return; // 未启用/暂无数据：静默
    const cur = Math.round(Number(raw));

    // 本 session 首次读到：优先用 localStorage 里的旧基线（跨刷新也能感知变化），
    // 没有就建基线、不弹（避免新用户一进门就被搭话）
    if (lastStressScoreRef.current == null) {
      let saved = null;
      try {
        const s = localStorage.getItem(PRESSURE_BASELINE_KEY);
        saved = s == null ? null : Number(s);
      } catch {}
      if (saved == null || !Number.isFinite(saved)) {
        lastStressScoreRef.current = cur;
        try { localStorage.setItem(PRESSURE_BASELINE_KEY, String(cur)); } catch {}
        return;
      }
      lastStressScoreRef.current = saved;
    }

    const delta = cur - lastStressScoreRef.current;
    // 基线每次都更新（哪怕在冷却里、哪怕没到阈值）—— 不然会积累出"假波动"
    lastStressScoreRef.current = cur;
    try { localStorage.setItem(PRESSURE_BASELINE_KEY, String(cur)); } catch {}

    if (Math.abs(delta) < PRESSURE_DELTA) return;
    const cdKey = delta > 0 ? PRESSURE_UP_CD_KEY : PRESSURE_DOWN_CD_KEY;
    try {
      if (Date.now() < (Number(localStorage.getItem(cdKey)) || 0)) return; // 冷却中
      localStorage.setItem(cdKey, String(Date.now() + PRESSURE_COOLDOWN_MS));
    } catch {}
    // 排队（idle 时 drain 会立刻弹出；busy 时等状态结束）
    setPendingStress(delta > 0 ? PRESSURE_UP_LINE : PRESSURE_DOWN_LINE);
  }, [stressData?.score]);

  // 压力气泡弹出闸口：只在「idle + 没打哈欠 + 没贴边 + 面板关着」时弹出。
  // 生气/睡眠/拖拽/哈欠期间排队等待 —— 这些状态收气泡的时机（如 angry 计时器）打不到它；
  // 弹出时重启 60s 待机计时，别刚说完话就睡着把气泡收走。
  useEffect(() => {
    if (!pendingStress) return;
    if (currentState !== "idle" || yawnSrc || isHidden || panelOpen) return;
    setPendingStress(null);
    setBubbleText(pendingStress); // idle 时直接覆盖点击气泡：紧急压力感知优先于待机搭话
    setBubbleOpen(true);
    resetIdleTimer();
  }, [pendingStress, currentState, yawnSrc, isHidden, panelOpen]);

  // 卸载清定时器 + 拖拽监听（避免内存泄漏 / 卸载后 setState）
  useEffect(() => () => {
    clearTimeout(angryTimerRef.current);
    clearTimeout(clickResetTimerRef.current);
    clearTimeout(flyTimeoutRef.current);
    yawnTimersRef.current.forEach(clearTimeout);
    // 拖到一半被卸载（切路由 / 热更新）时，window 上的 pointermove/up 还挂着
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
    hiddenDragRef.current = null;
  }, []);

  const posTransform = pos ? `translate(${pos.x}px, ${pos.y}px)` : "translate(-9999px,-9999px)";

  // 气泡定位：本体上方居中，水平方向夹取防出屏（文案最大宽 200 + 内边距，半宽约 112px）
  const bubbleStyle = (() => {
    if (!pos) return { visibility: "hidden" };
    const { w } = sizeRef.current;
    const halfW = 116;
    const left = Math.max(halfW, Math.min(window.innerWidth - halfW, pos.x + w / 2));
    return { left, top: pos.y - 10, transform: "translate(-50%, -100%)" };
  })();

  // 功能面板定位：默认悬浮在桌宠【正上方】——top 锚在桌宠头顶上方 12px，再用
  // translateY(-100%) 把面板整个抬到锚点之上（与气泡同一个套路），面板自身多高都不会盖住她。
  // 桌宠太靠近屏幕顶部时翻转到脚下展开。水平方向面板右边对齐 ≡ 按钮，夹取防出屏。
  const PANEL_W = 208;
  const PANEL_H_EST = 220; // 面板估算高度（4 个按钮 + 滑块），只用于判断"头顶是否放得下"
  const panelStyle = (() => {
    if (!pos) return { visibility: "hidden" };
    const flipBelow = pos.y < PANEL_H_EST + 24; // 头顶放不下才往下翻
    let left = pos.x + petSize - 8 - PANEL_W;   // 面板右边 ≈ ≡ 按钮右边
    if (left < 6) left = 6;
    if (left + PANEL_W > window.innerWidth - 6) left = window.innerWidth - 6 - PANEL_W;
    if (flipBelow) {
      return { left, top: pos.y + petSize + 12 };
    }
    return { left, top: pos.y - 12, transform: "translateY(-100%)" };
  })();

  return (
    <>
      <style>{`
/* 待机呼吸：3s 一循环，0 → -4px 平滑浮动 */
@keyframes warm-breathe {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-4px); }
}
/* 睡着的呼吸：幅度更小、速度更慢（0.98 → 1），以脚底为轴轻微起伏 */
@keyframes warm-sleep-breathe {
  0%, 100% { transform: scale(0.98); }
  50%      { transform: scale(1); }
}
/* 睡觉的 Zzz：缓缓向上飘、边飘边变大淡出 */
@keyframes warm-zzz {
  0%   { transform: translate(0, 0) scale(0.7); opacity: 0; }
  18%  { opacity: 0.9; }
  100% { transform: translate(7px, -26px) scale(1.15); opacity: 0; }
}
/* 点击回弹：先纵向压扁再弹回，0.2s，模拟"戳"到的手感 */
@keyframes warm-click-bounce {
  0%   { transform: scaleY(1) scaleX(1); }
  35%  { transform: scaleY(0.95) scaleX(1.02); }
  70%  { transform: scaleY(1.03) scaleX(0.99); }
  100% { transform: scaleY(1) scaleX(1); }
}
/* AI 回应点头：整体缩小再放大，scale 0.95 → 1，overshoot 带出"嗯"的一下 */
@keyframes warm-nod {
  0%   { transform: scale(1); }
  40%  { transform: scale(0.95); }
  70%  { transform: scale(1.03); }
  100% { transform: scale(1); }
}
/* 思考中的 💭：悬浮 + 轻微闪烁 */
@keyframes warm-think-float {
  0%, 100% { transform: translateY(0) scale(1); opacity: 0.95; }
  50%      { transform: translateY(-4px) scale(1.06); opacity: 0.6; }
}
/* 生气淡出后淡回待机 */
@keyframes warm-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
/* 生气蒸汽：白色小圆往上飘散并淡出 */
@keyframes warm-steam {
  0%   { transform: translateY(0) scale(0.5); opacity: 0; }
  25%  { opacity: 0.55; }
  100% { transform: translateY(-30px) scale(1.3); opacity: 0; }
}
/* 怒气符号上下浮动 */
@keyframes warm-anger-float {
  0%, 100% { transform: translateY(0) rotate(-6deg); }
  50%      { transform: translateY(-5px) rotate(6deg); }
}
/* 漫画气泡：暖白底 + 暖色描边 + 小尾巴（尾巴的描边和气泡描边同色，接缝处严丝合缝） */
.warm-bubble {
  position: relative;
  background: #FFF8F5;
  border: 1.5px solid #C9826F;
  border-radius: 14px;
  padding: 8px 12px;
  box-shadow: 0 4px 14px rgba(133, 76, 60, 0.18);
  color: #3D3535;
  font-size: 14px;
  line-height: 1.5;
  white-space: nowrap;
  animation: warm-pop 0.13s ease-out forwards;
}
/* ⚠️ 尾巴是 12×12 方块旋转 45°，中心正好压在气泡下边框上：
   描边只画「右 + 下」两条边，旋转后正好是露在外面的那个 V；
   白色填充盖住气泡下边框那一小段，所以看不出断口。改尺寸/位移时要保持这个几何关系。 */
.warm-bubble::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: -6px;
  transform: translateX(-50%) rotate(45deg);
  width: 12px;
  height: 12px;
  background: #FFF8F5;
  border-right: 1.5px solid #C9826F;
  border-bottom: 1.5px solid #C9826F;
  border-radius: 2px;
}
@keyframes warm-pop {
  from { opacity: 0; transform: scale(0.92) translateY(4px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}
`}</style>

      {/* 漫画气泡：只装纯文本（点击/生气文案），功能按钮全搬到 ≡ 面板 */}
      {bubbleOpen && pos && bubbleText && (
        <div data-warm-bubble className="fixed z-[9998]" style={bubbleStyle}>
          <div className="warm-bubble" style={{ maxWidth: 200, whiteSpace: "normal", lineHeight: 1.55 }}>
            {bubbleText}
          </div>
        </div>
      )}

      {/* 功能面板（从气泡解耦出来的设置类操作）。
          ⚠️ 双层结构（与气泡同一个套路）：外层只负责定位（panelStyle 带 translateY(-100%) 把面板抬到桌宠头顶），
          内层负责视觉 + warm-pop 入场动画 —— warm-pop 的结束帧是 transform: scale(1) translateY(0)，
          若把动画和定位放同一层，forwards 填充会永久覆盖定位用的 translateY，面板就会往下塌盖住桌宠。 */}
      {panelOpen && pos && (
        <div
          ref={panelRef}
          className="fixed z-[10000]"
          style={panelFrozen || panelStyle}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerEnter={() => { panelHoverRef.current = true; }}
          onPointerLeave={() => { panelHoverRef.current = false; }}
        >
          <div
            style={{
              width: PANEL_W,
              background: "#FFFBF8",
              border: "1.5px solid #C9826F",
              borderRadius: 12,
              boxShadow: "0 6px 22px rgba(133, 76, 60, 0.26), 0 1px 0 rgba(201, 130, 111, 0.35) inset",
              padding: "6px 8px",
              animation: "warm-pop 0.13s ease-out forwards",
            }}
          >
          {/* 「看看现在的状态」：压力测评当前状态 */}
          <button
            onClick={() => { setStressOpen((v) => !v); }}
            className="w-full text-left text-xs text-[#7fa8c4] hover:text-[#5b8aa6] hover:bg-[#f2f7fa] rounded-lg px-2.5 py-1.5 transition-colors"
          >
            看看现在的状态
          </button>
          {stressOpen && (
            <div className="px-1 pb-1" style={{ whiteSpace: "normal", width: "100%" }}>
              {(() => {
                const hasScore = stressData?.score != null;
                const tone = hasScore ? toneOf(stressData.score) : NO_DATA_TONE;
                return (
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <StressRing score={hasScore ? stressData.score : 0} tone={tone} size={40} />
                      <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold" style={{ color: tone.text }}>
                        {hasScore ? Math.round(stressData.score) : "--"}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] text-slate-400">现在的状态</p>
                      <p className="text-sm font-semibold" style={{ color: tone.text }}>
                        {hasScore ? stressData?.level?.label || "暂无" : "暂无数据"}
                      </p>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* 调整大小 */}
          <div className="border-t border-[#e6b9a9] my-1.5 mx-1" />
          <div className="px-1">
            <p className="text-[11px] text-slate-400 mb-1.5">调整大小（{petSize}px）</p>
            <input
              type="range"
              min={MIN_SIZE}
              max={MAX_SIZE}
              step={1}
              value={petSize}
              onChange={(e) => handleSizeChange(Number(e.target.value))}
              onPointerDown={(e) => {
                e.stopPropagation();
                // 冻结面板：把当前视觉位置（含 translateY(-100%) 的结果）快照成固定坐标。
                // ⚠️ 冻结后不再随尺寸/位置变化重锚，一直钉在"打开菜单时的位置"，
                // 直到面板关闭（panelOpen 置 false 时才解冻）—— 松手也不动。
                const r = panelRef.current?.getBoundingClientRect();
                if (r) setPanelFrozen({ left: r.left, top: r.top, transform: "none" });
              }}
              aria-label="调整暖言大小"
              className="w-full"
              style={{ accentColor: "#e8a0b4", cursor: "pointer" }}
            />
            <div className="flex justify-between text-[10px] text-slate-300 mt-0.5 px-0.5">
              <span>{MIN_SIZE}</span>
              <span>{DEFAULT_SIZE}</span>
              <span>{MAX_SIZE}</span>
            </div>
          </div>

          {/* 氛围光效调节（温和暗光模式） */}
          <div className="border-t border-[#e6b9a9] my-1.5 mx-1" />
          <button
            onClick={() => { setThemeModalOpen(true); setPanelOpen(false); }}
            className="w-full text-left text-xs flex items-center justify-between text-[#8a5746] hover:text-[#6e3e30] hover:bg-[#faeee7] rounded-lg px-2.5 py-1.5 transition-colors cursor-pointer"
          >
            <span className="flex items-center gap-1.5">
              <span>🌙</span>
              <span>氛围光效</span>
            </span>
            <span className="text-[10px] text-slate-500 bg-white/70 px-1.5 py-0.5 rounded-full border border-[#f0ded4]">
              {THEME_MODES.find((m) => m.id === currentThemeMode)?.title || "晨光浅杏"}
            </span>
          </button>

          {/* 我去休息啦：贴边睡眠隐藏 */}
          <div className="border-t border-[#e6b9a9] my-1.5 mx-1" />
          <button
            onClick={() => { hidePet(); setPanelOpen(false); }}
            className="w-full text-left text-xs text-[#9b93c9] hover:text-[#7a72a8] hover:bg-[#f4f2fa] rounded-lg px-2.5 py-1.5 transition-colors"
          >
            我去休息啦
          </button>

          {/* 隐藏菜单键：藏起右上角 ≡，右键/长按点她可再叫出来 */}
          <div className="border-t border-[#e6b9a9] my-1.5 mx-1" />
          <button
            onClick={() => setMenuVisible(false)}
            className="w-full text-left text-xs text-[#a09a96] hover:text-[#7a6a6a] hover:bg-[#f7f2ee] rounded-lg px-2.5 py-1.5 transition-colors"
          >
            <span className="hidden sm:inline">隐藏菜单键（右键桌宠恢复）</span>
            <span className="inline sm:hidden">隐藏菜单键（长按桌宠恢复）</span>
          </button>
          </div>
        </div>
      )}

      {/* 暖言本体：外层位置 / 中层回弹 / 内层呼吸 / 单图 sprite 裁切帧 + 蒸汽 */}
      <div
        ref={elRef}
        onPointerDown={onPointerDown}
        onContextMenu={onContextMenu}
        aria-label={isHidden ? "暖言在休息（单击唤醒，可拖拽移动）" : "桌宠暖言（点击互动）"}
        style={{
          position: "fixed",
          left: 0, top: 0,
          width: petSize,
          height: petSize,
          // 保持高于页面内容，便于拖拽；不压「发送」靠的是 defaultAnchor 让开矩形，而不是把桌宠压到输入条下面
          zIndex: 9999,
          transform: posTransform,
          transition: flyTransition ? `transform ${HIDE_FLY_MS}ms cubic-bezier(0.34, 1.3, 0.64, 1)` : "none",
          pointerEvents: "auto",
          cursor: isHidden ? "pointer" : isDragging ? "grabbing" : "grab",
          touchAction: "none",
          userSelect: "none",
          visibility: pos ? "visible" : "hidden",
        }}
      >
        {/* ≡ 设置按钮：桌宠右上角，默认半透明，hover 变清晰；pointer-events: auto 穿透到本体的事件拦截。
            隐藏后完全不渲染 —— 不占 DOM，也不会挡住点击她；右键她可再叫出来。 */}
        {isMenuBtnVisible && (
          <button
            ref={settingsBtnRef}
            aria-label="暖言设置"
            onClick={(e) => { e.stopPropagation(); togglePanel(); }}
            onPointerDown={(e) => { e.stopPropagation(); }}
            style={{
              position: "absolute",
              top: 4,
              right: 4,
              width: 22,
              height: 22,
              zIndex: 2,
              borderRadius: 6,
              background: "linear-gradient(135deg, #C9826F 0%, #B56E5C 100%)",
              border: "1px solid rgba(133, 76, 60, 0.55)",
              boxShadow: "0 2px 6px rgba(133, 76, 60, 0.28)",
              cursor: "pointer",
              lineHeight: 1,
              fontSize: 13,
              fontWeight: 700,
              color: "#FFF7F2",
              opacity: panelOpen ? 1 : 0.85,
              transition: "opacity 0.18s ease, background 0.18s ease, box-shadow 0.18s ease",
              backdropFilter: "blur(3px)",
              pointerEvents: "auto",
            }}
            onMouseEnter={(e) => { if (!panelOpen) e.currentTarget.style.opacity = 1; }}
            onMouseLeave={(e) => { if (!panelOpen) e.currentTarget.style.opacity = 0.85; }}
          >
            ≡
          </button>
        )}

        {/* 回弹层：点击压缩 / AI 回应点头（animation 独占这一层 transform） */}
        <div ref={bounceLayerRef} style={{ height: "100%", transformOrigin: "center bottom" }}>
          {/* 呼吸层：待机时上下浮动；睡着时换成更慢更小的缩放呼吸（animation 独占这一层 transform） */}
          <div
            style={{
              height: "100%",
              position: "relative",
              transformOrigin: "bottom center",
              animation: poseSleeping
                ? "warm-sleep-breathe 5.5s ease-in-out infinite"
                : "warm-breathe 3s ease-in-out infinite",
            }}
          >
            {/* 视差层：只管探头微倾（直接改 DOM style），transform-origin 在脚底 */}
            <div
              ref={tiltRef}
              style={{
                height: "100%",
                transformOrigin: "bottom center",
                transition: "transform 0.15s ease-out",
                willChange: "transform",
                pointerEvents: "none",
              }}
            >
              {/*
                唯一的 <img>：元素恒为 1 个，不可能叠罗汉。两种显示模式：
                - 平时：src 恒定指向 sprite，切帧只改 translateX —— 位图常驻，纯合成层位移，不白闪；
                - 打哈欠：yawnSrc 非 null，切到单图模式（帧图已预载，不会闪白），宽度=petSize、无位移。
                尺寸随 petSize 走（用户可在气泡里调 80~200）。
              */}
              <div style={{ width: petSize, height: petSize, overflow: "hidden" }}>
                <img
                  ref={imgRef}
                  src={yawnSrc ?? SPRITE}
                  alt="暖言"
                  draggable={false}
                  decoding="sync"
                  style={{
                    display: "block",
                    width: yawnSrc ? petSize : petSize * FRAME_COUNT,
                    height: petSize,
                    maxWidth: "none",
                    objectFit: "contain",
                    objectPosition: "left bottom",
                    transform: yawnSrc ? "none" : `translateX(-${frameIndex * petSize}px)`,
                    willChange: "transform",
                    pointerEvents: "none",
                    userSelect: "none",
                  }}
                />
              </div>

              {/* 生气特效：头顶飘散的白色蒸汽 + 右上角上下浮动的 💢（拖拽中保持） */}
              {poseAngry && (
                <>
                  {[28, 46, 64].map((left, i) => (
                    <span
                      key={left}
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        left: `${left}%`,
                        bottom: "86%",
                        width: 9,
                        height: 9,
                        borderRadius: "50%",
                        background: "rgba(255,255,255,0.92)",
                        boxShadow: "0 0 6px rgba(255,255,255,0.75)",
                        animation: "warm-steam 1.4s ease-out infinite",
                        animationDelay: `${i * 0.35}s`,
                        pointerEvents: "none",
                      }}
                    />
                  ))}
                  <span
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      top: "-4px",
                      right: "2px",
                      fontSize: "24px",
                      lineHeight: 1,
                      filter: "drop-shadow(0 1px 2px rgba(180,40,40,0.35))",
                      animation: "warm-anger-float 1s ease-in-out infinite",
                      pointerEvents: "none",
                    }}
                  >
                    💢
                  </span>
                </>
              )}
            </div>

            {/* 睡觉特效：三个 Z 交错延迟，缓缓上飘变大淡出（拖拽中保持闭眼与 Zzz） */}
            {poseSleeping && (
              <>
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      // 贴边睡眠时右半身在屏外，Zzz 挪到可见的左半边
                      ...(isHidden ? { left: `${6 + i * 8}px` } : { right: `${6 + i * 8}px` }),
                      top: `${20 + i * 6}px`,
                      fontSize: 12 + i * 3,
                      fontWeight: 700,
                      lineHeight: 1,
                      color: "#9b93c9",
                      textShadow: "0 1px 2px rgba(255,255,255,0.9)",
                      animation: "warm-zzz 2.6s ease-out infinite",
                      animationDelay: `${i * 0.85}s`,
                      pointerEvents: "none",
                    }}
                  >
                    Z
                  </span>
                ))}
              </>
            )}

            {/* 思考特效：右上角 💭 悬浮闪烁（AI 流式输出期间显示） */}
            {isThinking && (
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  top: "-6px",
                  right: "-2px",
                  fontSize: 22,
                  lineHeight: 1,
                  filter: "drop-shadow(0 1px 3px rgba(120,110,170,0.35))",
                  animation: "warm-think-float 1.4s ease-in-out infinite",
                  pointerEvents: "none",
                }}
              >
                💭
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 氛围光效调节弹窗 */}
      <ThemeModal open={themeModalOpen} onClose={() => setThemeModalOpen(false)} />
    </>
  );
}
