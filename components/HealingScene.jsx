"use client";

/**
 * 治愈小屋 · 沉浸式放松场景：呼吸放松 / 蝴蝶拍
 *
 * 为什么从「白色弹窗 + 纯色圆」改成全屏场景：
 *   - 放松时屏幕里最亮的是一块白卡片，在夜里很刺眼，也谈不上"氛围"；
 *   - 动画只有一个纯色圆在放大缩小，几乎看不出和呼吸的关系；
 *   - 蝴蝶拍原来的蝴蝶由桌宠承担，但现在的桌宠（WarmCompanion）已不再配合蝴蝶拍，
 *     开始后弹窗里是一块空白 —— 所以蝴蝶改由场景自己画（矢量，不依赖任何图片）。
 *
 * 设计原则（放松类动画和普通动效不一样）：
 *   1. 慢、软、不闪烁：所有过渡 ≥ 半秒，没有频闪，没有突然变亮；
 *   2. 提示语是"陪伴"而不是"命令"：停一停 / 缓缓呼出，而不是 屏住 / 呼气；
 *   3. 前后各问一次感受（可关）：没变化、变差都有不评判的回应，高分温和给出求助渠道；
 *   4. 任何时候都能体面地离开：中途点 × 只会得到一句"没关系"，不会像"失败"；
 *   5. 尊重 prefers-reduced-motion：关掉粒子 / 残影 / 旋转，只保留颜色与文字；
 *   6. 感受分数只在本次显示，**不上传、不入库**（心理状态属于敏感数据）。
 *
 * 对外：BreathScene / ButterflyScene —— 属性与旧的 BreathingAnimation / ButterflyAnimation 一致。
 */
import { useCallback, useEffect, useRef, useState } from "react";

const TAU = Math.PI * 2;
const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

/* ------------------------------ 偏好（只存本机） ------------------------------ */
const PREF_KEY = "solace_relax_prefs";
function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) || "{}") || {};
  } catch {
    return {};
  }
}
function savePrefs(patch) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
  } catch {
    /* 隐私模式 / 配额满：忽略 */
  }
}

/* ------------------------------ 文案 ------------------------------ */
const RHYTHMS = [
  { id: "4-2-6", label: "吸4 停2 呼6", v: [4, 2, 6] },
  // 有些人（尤其容易紧张的人）屏息反而更难受，所以提供"不停顿"的选择
  { id: "4-0-6", label: "吸4 呼6（不停顿）", v: [4, 0, 6] },
  { id: "5-0-5", label: "吸5 呼5", v: [5, 0, 5] },
];
const DURATIONS = [
  { v: 30, label: "30 秒" },
  { v: 60, label: "1 分钟" },
  { v: 120, label: "2 分钟" },
];
const PHASE_TEXT = { inhale: "慢慢吸气", hold: "停一停", exhale: "缓缓呼出" };
// 每个阶段轮换几句轻声的话（按"轮次"取，同一阶段内不变，不会闪来闪去）
const COMPANION_LINES = {
  inhale: ["吸进一点平静", "让空气慢慢填满", "你已经在照顾自己了"],
  hold: ["不用用力，停一停", "静静待着就好"],
  exhale: ["把紧绷一点点呼出去", "肩膀可以放松了", "不急，慢慢来"],
};
const HELPLINE_NOTE = "如果还是很难受，可以找信任的人聊聊，或拨打 12356 心理援助热线。你不必一个人扛着。";

/** 结束后的回应：不评判；没变化 / 变紧都是"正常的"；高分温和给出求助渠道 */
function feedback(pre, post) {
  if (post == null) {
    return { text: "辛苦了，不管感觉如何，你刚刚都在好好照顾自己。", care: "" };
  }
  let text;
  if (pre == null) text = "谢谢你告诉我。";
  else if (post < pre) text = `从 ${pre} 到 ${post}，身体在慢慢松下来。`;
  else if (post === pre) text = "感觉没怎么变也没关系，身体有时需要多一点时间。";
  else text = "现在比刚才更紧一些，也没关系，这样的感受很真实。";
  return { text, care: post >= 4 ? HELPLINE_NOTE : "" };
}

