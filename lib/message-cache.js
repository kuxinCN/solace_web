/**
 * 消息与会话本地缓存（localStorage）
 *
 * 核心安全规则：
 *   * 严格按 userId 隔离，严禁任何形式的跨用户模糊猜测或 latest 全局兜底；
 *   * 退出登录时必须由 clearAllLocalChatState 彻底清空所有本地会话与消息缓存；
 *   * 未登录或登录态未确认前，不回填任何私有会话数据。
 */

const KEY_PREFIX = "solace_msgs_";
const MAX_CONVERSATIONS = 15;
const MAX_MESSAGES_PER_CONV = 200;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const CONVS_KEY_PREFIX = "solace_convs_";

function keyOf(userId, convId) {
  if (!userId || !convId) return null;
  return `${KEY_PREFIX}${userId}_${convId}`;
}

function usedBytes() {
  let total = 0;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(KEY_PREFIX)) continue;
      total += (localStorage.getItem(key) || "").length * 2;
    }
  } catch {
    return 0;
  }
  return total;
}

function evictOldest(userId) {
  try {
    const entries = [];
    const userPrefix = userId ? `${KEY_PREFIX}${userId}_` : KEY_PREFIX;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(userPrefix)) continue;
      let at = 0;
      try {
        at = JSON.parse(localStorage.getItem(key) || "{}").at || 0;
      } catch {
        at = 0;
      }
      entries.push({ key, at });
    }
    if (entries.length <= MAX_CONVERSATIONS) return;
    entries.sort((a, b) => a.at - b.at);
    for (const item of entries.slice(0, entries.length - MAX_CONVERSATIONS)) {
      localStorage.removeItem(item.key);
    }
  } catch {}
}

/**
 * 读消息缓存（严格要求 userId）
 */
export function readMessageCache(userId, convId) {
  if (!userId || !convId) return null;
  try {
    const k = keyOf(userId, convId);
    if (!k) return null;
    const raw = localStorage.getItem(k);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.messages) || !parsed.messages.length) return null;

    try {
      localStorage.setItem(k, JSON.stringify({ ...parsed, at: Date.now() }));
    } catch {}

    return { messages: parsed.messages, at: Number(parsed.at) || 0 };
  } catch {
    return null;
  }
}

/**
 * 写消息缓存（严格要求 userId）
 */
export function writeMessageCache(userId, convId, messages) {
  if (!userId || !convId || !Array.isArray(messages) || !messages.length) return;
  try {
    const k = keyOf(userId, convId);
    if (!k) return;
    const slim = messages.slice(-MAX_MESSAGES_PER_CONV).map((m) => ({
      id: m.id,
      role: m.role,
      content: typeof m.content === "string" ? m.content.slice(0, 8000) : "",
      createdAt: m.createdAt || m.created_at || "",
      ck: m.ck || undefined,
    }));

    localStorage.setItem(k, JSON.stringify({ at: Date.now(), messages: slim }));

    if (usedBytes() > MAX_TOTAL_BYTES) {
      clearMessageCache(userId);
      return;
    }
    evictOldest(userId);
  } catch {}
}

/** 删掉某个对话的缓存 */
export function removeMessageCache(userId, convId) {
  if (!userId || !convId) return;
  try {
    const k = keyOf(userId, convId);
    if (k) localStorage.removeItem(k);
  } catch {}
}

/** 清空指定用户的消息缓存 */
export function clearMessageCache(userId) {
  try {
    const keys = [];
    const userPrefix = userId ? `${KEY_PREFIX}${userId}_` : KEY_PREFIX;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(userPrefix)) continue;
      keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {}
}

/** 获取上次用户浏览的活跃会话 ID（严格按 userId 隔离） */
export function getLastActiveConversation(userId) {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(`solace_last_active_conv_${userId}`);
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/** 记录当前活跃会话 ID（严格按 userId 隔离） */
export function setLastActiveConversation(convId, userId) {
  try {
    if (userId) {
      const key = `solace_last_active_conv_${userId}`;
      if (convId) {
        localStorage.setItem(key, String(convId));
      } else {
        localStorage.removeItem(key);
      }
    }
    localStorage.removeItem("solace_last_active_conv");
    if (convId) {
      localStorage.setItem(key, String(convId));
    } else {
      localStorage.removeItem(key);
    }
  } catch {}
}

/** 安全查找消息缓存（严格要求 userId，无 userId 绝不跨用户扫描） */
export function findCachedMessages(convId, userId = null) {
  if (!convId || !userId) return null;
  const res = readMessageCache(userId, convId);
  if (res?.messages?.length) return res.messages;
  return null;
}

/**
 * 读取本地缓存的会话列表（严格按 userId 隔离）
 */
export function readConversationsCache(userId = null) {
  if (!userId || typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(`${CONVS_KEY_PREFIX}${userId}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch {}
  return [];
}

/**
 * 缓存会话列表到本地（严格按 userId 隔离）
 */
export function writeConversationsCache(userId, conversations) {
  if (!userId || !Array.isArray(conversations) || typeof window === "undefined") return;
  try {
    localStorage.setItem(`${CONVS_KEY_PREFIX}${userId}`, JSON.stringify(conversations));
  } catch {}
}

/**
 * 彻底清理浏览器中残留的所有聊天与会话状态（退出登录时调用，杜绝账号切换串数据）
 */
export function clearAllLocalChatState() {
  if (typeof window === "undefined") return;
  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (
        k.startsWith("solace_msgs_") ||
        k.startsWith("solace_convs_") ||
        k.startsWith("solace_last_active_conv") ||
        k === "solace_diary_context" ||
        k.startsWith("memory_extract_gate_")
      ) {
        keysToRemove.push(k);
      }
    }
    for (const k of keysToRemove) localStorage.removeItem(k);

    const sessionKeysToRemove = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const sk = sessionStorage.key(i);
      if (!sk) continue;
      if (sk.startsWith("solace_chat_draft_") || sk === "solace_welcomed") {
        sessionKeysToRemove.push(sk);
      }
    }
    for (const sk of sessionKeysToRemove) sessionStorage.removeItem(sk);
  } catch {}
}
