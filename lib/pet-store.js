/**
 * 桌宠（蓝蝴蝶）数据读写：形象库 / 情绪选项 / 回复话术。
 *
 * 为什么这些不放 settings 分组：
 *   它们天生是"列表" —— 多张形象、多条情绪、每条情绪挂多句回复。塞进一个 JSON 配置里
 *   就没法做「单条启停、单条排序」，后台还得让人手写 JSON。所以约定是：
 *   **单值进 settings（pet 分组），列表进表**。
 *
 * ⚠️ 播种策略与词表**不同**，别照抄 ensureKeywordGroups：
 *   词表是"只插缺的 id"（内置词表有固定 id、不该被删）；
 *   形象 / 情绪 / 话术都是管理员**可增删的内容**，所以是「**表为空才播种**」——
 *   否则管理员删掉的某条情绪，下次部署又会被悄悄加回来。
 *
 * ⚠️ 一条产品红线（写在这里提醒后来人）：
 *   回复话术是**陪伴**，不是索取。后台可以随便改文案，但别写
 *   "你怎么才来""等你好久了"这类让人愧疚的话 —— 对照表见 docs/PET-DESIGN.md §二。
 */
import { execute, query } from "./db";
import { getGroup } from "./settings";

/** 内置默认形象：形象库被清空 / 编号失效时的兜底（这张图是随项目走的） */
export const DEFAULT_PET_IMAGE = "/stickers/blue_butterfly.png";
export const DEFAULT_PET_IMAGE_NAME = "蓝蝴蝶（内置默认）";

/**
 * 可选的动画 —— **前四个必须是 ButterflyEffect.jsx 里已经存在的 CSS 类**：
 *   droop  = 下垂慢扇（不开心）
 *   descend= 原地半闭翅、轻轻下沉（好累）
 *   shake  = 快速抖翅两下再慢下来（心烦）
 *   spin   = 原地缓缓转一圈（说不清）
 *   goto   = 不做动画，直接切到聊天去（"就是想找人说说话"那一项）
 * ⚠️ 想加新动画：先去组件 <style> 里补关键帧和 class，再把名字加进这个数组。
 */
export const PET_ANIMS = ["droop", "descend", "shake", "spin", "goto"];
export const PET_GOTO_ANIM = "goto";

/* 上限：气泡就那么大，给太多选项用户反而不会点 */
export const PET_MOOD_LIMIT = 12; // 情绪选项最多几条
export const PET_LINE_LIMIT = 20; // 单条情绪最多挂几句回复
export const PET_LABEL_MAX_CHARS = 16; // 选项文案最长（用户看到的那句）
export const PET_LINE_MAX_CHARS = 60; // 单句回复最长（气泡一行放得下）
export const PET_NAME_MAX_CHARS = 32; // 形象名称最长
export const PET_NOTE_MAX_CHARS = 100; // 后台备注最长

export const PET_MOOD_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const PET_STAY_RANGE = [0, 20000];
export const PET_SIZE_RANGE = [40, 160];

/** 内置的 5 个情绪选项 + 各自的那句回复（**只在首次播种时用**，之后后台随便改） */
const BUILTIN_MOODS = [
  {
    key: "unhappy",
    label: "我今天不开心",
    anim: "droop",
    stay: 3000,
    droop: true,
    lines: ["那就先不开心一会儿，不着急好起来"],
  },
  {
    key: "tired",
    label: "我今天好累",
    anim: "descend",
    stay: 5000,
    droop: true,
    lines: ["不用撑着，歇着吧"],
  },
  {
    key: "anxious",
    label: "我心里很烦",
    anim: "shake",
    stay: 3000,
    droop: true,
    lines: ["Solace 帮你收一会儿"],
  },
  {
    key: "unclear",
    label: "我说不清",
    anim: "spin",
    stay: 3000,
    droop: false,
    lines: ["说不清就先不说，我一直在"],
  },
  {
    key: "talk",
    label: "就是想找人说说话",
    anim: "goto",
    stay: 0,
    droop: false,
    lines: [],
  },
];

function clamp(value, [min, max], fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(num)));
}

/* ---------------------------------------------------------------- 校验 */

