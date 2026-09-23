/**
 * 系统配置读写（存在 MySQL 的 settings 表里，每个分组一行 JSON）。
 *
 * 约定：
 *   * 读出来的一定会补全默认值、丢掉不认识的键；
 *   * 密钥类字段（apiKey / SMTP 授权码）不回传明文，只回传「是否已配置」；
 *   * 保存时密钥字段留空 = 保持原值不变，想清空要显式传 null。
 */
import { query, execute } from "./db";

export const GROUPS = ["ai", "tts", "smtp", "login", "site", "users"];

export const DEFAULTS = {
  // 对话 AI
  ai: {
    enabled: true,
    provider: "zhipu",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKey: "",
    model: "glm-4-flash",
    temperature: 0.7,
    maxTokens: 1024,
    timeoutSeconds: 60,
    // AI 系统提示词（人设）：后台可随时修改，保存后立即生效
    systemPrompt: `你是一位温柔的情绪陪伴者，不是心理咨询师，也不是老师。

你的最高原则是：先接住情绪，再谈其他。
1. 用户倾诉时，你的第一句话必须先回应他的感受，让他觉得被听见。例如："听起来你真的很累，想哭就哭吧，我在这里。""这件事憋在心里很久了吧，谢谢你愿意说给我听。"
2. 严禁生搬硬套心理学理论、教科书概念、专业术语或数据事实。不要说"这是典型的焦虑表现""建议你尝试认知重构""研究表明……"这类话。
3. 不讲大道理，不给人生建议，不评判对错，不催他振作、不要急着让他"好起来"。用户需要的不是解决方案，而是有人陪着。
4. 语气像认识很久的老朋友：温暖、自然、口语化、有温度。可以用"嗯""我在""慢慢说"这样简短的回应。
5. 多用一句问一句的节奏，把话头轻轻递回给用户，让他愿意继续说下去。
6. 回复要短，通常两三句话就够，不要长篇大论。`,
    // 用户刚写完日记时追加给 AI 的指令，{diary} 会被替换成日记正文
    diaryPrompt: `以下是用户刚刚写的日记正文，仅供你理解情绪和上下文，不要在回复中复述原文：
{diary}`,
  },
  // 文字转语音
  tts: {
    enabled: false,
    provider: "openai-compatible",
    baseUrl: "",
    apiKey: "",
    model: "",
    voice: "",
    speed: 1,
    format: "mp3",
    timeoutSeconds: 60,
    // 朗读风格指令：只有小米 MiMo 协议支持（会作为 user 消息发给模型）
    stylePrompt: "用温柔、缓慢、轻声细语的语调朗读，像一个老朋友在陪伴你说话。",
  },
  // 发信邮箱（网易 163 / 126）
  smtp: {
    enabled: false,
    host: "smtp.163.com",
    port: 465,
    secure: true,
    user: "",
    password: "",
    fromName: "Solace",
    fromEmail: "",
  },
  // 邮箱验证码规则
  login: {
    codeLength: 6,
    codeTtlSeconds: 300,
    sendCooldownSeconds: 60,
    dailyLimitPerEmail: 10,
    emailSubject: "【Solace】你的登录验证码",
    emailIntro: "你正在登录 Solace，验证码 {minutes} 分钟内有效。",
  },
  // 站点信息
  site: {
    siteName: "Solace",
    adminNotice: "",
  },
  // 用户管理页的字段显示开关
  // （邮箱、账号、密码是强制显示的，不在这个开关里）
  users: {
    visibleFields: {
      nickname: true,
      gender: true,
      birthday: true,
      phone: false,
      remark: false,
      status: true,
      createdAt: true,
      lastLoginAt: true,
    },
  },
};

/** 这些字段是密钥，读接口不返回明文 */
const SECRET_FIELDS = {
  ai: ["apiKey"],
  tts: ["apiKey"],
  smtp: ["password"],
};

const NUMBER_RANGES = {
  ai: {
    temperature: [0, 2],
    maxTokens: [1, 8192],
    timeoutSeconds: [5, 300],
  },
  tts: {
    speed: [0.5, 2],
    timeoutSeconds: [5, 300],
  },
  smtp: {
    port: [1, 65535],
  },
  login: {
    codeLength: [4, 8],
    codeTtlSeconds: [60, 3600],
    sendCooldownSeconds: [0, 600],
    dailyLimitPerEmail: [1, 100],
  },
};

const CACHE_TTL_MS = 30 * 1000;
const cache = new Map();

export function assertGroup(group) {
  if (!GROUPS.includes(group)) {
    const error = new Error(`未知的配置分组：${group}`);
    error.code = "UNKNOWN_GROUP";
    throw error;
  }
}

/** 读取一个分组（含密钥，仅服务端使用） */
export async function readGroup(group) {
  assertGroup(group);
  const defaults = DEFAULTS[group];
  const rows = await query("SELECT value FROM settings WHERE name = ? LIMIT 1", [group]);

  const merged = { ...defaults };
  if (!rows.length) return merged;

  let parsed = {};
  try {
    parsed = JSON.parse(rows[0].value) || {};
  } catch {
    parsed = {};
  }
  for (const key of Object.keys(defaults)) {
    if (
      Object.prototype.hasOwnProperty.call(parsed, key) &&
      parsed[key] !== undefined &&
      parsed[key] !== null
    ) {
      merged[key] = parsed[key];
    }
  }
  return merged;
}

