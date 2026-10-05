/**
 * 表情包（贴纸）：分类与素材的读写 + 播种。
 *
 * 为什么要有这个模块：
 *   以前"有哪些分类、每类的关键词、优先级"全是 `lib/sticker-engine.js` 里的模块常量，
 *   想加一个分类要改四处代码（词表 / 优先级 / 前端资源表 / AI 兜底提示词）。
 *   现在这些全部落表：引擎改成**读这里的 spec**，后台就能自己增删分类和素材了。
 *
 * 目录约定（**别改**）：
 *   public/stickers/<sticker_key>/<文件名>
 *   sleep 目录对应 sleepy 情绪 —— 历史命名，标记协议 [sticker:sleep] 已经上线，改名会断历史消息。
 *
 * ⚠️ 播种策略：「**表为空才播种**」（和词表的"只插缺的 id"不同）。
 *    分类与素材都是管理员可增删的，删掉的不该被下次部署加回来。
 *    素材是**扫磁盘登记**的：目录里已有的图会被收进表，这样按老流程
 *    手工丢进目录的图不会变成"看不见的图"。
 *
 * ⚠️ 词表**不在这里抄第二份**：出厂分类表在 `lib/sticker-engine.js` 的 `DEFAULT_SPEC`，
 *    这里只是把它转换成入库的行。两份词表迟早会不一致，那是"改了 A 没改 B"的经典陷阱。
 */
import fs from "node:fs";
import path from "node:path";
import { execute, query } from "./db";
import { getGroup } from "./settings";
import { DEFAULT_SPEC } from "./sticker-engine";

export const STICKER_ROOT = path.join(process.cwd(), "public", "stickers");

/** 允许的图片扩展名（README.md 这类文件会被自然排除掉） */
export const STICKER_IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
export const STICKER_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif"];
export const STICKER_MAX_BYTES = 2 * 1024 * 1024; // 2MB：够 240-512px 的图，再大就是没压

/** 分类名（= 目录名 = 标记名）：小写字母开头，只含小写字母 / 数字 / 下划线 */
export const STICKER_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * 概率表 —— ⚠️ **保持全局，不做成"每类一张"**。
 *   白天（06:00-23:00）所有分类通用：第 1 句 0%、第 2 句 40%、第 3 句 100% 保底。
 *   深夜（23:00-06:00）只有勾了「深夜放宽」的分类换成后一张：第 1 句 60%、第 2 句 100%。
 *   理由：分类可以加到十几个，每类一张概率表会让调参入口彻底失控
 *   （docs/STICKER.md §8 那张"想改什么改哪里"的表要保持可用）。
 *
 * 值本身来自引擎的出厂 spec（唯一来源），这里只是转出来给后台页面显示用。
 */
export const TRIGGER_PROB_NORMAL = DEFAULT_SPEC.normalProb;
export const TRIGGER_PROB_LATE_NIGHT = DEFAULT_SPEC.lateNightProb;

export const STICKER_CATEGORY_LIMIT = 12;
export const STICKER_LABEL_MAX_CHARS = 16;
export const STICKER_KEYWORD_LIMIT = 200;
export const STICKER_NOTE_MAX_CHARS = 100;

/**
 * 出厂四个分类（入库用的行格式）—— 直接由引擎的 `DEFAULT_SPEC` 转换而来。
 * ⚠️ `daily` 是 `triggerable = 0`：只作 AI 兜底分类，**永不主动发图**。
 */
const BUILTIN_CATEGORIES = DEFAULT_SPEC.categories.map((item) => ({
  catKey: item.catKey,
  stickerKey: item.stickerKey,
  label: item.label,
  priority: item.priority,
  lateNight: item.lateNight ? 1 : 0,
  aiDetect: item.aiDetect === false ? 0 : 1,
  triggerable: item.triggerable === false ? 0 : 1,
  keywords: (item.keywords || []).join("\n"),
}));