/* ------------------------------ 小工具：减少动态效果 ------------------------------ */
function prefersReducedMotion() {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/* ------------------------------ 声音（WebAudio 治愈级合成：温暖颂钵微风海潮 + 木质空灵轻叩） ------------------------------ */
function makeAudio() {
  let ac = null;
  let pad = null;
  const ctx = () => {
    if (!ac) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      ac = new C();
    }
    if (ac.state === "suspended") ac.resume();
    return ac;
  };

  // 生成一段 2 秒的柔和粉红噪波微风缓冲（模拟浅滩海潮与森林微风）
  const createBreezeBuffer = (a) => {
    const bufferSize = Math.floor(a.sampleRate * 2);
    const buffer = a.createBuffer(1, bufferSize, a.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.0990460;
      b1 = 0.96300 * b1 + white * 0.115926;
      b2 = 0.57000 * b2 + white * 0.444000;
      data[i] = (b0 + b1 + b2) * 0.055;
    }
    return buffer;
  };

  return {
    prime() {
      ctx();
    },
    // 呼吸放松：温暖颂钵大三度微泛音（432Hz 体系安定和弦）+ 随呼吸轻柔开合的潮汐微风
    padOn() {
      if (pad) return;
      const a = ctx();
      if (!a) return;

      // 1. 和弦基底：A2 (108Hz) 与 E3 (162.2Hz)，音高稳定恒定，绝无机械滑音或尖锐耳鸣
      const o1 = a.createOscillator();
      const o2 = a.createOscillator();
      o1.type = "sine";
      o2.type = "sine";
      o1.frequency.value = 108;
      o2.frequency.value = 162.2; // 纯五度自然微失谐，产生极其舒缓的疗愈波动

      // 2. 温暖低通滤波：随吸气自然打开，呼气时沉静收敛
      const filter = a.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 180;
      filter.Q.value = 0.8;

      // 3. 微风潮汐轻流
      let noiseNode = null;
      let noiseGain = null;
      try {
        const buf = createBreezeBuffer(a);
        noiseNode = a.createBufferSource();
        noiseNode.buffer = buf;
        noiseNode.loop = true;
        noiseGain = a.createGain();
        noiseGain.gain.value = 0.0001;
        noiseNode.connect(noiseGain);
        noiseGain.connect(filter);
        noiseNode.start();
      } catch {}

      const gn = a.createGain();
      gn.gain.value = 0;

      o1.connect(filter);
      o2.connect(filter);
      filter.connect(gn);
      gn.connect(a.destination);

      o1.start();
      o2.start();

      // 1.8秒缓慢淡入，主音量控制在 0.026，极为克制温和
      gn.gain.setTargetAtTime(0.026, a.currentTime, 1.8);

      pad = { o1, o2, gn, filter, noiseNode, noiseGain };
    },
    padSet(b) {
      if (!pad || !ac) return;
      const t = ac.currentTime;
      // 滤波与音量随呼吸平滑起伏：吸气时明亮充盈，呼气时沉稳消散
      const cutoff = 160 + 200 * b;
      pad.filter.frequency.setTargetAtTime(cutoff, t, 0.35);
      const vol = 0.015 + 0.02 * b;
      pad.gn.gain.setTargetAtTime(vol, t, 0.35);
      if (pad.noiseGain) {
        pad.noiseGain.gain.setTargetAtTime(0.003 + 0.011 * b, t, 0.35);
      }
    },
    padOff() {
      if (!pad || !ac) return;
      const { o1, o2, gn, noiseNode } = pad;
      pad = null;
      gn.gain.setTargetAtTime(0, ac.currentTime, 0.8);
      setTimeout(() => {
        try {
          o1.stop();
          o2.stop();
          noiseNode?.stop();
        } catch {}
      }, 1500);
    },
    // 蝴蝶拍：温暖木质轻叩与空灵风铃音（Soft Wooden Chime & Warm Tap）
    // 彻底告别 440/523Hz 刺耳蜂鸣，采用指腹轻拍双肩的自然温润声
    ping(side) {
      const a = ctx();
      if (!a) return;
      const t = a.currentTime;

      // 左右耳舒缓纯净音阶：左 220Hz (A3)，右 261.6Hz (C4 纯净大三度)
      const baseFreq = side < 0 ? 220 : 261.6;

      // 1. 模拟指腹轻叩衣物的温润触感（Tap / Thud）
      const oscTap = a.createOscillator();
      const gainTap = a.createGain();
      oscTap.type = "triangle";
      oscTap.frequency.setValueAtTime(baseFreq * 0.45, t);
      oscTap.frequency.exponentialRampToValueAtTime(75, t + 0.08);

      gainTap.gain.setValueAtTime(0.0001, t);
      gainTap.gain.exponentialRampToValueAtTime(0.032, t + 0.005);
      gainTap.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      oscTap.connect(gainTap);

      // 2. 空灵温润的泛音（Warm Chime），低通滤波滤除一切金属刺耳感
      const oscChime = a.createOscillator();
      const gainChime = a.createGain();
      const filter = a.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 420;

      oscChime.type = "sine";
      oscChime.frequency.setValueAtTime(baseFreq, t);

      gainChime.gain.setValueAtTime(0.0001, t);
      gainChime.gain.exponentialRampToValueAtTime(0.024, t + 0.01);
      gainChime.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);

      oscChime.connect(filter);
      filter.connect(gainChime);

      // 3. 立体声分相混音
      const merger = a.createGain();
      gainTap.connect(merger);
      gainChime.connect(merger);

      const p = a.createStereoPanner ? a.createStereoPanner() : null;
      if (p) {
        // 声相温和分离（0.6），既有明确的左右交替感，又不会单耳过载
        p.pan.value = Math.max(-0.6, Math.min(0.6, side * 0.6));
        merger.connect(p);
        p.connect(a.destination);
      } else {
        merger.connect(a.destination);
      }

      oscTap.start(t);
      oscTap.stop(t + 0.1);
      oscChime.start(t);
      oscChime.stop(t + 0.42);
    },
    dispose() {
      this.padOff();
      setTimeout(() => {
        try {
          ac && ac.close();
        } catch {}
      }, 1700);
    },
  };
}

/* ------------------------------ 画布素材 ------------------------------ */
function makeSprite() {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const x = c.getContext("2d");
  const q = x.createRadialGradient(16, 16, 0, 16, 16, 16);
  q.addColorStop(0, "rgba(255,255,255,1)");
  q.addColorStop(0.3, "rgba(190,215,255,.6)");
  q.addColorStop(1, "rgba(190,215,255,0)");
  x.fillStyle = q;
  x.fillRect(0, 0, 32, 32);
  return c;
}
const makeStars = () =>
  Array.from({ length: 70 }, () => ({
    x: Math.random(),
    y: Math.random() * 0.9,
    r: Math.random() * 1.1 + 0.3,
    p: Math.random() * TAU,
  }));
const makeParticles = (n) =>
  Array.from({ length: n }, () => ({
    a: Math.random() * TAU,
    d: 0.9 + Math.random() * 0.9,
    s: 0.4 + Math.random() * 0.8,
    p: Math.random() * TAU,
  }));

function drawStars(g, stars, W, H, now, rm) {
  g.fillStyle = "#fff";
  for (const s of stars) {
    g.globalAlpha = 0.25 + 0.45 * (rm ? 0.5 : Math.pow(Math.sin(now / 1300 + s.p), 2));
    g.beginPath();
    g.arc(s.x * W, s.y * H, s.r, 0, TAU);
    g.fill();
  }
  g.globalAlpha = 1;
}