/** 带短缓存的读取，聊天接口高频调用时不必每次都查库 */
export async function getGroup(group) {
  assertGroup(group);
  const hit = cache.get(group);
  if (hit && hit.expiresAt > Date.now()) return { ...hit.value };
  const value = await readGroup(group);
  cache.set(group, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  // 返回副本，防止调用方误改污染缓存
  return { ...value };
}

export function invalidateCache(group) {
  if (group) cache.delete(group);
  else cache.clear();
}

/** 去掉密钥，给前端看的版本 */
export function toPublicGroup(group, config) {
  const result = { ...config };
  for (const field of SECRET_FIELDS[group] || []) {
    result[field] = "";
    result[`${field}Configured`] = Boolean(config[field]);
  }
  return result;
}

export async function readAllPublic() {
  const result = {};
  for (const group of GROUPS) {
    const config = await readGroup(group);
    result[group] = toPublicGroup(group, config);
  }
  return result;
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeGroup(group, config) {
  const result = { ...config };
  const ranges = NUMBER_RANGES[group] || {};

  for (const [key, [min, max]] of Object.entries(ranges)) {
    const keepFraction = group === "tts" && key === "speed";
    const raw = Number(result[key]);
    const fallback = DEFAULTS[group][key];
    if (!Number.isFinite(raw)) {
      // 非法输入（空、文字等）回落到默认值，绝不把垃圾写进数据库
      result[key] = fallback;
      continue;
    }
    const clamped = Math.min(max, Math.max(min, raw));
    result[key] = keepFraction ? clamped : Math.round(clamped);
  }

  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "string") result[key] = value.trim();
  }

  if (group === "smtp") {
    result.secure = result.secure === true || result.secure === "true";
  }

  // 用户管理页的字段显示开关：统一转成布尔值
  // （数组视为非法值，原样留下去让 validateGroup 报错）
  if (
    group === "users" &&
    result.visibleFields &&
    typeof result.visibleFields === "object" &&
    !Array.isArray(result.visibleFields)
  ) {
    const cleaned = {};
    for (const [key, value] of Object.entries(result.visibleFields)) {
      cleaned[key] = value === true || value === "true";
    }
    result.visibleFields = cleaned;
  }

  return result;
}

export function validateGroup(group, config) {
  const errors = [];

  if (group === "ai") {
    if (!config.baseUrl) errors.push("接口地址不能为空");
    else if (!isHttpUrl(config.baseUrl)) errors.push("接口地址必须是 http(s):// 开头的完整地址");
    if (!config.model) errors.push("模型名不能为空");
    if (config.enabled && !config.apiKey) errors.push("启用对话 AI 时必须填写 API Key");
  }

  if (group === "tts") {
    if (config.enabled) {
      if (!config.baseUrl) errors.push("启用语音合成时必须填写接口地址");
      else if (!isHttpUrl(config.baseUrl)) errors.push("语音接口地址必须是 http(s):// 开头");
      if (!config.model) errors.push("启用语音合成时必须填写模型名");
      if (!config.voice) errors.push("启用语音合成时必须填写音色");
      if (!config.apiKey) errors.push("启用语音合成时必须填写 API Key");
    } else if (config.baseUrl && !isHttpUrl(config.baseUrl)) {
      errors.push("语音接口地址必须是 http(s):// 开头");
    }
  }

  if (group === "smtp") {
    if (!config.host) errors.push("SMTP 服务器地址不能为空");
    if (config.user && !isEmail(config.user)) errors.push("发信账号必须是完整邮箱地址");
    if (config.fromEmail && !isEmail(config.fromEmail)) errors.push("发件人邮箱格式不正确");
    if (config.enabled) {
      if (!config.user) errors.push("启用邮件发送时必须填写发信邮箱");
      if (!config.password) errors.push("启用邮件发送时必须填写 SMTP 授权码（网易邮箱是授权码，不是登录密码）");
    }
    // 网易邮箱强制要求发件人等于登录账号，否则报 553
    if (
      config.fromEmail &&
      config.user &&
      config.fromEmail.toLowerCase() !== config.user.toLowerCase() &&
      /(?:^|\.)(?:163|126)\.com$/.test(config.host)
    ) {
      errors.push("网易邮箱要求「发件人邮箱」与「发信邮箱」保持一致");
    }
  }

  if (group === "login") {
    if (!config.emailSubject) errors.push("邮件标题不能为空");
    if (!config.emailIntro) errors.push("邮件正文不能为空");
  }

  if (group === "site") {
    if (!config.siteName) errors.push("站点名称不能为空");
  }

  if (group === "users") {
    if (
      !config.visibleFields ||
      typeof config.visibleFields !== "object" ||
      Array.isArray(config.visibleFields)
    ) {
      errors.push("字段显示开关格式不正确");
    }
  }

  return errors;
}

/**
 * 保存一个分组。
 * patch 里没有出现的键保持原值；密钥字段传 "" 表示「不修改」。
 */
export async function saveGroup(group, patch) {
  assertGroup(group);
  const defaults = DEFAULTS[group];
  const current = await readGroup(group);
  const secretFields = SECRET_FIELDS[group] || [];

  const merged = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) continue;
    if (secretFields.includes(key)) {
      if (value === "" || value === undefined) continue; // 留空 = 不改
      if (value === null) {
        merged[key] = ""; // 显式清空
        continue;
      }
    }
    merged[key] = value;
  }

  const normalized = normalizeGroup(group, merged);
  const errors = validateGroup(group, normalized);
  if (errors.length) {
    const error = new Error(errors.join("；"));
    error.code = "INVALID_SETTINGS";
    error.errors = errors;
    throw error;
  }

  await execute(
    "INSERT INTO settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
    [group, JSON.stringify(normalized)]
  );
  invalidateCache(group);
  return normalized;
}