/* ---------------------------------------------------------------- 小工具 */

function clamp(value, [min, max], fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(num)));
}

/** 关键词文本 → 数组（换行 / 逗号 / 顿号都能分隔，自动去重去空） */
export function parseKeywords(content) {
  return String(content || "")
    .split(/[\n,，、]+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .slice(0, STICKER_KEYWORD_LIMIT);
}

/** 数组 → 关键词文本（一行一个，后台编辑起来最直观） */
export function joinKeywords(list) {
  const words = Array.isArray(list) ? list : parseKeywords(list);
  return Array.from(new Set(words.map((w) => String(w).trim()).filter(Boolean)))
    .slice(0, STICKER_KEYWORD_LIMIT)
    .join("\n");
}

function isImageName(name) {
  return STICKER_IMAGE_EXT.includes(path.extname(String(name)).toLowerCase());
}

/**
 * 扫一个分类目录，返回 { filename, url } 列表。
 * ⚠️ 分类名先过正则再拼路径：它是从后台来的，不校验就等于开了目录穿越。
 */
export function scanCategoryDir(stickerKey) {
  const key = String(stickerKey || "").trim();
  if (!STICKER_KEY_RE.test(key)) return [];
  const dir = path.join(STICKER_ROOT, key);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // 目录不存在（还没传过图）→ 空列表，不是错误
  }
  return entries
    .filter((entry) => entry.isFile() && isImageName(entry.name))
    .map((entry) => ({
      filename: entry.name,
      url: `/stickers/${key}/${entry.name}`,
    }))
    .sort((a, b) => a.filename.localeCompare(b.filename));
}

/* ---------------------------------------------------------------- 校验 */

/** 校验并清洗一个「分类」；返回 { ok, error, value } */
export function normalizeCategoryInput(input = {}) {
  const catKey = String(input.catKey ?? input.cat_key ?? "").trim().toLowerCase();
  const stickerKey = String(input.stickerKey ?? input.sticker_key ?? catKey).trim().toLowerCase();
  const label = String(input.label ?? "").trim();

  if (!STICKER_KEY_RE.test(catKey)) {
    return { ok: false, error: "情绪键只能用小写字母、数字、下划线，且以字母开头" };
  }
  if (!STICKER_KEY_RE.test(stickerKey)) {
    return { ok: false, error: "素材目录名只能用小写字母、数字、下划线，且以字母开头" };
  }
  if (!label) return { ok: false, error: "分类名称不能为空" };
  if (label.length > STICKER_LABEL_MAX_CHARS) {
    return { ok: false, error: `分类名称不能超过 ${STICKER_LABEL_MAX_CHARS} 个字` };
  }

  const triggerable = input.triggerable === true || input.triggerable === 1 || input.triggerable === "1";
  return {
    ok: true,
    value: {
      cat_key: catKey,
      sticker_key: stickerKey,
      label,
      keywords: joinKeywords(input.keywords),
      priority: clamp(input.priority, [0, 999999], 100),
      late_night: input.lateNight === true || input.lateNight === 1 || input.lateNight === "1" ? 1 : 0,
      ai_detect: input.aiDetect === false || input.aiDetect === 0 ? 0 : 1,
      triggerable: triggerable ? 1 : 0,
      sort_order: clamp(input.sortOrder ?? input.sort_order, [0, 999999], 0),
    },
  };
}

/** 校验并清洗一条「素材」；返回 { ok, error, value } */
export function normalizeStickerInput(input = {}) {
  const category = String(input.category ?? "").trim().toLowerCase();
  const filename = String(input.filename ?? "").trim();
  const note = String(input.adminNote ?? input.admin_note ?? "").trim();

  if (!STICKER_KEY_RE.test(category)) return { ok: false, error: "素材分类不合法" };
  if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    return { ok: false, error: "文件名不合法" };
  }
  if (!isImageName(filename)) {
    return { ok: false, error: `只支持 ${STICKER_IMAGE_EXT.join(" / ")} 格式` };
  }
  if (note.length > STICKER_NOTE_MAX_CHARS) {
    return { ok: false, error: `备注不能超过 ${STICKER_NOTE_MAX_CHARS} 个字` };
  }

  return {
    ok: true,
    value: {
      category,
      filename,
      url: `/stickers/${category}/${filename}`,
      admin_note: note || null,
      sort_order: clamp(input.sortOrder ?? input.sort_order, [0, 999999], 0),
    },
  };
}