/** 校验并清洗一条「情绪选项」；返回 { ok, error, value } */
export function normalizeMoodInput(input = {}) {
  const key = String(input.key ?? input.mood_key ?? "").trim().toLowerCase();
  const label = String(input.label ?? "").trim();
  const anim = String(input.anim ?? "").trim();
  const droopRaw = input.droop;
  const droop = droopRaw === true || droopRaw === 1 || droopRaw === "1" || droopRaw === "true";

  if (!PET_MOOD_KEY_RE.test(key)) {
    return { ok: false, error: "情绪键只能用小写字母、数字、下划线，且以字母开头" };
  }
  if (!label) return { ok: false, error: "选项文案不能为空" };
  if (label.length > PET_LABEL_MAX_CHARS) {
    return { ok: false, error: `选项文案不能超过 ${PET_LABEL_MAX_CHARS} 个字` };
  }
  if (!PET_ANIMS.includes(anim)) {
    return { ok: false, error: `动画只能选：${PET_ANIMS.join(" / ")}` };
  }

  // goto 项不显示回复，所以停留时间和低垂状态都强制归零（避免后台填了却不生效）
  const isGoto = anim === PET_GOTO_ANIM;
  return {
    ok: true,
    value: {
      mood_key: key,
      label,
      anim,
      stay_ms: isGoto ? 0 : clamp(input.stay ?? input.stay_ms, PET_STAY_RANGE, 3000),
      droop: isGoto || !droop ? 0 : 1,
      sort_order: clamp(input.sortOrder ?? input.sort_order, [0, 999999], 0),
    },
  };
}

/** 校验并清洗一句「回复话术」；返回 { ok, error, value } */
export function normalizeLineInput(input = {}) {
  const raw =
    typeof input === "string"
      ? input
      : String(input.text ?? input.line ?? "");
  // 气泡只有一行：换行统一压成空格，避免"看起来像两句话"却挤在一起
  const text = raw.replace(/[\r\n]+/g, " ").trim();

  if (!text) return { ok: false, error: "回复话术不能为空" };
  if (text.length > PET_LINE_MAX_CHARS) {
    return { ok: false, error: `单句回复不能超过 ${PET_LINE_MAX_CHARS} 个字` };
  }
  return {
    ok: true,
    value: {
      text,
      sort_order: clamp(typeof input === "object" ? input.sortOrder ?? input.sort_order : 0, [0, 999999], 0),
    },
  };
}

/** 校验并清洗一个「形象」；返回 { ok, error, value } */
export function normalizeImageInput(input = {}) {
  const name = String(input.name ?? "").trim();
  const url = String(input.url ?? "").trim();
  const note = String(input.adminNote ?? input.admin_note ?? "").trim();

  if (!name) return { ok: false, error: "形象名称不能为空" };
  if (name.length > PET_NAME_MAX_CHARS) {
    return { ok: false, error: `形象名称不能超过 ${PET_NAME_MAX_CHARS} 个字` };
  }
  // 只接受站内相对路径或 http(s) 外链：不接受 data: / javascript: 这类
  const isLocal = /^\/[A-Za-z0-9._\-/]+$/.test(url);
  const isRemote = /^https?:\/\/[^\s]+$/i.test(url);
  if (!url || (!isLocal && !isRemote)) {
    return { ok: false, error: "形象地址只能是站内路径（/pets/xxx.png）或 http(s) 外链" };
  }
  if (note.length > PET_NOTE_MAX_CHARS) {
    return { ok: false, error: `备注不能超过 ${PET_NOTE_MAX_CHARS} 个字` };
  }

  return {
    ok: true,
    value: {
      name,
      url,
      admin_note: note || null,
      sort_order: clamp(input.sortOrder ?? input.sort_order, [0, 999999], 0),
    },
  };
}

/* ---------------------------------------------------------------- 读 */

/** 形象库列表（后台用；onlyEnabled=true 时只给前台可用的） */
export async function listPetImages({ onlyEnabled = false } = {}) {
  const where = onlyEnabled ? "WHERE enabled = 1" : "";
  return query(
    `SELECT id, name, url, filename, enabled, sort_order, admin_note, created_at
       FROM pet_images ${where}
      ORDER BY sort_order ASC, id ASC`
  );
}

/** 取一张形象（含停用状态）；找不到返回 null */
export async function getPetImage(id) {
  const numeric = Number(id) || 0;
  if (numeric <= 0) return null;
  const rows = await query(
    "SELECT id, name, url, filename, enabled, sort_order FROM pet_images WHERE id = ? LIMIT 1",
    [numeric]
  );
  return rows[0] || null;
}

/**
 * 情绪选项（含各自的回复话术）。后台要看到停用的，所以默认不过滤。
 * 话术一次查回来在内存里分组，避免每条情绪一次查询（最多十几条）。
 */
