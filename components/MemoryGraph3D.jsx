"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * 「记忆电子云」—— 原生 Three.js 纯展示组件（v4，全部贴图 / 粒子，没有实心球）。
 *
 * 视觉层级：
 *   * 3000 个 `Points` 微尘 = 背景电子云（高斯分布半径，越靠外越稀）；
 *   * **记忆节点 = `THREE.Sprite` + 十字星芒贴图**（⛔ 不用 SphereGeometry 实心球）；
 *     尺寸介于核心与背景微尘之间，颜色按分类（画像金 / 偏好青 / 愿望紫 / 日常灰蓝）；
 *   * 正中心 = 最大的一颗亮白星芒 + 柔光（**只比最亮的记忆星稍大稍亮**，别做成探照灯）；
 *     「暖言」名字**不常驻**，悬停在核心上时才弹出「核心（暖言）」卡片；
 *   * `LineSegments` 画**记忆节点之间的**弯曲突触（没有连向中心的辐条），加法混合、极低透明度；
 *
 * 发光感靠"贴图自带柔光 + 加法混合"模拟 Bloom —— 不做后处理，省下整屏后期开销。
 *
 * ⛔ 绝对不自动旋转：
 *   * `OrbitControls.autoRotate = false`、`enableDamping = false`（松手立即停，没有惯性）；
 *   * **没有 requestAnimationFrame 循环** —— 只有拖拽 / 缩放 / 悬停 / 数据变化时渲染一帧。
 *
 * ⚠️ 性能红线：
 *   * 节点上限 150（与服务端 graph=1 的 MAX_GRAPH_NODES 一致）；
 *   * 粒子固定 3000，一次性 BufferGeometry，不做逐帧更新；
 *   * 所有节点共享同一张星芒贴图，靠 `SpriteMaterial.color` 着色；
 *   * 卸载时 dispose 材质 / 贴图 + `renderer.dispose()` + `forceContextLoss()`。
 */

const MAX_NODES = 150;
const MAX_SYNAPSE_LINKS = 180;
const MAX_EXTRA_DEGREE = 4;
const CLOUD_COUNT = 3000;
const CLOUD_RADIUS = 155; // 点云半径（世界单位）
const LAYOUT_RADIUS = 112; // 记忆节点最大半径
const CAMERA_Z = 210; // 兜底视距（真正打开时按节点范围自动算一次，见 fitCameraDistance）
const SPRITE_SCALE = 2.6; // 节点星芒尺寸 = radius × 该倍数（比背景点大、比中心核心小）

// 中心核心：只比最亮的记忆星（≈10.9）稍大一点；
// ⚠️ 加法混合下 opacity 越接近 1 越像"探照灯"，0.58 左右刚好亮一档
const CORE_SCALE = 18;
const CORE_OPACITY = 0.58;
const CORE_HOVER_SCALE = 1.22; // 悬停时微微放大，不用高亮眩光

const CORE_ID = "core";
// 中心核心的伪节点：只用于悬停卡片，不参与筛选 / 选中 / 布局
const CORE_NODE = { id: CORE_ID, content: "核心（暖言）", category: "", strength: 0, core: true };
const PERMANENT = new Set(["profile", "preference", "relation", "wish"]);

// 分类配色（中心核心是纯白，不在此表里）
const PALETTE = {
  profile: [255, 209, 102], // 画像：亮金
  preference: [103, 232, 249], // 偏好：青蓝
  relation: [125, 211, 252], // 关系：柔青
  wish: [192, 132, 252], // 愿望：梦幻紫
  self: [130, 150, 175],
  event: [148, 163, 184], // 日常：浅灰蓝
  emotion: [148, 163, 184],
  daily: [100, 116, 139],
};
const FALLBACK_COLOR = [130, 145, 165];

const CATEGORY_LABEL = {
  profile: "印象总结",
  preference: "偏好",
  relation: "关系",
  wish: "愿望",
  self: "暖言记的",
  event: "事实 · 近况",
  emotion: "情绪",
  daily: "每日汇总",
};

const BASE_RADIUS = {
  profile: 4.2,
  preference: 4,
  relation: 4,
  wish: 3.6,
  self: 3,
  event: 2.8,
  emotion: 2.6,
  daily: 2.6,
};
const FALLBACK_RADIUS = 2.6;

