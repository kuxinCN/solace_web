/**
 * 消息本地缓存（localStorage）
 *
 * 为什么要有它：
 *   切换对话时原来每次都要等接口返回 —— 几百条消息要等一两秒，来回切就更难受。
 *   这里把每个对话的消息在浏览器里存一份，再次打开时**先用缓存立刻渲染**，
 *   同时后台请求最新数据覆盖。视觉上就是"秒开"。
 *
 * 设计要点：
 *   * key 里带 userId，换账号不会串数据；
 *   * 每个对话最多存 200 条（和接口的 LIMIT 500 呼应，够用又不占空间）；
 *   * 最多缓存 15 个对话，超了淘汰最久没被读过的；
 *   * 总量超 4MB 就整体清一次（localStorage 一般只有 5MB）；
 *   * **只缓存消息本身**，不缓存"正在发送""正在播放"这类临时状态，
 *     所以缓存里的 id 可能是 `temp-xxx` 的，读取方要自己过滤；
 *   * 任何失败（隐私模式 / 配额满 / 解析错）都静默忽略，绝不影响聊天。
 */

const KEY_PREFIX = "solace_msgs_";
const MAX_CONVERSATIONS = 15;
const MAX_MESSAGES_PER_CONV = 200;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

function keyOf(userId, convId) {
  return `${KEY_PREFIX}${userId || "anon"}_${convId}`;
}

/** 当前 localStorage 里我们的缓存占了多少字节 */
function usedBytes() {
  let total = 0;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(KEY_PREFIX)) continue;
      total += (localStorage.getItem(key) || "").length * 2; // utf-16，按 2 字节估
    }
  } catch {
    return 0;
  }
  return total;
}

/** 淘汰最久没读过的对话缓存，直到数量不超标 */
function evictOldest() {
  try {
    const entries = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(KEY_PREFIX)) continue;
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
  } catch {
    /* 忽略 */
  }
}

/**
 * 读缓存。
 * @returns {{ messages: Array, at: number } | null}
 */
export function readMessageCache(userId, convId) {
  if (!convId) return null;
  try {
    const raw = localStorage.getItem(keyOf(userId, convId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.messages) || !parsed.messages.length) return null;

    // 顺手刷新"最近读取时间"，供淘汰用
    try {
      localStorage.setItem(keyOf(userId, convId), JSON.stringify({ ...parsed, at: Date.now() }));
    } catch {
      /* 写不进去也无所谓 */
    }

    return { messages: parsed.messages, at: Number(parsed.at) || 0 };
  } catch {
    return null;
  }
}

/**
 * 写缓存。只保留每条消息渲染需要的字段，避免把大对象整存进去。
 */
export function writeMessageCache(userId, convId, messages) {
  if (!convId || !Array.isArray(messages) || !messages.length) return;
  try {
    const slim = messages.slice(-MAX_MESSAGES_PER_CONV).map((m) => ({
      id: m.id,
      role: m.role,
      content: typeof m.content === "string" ? m.content.slice(0, 8000) : "",
      createdAt: m.createdAt || m.created_at || "",
      ck: m.ck || undefined,
    }));

    localStorage.setItem(
      keyOf(userId, convId),
      JSON.stringify({ at: Date.now(), messages: slim })
    );

    if (usedBytes() > MAX_TOTAL_BYTES) {
      // 超了就整体清空重来，别做精细回收（不值得，聊天记录还能从服务器拉）
      clearMessageCache();
      return;
    }
    evictOldest();
  } catch {
    /* 隐私模式 / 配额满：静默放弃缓存 */
  }
}

/** 删掉某个对话的缓存（删除对话、清空消息时调用） */
export function removeMessageCache(userId, convId) {
  try {
    localStorage.removeItem(keyOf(userId, convId));
  } catch {
    /* 忽略 */
  }
}

/** 清空当前用户的全部消息缓存（退出登录、注销账号时调用） */
export function clearMessageCache(userId) {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(KEY_PREFIX)) continue;
      if (userId && !key.startsWith(`${KEY_PREFIX}${userId}_`)) continue;
      keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    /* 忽略 */
  }
}
