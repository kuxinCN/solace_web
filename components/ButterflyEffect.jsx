"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toneOf, NO_DATA_TONE, StressRing, StressTrend } from "@/components/StressMeter";

/**
 * 全局桌宠：单只蓝蝴蝶。
 *
 * - 固定浮层 z-index:9999，可拖动（鼠标+触摸），拖动限制不出屏幕
 * - 点击蝴蝶 → 原地弹出情绪气泡（不跳页）
 * - 情绪行为 + 低垂状态持久化（localStorage）+ 「我好点了」恢复
 * - **形象 / 尺寸 / 情绪选项 / 回复话术全部来自 props**（后台「桌宠」页可配）；
 *    props 不传或为空时回落到内置的蓝蝴蝶 + 5 条情绪（改造前的行为）
 * - 「就是想找人说说话」→ 调父组件回调切聊天 tab + 发消息（唯一跳页项）
 * - 治愈小屋「蝴蝶拍」打开时：蝴蝶飞到弹窗正中央；点「开始」后切换为节拍扇翅
 * - 动画全程 CSS transform/opacity，不影响主链路
 */

/**
 * 兜底形象与尺寸：**后台配置读不到时用它们**（比如 /api/pet 挂了、表还没建好）。
 * 正常路径是用户端 `/api/pet` 拿到 imageUrl / size / moods 之后传进来。
 *
 * ⚠️ `size` 不是"只管大小"的一个数：初始定位、拖动夹取、气泡定位、飞行目标
 *    四处都拿它算（就是下面每一处用到 SIZE 的地方）。改尺寸要连着这四处一起想。
 */
const FALLBACK_IMG = "/stickers/blue_butterfly.png";
const FALLBACK_SIZE = 70;
/** 默认落点：右下角，横向距屏幕右边这么多 px（贴着右边缘） */
const RIGHT_GAP = 16;
/** 拿不到聊天输入框时的兜底下边距（≈ 输入框 + 下面那行免责声明的高度） */
const FALLBACK_BOTTOM_GAP = 132;
/** 聊天页输入区容器上的标记；其它 tab / 别的页面没有它 → 走兜底位置 */
const INPUT_BAR_SELECTOR = "[data-chat-input-bar]";
const STORAGE_KEY = "solace_butterfly_state";
/** 「同一句回复多久之内不重复」的本地记录（只存时间戳，不落库、不发请求） */
const LINES_KEY = "solace_butterfly_lines";

/**
 * 兜底情绪配置 —— 只在后台一条情绪都没配（或接口失败）时用，与改造前完全一致。
 * 正常情况下来自后台的 `pet_moods` 表，每条自带回复话术池 `lines`。
 */
const FALLBACK_MOODS = [
  { key: "unhappy", label: "我今天不开心",   anim: "droop",   lines: ["那就先不开心一会儿，不着急好起来"], stay: 3000, droop: true },
  { key: "tired",   label: "我今天好累",     anim: "descend", lines: ["不用撑着，歇着吧"],                 stay: 5000, droop: true },
  { key: "anxious", label: "我心里很烦",     anim: "shake",   lines: ["Solace 帮你收一会儿"],             stay: 3000, droop: true },
  { key: "unclear", label: "我说不清",       anim: "spin",    lines: ["说不清就先不说，我一直在"],         stay: 3000, droop: false },
  { key: "talk",    label: "就是想找人说说话", anim: "goto",   lines: [],                                  stay: 0,    droop: false },
];

// ── 低垂状态读写 ──────────────────────────────────────────
function readDroopState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    return JSON.parse(raw)?.drooped === true;
  } catch { return false; }
}
function writeDroopState(drooped) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ drooped, ts: Date.now() })); } catch {}
}

// ── 回复话术：随机挑一句，同一句在窗口期内不重复 ──────────────
function readLineHistory() {
  try { return JSON.parse(localStorage.getItem(LINES_KEY) || "{}") || {}; } catch { return {}; }
}