/* ---------------------------------------------------------------- 读 */

/** 分类列表（后台用；后台要看到停用的，所以默认不过滤） */
export async function listCategories({ onlyEnabled = false } = {}) {
  const where = onlyEnabled ? "WHERE enabled = 1" : "";
  return query(
    `SELECT id, cat_key, sticker_key, label, keywords, priority, late_night, ai_detect,
            triggerable, enabled, sort_order, created_at, updated_at
       FROM sticker_categories ${where}
      ORDER BY priority ASC, sort_order ASC, id ASC`
  );
}

/** 素材列表（可按分类过滤） */
export async function listStickers({ category = "", onlyEnabled = false } = {}) {
  const conditions = [];
  const params = [];
  if (category) {
    conditions.push("category = ?");
    params.push(String(category).trim().toLowerCase());
  }
  if (onlyEnabled) conditions.push("enabled = 1");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return query(
    `SELECT id, category, url, filename, enabled, sort_order, admin_note, created_at
       FROM stickers ${where}
      ORDER BY category ASC, sort_order ASC, id ASC`,
    params
  );
}

/** 每个分类的素材数量（后台列表上直接看到"哪类还是空的"） */
export async function countStickers() {
  return query(
    `SELECT category, COUNT(*) AS total, SUM(enabled = 1) AS enabled
       FROM stickers GROUP BY category`
  );
}

/**
 * 给表情包引擎的分类 spec —— 引擎不再从模块常量读词表/优先级，改读这里。
 * `available` 表示"这个分类下至少有一张启用中的素材"：
 * 空分类不该参与掷骰，否则引擎发了标记、前端却找不到图（静默失效，最难查）。
 *
 * ⚠️ 带 30 秒进程内缓存：这个函数在**每条聊天消息**里都会被调用一次（2 次查询），
 *    而分类配置是"改一次管很久"的东西，没必要每句话都查库。
 *    后台任何写操作都会调 `invalidateStickerSpec()` 立刻失效缓存 ——
 *    所以"后台改完刷新聊天页就生效"，不用等 30 秒、更不用重启。
 */
let specCache = { at: 0, value: null };
const SPEC_TTL_MS = 30 * 1000;

export function invalidateStickerSpec() {
  specCache = { at: 0, value: null };
}

export async function readStickerSpec({ ttlMs = SPEC_TTL_MS } = {}) {
  const now = Date.now();
  if (specCache.value && now - specCache.at < ttlMs) return specCache.value;

  const categories = await listCategories({ onlyEnabled: true });
  const stickers = await listStickers({ onlyEnabled: true });
  const available = new Set(stickers.map((s) => String(s.category)));

  const spec = {
    normalProb: TRIGGER_PROB_NORMAL,
    lateNightProb: TRIGGER_PROB_LATE_NIGHT,
    categories: categories.map((row) => ({
      catKey: row.cat_key,
      stickerKey: row.sticker_key,
      label: row.label,
      keywords: parseKeywords(row.keywords),
      priority: Number(row.priority) || 100,
      lateNight: Number(row.late_night) === 1,
      aiDetect: Number(row.ai_detect) === 1,
      triggerable: Number(row.triggerable) === 1,
      available: available.has(String(row.sticker_key)),
    })),
  };

  specCache = { at: now, value: spec };
  return spec;
}

