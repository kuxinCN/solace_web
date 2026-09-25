/**
 * 回收站：被删除的聊天记录 / 日记 / 习惯先在这里放 3 天，用户后悔了能捞回来。
 *
 * 为什么用「独立的 payload 表」而不是给各表加 `deleted_at` 做软删除：
 *   * 软删除要给**所有**读取查询都加 `deleted_at IS NULL`，漏一处就会看到已删除的数据；
 *   * 独立表只需要改几个删除接口，所有读取路径完全不用动，风险小得多。
 *
 * ⚠️ 放在 lib 而不是 route 文件里：Next.js 的 route.js 只允许导出 HTTP 方法，
 *    导出普通函数会导致 build 报错。
 */
import { execute, query } from "./db";
import { cleanString, toMysqlDateTime } from "./util";

/** 回收站保留天数：3 天之内不主动恢复就自动删除 */
export const TRASH_DAYS = 3;

/** 单条回收站记录的大小上限 512KB：超过就截断正文，避免一条超长对话把表撑爆 */
export const MAX_PAYLOAD_BYTES = 512 * 1024;

/**
 * 回收站分类（前端 tab 顺序也是这样）。
 *
 * ⚠️ `habit`（习惯）目前项目里还没有对应功能，**分类先留好**：
 *    前端会显示这个 tab（为空），以后做习惯功能时把 `pushToTrash({ itemType: "habit" })`
 *    接上即可，接口和界面都不用再改。
 */
export const TRASH_CATEGORIES = [
  { id: "chat", label: "聊天记录", types: ["conversation", "message"] },
  { id: "diary", label: "日记", types: ["diary"] },
  // 「记忆」对应 user_memories 表 —— 就是 AI 记住的那些事（前端叫"记忆库"）
  { id: "memory", label: "记忆", types: ["memory"] },
];

/** 分类 id → 它包含的 item_type 列表；分类不存在返回 null */
export function typesOfCategory(categoryId) {
  if (!categoryId) return null;
  const found = TRASH_CATEGORIES.find((item) => item.id === String(categoryId));
  return found ? found.types : null;
}

/** item_type → 它属于哪个分类；认不出来的一律归到「聊天记录」 */
export function categoryOfType(itemType) {
  const type = String(itemType || "");
  const found = TRASH_CATEGORIES.find((item) => item.types.includes(type));
  return found ? found.id : "chat";
}

/** 把 payload 压到上限以内：优先截断 content，实在不行只留元信息 */
function limitPayload(payload) {
  const obj = payload && typeof payload === "object" ? { ...payload } : {};
  let text = JSON.stringify(obj);
  if (Buffer.byteLength(text, "utf8") <= MAX_PAYLOAD_BYTES) return text;

  // 先尝试只截断 content（正文），其余字段尽量保留
  if (typeof obj.content === "string") {
    let keep = obj.content.length;
    while (keep > 0) {
      const candidate = JSON.stringify({
        ...obj,
        content: obj.content.slice(0, keep),
        truncated: true,
      });
      if (Buffer.byteLength(candidate, "utf8") <= MAX_PAYLOAD_BYTES) {
        return candidate;
      }
      keep = Math.floor(keep * 0.8);
    }
  }

  // 消息数组（一整段对话）特别大时，逐个砍消息，保留最近的部分
  if (Array.isArray(obj.messages) && obj.messages.length) {
    let keep = obj.messages.length;
    while (keep > 0) {
      const candidate = JSON.stringify({
        ...obj,
        messages: obj.messages.slice(-keep),
        truncated: true,
      });
      if (Buffer.byteLength(candidate, "utf8") <= MAX_PAYLOAD_BYTES) {
        return candidate;
      }
      keep = Math.floor(keep * 0.8);
    }
  }

  // 还是超：只留元信息，至少列表里能看到是什么
  return JSON.stringify({
    id: obj.id,
    title: obj.title,
    truncated: true,
    note: "内容过大，回收站只保留了基本信息",
  });
}