/** 矢量蝴蝶：不依赖图片；fl = 翅膀横向开合（0.25~1），rot = 倾斜 */
function drawButterfly(g, x, y, s, fl, rot, alpha) {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.globalAlpha = alpha;
  for (const sd of [-1, 1]) {
    g.save();
    g.scale(sd * fl, 1);
    const q = g.createLinearGradient(0, -s, s, s * 0.8);
    q.addColorStop(0, "#e6f3ff");
    q.addColorStop(0.5, "#8fc0f0");
    q.addColorStop(1, "#4a78c8");
    g.fillStyle = q;
    g.strokeStyle = "rgba(255,255,255,.55)";
    g.lineWidth = 1;
    g.beginPath(); // 上翅
    g.moveTo(0, 0);
    g.bezierCurveTo(s * 0.2, -s * 0.9, s * 1.05, -s, s * 1.05, -s * 0.35);
    g.bezierCurveTo(s, s * 0.05, s * 0.45, s * 0.15, 0, 0);
    g.fill();
    g.stroke();
    g.beginPath(); // 下翅
    g.moveTo(0, s * 0.05);
    g.bezierCurveTo(s * 0.8, s * 0.1, s * 0.95, s * 0.8, s * 0.45, s * 0.85);
    g.bezierCurveTo(s * 0.15, s * 0.8, 0, s * 0.4, 0, s * 0.05);
    g.fill();
    g.stroke();
    g.restore();
  }
  g.fillStyle = "#24427a"; // 身体
  g.beginPath();
  g.ellipse(0, s * 0.25, s * 0.06, s * 0.5, 0, 0, TAU);
  g.fill();
  g.strokeStyle = "#24427a"; // 触角
  g.lineWidth = 1.2;
  g.beginPath();
  g.moveTo(0, -s * 0.22);
  g.quadraticCurveTo(-s * 0.15, -s * 0.55, -s * 0.3, -s * 0.62);
  g.moveTo(0, -s * 0.22);
  g.quadraticCurveTo(s * 0.15, -s * 0.55, s * 0.3, -s * 0.62);
  g.stroke();
  g.restore();
}

/** 呼吸阶段（el 秒 → 当前阶段 / 阶段进度 / 平滑后的"胀缩值" b / 本阶段剩余秒数 / 第几轮） */
function breathState(el, a, h, o) {
  const cyc = a + h + o;
  const round = Math.min(3, Math.floor(el / cyc) + 1);
  const c = el % cyc;
  if (c < a) return { ph: "inhale", pt: c / a, b: easeInOut(c / a), left: a - c, round };
  if (c < a + h) return { ph: "hold", pt: (c - a) / h, b: 1, left: a + h - c, round };
  return { ph: "exhale", pt: (c - a - h) / o, b: 1 - easeInOut((c - a - h) / o), left: cyc - c, round };
}

/* ------------------------------ 场景流程（两个场景共用） ------------------------------ */
// idle 开始前 → pre 问感受 → run 进行中 → post 问感受 → end 收尾；run 中途点 × → quit
function useSession({ moodOn, onClose }) {
  const [stage, setStage] = useState("idle");
  const [pre, setPre] = useState(null);
  const [post, setPost] = useState(null);
  const [paused, setPaused] = useState(false);

  const go = useCallback(() => { setPaused(false); setStage("run"); }, []);
  const start = useCallback(() => {
    setPre(null);
    setPost(null);
    setPaused(false);
    setStage(moodOn ? "pre" : "run");
  }, [moodOn]);
  const pickPre = useCallback((n) => {
    setPre(n);
    setPaused(false);
    setStage("run");
  }, []);
  const pickPost = useCallback((n) => {
    setPost(n);
    setStage("end");
  }, []);
  const skip = useCallback(() => setStage("end"), []);
  const finish = useCallback(() => setStage(moodOn ? "post" : "end"), [moodOn]);
  const quit = useCallback(() => {
    setPaused(false);
    if (stage === "run") setStage("quit");
    else onClose();
  }, [stage, onClose]);
  const togglePause = useCallback(() => {
    setPaused((p) => !p);
  }, []);

  return { stage, pre, post, paused, togglePause, go, start, pickPre, pickPost, skip, finish, quit };
}

/* ------------------------------ 界面小件 ------------------------------ */
const chipCls =
  "min-h-[40px] rounded-full border border-white/25 bg-white/10 px-4 py-2 text-sm text-[#eaf3ff] backdrop-blur " +
  "transition-colors hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300";
const hotCls = "!bg-sky-300/30 !border-sky-200/50";
const shadow = { textShadow: "0 2px 12px rgba(0,0,0,.5)" };

function Chip({ children, hot, pressed, ...rest }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={`${chipCls} ${hot || pressed ? hotCls : ""}`}
      {...rest}
    >
      {children}
    </button>
  );
}

function MoodChips({ onPick }) {
  return (
    <>
      <div className="flex flex-wrap justify-center gap-2" role="group" aria-label="感受打分，1 很平静，5 很难受">
        {[1, 2, 3, 4, 5].map((n) => (
          <Chip key={n} onClick={() => onPick(n)} aria-label={`${n} 分`}>
            {n}
          </Chip>
        ))}
      </div>
      <small className="text-xs opacity-75">1 很平静 · 5 很难受（只在这里显示，不会被保存）</small>
    </>
  );
}