/**
 * 用户端一次性读全：开关 + 分类 + 每类可用素材。
 * ⚠️ 一次返回全部是有意的：前端必须**进站预取**，绝不能在收到 [sticker:x] 事件时再去请求
 *    （那条事件在 SSE 流末，等网络就等于丢图 / 拖慢收尾）。
 */
export async function readStickersPublic() {
  let config = null;
  try {
    config = await getGroup("sticker");
  } catch {
    config = null;
  }

  if (config?.enabled === false) return { enabled: false, categories: [] };

  const categories = await listCategories({ onlyEnabled: true });
  const stickers = await listStickers({ onlyEnabled: true });

  const byCategory = new Map();
  for (const sticker of stickers) {
    const key = String(sticker.category);
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push({ url: sticker.url });
  }

  return {
    enabled: true,
    categories: categories
      .filter((row) => byCategory.has(String(row.sticker_key)))
      .map((row) => ({
        key: row.sticker_key, // = [sticker:xxx] 标记名 = 前端资源表的 key
        catKey: row.cat_key,
        label: row.label,
        items: byCategory.get(String(row.sticker_key)),
      })),
  };
}

/* ---------------------------------------------------------------- 播种 / 补登 */

/**
 * 播种内置分类与磁盘上已有的素材（**只在表为空时**）。
 * 返回播种数量，方便在日志里看到到底做了什么。
 */
export async function ensureBuiltinStickers() {
  const result = { categories: 0, stickers: 0 };

  try {
    const rows = await query("SELECT COUNT(*) AS total FROM sticker_categories");
    if (!Number(rows[0]?.total || 0)) {
      let order = 0;
      for (const item of BUILTIN_CATEGORIES) {
        await execute(
          `INSERT INTO sticker_categories
             (cat_key, sticker_key, label, keywords, priority, late_night, ai_detect,
              triggerable, enabled, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          [
            item.catKey,
            item.stickerKey,
            item.label,
            item.keywords,
            item.priority,
            item.lateNight,
            item.aiDetect,
            item.triggerable,
            order * 10,
          ]
        );
        result.categories += 1;
        order += 1;
      }
    }
  } catch (err) {
    console.error("[sticker] 播种分类失败：", err?.code || err?.message || err);
  }

  try {
    const rows = await query("SELECT COUNT(*) AS total FROM stickers");
    if (Number(rows[0]?.total || 0)) {
      invalidateStickerSpec();
      return result;
    }

    for (const item of BUILTIN_CATEGORIES) {
      for (const file of scanCategoryDir(item.stickerKey)) {
        await execute(
          `INSERT INTO stickers (category, url, filename, enabled, sort_order)
           VALUES (?, ?, ?, 1, 0)`,
          [item.stickerKey, file.url, file.filename]
        );
        result.stickers += 1;
      }
    }
  } catch (err) {
    console.error("[sticker] 播种素材失败：", err?.code || err?.message || err);
  }

  invalidateStickerSpec();
  return result;
}

/**
 * 把一个分类目录里**还没登记**的图补进表（后台「重新扫描」按钮用）。
 * 手工往目录丢图的老流程靠它兜底，不然那些图在用户端永远不出现。
 */
export async function registerScannedFiles(stickerKey) {
  const key = String(stickerKey || "").trim().toLowerCase();
  if (!STICKER_KEY_RE.test(key)) return { added: 0, scanned: 0, error: "分类名不合法" };

  const files = scanCategoryDir(key);
  if (!files.length) return { added: 0, scanned: 0 };

  const rows = await query("SELECT filename FROM stickers WHERE category = ?", [key]);
  const known = new Set(rows.map((row) => String(row.filename)));

  let added = 0;
  for (const file of files) {
    if (known.has(file.filename)) continue;
    await execute(
      `INSERT INTO stickers (category, url, filename, enabled, sort_order)
       VALUES (?, ?, ?, 1, 0)`,
      [key, file.url, file.filename]
    );
    added += 1;
  }

  if (added) invalidateStickerSpec();
  return { added, scanned: files.length };
}