export async function listPetMoods({ includeLines = true } = {}) {
  const moods = await query(
    `SELECT id, mood_key, label, anim, stay_ms, droop, sort_order, enabled, created_at, updated_at
       FROM pet_moods
      ORDER BY sort_order ASC, id ASC`
  );
  if (!includeLines || !moods.length) {
    return moods.map((mood) => ({ ...mood, lines: [] }));
  }

  const lines = await query(
    `SELECT id, mood_id, text, sort_order, enabled
       FROM pet_lines
      ORDER BY sort_order ASC, id ASC`
  );
  const byMood = new Map();
  for (const line of lines) {
    const moodId = Number(line.mood_id);
    if (!byMood.has(moodId)) byMood.set(moodId, []);
    byMood.get(moodId).push(line);
  }

  return moods.map((mood) => ({ ...mood, lines: byMood.get(Number(mood.id)) || [] }));
}

/**
 * 用户端一次性读全：开关 + 当前形象 + 边长 + 情绪选项（每项带可用话术池）。
 * ⚠️ 一次返回全部是有意的：进站只发 **1 个**请求，而不是"形象一个、话术一个"。
 */
export async function readPetPublic() {
  let config = null;
  try {
    config = await getGroup("pet");
  } catch {
    config = null; // 表还没建好：按默认值走，用户端不能因为读配置失败就白屏
  }

  const enabled = config?.enabled !== false;
  const size = clamp(config?.size, PET_SIZE_RANGE, 70);
  const lineRepeatHours = clamp(config?.lineRepeatHours, [0, 168], 24);

  // 当前形象：编号指向的那张；查不到 / 已被停用 → 回落内置默认图（绝不返回空地址）
  let imageUrl = DEFAULT_PET_IMAGE;
  let imageName = DEFAULT_PET_IMAGE_NAME;
  const activeId = Number(config?.activeImageId) || 0;
  if (activeId > 0) {
    try {
      const image = await getPetImage(activeId);
      if (image && Number(image.enabled)) {
        imageUrl = image.url;
        imageName = image.name;
      }
    } catch {
      /* 读不到就用默认图 */
    }
  }

  if (!enabled) {
    return { enabled: false, imageUrl, imageName, size, lineRepeatHours, moods: [] };
  }

  let moods = [];
  try {
    moods = await listPetMoods();
  } catch {
    moods = [];
  }

  return {
    enabled: true,
    imageUrl,
    imageName,
    size,
    lineRepeatHours,
    moods: moods
      .filter((mood) => Number(mood.enabled))
      .map((mood) => ({
        key: mood.mood_key,
        label: mood.label,
        anim: mood.anim,
        stay: Number(mood.stay_ms) || 0,
        droop: Number(mood.droop) === 1,
        // goto 项本来就没有回复（点了直接去聊天），这里会是空数组
        lines: (mood.lines || [])
          .filter((line) => Number(line.enabled))
          .map((line) => line.text),
      })),
  };
}

/* ---------------------------------------------------------------- 播种 */

/**
 * 播种内置形象与 5 个情绪选项（**只在表为空时**）。
 * 幂等：表里已经有内容就原样返回，绝不覆盖管理员改过的东西。
 */
export async function ensureBuiltinPet() {
  const result = { images: 0, moods: 0, lines: 0 };

  try {
    const rows = await query("SELECT COUNT(*) AS total FROM pet_images");
    if (!Number(rows[0]?.total || 0)) {
      await execute(
        `INSERT INTO pet_images (name, url, filename, enabled, sort_order)
         VALUES (?, ?, ?, 1, 0)`,
        [DEFAULT_PET_IMAGE_NAME, DEFAULT_PET_IMAGE, "blue_butterfly.png"]
      );
      result.images = 1;
    }
  } catch (err) {
    console.error("[pet] 播种形象失败：", err?.code || err?.message || err);
  }

  try {
    const rows = await query("SELECT COUNT(*) AS total FROM pet_moods");
    if (Number(rows[0]?.total || 0)) return result; // 已有内容：绝不覆盖

    let moodOrder = 0;
    for (const mood of BUILTIN_MOODS) {
      const inserted = await execute(
        `INSERT INTO pet_moods (mood_key, label, anim, stay_ms, droop, sort_order, enabled)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [
          mood.key,
          mood.label,
          mood.anim,
          mood.anim === PET_GOTO_ANIM ? 0 : mood.stay,
          mood.droop ? 1 : 0,
          moodOrder * 10,
        ]
      );
      result.moods += 1;

      let lineOrder = 0;
      for (const text of mood.lines) {
        await execute(
          `INSERT INTO pet_lines (mood_id, text, sort_order, enabled) VALUES (?, ?, ?, 1)`,
          [inserted.insertId, text, lineOrder * 10]
        );
        result.lines += 1;
        lineOrder += 1;
      }
      moodOrder += 1;
    }
  } catch (err) {
    console.error("[pet] 播种情绪/话术失败：", err?.code || err?.message || err);
  }

  return result;
}