/**
 * 从这条情绪的话术池里挑一句。
 *
 * @param mood 情绪项（`lines` 是话术池）
 * @param repeatHours 去重窗口（小时，0 = 纯随机）
 * @returns 要说的话，或 null（池子为空 → 这条情绪只动不说话，不报错也不崩）
 *
 * ⚠️ 全都在窗口内时**兜底返回池子里任意一句**：宁可重复说，也不能"点了不说话" ——
 *    用户点了情绪却什么都没发生，看起来就是坏了。
 */
function pickLine(mood, repeatHours) {
  const pool = Array.isArray(mood?.lines)
    ? mood.lines.filter((text) => typeof text === "string" && text.trim())
    : [];
  if (!pool.length) return null;

  const roll = (list) => list[Math.floor(Math.random() * list.length)];
  const hours = Number(repeatHours);
  const windowMs = Number.isFinite(hours) && hours > 0 ? hours * 3600 * 1000 : 0;
  if (!windowMs) return roll(pool);

  const now = Date.now();
  const history = readLineHistory();
  const said = history[mood.key] && typeof history[mood.key] === "object" ? history[mood.key] : {};
  const fresh = pool.filter((text) => !(said[text] && now - Number(said[text]) < windowMs));
  const chosen = roll(fresh.length ? fresh : pool);

  // 记一笔，顺手清掉过期的，避免 localStorage 无限长大
  const next = {};
  for (const [text, ts] of Object.entries(said)) {
    if (now - Number(ts) < windowMs) next[text] = ts;
  }
  next[chosen] = now;
  history[mood.key] = next;
  try { localStorage.setItem(LINES_KEY, JSON.stringify(history)); } catch {}
  return chosen;
}