/** 安全解析 payload */
function parsePayload(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 把一个即将被删除的条目暂存进回收站。
 * 失败时抛错，调用方自行决定是否忽略（一般用 try/catch 包住，别阻止删除本身）。
 */
export async function pushToTrash({ userId, itemType, title, payload }) {
  const now = new Date();
  const expireAt = new Date(now.getTime() + TRASH_DAYS * 24 * 3600 * 1000);

  await execute(
    `INSERT INTO trash (user_id, item_type, title, payload, deleted_at, expire_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      userId,
      cleanString(itemType, 16),
      cleanString(title, 160) || null,
      limitPayload(payload),
      toMysqlDateTime(now),
      toMysqlDateTime(expireAt),
    ]
  );
}

/**
 * 带原 ID 插入；ID 被占用时退回不带 ID 插入（让数据库分配新 ID）。
 *
 * 为什么要带原 ID：恢复后用户看到的消息/日记 ID 不变，前端缓存和链接也还有效。
 * 为什么要有兜底：万一原 ID 被新数据占了，不能因为主键冲突就让恢复失败。
 */
async function insertWithIdFallback(table, columns, values) {
  const placeholders = columns.map(() => "?").join(", ");
  const columnList = columns.map((name) => `\`${name}\``).join(", ");

  try {
    await execute(
      `INSERT INTO \`${table}\` (${columnList}) VALUES (${placeholders})`,
      values
    );
    return true;
  } catch {
    // 去掉前两列里的 id（约定：columns[0] 是 id）
    const cols = columns.slice(1);
    const vals = values.slice(1);
    const ph = cols.map(() => "?").join(", ");
    const cl = cols.map((name) => `\`${name}\``).join(", ");
    await execute(`INSERT INTO \`${table}\` (${cl}) VALUES (${ph})`, vals);
    return true;
  }
}

/**
 * 把回收站里的一条还原回原表。
 *
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function restoreTrashItem(userId, item) {
  const type = String(item?.item_type || "");
  const payload = parsePayload(item?.payload);

  if (type === "diary") {
    const content = typeof payload.content === "string" ? payload.content : "";
    if (!content) return { ok: false, reason: "内容已丢失（可能过大被截断）" };

    await insertWithIdFallback(
      "diaries",
      ["id", "user_id", "title", "content", "mood", "is_pinned", "is_favorited", "created_at"],
      [
        Number(payload.id) || null,
        userId,
        cleanString(payload.title, 120) || "无题",
        content,
        cleanString(payload.mood, 16) || null,
        Number(payload.isPinned ? 1 : 0),
        Number(payload.isFavorited ? 1 : 0),
        payload.createdAt || toMysqlDateTime(new Date()),
      ]
    );
    return { ok: true };
  }

  if (type === "conversation") {
    // 会话恢复时要把它下面的消息一起带回来（payload.messages 是删除时一起存的）
    const messages = Array.isArray(payload.messages) ? payload.messages : [];

    await insertWithIdFallback(
      "conversations",
      ["id", "user_id", "title", "pinned", "pinned_at", "last_message_at", "created_at"],
      [
        Number(payload.id) || null,
        userId,
        cleanString(payload.title, 120) || "新对话",
        Number(payload.pinned ? 1 : 0),
        payload.pinnedAt || null,
        payload.lastMessageAt || null,
        payload.createdAt || toMysqlDateTime(new Date()),
      ]
    );

    const conversationId = Number(payload.id) || 0;
    if (conversationId && messages.length) {
      for (const msg of messages) {
        const content = typeof msg?.content === "string" ? msg.content : "";
        if (!content) continue;
        try {
          await insertWithIdFallback(
            "messages",
            ["id", "conversation_id", "user_id", "role", "content", "created_at"],
            [
              Number(msg.id) || null,
              conversationId,
              userId,
              msg.role === "user" ? "user" : "assistant",
              content,
              msg.createdAt || toMysqlDateTime(new Date()),
            ]
          );
        } catch {
          /* 单条消息恢复失败不影响整体（比如会话 ID 已变） */
        }
      }
    }
    return { ok: true };
  }

  if (type === "message") {
    const content = typeof payload.content === "string" ? payload.content : "";
    if (!content) return { ok: false, reason: "内容已丢失" };

    // 消息必须挂在一个存在的会话下，否则外键会失败
    const conversationId = Number(payload.conversationId) || 0;
    const parents = await query(
      "SELECT id FROM conversations WHERE id = ? AND user_id = ? LIMIT 1",
      [conversationId, userId]
    );
    if (!parents.length) {
      return { ok: false, reason: "所属对话已被删除，无法单独恢复这条消息" };
    }

    await insertWithIdFallback(
      "messages",
      ["id", "conversation_id", "user_id", "role", "content", "created_at"],
      [
        Number(payload.id) || null,
        conversationId,
        userId,
        payload.role === "user" ? "user" : "assistant",
        content,
        payload.createdAt || toMysqlDateTime(new Date()),
      ]
    );
    return { ok: true };
  }

  if (type === "memory") {
    // 记忆库（user_memories）：内容 + 分类标签
    const content = typeof payload.content === "string" ? payload.content : "";
    if (!content) return { ok: false, reason: "内容已丢失" };

    await insertWithIdFallback(
      "user_memories",
      ["id", "user_id", "content", "category", "created_at"],
      [
        Number(payload.id) || null,
        userId,
        cleanString(content, 200) || "（空记忆）",
        cleanString(payload.category, 32) || null,
        payload.createdAt || toMysqlDateTime(new Date()),
      ]
    );
    return { ok: true };
  }

  return { ok: false, reason: `不认识的类型：${type}` };
}

/** 清理到期条目，返回删掉的条数（供 scripts/cleanup.mjs 与后台清理按钮调用） */
export async function purgeExpiredTrash() {
  const result = await execute("DELETE FROM trash WHERE expire_at < ?", [
    toMysqlDateTime(new Date()),
  ]);
  return result.affectedRows || 0;
}