function hashUnit(n) {
  const x = Math.sin(Number(n || 0) * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigramSet(text) {
  const s = normalizeText(text);
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const g of small) if (large.has(g)) inter += 1;
  return inter / small.size;
}

/**
 * 星芒保持分类本色（金 / 青 / 紫 / 灰蓝）—— "褪色"交给透明度与尺寸，
 * 全部往灰色里混会让图例对不上颜色。
 */
function categoryColor(category) {
  return PALETTE[category] || FALLBACK_COLOR;
}

function nodeAlpha(strength, permanent, superseded) {
  if (superseded) return 0.28;
  if (strength > 80) return 1;
  if (permanent) return 0.72 + 0.28 * (strength / 100);
  if (strength < 10) return 0.12;
  return 0.35 + 0.65 * (strength / 100);
}

function nodeRadius(category, strength, permanent) {
  const base = BASE_RADIUS[category] || FALLBACK_RADIUS;
  if (permanent) return base * (0.8 + 0.2 * (strength / 100));
  if (strength < 10) return Math.max(1, base * 0.4);
  return base * (0.55 + 0.45 * (strength / 100));
}

/** 排序 = 谁进星云：有效优先 → 核心优先 → 强度高的（=更靠近中心的那批）。
 *  ⚠️ 已失效（superseded）必须排最后：超过 150 条时，先被裁掉的应该是它们和最弱的边缘记忆，
 *     而不是还在用的核心事实。 */
function rankMemory(a, b) {
  const sa = a.superseded_at ? 1 : 0;
  const sb = b.superseded_at ? 1 : 0;
  if (sa !== sb) return sa - sb;
  const pa = PERMANENT.has(a.category) ? 0 : 1;
  const pb = PERMANENT.has(b.category) ? 0 : 1;
  if (pa !== pb) return pa - pb;
  return (Number(b.strength) || 0) - (Number(a.strength) || 0);
}

/** 斐波那契球面方向：让节点均匀铺在球壳上，不会挤成一团。 */
function fibonacciDirection(i, n) {
  const y = 1 - (i / Math.max(1, n - 1)) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = i * Math.PI * (3 - Math.sqrt(5));
  return { x: Math.cos(theta) * r, y, z: Math.sin(theta) * r };
}

/**
 * 把「排序后的第 i 条记忆」映射到斐波那契球面上的第几个方向槽位。
 *
 * ⚠️ 不能直接拿排名 i 当槽位：斐波那契的 y 是从北极到南极线性变化的，
 *    排名靠前（核心 / 强）的记忆会全堆在上半球，弱的堆在下半球 ——
 *    视觉上就是「上半球亮、下半球暗」（实测 重要度与纬度的相关系数 ≈ 0.85~0.92）。
 *
 * 做法：按「记忆 id 的哈希」排序后依次发槽位。
 *   * 槽位集合不变 → 球面覆盖仍然均匀；
 *   * 方向与排名脱钩 → 排名只通过半径体现（重要 → 靠近球心）；
 *   * 用 id 而不是下标做哈希 → 同一条记忆在列表里的相对次序不会因别的记忆强度变化而跳动。
 * 全程确定性（没有 Math.random），同一份数据每次打开长得一样。
 */
function shuffledSlots(list) {
  const keyOf = (m, i) => {
    const id = Number(m?.id);
    return hashUnit((Number.isFinite(id) ? id : i + 1) * 131 + 17);
  };
  const order = list
    .map((m, i) => ({ i, key: keyOf(m, i) }))
    .sort((a, b) => a.key - b.key || a.i - b.i);
  const slotOf = new Array(list.length);
  order.forEach((item, slot) => {
    slotOf[item.i] = slot;
  });
  return slotOf;
}

/**
 * 布局（纯数据，不含 three 对象）：
 *   ① 半径由「重要性」决定 —— 核心类永远靠内圈，其余按 strength：越弱越靠外；
 *      方向（经纬）与重要性无关，由 shuffledSlots 均匀打散；
 *   ② ⛔ 不再有"每个记忆 → 原点"的辐条，线只存在于**记忆节点之间**；
 *   ③ 联想突触：内容 bigram 相似度 ≥0.28 必连，同分类 34% / 跨分类 10% 随机；
 *   ④ 每节点额外度数 ≤4、突触总数 ≤180。
 */
function buildLayout(memories) {
  const list = (Array.isArray(memories) ? memories : [])
    .slice()
    .sort(rankMemory)
    .slice(0, MAX_NODES);

  const nodes = [];
  const slotOf = shuffledSlots(list);

  list.forEach((m, i) => {
    const strength = Math.max(0, Math.min(100, Number(m.strength ?? 100)));
    const permanent = PERMANENT.has(m.category);
    const importance = permanent ? 1 : strength / 100;
    // 重要 → 靠近球心（0.26R）；边缘 → 外围（0.8R）
    const radius = LAYOUT_RADIUS * (0.8 - 0.54 * importance);
    const dir = fibonacciDirection(slotOf[i], list.length);
    // 微小抖动，让壳层看起来是"云"而不是规整的球面
    const jitter = 0.94 + 0.12 * hashUnit(i * 31 + 7);

    const node = {
      id: m.id,
      content: String(m.content || ""),
      category: m.category || "",
      strength,
      permanent,
      superseded: !!m.superseded_at,
      color: categoryColor(m.category),
      alpha: nodeAlpha(strength, permanent, !!m.superseded_at),
      radius: nodeRadius(m.category, strength, permanent),
      position: {
        x: dir.x * radius * jitter,
        y: dir.y * radius * jitter,
        z: dir.z * radius * jitter,
      },
    };
    nodes.push(node);
  });

  // ⛔ 不再有"所有节点连向中心"的辐条：线只存在于**记忆节点之间**
  const links = [];

  // —— 语义相似度突触 ——
  const activeNodes = nodes.filter((n) => !n.superseded);
  const grams = new Map();
  for (const node of activeNodes) {
    if (normalizeText(node.content).length >= 6) grams.set(node.id, bigramSet(node.content));
  }

  const extraDegree = new Map();
  let synapseCount = 0;

  const addSynapse = (a, b, bright) => {
    if (synapseCount >= MAX_SYNAPSE_LINKS) return;
    if ((extraDegree.get(a) || 0) >= MAX_EXTRA_DEGREE) return;
    if ((extraDegree.get(b) || 0) >= MAX_EXTRA_DEGREE) return;
    extraDegree.set(a, (extraDegree.get(a) || 0) + 1);
    extraDegree.set(b, (extraDegree.get(b) || 0) + 1);
    links.push({ a, b, bright, kind: "synapse" });
    synapseCount += 1;
  };

  const similarPairs = [];
  for (let i = 0; i < activeNodes.length; i++) {
    const a = activeNodes[i];
    const ga = grams.get(a.id);
    if (!ga) continue;
    for (let j = i + 1; j < activeNodes.length; j++) {
      const b = activeNodes[j];
      const gb = grams.get(b.id);
      if (!gb) continue;
      const score = overlap(ga, gb);
      if (score >= 0.28) similarPairs.push({ a, b, score });
    }
  }
  similarPairs.sort((x, y) => y.score - x.score);
  for (const pair of similarPairs) {
    addSynapse(pair.a.id, pair.b.id, pair.a.permanent || pair.b.permanent);
  }

  for (let i = 0; i < activeNodes.length; i++) {
    const a = activeNodes[i];
    for (let j = i + 1; j < activeNodes.length; j++) {
      if (synapseCount >= MAX_SYNAPSE_LINKS) break;
      const b = activeNodes[j];
      const sameCategory = a.category === b.category;
      const r = hashUnit(Number(a.id) * 7919 + Number(b.id) * 104729 + 13);
      if (r < (sameCategory ? 0.34 : 0.1)) {
        addSynapse(a.id, b.id, sameCategory || a.permanent || b.permanent);
      }
    }
  }

  return { nodes, links, renderedCount: nodes.length };
}

/**
 * 打开时的默认视距：按**最外层记忆节点**算一次，让星云刚好填满画面。
 * ⚠️ 比 FOV 公式的结果再拉近一点（×0.95）—— "刚好框住"看起来仍然偏小、四角留白太多。
 * （没有 react-force-graph 的 zoomToFit，这里等价于"自动适配 + 50 留白"）
 */
function fitCameraDistance(layout, fovDeg, aspect) {
  let maxR = 0;
  for (const node of layout.nodes) {
    const p = node.position;
    maxR = Math.max(maxR, Math.hypot(p.x, p.y, p.z));
  }
  if (!maxR) return CAMERA_Z;
  const vFov = (fovDeg * Math.PI) / 180;
  // 竖屏时水平视角更窄，必须按窄的那一边算，否则左右会被裁掉
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const dist = (maxR / Math.tan(Math.min(vFov, hFov) / 2)) * 0.95;
  return THREE.MathUtils.clamp(dist, 120, 520);
}

/** 高斯分布半径：中心密度高、外围迅速变稀（Box–Muller）。 */
function gaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 3000 个粒子的静态点云几何（世界坐标，一次生成，永不更新）。 */
function createCloudGeometry() {
  const positions = new Float32Array(CLOUD_COUNT * 3);
  for (let i = 0; i < CLOUD_COUNT; i++) {
    // 均匀球面方向
    const theta = Math.random() * Math.PI * 2;
    const cosPhi = 1 - Math.random() * 2;
    const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
    // 半径：高斯分布（σ≈52）→ 绝大多数挤在球心附近，少数飘到 155 边缘
    const r = Math.min(CLOUD_RADIUS, Math.abs(gaussian()) * 52);

    positions[i * 3] = Math.cos(theta) * sinPhi * r;
    positions[i * 3 + 1] = cosPhi * r * 0.92;
    positions[i * 3 + 2] = Math.sin(theta) * sinPhi * r;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return geometry;
}

/** 径向渐变贴图：只给中心核心做一圈柔光（不是节点）。 */
function createGlowTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(210,235,255,0.65)");
  grad.addColorStop(0.6, "rgba(96,165,250,0.16)");
  grad.addColorStop(1, "rgba(96,165,250,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * 十字星芒贴图（**白色**，颜色靠 `SpriteMaterial.color` 染）：
 * 中心亮核 + 四条长芒 + 四条短芒 + 柔光 —— 加法混合后就是"发光泛光"的效果。
 */
function createStarTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const c = size / 2;

  // 中心柔光（Bloom 的替代：贴图自带渐变，不跑后处理）
  const glow = ctx.createRadialGradient(c, c, 0, c, c, c);
  glow.addColorStop(0, "rgba(255,255,255,1)");
  glow.addColorStop(0.1, "rgba(255,255,255,0.92)");
  glow.addColorStop(0.3, "rgba(255,255,255,0.22)");
  glow.addColorStop(0.62, "rgba(255,255,255,0.05)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);

  // 星芒：从中心向外逐渐变透明的水滴形
  const spike = (angle, len, width, alpha) => {
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(angle);
    const grad = ctx.createLinearGradient(0, 0, 0, -len);
    grad.addColorStop(0, `rgba(255,255,255,${alpha})`);
    grad.addColorStop(0.45, `rgba(255,255,255,${alpha * 0.4})`);
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-width, 0);
    ctx.lineTo(0, -len);
    ctx.lineTo(width, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  for (let i = 0; i < 4; i++) spike((i * Math.PI) / 2, c * 0.96, c * 0.045, 1);
  for (let i = 0; i < 4; i++) spike(Math.PI / 4 + (i * Math.PI) / 2, c * 0.6, c * 0.026, 0.6);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** 释放一棵子树的几何 / 材质（共享贴图不在这里释放，交给卸载时的统一清理）。 */
function disposeTree(root) {
  root.traverse((child) => {
    // ⚠️ Sprite 的几何是 three 内部共享的，⛔ 不要 dispose；
    //    其它标了 sharedGeometry 的共享几何同理
    if (child.geometry && !child.isSprite && !child.userData?.sharedGeometry) {
      child.geometry.dispose?.();
    }
    const material = child.material;
    if (!material) return;
    const list = Array.isArray(material) ? material : [material];
    for (const mat of list) mat.dispose?.();
  });
}

export default function MemoryGraph3D({
  memories = [],
  selectedId = null,
  filter = "all",
  query = "",
  onSelect,
  onUnsupported,
}) {
  const wrapRef = useRef(null);
  const hostRef = useRef(null);
  const cardRef = useRef(null);
  const ctxRef = useRef(null);
  const handlesRef = useRef(new Map()); // id -> { node, sprite, hit, baseScale, baseAlpha }
  const hoveredIdRef = useRef(null);
  const styleRef = useRef({ filter, query, selectedId });
  const selectRef = useRef(onSelect);
  const unsupportedRef = useRef(onUnsupported);

  const [hoverNode, setHoverNode] = useState(null);

  const layout = useMemo(() => buildLayout(memories), [memories]);
  // ① 的 scene 只建一次，但"默认视距"要按当前节点范围算 —— 用 ref 拿最新布局，
  //    避免把 layout 放进 effect 依赖里（那会在数据变化时重建整个场景）
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  selectRef.current = onSelect;
  unsupportedRef.current = onUnsupported;

  // 在场景里真实渲染一帧（只在需要时调用，不跑循环）
  const requestRender = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx || ctx.rafId) return;
    ctx.rafId = requestAnimationFrame(() => {
      ctx.rafId = 0;
      ctx.renderer.render(ctx.scene, ctx.camera);
    });
  }, []);

  // 筛选 / 搜索 / 选中 / 悬停：只改材质与缩放，不重建场景
  const applyStyles = useCallback(() => {
    const style = styleRef.current;
    const keyword = String(style.query || "").trim().toLowerCase();
    const hoverId = hoveredIdRef.current;
    for (const [id, handle] of handlesRef.current) {
      const node = handle.node;
      let matched = true;
      if (style.filter === "__superseded") matched = node.superseded;
      else if (style.filter && style.filter !== "all") {
        matched = !node.superseded && node.category === style.filter;
      }
      if (matched && keyword) matched = node.content.toLowerCase().includes(keyword);

      const dim = matched ? 1 : 0.12;
      const active = hoverId === id || Number(style.selectedId) === Number(id);
      const scale = handle.baseScale * (active ? 1.45 : 1);
      handle.sprite.scale.setScalar(scale);
      handle.sprite.material.opacity = Math.min(1, handle.baseAlpha * (active ? 1.8 : 1)) * dim;
      handle.hit.scale.setScalar(scale * 1.3);
    }

    // 核心：悬停时只放大一点点（不提高亮度），移开立即复原
    const sceneCtx = ctxRef.current;
    if (sceneCtx?.coreStar) {
      const onCore = hoveredIdRef.current === CORE_ID;
      sceneCtx.coreStar.scale.setScalar(CORE_SCALE * (onCore ? CORE_HOVER_SCALE : 1));
      sceneCtx.coreGlow.material.opacity = onCore ? 0.44 : 0.34;
    }
    requestRender();
  }, [requestRender]);

  // ————————————————————————————————————————————————
  // ① 渲染器 / 相机 / 控制器 / 点云 / 核心：挂载时创建一次
  // ————————————————————————————————————————————————
  useEffect(() => {
    const wrap = wrapRef.current;
    const host = hostRef.current;
    if (!wrap || !host) return undefined;
    const handleMap = handlesRef.current; // 固定引用，cleanup 里用（别直接读 ref.current）

    // ⚠️ 设备不支持 WebGL（被禁用 / 驱动黑名单 / 显存耗尽 / 无头环境）时，
    //    THREE.WebGLRenderer 的构造函数会直接抛异常。这里必须接住：
    //    告诉上层「这台设备画不了 3D」，由上层退回列表视图，而不是让整个弹窗白屏。
    //    此时 ctxRef 保持为 null，下面的 ② ③ 两个 effect 都会因此直接跳过。
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
    } catch (err) {
      console.warn("[MemoryGraph3D] 无法创建 WebGL 渲染器，已通知上层退回列表视图：", err);
      unsupportedRef.current?.("webgl");
      return undefined;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
    camera.position.set(0, 0, CAMERA_Z);

    // ⛔ 自动旋转必须是 false：这是"绝对不转"的唯一开关
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.autoRotate = false;
    controls.enableDamping = false; // 松手立即停，不留惯性
    controls.enablePan = false;
    controls.rotateSpeed = 0.65;
    controls.zoomSpeed = 0.8;
    controls.minDistance = 80;
    controls.maxDistance = 560;
    controls.target.set(0, 0, 0);

    const glowTexture = createGlowTexture();
    const starTexture = createStarTexture();

    // —— 背景电子云（Points）——
    const cloudGeometry = createCloudGeometry();
    const cloudMaterial = new THREE.PointsMaterial({
      size: 0.55,
      sizeAttenuation: true,
      color: new THREE.Color(0x60a5fa),
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const cloud = new THREE.Points(cloudGeometry, cloudMaterial);
    scene.add(cloud);

    // —— 核心：比记忆星稍大稍亮的一颗星芒（⛔ 没有实心球，也不是探照灯）——
    const coreGroup = new THREE.Group();
    const coreStar = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: starTexture,
        color: 0xfff6d8,
        transparent: true,
        opacity: CORE_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    coreStar.scale.setScalar(CORE_SCALE);
    coreGroup.add(coreStar);

    // 柔光压得很低，只负责"有一圈空气感"，不能抢主次
    const coreGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        color: 0xbfdbfe,
        transparent: true,
        opacity: 0.34,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    coreGlow.scale.setScalar(15);
    coreGroup.add(coreGlow);

    // 不可见的命中区：名字不常驻，只能靠悬停核心才弹「核心（暖言）」
    const coreHit = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: starTexture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      })
    );
    coreHit.scale.setScalar(CORE_SCALE * 1.2);
    coreHit.userData.nodeId = CORE_ID;
    coreHit.visible = false; // 同上：只是拾取用的，不参与渲染
    coreGroup.add(coreHit);

    scene.add(coreGroup);

    const ctx = {
      renderer,
      scene,
      camera,
      controls,
      glowTexture,
      starTexture,
      cloud,
      coreGroup,
      coreStar,
      coreGlow,
      coreHit,
      graphGroup: null,
      hitMeshes: [],
      rafId: 0,
      requestRender: () => {},
    };
    ctxRef.current = ctx;
    ctx.requestRender = requestRender;

    // —— 尺寸 ——
    // 第一次拿到画布尺寸时算「自动适配」的默认视距（之后窗口缩放只改比例，不再改动用户手动缩放）
    let fitted = false;
    const resize = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (!fitted) {
        fitted = true;
        camera.position.set(0, 0, fitCameraDistance(layoutRef.current, camera.fov, camera.aspect));
        controls.update();
      }
      requestRender();
    };
    resize();

    let ro = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(resize);
      ro.observe(wrap);
    }
    window.addEventListener("resize", resize);

    // —— 拾取：先打不可见放大的 Sprite（提高命中率），再映射回记忆 / 核心 ——
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let dragStart = null;

    const toNdc = (clientX, clientY) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    };

    const pick = () => {
      const meshes = ctx.hitMeshes;
      if (!meshes.length) return null;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(meshes, false);
      const id = hits[0]?.object?.userData?.nodeId;
      if (id === undefined) return null;
      // 命中核心 → 伪节点（只弹「核心（暖言）」，不参与筛选）
      if (id === CORE_ID) return { node: CORE_NODE };
      return handlesRef.current.get(id) || null;
    };

    const onPointerMove = (event) => {
      // 卡跟随鼠标（直接改样式，避免每次移动都触发 React 重渲染）
      const card = cardRef.current;
      if (card) {
        const rect = wrap.getBoundingClientRect();
        const x = Math.min(Math.max(8, event.clientX - rect.left + 14), rect.width - 236);
        const y = Math.min(Math.max(8, event.clientY - rect.top + 14), rect.height - 120);
        card.style.transform = `translate(${x}px, ${y}px)`;
      }

      if (event.buttons & 1) return; // 拖拽时不拾取，避免旋转时闪烁

      toNdc(event.clientX, event.clientY);
      const handle = pick();
      const id = handle ? handle.node.id : null;
      if (id === hoveredIdRef.current) return;

      hoveredIdRef.current = id;
      setHoverNode(handle ? handle.node : null);
      applyStyles();
    };

    const onPointerDown = (event) => {
      if (event.button !== 0) return;
      dragStart = { x: event.clientX, y: event.clientY };
    };

    const onPointerUp = (event) => {
      if (!dragStart || event.button !== 0) return;
      const moved = Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y);
      dragStart = null;
      if (moved > 8) return; // 这是拖拽旋转，不是点击

      toNdc(event.clientX, event.clientY);
      const handle = pick();
      const node = handle && !handle.node.core ? handle.node : null; // 点核心 = 取消选中
      selectRef.current?.(
        node
          ? { id: node.id, content: node.content, category: node.category }
          : null
      );
    };

    const onPointerLeave = () => {
      if (hoveredIdRef.current === null) return;
      hoveredIdRef.current = null;
      setHoverNode(null);
      applyStyles();
    };

    const onChange = () => requestRender();

    controls.addEventListener("change", onChange);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointerleave", onPointerLeave);

    requestRender();

    return () => {
      cancelAnimationFrame(ctx.rafId);
      ro?.disconnect();
      window.removeEventListener("resize", resize);
      controls.removeEventListener("change", onChange);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      controls.dispose();

      if (ctx.graphGroup) {
        scene.remove(ctx.graphGroup);
        disposeTree(ctx.graphGroup);
      }
      scene.remove(cloud);
      disposeTree(cloud);
      scene.remove(coreGroup);
      disposeTree(coreGroup);
      glowTexture.dispose();
      starTexture.dispose();

      renderer.dispose();
      renderer.forceContextLoss?.();
      renderer.domElement.remove();
      handleMap.clear();
      ctxRef.current = null;
    };
  }, [applyStyles, requestRender]);

  // ————————————————————————————————————————————————
  // ② 记忆节点 + 突触连线：数据变化时重建这一层（点云与核心不动）
  // ————————————————————————————————————————————————
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return undefined;
    const { scene, starTexture } = ctx;
    const group = new THREE.Group();
    const byId = new Map();
    const handleMap = handlesRef.current;

    for (const node of layout.nodes) {
      const [r, g, b] = node.color;
      const color = new THREE.Color(`rgb(${r},${g},${b})`);

      // 记忆节点 = 十字星芒贴图（⛔ 不是球）：同一张白色贴图，靠 color 染色
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: starTexture,
          color,
          transparent: true,
          opacity: node.alpha,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      sprite.position.set(node.position.x, node.position.y, node.position.z);
      const baseScale = node.radius * SPRITE_SCALE;
      sprite.scale.setScalar(baseScale);

      // 不可见的命中区（比星芒略大一圈，好点中；Sprite 同样能被 raycaster 命中）
      // ⚠️ visible=false：Raycaster **不检查** visible（three 只在渲染阶段跳过），
      //    所以依然能拾取，却省掉 150 次 draw call —— 每次渲染的 draw call 直接减半。
      const hit = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: starTexture,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        })
      );
      hit.visible = false;
      hit.position.copy(sprite.position);
      hit.scale.setScalar(baseScale * 1.3);
      hit.userData.nodeId = node.id;

      group.add(sprite, hit);
      byId.set(node.id, node);
      handleMap.set(node.id, {
        node,
        sprite,
        hit,
        baseScale,
        baseAlpha: node.alpha,
      });
    }

    // —— 连线：只在记忆节点之间，二次贝塞尔微弯；核心类记忆参与的突触更亮 ——
    const vertices = [];
    const colors = [];

    const quadPoint = (a, c, b, t, out) => {
      const mt = 1 - t;
      out.x = mt * mt * a.x + 2 * mt * t * c.x + t * t * b.x;
      out.y = mt * mt * a.y + 2 * mt * t * c.y + t * t * b.y;
      out.z = mt * mt * a.z + 2 * mt * t * c.z + t * t * b.z;
      return out;
    };

    for (const link of layout.links) {
      // 突触只连记忆节点（没有核心辐条），两端都必须存在
      const nodeA = byId.get(link.a);
      const nodeB = byId.get(link.b);
      if (!nodeA || !nodeB) continue;
      const endA = new THREE.Vector3(nodeA.position.x, nodeA.position.y, nodeA.position.z);
      const endB = new THREE.Vector3(
        nodeB.position.x,
        nodeB.position.y,
        nodeB.position.z
      );

      const mid = endA.clone().add(endB).multiplyScalar(0.5);
      const outward = mid.lengthSq() > 1e-6 ? mid.clone().normalize() : new THREE.Vector3(0, 1, 0);
      const control = mid.clone().add(outward.multiplyScalar(mid.length() * 0.2));

      const brightColor = link.bright ? new THREE.Color(0x93c5fd) : new THREE.Color(0x3b6e9e);
      const segments = 6;
      const a = new THREE.Vector3();
      const bPt = new THREE.Vector3();

      for (let s = 0; s < segments; s++) {
        quadPoint(endA, control, endB, s / segments, a);
        quadPoint(endA, control, endB, (s + 1) / segments, bPt);
        vertices.push(a.x, a.y, a.z, bPt.x, bPt.y, bPt.z);
        colors.push(brightColor.r, brightColor.g, brightColor.b);
        colors.push(brightColor.r, brightColor.g, brightColor.b);
      }
    }

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    lineGeo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const lineMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(lineGeo, lineMat);
    group.add(lines);

    scene.add(group);
    ctx.graphGroup = group;
    // 命中列表里带上核心的命中区，悬停才能弹出「核心（暖言）」
    ctx.hitMeshes = [...Array.from(handleMap.values()).map((h) => h.hit), ctx.coreHit];

    applyStyles();
    requestRender();

    return () => {
      scene.remove(group);
      disposeTree(group);
      ctx.graphGroup = null;
      ctx.hitMeshes = [];
      handleMap.clear();
    };
  }, [layout, applyStyles, requestRender]);

  // 筛选 / 搜索 / 选中变化 → 只改样式
  useEffect(() => {
    styleRef.current = { filter, query, selectedId };
    applyStyles();
  }, [filter, query, selectedId, applyStyles]);

  const hiddenCount = Math.max(0, memories.length - layout.renderedCount);

  return (
    <div
      ref={wrapRef}
      className="relative w-full h-full min-h-[320px] overflow-hidden"
      style={{
        // 统一深空蓝渐变：中心偏亮蓝 → 边缘近黑，衬托星芒与电子云
        background:
          "radial-gradient(ellipse at 50% 45%, #12294a 0%, #0a1a33 45%, #050c1c 75%, #02060f 100%)",
      }}
    >
      {/* 极微弱的星点噪点（纯 CSS，不占渲染） */}
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          backgroundImage: [
            "radial-gradient(1px 1px at 12% 22%, rgba(226,232,240,0.45) 0, transparent 100%)",
            "radial-gradient(1px 1px at 28% 68%, rgba(226,232,240,0.30) 0, transparent 100%)",
            "radial-gradient(1.5px 1.5px at 41% 14%, rgba(96,165,250,0.35) 0, transparent 100%)",
            "radial-gradient(1px 1px at 57% 82%, rgba(226,232,240,0.28) 0, transparent 100%)",
            "radial-gradient(1px 1px at 69% 33%, rgba(226,232,240,0.40) 0, transparent 100%)",
            "radial-gradient(1.5px 1.5px at 82% 71%, rgba(147,197,253,0.30) 0, transparent 100%)",
            "radial-gradient(1px 1px at 91% 18%, rgba(226,232,240,0.25) 0, transparent 100%)",
            "radial-gradient(1px 1px at 8% 88%, rgba(226,232,240,0.22) 0, transparent 100%)",
            "radial-gradient(1.5px 1.5px at 34% 42%, rgba(226,232,240,0.16) 0, transparent 100%)",
            "radial-gradient(1px 1px at 66% 58%, rgba(96,165,250,0.18) 0, transparent 100%)",
          ].join(", "),
          backgroundRepeat: "no-repeat",
        }}
      />

      {/* WebGL 画布挂载点：透明，深空渐变透出来 */}
      <div ref={hostRef} className="absolute inset-0" />

      {/* 悬停小卡片：完整记忆内容 */}
      <div
        ref={cardRef}
        className={`pointer-events-none absolute left-0 top-0 z-10 max-w-[230px] rounded-xl border border-[#243149] bg-[#0b1220]/95 px-3 py-2 text-[#E2E8F0] shadow-[0_12px_32px_-12px_rgba(0,0,0,0.9)] backdrop-blur transition-opacity duration-100 ${
          hoverNode ? "opacity-100" : "opacity-0"
        }`}
      >
        {hoverNode &&
          (hoverNode.core ? (
            <p className="text-xs leading-5 text-[#E2E8F0]">核心（暖言）</p>
          ) : (
            <>
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-[11px] text-[#60A5FA]">
                  {CATEGORY_LABEL[hoverNode.category] || "其他"}
                </span>
                <span className="ml-auto text-[11px] text-[#94A3B8]">
                  {hoverNode.superseded ? "已失效" : `强度 ${hoverNode.strength}`}
                </span>
              </div>
              <p className="text-xs leading-5 break-words whitespace-pre-wrap max-h-28 overflow-y-auto">
                {hoverNode.content || "（空记忆）"}
              </p>
            </>
          ))}
      </div>

      {/* 左上角图例：颜色与渲染层 PALETTE 一一对应（✦ = 星芒，● = 光点） */}
      <div className="pointer-events-none absolute left-3 top-2 z-10 text-[11px] leading-5 text-[#94A3B8]">
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-[#FFF6D8] shadow-[0_0_10px_rgba(255,246,216,0.85)]" />
          中心发光体：暖言（核心）
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="text-[13px] leading-none"
            style={{ color: "#FFD166", textShadow: "0 0 6px rgba(255,209,102,0.9)" }}
          >
            ✦
          </span>
          <span
            className="text-[13px] leading-none"
            style={{ color: "#67E8F9", textShadow: "0 0 6px rgba(103,232,249,0.9)" }}
          >
            ✦
          </span>
          金色/青色星芒：核心记忆（画像/偏好）
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="text-[13px] leading-none"
            style={{ color: "#C084FC", textShadow: "0 0 6px rgba(192,132,252,0.9)" }}
          >
            ✦
          </span>
          紫色星芒：愿望期许
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#64748B] opacity-80" />
          暗淡星点：边缘记忆（随时间淡忘）
        </div>
      </div>

      {hiddenCount > 0 && (
        <div className="pointer-events-none absolute bottom-2 right-3 z-10 text-[10px] text-[#64748B]">
          仅渲染最强的 {layout.renderedCount} 条，另有 {hiddenCount} 条未绘制
        </div>
      )}
    </div>
  );
}