// ── 组件 ──────────────────────────────────────────────────
export default function ButterflyEffect({
  onWantToTalk,
  stressData,
  butterflyPat,
  // ── 以下四项来自 GET /api/pet（后台可配），不传就回落到改造前的行为 ──
  imageUrl, // 当前形象（形象库里的那一张）
  size, // 显示边长（px）
  moods, // 情绪选项（每项带 lines 话术池；空数组 = 用内置 5 条）
  lineRepeatHours, // 同一句回复的去重窗口（小时，0 = 不限制）
}) {
  // 配置读不到时一律回落，保证"接口挂了桌宠照常能用"
  const SIZE = Number(size) > 0 ? Number(size) : FALLBACK_SIZE;
  const imgSrc = imageUrl || FALLBACK_IMG;
  const moodList = Array.isArray(moods) && moods.length ? moods : FALLBACK_MOODS;
  const repeatHours = lineRepeatHours === undefined ? 24 : Number(lineRepeatHours) || 0;
  // ── 拖动 ──
  const elRef = useRef(null);
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const offsetRef = useRef({ x: 0, y: 0 });
  const [pos, setPos] = useState(null);

  // ── 情绪气泡 ──
  const [bubbleOpen, setBubbleOpen] = useState(false);
  const [animState, setAnimState] = useState(null);
  const [floatText, setFloatText] = useState(null);
  const [drooped, setDrooped] = useState(false);
  const animTimerRef = useRef(null);

  // ── 压力状态展开 ──
  const [stressOpen, setStressOpen] = useState(false);

  // ── 飞行 ──
  // homePosRef: 飞入蝴蝶拍前蝴蝶的原位，关闭时飞回这里
  // flight: true=正在飞行（位置层加 transition、中间层加弧线动画）
  const homePosRef = useRef(null);
  const [flight, setFlight] = useState(false);

  // 读取持久化低垂状态（仅客户端）
  useEffect(() => { setDrooped(readDroopState()); }, []);

  // 挂载后定位到**右下角、聊天输入框上方**（也就是「发送」键的上面）
  //
  // ⚠️ 这里**故意不依赖 SIZE**：形象尺寸是 /api/pet 异步拿到的，如果依赖它，
  //    配置一到就会把用户刚拖到别处的蝴蝶"啪"地拽回默认点。
  //    所以只在挂载时定位一次，之后尺寸变化由下面的钳制/气泡/飞行计算各自用最新 SIZE。
  //
  // ⚠️ 为什么不再是"屏幕中下方"：中下方正好压在聊天正文和输入框那一带，
  //    第一眼就挡事（用户还得先把它拖走）。右下角贴着发送键上方才是"不挡内容"的角落。
  useEffect(() => {
    const place = () => {
      const x = Math.max(0, window.innerWidth - SIZE - RIGHT_GAP);
      // 输入区容器上带 data-chat-input-bar 标记（见 app/chat/page.js）：
      // 拿它的上沿做基准，蝴蝶就正好停在「发送」键上方，且换设备/换字号都自动跟得上。
      const bar = document.querySelector(INPUT_BAR_SELECTOR);
      const barTop = bar ? bar.getBoundingClientRect().top : 0;
      // ⚠️ 只认"确实在屏幕下半部分"的输入框：切到日记等 tab 时它可能仍挂在 DOM 里
      //    但被隐藏（这时 top 是 0），照它定位会把蝴蝶顶到屏幕最上边去。
      const useBar = barTop > window.innerHeight * 0.5;
      const y = useBar
        ? barTop - SIZE - 8
        : window.innerHeight - SIZE - FALLBACK_BOTTOM_GAP;
      setPos({ x, y: Math.max(0, Math.min(window.innerHeight - SIZE, y)) });
    };
    place();
    // 输入框有时比蝴蝶晚一帧挂载（同一渲染批次里排在后面）→ 补一帧再定位一次
    const raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 窗口变化时拉回可视区
  useEffect(() => {
    function onResize() {
      const el = elRef.current; if (!el) return;
      const r = el.getBoundingClientRect();
      const x = Math.max(0, Math.min(window.innerWidth - SIZE, r.left));
      const y = Math.max(0, Math.min(window.innerHeight - SIZE, r.top));
      el.style.transform = `translate(${x}px,${y}px)`;
      setPos({ x, y });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // 依赖 SIZE：尺寸可配，换了大形象之后窗口变化要按新尺寸夹取
  }, [SIZE]);

  // ── 蝴蝶拍联动：飞入蝴蝶拍中央 / 飞出回原位 ──
  useEffect(() => {
    if (!pos) return;
    if (butterflyPat?.open) {
      // 飞入：保存原位 + 关闭气泡（锁定态不允许交互）
      homePosRef.current = { ...pos };
      setBubbleOpen(false);
      // 等一帧让蝴蝶拍弹窗挂载到 DOM，再取它的真实中心坐标
      const raf = requestAnimationFrame(() => {
        const card = document.querySelector("[data-butterfly-pat-card]");
        let tx, ty;
        if (card) {
          // 目标在弹窗卡片上半部分（顶部 1/3 处），避免放大后压住下方「左拍右拍」文字
          const r = card.getBoundingClientRect();
          tx = r.left + r.width / 2 - SIZE / 2;
          ty = r.top + r.height * 0.32 - SIZE / 2;
        } else {
          // 兜底：视口上方 1/3
          tx = window.innerWidth / 2 - SIZE / 2;
          ty = window.innerHeight / 3 - SIZE / 2;
        }
        // 钳制在屏幕内
        tx = Math.max(0, Math.min(window.innerWidth - SIZE, tx));
        ty = Math.max(0, Math.min(window.innerHeight - SIZE, ty));
        setFlight(true);              // 开启 transition + 弧线动画
        setPos({ x: tx, y: ty });    // 位置层平滑过渡到目标
      });
      return () => cancelAnimationFrame(raf);
    } else if (homePosRef.current) {
      // 飞出：回原位
      setFlight(true);
      setPos({ ...homePosRef.current });
      homePosRef.current = null;
    }
  }, [butterflyPat?.open]); // eslint-disable-line

  // 飞行结束（位置 transition 完成）：关闭弧线动画、恢复可拖动
  function onPosTransitionEnd(e) {
    if (e.propertyName === "transform") {
      setFlight(false);
    }
  }

  // ── 拖动逻辑（直接改 DOM，不走 setState）──
  const locked = !!butterflyPat?.open; // 蝴蝶拍打开期间蝴蝶锁定
  function onPointerDown(e) {
    // 锁定态：禁止拖动、禁止弹气泡
    if (locked) return;
    // 飞行中按下 → 立即取消飞行，把当前可视位置固化为 pos，然后正常拖动
    if (flight) {
      const r = elRef.current.getBoundingClientRect();
      setPos({ x: r.left, y: r.top });
      setFlight(false);
    }
    if (e.button !== undefined && e.button !== 0) return;
    draggingRef.current = true;
    movedRef.current = false;
    const r = elRef.current.getBoundingClientRect();
    offsetRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    // 不用 setPointerCapture：拖动监听挂在 window 上已覆盖鼠标/触摸；
    // capture 会把后续事件锁在蝴蝶上，曾导致气泡/输入框点不中
  }
  function onPointerMove(e) {
    if (!draggingRef.current) return;
    movedRef.current = true;
    let x = Math.max(0, Math.min(window.innerWidth - SIZE, e.clientX - offsetRef.current.x));
    let y = Math.max(0, Math.min(window.innerHeight - SIZE, e.clientY - offsetRef.current.y));
    elRef.current.style.transform = `translate(${x}px, ${y}px)`;
    setPos({ x, y });
  }
  function onPointerUp() {
    draggingRef.current = false;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    if (!movedRef.current) setBubbleOpen((v) => !v);
  }

  // ── 关闭气泡（点外面）──
  useEffect(() => {
    if (!bubbleOpen) return;
    function close(e) {
      if (elRef.current?.contains(e.target)) return;
      if (e.target.closest?.("[data-bf-bubble]")) return;
      setBubbleOpen(false);
    }
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [bubbleOpen]);

  // ── 点击情绪 ──
  const handleMood = useCallback((mood) => {
    clearTimeout(animTimerRef.current);
    setBubbleOpen(false);
    if (mood.anim === "goto") {
      // 唯一跳页项：不显示回复，直接去聊天
      onWantToTalk?.(mood.label);
      return;
    }
    setAnimState(mood.anim);
    // 回复从后台配的话术池里随机挑一句（去过重窗口）
    setFloatText(pickLine(mood, repeatHours));
    // ⚠️ 是否进入低垂改由**后台配置**决定（pet_moods.droop）。
    //    以前这里写死 ["unhappy","tired","anxious"] —— 于是后台新增一条情绪
    //    永远进不了低垂，改标签也改不动行为。
    if (mood.droop) {
      setDrooped(true);
      writeDroopState(true);
    }
    animTimerRef.current = setTimeout(() => {
      setAnimState(null);
      setFloatText(null);
    }, Number(mood.stay) || 0);
  }, [onWantToTalk, repeatHours]);

  // ── 「我好点了」──
  const handleBetter = useCallback(() => {
    clearTimeout(animTimerRef.current);
    setDrooped(false);
    writeDroopState(false);
    setAnimState(null);
    setFloatText(null);
    setBubbleOpen(false);
  }, []);

  // ── 计算蝴蝶内层动画类 ──
  // 蝴蝶拍运行中 → 节拍扇翅（最高优先级）；否则情绪动画；否则常态/低垂
  const running = butterflyPat?.running;
  const imgCls = running ? "bf-metronome" : [
    "bf-flap",
    animState === "droop"   ? "bf-droop"   : "",
    animState === "descend" ? "bf-descend" : "",
    animState === "shake"   ? "bf-shake"   : "",
    animState === "spin"    ? "bf-spin"    : "",
    drooped && !animState   ? "bf-drooped" : "",
  ].filter(Boolean).join(" ");

  // ── 情绪颜色（蓝色系内部用饱和度/明度/速度表达浓度）──
  // filter 以内联样式作用在扇翅层，配 transition: filter 直接在颜色间插值，
  // 切换情绪时不经过原色（不回蓝）；最深不低于 saturate(0.2) brightness(0.7)，不用黑色
  let moodFilter = "";
  let filterDur = "2.5s"; // 默认（含「我好点了」恢复原色）：缓慢 2.5s 回蓝
  if (animState === "droop")       { moodFilter = "saturate(0.5)";                    filterDur = "1.5s"; }
  else if (animState === "descend"){ moodFilter = "saturate(0.3) brightness(0.85)";   filterDur = "2.5s"; }
  else if (animState === "shake")  { moodFilter = "saturate(0.4)";                    filterDur = "0.2s"; }
  else if (animState === "spin")   { moodFilter = "saturate(0.6) blur(0.5px)";        filterDur = "3s"; }
  else if (drooped)                { moodFilter = "saturate(0.45) brightness(0.9)";   filterDur = "2.5s"; }
  // 始终保留蝴蝶投影
  const innerFilter = `${moodFilter ? moodFilter + " " : ""}drop-shadow(0 4px 10px rgba(91,138,166,0.35))`;

  // 位置层 transform：永远由 pos 控制；飞行时靠 transition 平滑过渡
  const posTransform = pos ? `translate(${pos.x}px, ${pos.y}px)` : "translate(-9999px,-9999px)";

  // ── 气泡定位 ──
  const bubbleRef = useRef(null);
  const [bubbleSize, setBubbleSize] = useState({ w: 200, h: 200 });
  useEffect(() => {
    if (!bubbleOpen || !bubbleRef.current) return;
    const r = bubbleRef.current.getBoundingClientRect();
    setBubbleSize({ w: r.width, h: r.height });
  }, [bubbleOpen, stressOpen]);

  const bubbleStyle = (() => {
    if (!pos) return { visibility: "hidden" };
    const GAP = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bw = bubbleSize.w;
    const bh = bubbleSize.h;
    let left;
    if (pos.x < vw / 2) left = pos.x + SIZE;
    else left = pos.x - bw;
    left = Math.max(4, Math.min(vw - bw - 4, left));
    let top;
    if (pos.y > vh / 2) top = pos.y - bh - GAP;
    else top = pos.y + SIZE + GAP;
    top = Math.max(4, Math.min(vh - bh - 4, top));
    return { left, top };
  })();

  return (
    <>
      <style>{`
/* 基础扇翅（常态） */
@keyframes bf-flap {
  0%, 100% { transform: scaleX(1) rotate(-2deg); }
  50%      { transform: scaleX(0.62) rotate(2deg); }
}
/* 不开心：下垂、慢扇（颜色由内层 inline filter + transition 控制，不写在 keyframes 里） */
@keyframes bf-droop {
  0%, 100% { transform: scaleX(0.75) rotate(-6deg) translateY(4px); }
  50%      { transform: scaleX(0.70) rotate(-4deg) translateY(6px); }
}
/* 好累：原地停住、翅膀缓慢半闭、轻轻下沉 5px（只作用于内层，外层位置不变） */
@keyframes bf-descend {
  0%, 100% { transform: translateY(5px) scaleX(0.55) rotate(-3deg); }
  50%      { transform: translateY(5px) scaleX(0.42) rotate(-2deg); }
}
/* 心烦：快速抖翅两下（受惊）然后慢下来 */
@keyframes bf-shake {
  0%   { transform: scaleX(1) rotate(0deg); }
  8%   { transform: scaleX(0.5) rotate(-8deg); }
  16%  { transform: scaleX(0.5) rotate(8deg); }
  24%  { transform: scaleX(0.5) rotate(-6deg); }
  32%  { transform: scaleX(0.5) rotate(6deg); }
  50%  { transform: scaleX(0.8) rotate(-2deg); }
  75%  { transform: scaleX(0.9) rotate(1deg); }
  100% { transform: scaleX(1) rotate(0deg); }
}
/* 说不清：原地缓缓转一圈 */
@keyframes bf-spin {
  from { transform: scaleX(0.9) rotate(0deg); }
  to   { transform: scaleX(0.9) rotate(360deg); }
}
/* 持久低垂状态：只保留慢扇；颜色同理由 inline filter 控制 */
.bf-drooped {
  animation: bf-flap 2.8s ease-in-out infinite !important;
}
/* 动画类 */
.bf-flap    { animation: bf-flap 1.1s ease-in-out infinite; }
.bf-droop   { animation: bf-droop 2s ease-in-out infinite; }
.bf-descend { animation: bf-descend 2.6s ease-in-out infinite; }
.bf-shake   { animation: bf-shake 0.8s ease-out; }
.bf-spin    { animation: bf-spin 1.8s ease-in-out; }
/* 节拍扇翅：左右交替倾斜，2 秒一个循环（左拍 1s + 右拍 1s） */
@keyframes bf-metronome {
  0%   { transform: scaleX(0.45) rotate(-12deg); }
  25%  { transform: scaleX(1) rotate(-12deg); }
  50%  { transform: scaleX(0.45) rotate(12deg); }
  75%  { transform: scaleX(1) rotate(12deg); }
  100% { transform: scaleX(0.45) rotate(-12deg); }
}
.bf-metronome { animation: bf-metronome 2s ease-in-out infinite; }
/* 飞行弧线：中间层上下波动 + 轻微摇摆，与位置层 transition 叠加 */
@keyframes bf-arc {
  0%   { transform: translateY(0) rotate(0deg); }
  30%  { transform: translateY(8px) rotate(-10deg); }
  55%  { transform: translateY(-5px) rotate(5deg); }
  80%  { transform: translateY(3px) rotate(-3deg); }
  100% { transform: translateY(0) rotate(0deg); }
}
/* 漫画式对话气泡 */
.bf-float-bubble {
  position: relative;
  background: #FFF8F5;
  border-radius: 14px;
  padding: 8px 14px;
  box-shadow: 0 4px 14px rgba(91, 60, 60, 0.12);
  color: #3D3535;
  font-size: 14px;
  line-height: 1.5;
  white-space: nowrap;
  animation: bf-pop 0.13s ease-out forwards;
}
/* 尾巴：旋转 45° 的方块，只露两个边，颜色与气泡一致 */
.bf-float-bubble::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: -6px;
  transform: translateX(-50%) rotate(45deg);
  width: 12px;
  height: 12px;
  background: #FFF8F5;
  border-radius: 2px;
}
.bf-float-bubble .bf-brand {
  color: #C98BA4;
  font-weight: 600;
}
@keyframes bf-pop {
  from { opacity: 0; transform: scale(0.92) translateY(4px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}
`}</style>

      {/* 漫画式对话气泡（蝴蝶上方，尾巴朝下指向蝴蝶） */}
      {floatText && (
        <div
          className="pointer-events-none fixed z-[9998]"
          style={{
            left: pos ? pos.x + SIZE / 2 : "50%",
            top: pos ? pos.y - 46 : "50%",
            transform: "translateX(-50%)",
          }}
        >
          <div className="bf-float-bubble">
            {floatText.includes("Solace") ? (
              <>
                <span className="bf-brand">Solace</span>
                {floatText.replace(/^Solace/, "")}
              </>
            ) : (
              floatText
            )}
          </div>
        </div>
      )}

      {/* 蝴蝶本体：三层结构
          外层（位置层）：transform=translate(pos)，飞行时加 transition 平滑过渡
          中层（弧线层）：飞行时播放 bf-arc（y 波动 + 旋转），不影响位置
          内层（扇翅层）：bf-flap / 情绪 / 节拍动画，只影响翅膀 */}
      <div
        ref={elRef}
        onPointerDown={onPointerDown}
        onTransitionEnd={onPosTransitionEnd}
        aria-label="桌宠蝴蝶（点击互动）"
        style={{
          position: "fixed",
          left: 0, top: 0,
          width: SIZE, height: SIZE,
          zIndex: 9999,
          transform: posTransform,
          transition: flight ? "transform 1.8s ease-in-out" : "none",
          pointerEvents: "auto",
          cursor: locked ? "default" : "grab",
          touchAction: "none",
          userSelect: "none",
        }}
      >
        {/* 弧线层：飞行时播 bf-arc；开始后放大 1.6 倍（与飞行动画解耦） */}
        <div
          style={{
            width: "100%", height: "100%",
            animation: flight ? "bf-arc 1.8s ease-in-out" : undefined,
            transform: running ? "scale(1.6)" : "scale(1)",
            transition: flight ? "none" : "transform 0.4s ease-out",
          }}
        >
          {/* 扇翅层：所有翅膀动画都在这里；颜色 filter 与动画分离，单独过渡 */}
          <div
            className={imgCls}
            style={{
              width: "100%", height: "100%",
              transformOrigin: "center bottom",
              filter: innerFilter,
              transition: `filter ${filterDur} ease`,
              pointerEvents: "none",
            }}
          >
          <img
            src={imgSrc}
            alt=""
            draggable={false}
            decoding="async"
            style={{ width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none" }}
          />
          </div>
        </div>
      </div>

      {/* 情绪选项气泡 */}
      {bubbleOpen && (
        <div
          ref={bubbleRef}
          data-bf-bubble
          className="fixed z-[9998] flex flex-col gap-1 rounded-xl bg-white/95 backdrop-blur-sm border border-[#e0e8ee] shadow-lg p-2 max-w-[220px]"
          style={bubbleStyle}
        >
          {/* 压力状态按钮 */}
          <button
            onClick={() => setStressOpen((v) => !v)}
            className="text-left text-sm text-[#7fa8c4] hover:text-[#5b8aa6] hover:bg-[#f2f7fa] rounded-lg px-3 py-1.5 transition-colors whitespace-nowrap border-b border-[#e8eae7] mb-1 pb-2"
          >
            看看现在的状态
          </button>

          {/* 压力信息展开区 */}
          {stressOpen && (
            <div className="border-b border-[#e8eae7] mb-1 pb-2 px-1">
              {(() => {
                const hasScore = stressData?.score != null;
                const tone = hasScore ? toneOf(stressData.score) : NO_DATA_TONE;
                return (
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <StressRing score={hasScore ? stressData.score : 0} tone={tone} size={44} />
                      <span className="absolute inset-0 flex items-center justify-center text-[12px] font-semibold" style={{ color: tone.text }}>
                        {hasScore ? Math.round(stressData.score) : "--"}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-slate-400">现在的状态</p>
                      <p className="text-sm font-semibold" style={{ color: tone.text }}>
                        {hasScore ? stressData?.level?.label || "暂无" : "暂无数据"}
                      </p>
                      {stressData?.level?.hint && (
                        <p className="text-[11px] leading-4 text-slate-400">{stressData.level.hint}</p>
                      )}
                    </div>
                  </div>
                );
              })()}
              <div className="mt-2">
                <p className="text-[11px] text-slate-400 mb-1">最近的变化</p>
                <StressTrend history={stressData?.history} />
                <p className="text-[11px] text-slate-400 mt-1">
                  {stressData?.score != null
                    ? stressData?.trend > 0 ? "比之前紧了一些" : stressData?.trend < 0 ? "缓下来了一点" : "比较平稳"
                    : "还没有足够的数据"}
                </p>
              </div>
            </div>
          )}

          {drooped && (
            <button
              onClick={handleBetter}
              className="text-xs text-[#8fb3c7] border border-[#c5d8e4] rounded-lg px-3 py-1.5 hover:bg-[#f0f6fa] transition-colors mb-1"
            >
              我好点了
            </button>
          )}
          {moodList.map((m) => (
            <button
              key={m.key}
              onClick={() => handleMood(m)}
              className="text-left text-sm text-slate-600 hover:text-slate-800 hover:bg-[#f2f7fa] rounded-lg px-3 py-1.5 transition-colors whitespace-nowrap"
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