/** 底部面板：按阶段显示不同内容；run 时提供悬浮暂停与退出控制 */
function Panel({ sess, intro, options, onClose, onChat }) {
  const { stage } = sess;
  if (stage === "run") {
    return (
      <div
        className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-3 px-4 z-20 pointer-events-auto"
        style={{ paddingBottom: "max(24px, calc(env(safe-area-inset-bottom, 0px) + 16px))" }}
      >
        <Chip
          onClick={sess.togglePause}
          className={`${chipCls} min-w-[100px] !bg-white/20 !border-white/35 font-medium shadow-lg`}
        >
          {sess.paused ? "▶ 继续" : "⏸ 暂停"}
        </Chip>
        <Chip
          onClick={sess.quit}
          className={`${chipCls} min-w-[80px] !bg-black/25 hover:!bg-black/40 !border-white/20 shadow-lg`}
        >
          ✕ 退出
        </Chip>
      </div>
    );
  }
  let body = null;
  if (stage === "idle") {
    body = (
      <>
        <p>{intro}</p>
        <div className="flex flex-wrap justify-center gap-3">
          <Chip hot autoFocus onClick={sess.start}>
            开始
          </Chip>
          <Chip onClick={onClose}>
            退出
          </Chip>
        </div>
        {options}
        <small className="text-xs opacity-75">也可以按空格键开始</small>
      </>
    );
  } else if (stage === "pre") {
    body = (
      <>
        <p>开始之前，你现在感觉怎么样？</p>
        <MoodChips onPick={sess.pickPre} />
        <div className="flex flex-wrap justify-center gap-2">
          <Chip onClick={sess.go}>直接开始</Chip>
          <Chip onClick={onClose}>退出</Chip>
        </div>
      </>
    );
  } else if (stage === "post") {
    body = (
      <>
        <p>做完了，辛苦啦。现在感觉怎么样？</p>
        <MoodChips onPick={sess.pickPost} />
        <Chip onClick={sess.skip}>先不说</Chip>
      </>
    );
  } else if (stage === "end") {
    const fb = feedback(sess.pre, sess.post);
    body = (
      <>
        <p>{fb.text}</p>
        {fb.care && <p className="text-xs leading-5 opacity-85">{fb.care}</p>}
        <div className="flex flex-wrap justify-center gap-2">
          <Chip onClick={sess.start}>再来一轮</Chip>
          {onChat && (
            <Chip
              hot
              onClick={() => {
                onClose();
                onChat();
              }}
            >
              去和暖言聊聊
            </Chip>
          )}
          <Chip onClick={onClose}>先到这里</Chip>
        </div>
      </>
    );
  } else if (stage === "quit") {
    body = (
      <>
        <p>没关系，想继续的时候再来就好。</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Chip hot onClick={sess.start}>
            重新开始
          </Chip>
          <Chip onClick={onClose}>先到这里</Chip>
        </div>
      </>
    );
  }
  return (
    <div
      className="absolute inset-x-0 bottom-0 flex max-h-[60%] flex-col items-center gap-3 overflow-y-auto px-4 pt-2 text-center text-sm leading-7"
      style={{ ...shadow, paddingBottom: "max(28px, calc(env(safe-area-inset-bottom, 0px) + 20px))" }}
      aria-live="polite"
    >
      {body}
    </div>
  );
}

const BG_LAYERS = {
  c: "radial-gradient(ellipse at 50% 40%,#1e3a5a,#0e1c33 55%,#070d1a)", // 吸气：冷蓝
  l: "radial-gradient(ellipse at 50% 40%,#3a3470,#1a1840 55%,#0a0a1e)", // 停一停：淡紫
  w: "radial-gradient(ellipse at 50% 40%,#6a3a5a,#2e1a3a 55%,#120a1e)", // 呼气：暖粉
  d: "radial-gradient(ellipse at 50% 100%,#6a4a7a,#2a2750 50%,#0b0f24)", // 蝴蝶拍：暮色
};

/** 场景外壳：背景层 + 画布 + 关闭按钮 + 键盘（空格开始 / Esc 离开） */
function SceneShell({ label, bg, canvasRef, sess, children }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        sess.quit();
        return;
      }
      if (e.code === "Space" && sess.stage === "idle") {
        // 焦点在按钮上时空格本来就会触发点击，别重复
        if (e.target?.closest?.("button")) return;
        e.preventDefault();
        sess.start();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sess.stage, sess.quit, sess.start]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="modal-fade fixed inset-0 z-50 select-none overflow-hidden bg-[#070d1a] text-[#eaf3ff]"
    >
      {Object.entries(BG_LAYERS).map(([k, image]) => (
        <div
          key={k}
          className="absolute inset-0 transition-opacity duration-[3000ms] ease-in-out"
          style={{ backgroundImage: image, opacity: bg === k ? 1 : 0 }}
        />
      ))}
      <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full" />
      {children}
      <button
        type="button"
        onClick={sess.quit}
        aria-label="退出"
        title="退出（Esc）"
        className="absolute right-4 z-30 flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-black/30 hover:bg-black/50 text-white border border-white/25 text-xs backdrop-blur-md shadow-lg transition-all"
        style={{ top: "calc(16px + env(safe-area-inset-top, 0px))" }}
      >
        <span>✕</span>
        <span>退出</span>
      </button>
    </div>
  );
}

/** 画布尺寸跟随容器（DPR 封顶 2，省电） */
function fitCanvas(cv, g, rt) {
  const r = cv.getBoundingClientRect();
  const d = Math.min(window.devicePixelRatio || 1, 2);
  rt.W = r.width || 1;
  rt.H = r.height || 1;
  cv.width = rt.W * d;
  cv.height = rt.H * d;
  g.setTransform(d, 0, 0, d, 0, 0);
}

