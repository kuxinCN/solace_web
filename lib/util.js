/** 通用小工具 */

import crypto from "node:crypto";

const pad = (value) => String(value).padStart(2, "0");

/** Date → 'YYYY-MM-DD HH:mm:ss'（按服务器本地时间写入 MySQL） */
export function toMysqlDateTime(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** MySQL DATETIME 字符串（本地时间）→ Date */
export function parseMysqlDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const text = String(value).trim().replace(" ", "T");
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 取访客 IP：宝塔 Nginx 反代会带上 X-Real-IP / X-Forwarded-For */
export function clientIp(request) {
  const headers = request?.headers;
  if (!headers) return "";
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first.slice(0, 45);
  }
  const real = headers.get("x-real-ip");
  if (real) return real.trim().slice(0, 45);
  return "";
}

/** 统一的 JSON 返回 */
export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

export function jsonError(message, status = 400, extra = {}) {
  return json({ ok: false, error: message, ...extra }, status);
}

/** 安全读取 JSON 请求体，永不抛异常 */
export async function readJsonBody(request) {
  try {
    const data = await request.json();
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

/** 去掉首尾空白并限制长度，防超长输入 */
export function cleanString(value, maxLength = 200) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

/** 定长比较，避免时序差异 */
export function safeEqualHex(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 比较两个口令/密钥，先哈希再定长比较，避免通过响应时间逐字节猜出内容
 * （直接 !== 比较会因为提前返回而泄露长度与相同前缀的长度）。
 */
export function safeEqualText(a, b) {
  const left = crypto.createHash("sha256").update(String(a ?? "")).digest("hex");
  const right = crypto.createHash("sha256").update(String(b ?? "")).digest("hex");
  return safeEqualHex(left, right);
}

/**
 * 手动拼 Set-Cookie 字符串。
 * 不依赖框架的 cookies().set()，行为更可控（多个 Set-Cookie 必须分开传数组）。
 */
export function buildCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value ?? "")}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join("; ");
}