/* ============================== 呼吸放松 ============================== */
export function BreathScene({ onClose, onWantToTalk }) {
  const [rhythmId, setRhythmId] = useState(() => loadPrefs().rhythm || "4-2-6");
  const [style, setStyle] = useState(() => (loadPrefs().style === "lotus" ? "lotus" : "orb"));
  const [sound, setSound] = useState(() => !!loadPrefs().sound); // 声音默认关
  const [moodOn, setMoodOn] = useState(() => loadPrefs().mood !== false);
  const [showOpts, setShowOpts] = useState(false);
  const [hud, setHud] = useState({ label: "", sub: "", count: "", bg: "c" });

  const sess = useSession({ moodOn, onClose });
  const rhythm = (RHYTHMS.find((r) => r.id === rhythmId) || RHYTHMS[0]).v;

  const cvRef = useRef(null);
  const rt = useRef({ W: 1, H: 1, run: false, done: false, t0: 0, doneAt: 0, lastRip: 0, rip: [], hudKey: "" });
  const live = useRef({});
  live.current = { rhythm, style, sound, stage: sess.stage, finish: sess.finish, paused: sess.paused };
  const audio = useRef(null);
  if (!audio.current && typeof window !== "undefined") audio.current = makeAudio();

  // 偏好落盘
  useEffect(() => savePrefs({ rhythm: rhythmId, style, sound, mood: moodOn }), [rhythmId, style, sound, moodOn]);

  // 阶段切换：进入 run 才开始计时；离开 run 立刻停声音
  useEffect(() => {
    const r = rt.current;
    if (sess.stage === "run") {
      r.run = true;
      r.done = false;
      r.t0 = performance.now();
      r.rip.length = 0;
      if (live.current.sound) audio.current?.padOn();
    } else {
      r.run = false;
      audio.current?.padOff();
      if (sess.stage === "idle" || sess.stage === "pre" || sess.stage === "quit") r.done = false;
    }
  }, [sess.stage]);

  // 运行中切换声音开关
  useEffect(() => {
    if (sess.stage !== "run") return;
    if (sound) audio.current?.padOn();
    else audio.current?.padOff();
  }, [sound, sess.stage]);

  useEffect(() => () => audio.current?.dispose(), []);

  // 主循环
  useEffect(() => {
    const cv = cvRef.current;
    const g = cv?.getContext("2d");
    if (!g) return undefined;
    const r = rt.current;
    const rm = prefersReducedMotion();
    const sprite = makeSprite();
    const stars = makeStars();
    const parts = rm ? [] : makeParticles(70);
    const fit = () => fitCanvas(cv, g, r);
    fit();
    window.addEventListener("resize", fit);

    let raf = 0;
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      if (live.current.paused) {
        if (!r.pausedAt) {
          r.pausedAt = now;
          audio.current?.padOff();
        }
        const key = "已暂停|||c";
        if (key !== r.hudKey) {
          r.hudKey = key;
          setHud({ label: "已暂停", sub: "点击下方继续，随时回来", count: "", bg: "c" });
        }
        return;
      } else if (r.pausedAt) {
        r.t0 += (now - r.pausedAt);
        r.pausedAt = 0;
        if (live.current.sound) audio.current?.padOn();
      }
      const { rhythm: rh, style: sty, stage } = live.current;
      const [a, h, o] = rh;
      const total = (a + h + o) * 3;
      const { W, H } = r;

      let el = r.done ? total : r.run ? (now - r.t0) / 1000 : 0;
      if (r.run && el >= total) {
        r.run = false;
        r.done = true;
        r.doneAt = now;
        el = total;
        audio.current?.padOff();
        live.current.finish();
      }
      const running = r.run;
      const s = r.done
        ? { ph: "done", b: 0, pt: 1, left: 0, round: 3 }
        : running
        ? breathState(el, a, h, o)
        : { ph: "idle", b: 0, pt: 0, left: 0, round: 1 };

      r.lastPh = running ? s.ph : "";

      // ---- HUD（只在内容变化时才触发 React 更新）----
      const bg = running ? { inhale: "c", hold: "l", exhale: "w" }[s.ph] : stage === "post" || stage === "end" ? "w" : "c";
      const label = running ? PHASE_TEXT[s.ph] : "";
      const lines = COMPANION_LINES[s.ph];
      const sub = running && lines ? `${lines[(s.round - 1) % lines.length]}　·　第 ${s.round} / 3 轮` : "";
      const count = running ? String(Math.ceil(s.left)) : "";
      const key = `${label}|${sub}|${count}|${bg}`;
      if (key !== r.hudKey) {
        r.hudKey = key;
        setHud({ label, sub, count, bg });
      }
      if (running && live.current.sound) audio.current?.padSet(s.b);

      // ---- 绘制 ----
      g.clearRect(0, 0, W, H);
      drawStars(g, stars, W, H, now, rm);
      const cx = W / 2;
      const cy = H * 0.44;
      const R0 = Math.min(W, H) * 0.12;
      const rad = R0 * (1 + 0.5 * s.b);
      const M = Math.min(W, H) * 0.34;

      // 光点：吸气向中心聚拢、呼气散开；完成后像萤火虫缓缓上升
      g.globalCompositeOperation = "lighter";
      for (const p of parts) {
        const rise = r.done ? ((now - r.doneAt) / 1000) * p.s * 14 : 0;
        const dist = M * p.d * (1.1 - 0.5 * s.b) + Math.sin(now / 1500 + p.p) * 5;
        const an = p.a + now * 0.00006 * p.s;
        const x = cx + Math.cos(an) * dist;
        const y = cy + Math.sin(an) * dist - (rise % (H * 0.5));
        const sz = 6 + 9 * p.s;
        g.globalAlpha = 0.2 + 0.35 * Math.pow(Math.sin(now / 800 + p.p), 2);
        g.drawImage(sprite, x - sz / 2, y - sz / 2, sz, sz);
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = "source-over";

      // 柔光（夜里别太刺眼，亮度刻意压低）
      let q = g.createRadialGradient(cx, cy, rad * 0.3, cx, cy, rad * 2.7);
      q.addColorStop(0, `rgba(140,195,240,${0.4 + 0.2 * s.b})`);
      q.addColorStop(1, "rgba(140,195,240,0)");
      g.fillStyle = q;
      g.beginPath();
      g.arc(cx, cy, rad * 2.7, 0, TAU);
      g.fill();

      if (sty === "orb") {
        q = g.createRadialGradient(cx - rad * 0.25, cy - rad * 0.3, rad * 0.1, cx, cy, rad);
        q.addColorStop(0, "rgba(255,255,255,.8)");
        q.addColorStop(0.45, "rgba(169,198,218,.92)");
        q.addColorStop(1, "rgba(105,150,205,.6)");
        g.fillStyle = q;
        g.beginPath();
        g.arc(cx, cy, rad, 0, TAU);
        g.fill();
        if (!rm) {
          // 球内缓慢游动的三团光
          g.save();
          g.beginPath();
          g.arc(cx, cy, rad, 0, TAU);
          g.clip();
          g.globalCompositeOperation = "lighter";
          for (let k = 0; k < 3; k++) {
            const ang = now * 0.0003 + k * 2.094;
            const bx = cx + Math.cos(ang) * rad * 0.5;
            const by = cy + Math.sin(ang) * rad * 0.5;
            q = g.createRadialGradient(bx, by, 0, bx, by, rad * 0.6);
            q.addColorStop(0, "rgba(190,225,255,.35)");
            q.addColorStop(1, "rgba(190,225,255,0)");
            g.fillStyle = q;
            g.beginPath();
            g.arc(bx, by, rad * 0.6, 0, TAU);
            g.fill();
          }
          g.restore();
        }
      } else {
        // 莲花：吸气时花瓣展开，呼气时合拢
        g.globalCompositeOperation = "lighter";
        for (let k = 0; k < 2; k++) {
          for (let i = 0; i < 8; i++) {
            g.save();
            g.translate(cx, cy);
            g.rotate(i * 0.7854 + k * 0.3927 + (rm ? 0 : now * 0.00005 * (k ? -1 : 1)));
            const ry = rad * (0.4 + 0.2 * s.b) * (k ? 0.8 : 1);
            const off = rad * (0.08 + 0.3 * s.b) * (k ? 0.8 : 1);
            g.fillStyle = k ? "rgba(200,170,240,.24)" : "rgba(150,200,245,.28)";
            g.strokeStyle = "rgba(255,255,255,.3)";
            g.lineWidth = 1;
            g.beginPath();
            g.ellipse(0, -(off + ry * 0.55), rad * 0.2, ry, 0, 0, TAU);
            g.fill();
            g.stroke();
            g.restore();
          }
        }
        g.globalCompositeOperation = "source-over";
        q = g.createRadialGradient(cx, cy, 0, cx, cy, rad * 0.4);
        q.addColorStop(0, "rgba(255,245,230,.9)");
        q.addColorStop(1, "rgba(255,220,200,0)");
        g.fillStyle = q;
        g.beginPath();
        g.arc(cx, cy, rad * 0.4, 0, TAU);
        g.fill();
      }

      // 涟漪只在"呼气"时放出（吸气是聚拢，呼气才是释放）
      if (s.ph === "exhale" && now - r.lastRip > 1500 && !rm) {
        r.lastRip = now;
        r.rip.push(now);
      }
      for (let i = r.rip.length - 1; i >= 0; i--) {
        const t = (now - r.rip[i]) / 3200;
        if (t > 1) {
          r.rip.splice(i, 1);
          continue;
        }
        g.strokeStyle = `rgba(236,170,205,${0.5 * (1 - t)})`;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(cx, cy, rad * (1.05 + 1.1 * t), 0, TAU);
        g.stroke();
      }

      // 外圈 = 本阶段进度
      const RR = R0 * 2.35;
      g.lineWidth = 3;
      g.lineCap = "round";
      g.strokeStyle = "rgba(255,255,255,.12)";
      g.beginPath();
      g.arc(cx, cy, RR, 0, TAU);
      g.stroke();
      if (running) {
        g.strokeStyle = { inhale: "#9fd0f5", hold: "#c3b4f0", exhale: "#f0a8c8" }[s.ph];
        g.beginPath();
        g.arc(cx, cy, RR, -Math.PI / 2, -Math.PI / 2 + TAU * s.pt);
        g.stroke();
      }

      // 做完：一只蝴蝶飞进来
      if (r.done) {
        const k = Math.min(1, (now - r.doneAt) / 2500);
        drawButterfly(
          g,
          cx + (1 - k) * W * 0.45 + Math.sin(now / 1100) * W * 0.06,
          cy - RR - 30 - Math.sin(now / 700) * 6,
          Math.min(Math.min(W, H) * 0.045, 40),
          0.7 + 0.3 * Math.cos(now / 180),
          0.1 * Math.sin(now / 1100),
          k
        );
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", fit);
    };
  }, []);

  const onChat = onWantToTalk ? () => onWantToTalk() : null;

  return (
    <SceneShell label="呼吸放松" bg={hud.bg} canvasRef={cvRef} sess={sess}>
      {sess.stage === "run" && (
        <>
          <div
            className="pointer-events-none absolute inset-x-0 text-center font-light"
            // 数字落在发亮的光球上：用深色 + 淡白光晕，白字会和球心糊成一片
            style={{
              top: "44%",
              transform: "translateY(-50%)",
              fontSize: "clamp(28px, 6vw, 44px)",
              color: "#16324f",
              textShadow: "0 0 10px rgba(255,255,255,.35)",
            }}
          >
            {hud.count}
          </div>
          <div
            className="pointer-events-none absolute inset-x-0 text-center text-lg tracking-[.2em]"
            style={{ bottom: "15%", ...shadow }}
            aria-live="polite"
          >
            {hud.label}
          </div>
          <div className="pointer-events-none absolute inset-x-0 px-4 text-center text-xs opacity-75" style={{ bottom: "9%", ...shadow }}>
            {hud.sub}
          </div>
        </>
      )}
      <Panel
        sess={sess}
        onClose={onClose}
        onChat={onChat}
        intro="找个舒服的姿势，我们慢慢来。"
        options={
          <div className="flex flex-col items-center gap-2">
            <button type="button" onClick={() => setShowOpts((v) => !v)} aria-expanded={showOpts} className="text-xs underline opacity-80">
              {showOpts ? "收起选项" : "选项（节奏 · 样式 · 声音）"}
            </button>
            {showOpts && (
              <div className="flex flex-col items-center gap-2">
                <div className="flex flex-wrap justify-center gap-2" role="group" aria-label="呼吸节奏">
                  {RHYTHMS.map((x) => (
                    <Chip key={x.id} pressed={rhythmId === x.id} onClick={() => setRhythmId(x.id)}>
                      {x.label}
                    </Chip>
                  ))}
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  <Chip pressed={style === "orb"} onClick={() => setStyle("orb")}>光球</Chip>
                  <Chip pressed={style === "lotus"} onClick={() => setStyle("lotus")}>莲花</Chip>
                  <Chip pressed={sound} onClick={() => setSound((v) => !v)}>声音（柔和长音）</Chip>
                  <Chip pressed={moodOn} onClick={() => setMoodOn((v) => !v)}>前后问我感受</Chip>
                </div>
              </div>
            )}
          </div>
        }
      />
    </SceneShell>
  );
}

/* ============================== 蝴蝶拍 ============================== */
export function ButterflyScene({ onClose, onStateChange, onWantToTalk }) {
  const [dur, setDur] = useState(() => {
    const v = Number(loadPrefs().bfDur);
    return DURATIONS.some((d) => d.v === v) ? v : 60;
  });
  const [stereo, setStereo] = useState(() => !!loadPrefs().stereo); // 默认关
  const [moodOn, setMoodOn] = useState(() => loadPrefs().mood !== false);
  const [showOpts, setShowOpts] = useState(false);
  const [hud, setHud] = useState({ label: "", bg: "d" });

  const sess = useSession({ moodOn, onClose });
  const running = sess.stage === "run";

  const cvRef = useRef(null);
  const rt = useRef({ W: 1, H: 1, run: false, done: false, t0: 0, doneAt: 0, lastBeat: 0, beats: [], trail: [], pollen: [], hudKey: "" });
  const live = useRef({});
  live.current = { dur, stereo, finish: sess.finish, paused: sess.paused };
  const audio = useRef(null);
  if (!audio.current && typeof window !== "undefined") audio.current = makeAudio();
  const reportRef = useRef(onStateChange);
  reportRef.current = onStateChange;

  useEffect(() => savePrefs({ bfDur: dur, stereo, mood: moodOn }), [dur, stereo, moodOn]);

  // 向父组件上报（保持和旧版一致的 { open, running, phase } 形状；桌宠已不依赖它，保留给将来用）
  useEffect(() => {
    reportRef.current?.({ open: true, running, phase: running ? "leftUp" : "idle" });
  }, [running]);
  useEffect(() => () => reportRef.current?.({ open: false, running: false, phase: "idle" }), []);

  useEffect(() => {
    const r = rt.current;
    if (sess.stage === "run") {
      r.run = true;
      r.done = false;
      r.t0 = performance.now();
      r.lastBeat = 0;
      r.beats.length = r.trail.length = r.pollen.length = 0;
      if (live.current.stereo) audio.current?.prime(); // 需要在用户手势内唤醒音频
    } else {
      r.run = false;
      if (sess.stage === "idle" || sess.stage === "pre" || sess.stage === "quit") r.done = false;
    }
  }, [sess.stage]);

  useEffect(() => () => audio.current?.dispose(), []);

  useEffect(() => {
    const cv = cvRef.current;
    const g = cv?.getContext("2d");
    if (!g) return undefined;
    const r = rt.current;
    const rm = prefersReducedMotion();
    const sprite = makeSprite();
    const stars = makeStars();
    const fit = () => fitCanvas(cv, g, r);
    fit();
    window.addEventListener("resize", fit);

    let raf = 0;
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      if (live.current.paused) {
        if (!r.pausedAt) r.pausedAt = now;
        const pLabel = "已暂停";
        if (pLabel !== r.hudKey) {
          r.hudKey = pLabel;
          setHud({ label: pLabel, bg: "d" });
        }
        return;
      } else if (r.pausedAt) {
        r.t0 += (now - r.pausedAt);
        r.pausedAt = 0;
      }
      const { dur: total, stereo: st } = live.current;
      const { W, H } = r;
      let el = r.done ? total : r.run ? (now - r.t0) / 1000 : 0;
      if (r.run && el >= total) {
        r.run = false;
        r.done = true;
        r.doneAt = now;
        el = total;
        live.current.finish();
      }
      const liveRun = r.run;

      const label = liveRun ? (Math.floor(el) % 2 === 0 ? "左拍…" : "右拍…") : "";
      if (label !== r.hudKey) {
        r.hudKey = label;
        setHud({ label, bg: "d" });
      }

      g.clearRect(0, 0, W, H);
      drawStars(g, stars, W, H, now, rm);
      const cx = W / 2;
      const cy = H * 0.4;
      const S = Math.min(Math.min(W, H) * 0.14, 96);
      const A = Math.min(W * 0.17, 140);
      const sx = Math.min(W * 0.35, 280); // 左右肩光点离中线的距离（大屏上别飞太远）
      const sy = H * 0.8;

      // 节拍：每秒换一侧，在这一侧"最靠外"的时刻触发
      if (liveRun) {
        const idx = Math.floor(el + 0.5);
        if (idx > r.lastBeat) {
          r.lastBeat = idx;
          const sd = idx % 2 ? -1 : 1;
          r.beats.push({ sd, t: now });
          if (r.beats.length > 8) r.beats.shift();
          
          if (st) audio.current?.ping(sd);
        }
      }

      // 左右肩的光点：轮到哪边哪边亮起并扩散涟漪
      for (const sd of [-1, 1]) {
        const x = cx + sd * sx;
        let last = -1e9;
        for (const b of r.beats) if (b.sd === sd) last = b.t;
        const k = Math.max(0, 1 - (now - last) / 1000);
        const sz = 150 * (1 + 0.6 * k);
        g.globalCompositeOperation = "lighter";
        g.globalAlpha = 0.25 + 0.6 * k;
        g.drawImage(sprite, x - sz / 2, sy - sz / 2, sz, sz);
        g.globalCompositeOperation = "source-over";
        g.globalAlpha = 0.6;
        g.fillStyle = "#cfe3ff";
        g.font = "12px system-ui, sans-serif";
        g.textAlign = "center";
        g.fillText(sd < 0 ? "左肩" : "右肩", x, sy + 4);
      }
      for (const b of r.beats) {
        const t = (now - b.t) / 1000;
        if (t < 1) {
          g.globalAlpha = 0.6 * (1 - t);
          g.strokeStyle = "#bcdcff";
          g.lineWidth = 2;
          g.beginPath();
          g.arc(cx + b.sd * sx, sy, 14 + Math.min(W * 0.12, 100) * t, 0, TAU);
          g.stroke();
        }
      }
      g.globalAlpha = 1;

      // 蝴蝶：随节拍在左右之间摆动，翅膀 2 次/秒扇动，带淡淡的残影
      const off = liveRun ? -A * Math.sin(Math.PI * el) : Math.sin(now / 1600) * A * 0.2;
      const x = cx + off;
      const y = cy + (liveRun ? 0 : Math.sin(now / 900) * 6);
      const fl = liveRun ? 0.62 + 0.38 * Math.cos(el * 4 * Math.PI) : 0.75 + 0.25 * Math.cos(now / 450);
      const rot = (off / A) * 0.25;
      if (!rm && liveRun) {
        r.trail.push({ x, y, fl, rot, t: now });
        while (r.trail.length && now - r.trail[0].t > 280) r.trail.shift();
        for (const o of r.trail) drawButterfly(g, o.x, o.y, S, o.fl, o.rot, 0.16 * (1 - (now - o.t) / 280));
      }
      g.globalCompositeOperation = "lighter";
      g.globalAlpha = 0.55;
      g.drawImage(sprite, x - S * 2.4, y - S * 2.4, S * 4.8, S * 4.8);
      g.globalCompositeOperation = "source-over";
      g.globalAlpha = 1;
      drawButterfly(g, x, y, S, fl, rot, 1);

      // 磷粉
      if (!rm && (liveRun || r.done) && Math.random() < 0.4 && r.pollen.length < 60) {
        r.pollen.push({
          x: x + (Math.random() - 0.5) * S * 1.8,
          y: y + (Math.random() - 0.3) * S,
          vx: (Math.random() - 0.5) * 0.25,
          vy: -0.2 - Math.random() * 0.3,
          t: now,
          l: 1200 + Math.random() * 900,
        });
      }
      g.globalCompositeOperation = "lighter";
      for (let i = r.pollen.length - 1; i >= 0; i--) {
        const o = r.pollen[i];
        const t = (now - o.t) / o.l;
        if (t > 1) {
          r.pollen.splice(i, 1);
          continue;
        }
        o.x += o.vx;
        o.y += o.vy;
        g.globalAlpha = 0.8 * (1 - t);
        g.drawImage(sprite, o.x - 5, o.y - 5, 10, 10);
      }
      g.globalCompositeOperation = "source-over";
      g.globalAlpha = 1;

      // 顶部细进度条
      if (liveRun) {
        g.fillStyle = "rgba(159,208,245,.85)";
        g.fillRect(0, 0, (W * el) / total, 3);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", fit);
    };
  }, []);

  const onChat = onWantToTalk ? () => onWantToTalk() : null;

  return (
    <SceneShell label="蝴蝶拍" bg="d" canvasRef={cvRef} sess={sess}>
      {running && (
        <>
          <div
            className="pointer-events-none absolute inset-x-0 text-center text-lg tracking-[.2em]"
            style={{ bottom: "15%", ...shadow }}
            aria-live="polite"
          >
            {hud.label}
          </div>
          <div className="pointer-events-none absolute inset-x-0 px-4 text-center text-xs opacity-75" style={{ bottom: "9%", ...shadow }}>
            节奏放慢，对自己说「我现在是安全的」
          </div>
        </>
      )}
      <Panel
        sess={sess}
        onClose={onClose}
        onChat={onChat}
        intro={
          <>
            双手交叉抱在胸前，左手放在右肩，右手放在左肩。
            <br />
            左右交替轻轻拍打，像蝴蝶扇动翅膀一样。
            <br />
            一边拍一边深呼吸，慢慢来。
          </>
        }
        options={
          <div className="flex flex-col items-center gap-2">
            <button type="button" onClick={() => setShowOpts((v) => !v)} aria-expanded={showOpts} className="text-xs underline opacity-80">
              {showOpts ? "收起选项" : "选项（时长 · 立体声）"}
            </button>
            {showOpts && (
              <div className="flex flex-col items-center gap-2">
                <div className="flex flex-wrap justify-center gap-2" role="group" aria-label="时长">
                  {DURATIONS.map((d) => (
                    <Chip key={d.v} pressed={dur === d.v} onClick={() => setDur(d.v)}>
                      {d.label}
                    </Chip>
                  ))}
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  <Chip pressed={stereo} onClick={() => setStereo((v) => !v)}>立体声（戴耳机）</Chip>
                  
                  <Chip pressed={moodOn} onClick={() => setMoodOn((v) => !v)}>前后问我感受</Chip>
                </div>
              </div>
            )}
          </div>
        }
      />
    </SceneShell>
  );
}
