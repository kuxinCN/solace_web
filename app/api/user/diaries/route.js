/** 日记：列表 / 新增 / 编辑 / 删除 */
import { describeDbError, execute, query } from "@/lib/db";
import { enqueueReview } from "@/lib/content-review";
import { ensureUserColumnsOnce } from "@/lib/schema";
import { pushToTrash } from "@/lib/trash";
import { getCurrentUser } from "@/lib/user-auth";
import { cleanString, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CONTENT_CHARS = 20000;

function parseId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return 0;
  const id = Number.parseInt(text, 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

/** 布尔语义统一成 0 / 1（兼容 true/"true"/1/"1" 等前端常见写法） */
function toFlag(value) {
  return value === true || value === 1 || value === "1" || value === "true" ? 1 : 0;
}

export async function GET(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  try {
    // 老部署升级时自动补 mood 列。
    // ⚠️ 补列失败（比如数据库账号没有 ALTER 权限）绝不能拖垮整个接口，
    // 否则用户会连自己的日记都看不到 —— 所以单独包一层，失败了继续往下走。
    try {
      await ensureUserColumnsOnce();
    } catch {
      /* 忽略：下面的查询若真的缺列，会给出更明确的错误 */
    }

    const diaries = await query(
      "SELECT id, user_id, title, content, mood, user_mood, source, diary_date, is_pinned, is_favorited, created_at FROM diaries WHERE user_id = ? ORDER BY id DESC",
      [user.id]
    );

    // ⚠️ MySQL 的 DATE 列经 mysql2 出来是 **JS Date 对象**，
    //    直接 json 出去会变成一串带时区的 ISO 时间，前端切字符串会切错
    //    （严重时还会因时区反过来差一天）。这里统一裁成 YYYY-MM-DD。
    return json({
      ok: true,
      diaries: diaries.map((item) => ({
        ...item,
        diary_date: toDateOnly(item.diary_date),
      })),
    });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

/** 把 DATE / Date / 字符串统一成 `YYYY-MM-DD`（拿不到就返回 null） */
function toDateOnly(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export async function POST(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const body = await readJsonBody(request);
  const title = cleanString(body.title, 120) || "无题";
  const content = cleanString(body.content, MAX_CONTENT_CHARS);
  // 用户自己选的情绪标签（可选）。和 AI 打的分开存：user_mood vs mood。
  const userMood = cleanString(body.userMood, 16) || null;

  if (!content) return jsonError("先写点什么吧，哪怕一句也好", 400);

  try {
    // ⚠️ diary_date = **当天**：用户自己写的日记，"对应的那一天"就是写它的那天。
    //    有了它，前端展示日期就不用去猜 created_at 的时区，
    //    而且和 AI 生成的日记（diary_date = 聊天那天）是同一套语义。
    const result = await execute(
      "INSERT INTO diaries (user_id, title, content, user_mood, diary_date) VALUES (?, ?, ?, ?, CURDATE())",
      [user.id, title, content, userMood]
    );

    const diaryId = result.insertId;

    // 放进「日记打标」队列：之后由批量 AI 抽一个情绪标签，写进 diaries.mood。
    //
    // ⚠️ 这一步**不影响日记保存**（上面已经写库了），失败也无所谓 ——
    //    后台点一次「扫描存量数据」还能补上。
    // ⚠️ 用户自己选了标签也照常入队：**两个标签是并存的**
    //    （user_mood 是用户说的，mood 是 AI 读出来的），前端会都显示出来。
    try {
      await enqueueReview({
        userId: user.id,
        taskKind: "diary_mood",
        content,
        targetId: diaryId,
      });
    } catch {
      /* 入队失败不影响写日记 */
    }

    // ---- 压力评估（日记通道）----
    //
    // ⚠️ 这里**要 await**（和聊天接口相反）：日记是一次性的长文本，用户保存完就等着看结果；
    //    而且"要不要放松"的弹窗本来就要延迟十几秒才出现 —— 这点耗时完全藏得住。
    //    返回的 stress 里带 shouldPopup / popup，前端拿到后自己定时弹出。
    let stress = null;
    try {
      const { getGroup } = await import("@/lib/settings");
      const safetyConfig = await getGroup("safety");

      if (safetyConfig?.stressEnabled) {
        const { onDiarySave } = await import("@/lib/stress-trigger");
        stress = await onDiarySave(user.id, content, { diaryDate: null });
      }
    } catch (err) {
      console.warn("[stress] 日记压力分析失败：", err?.message || err);
    }

    return json({
      ok: true,
      stress,
      diary: {
        id: diaryId,
        user_id: user.id,
        title,
        content,
        user_mood: userMood,
        is_pinned: 0,
        is_favorited: 0,
      },
    });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function PATCH(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const body = await readJsonBody(request);

  // 入参支持两种形式：
  //   单条：{ id: 12, is_pinned: true }
  //   批量：{ ids: [12, 13], is_favorited: true }（为后续批量操作预留）
  const rawIds = Array.isArray(body.ids) ? body.ids : [body.id];
  const ids = [...new Set(rawIds.map(parseId).filter(Boolean))].slice(0, 200);
  if (!ids.length) return jsonError("缺少日记 id", 400);
  const singleId = ids[0];

  const sets = [];
  const params = [];

  if (typeof body.title === "string") {
    sets.push("title = ?");
    params.push(cleanString(body.title, 120) || "无题");
  }
  // 用户自己改情绪标签（和 AI 打的 mood 分开存）
  if (typeof body.userMood === "string") {
    sets.push("user_mood = ?");
    params.push(cleanString(body.userMood, 16) || null);
  }

  if (typeof body.content === "string") {
    const content = cleanString(body.content, MAX_CONTENT_CHARS);
    if (!content) return jsonError("正文不能为空", 400);
    sets.push("content = ?");
    params.push(content);
    // 正文改了，AI 之前打的标签不再适用 → 清掉，下面会重新排队打标
    sets.push("mood = NULL");
  }
  // 置顶 / 收藏：只接受布尔语义，统一存成 0 / 1
  if (body.is_pinned !== undefined) {
    sets.push("is_pinned = ?");
    params.push(toFlag(body.is_pinned));
  }
  if (body.is_favorited !== undefined) {
    sets.push("is_favorited = ?");
    params.push(toFlag(body.is_favorited));
  }
  if (!sets.length) return jsonError("没有需要修改的内容", 400);

  // 标题/正文这类正文修改只对单条生效，不允许批量误伤
  const canBatch = !("title" in body) && !("content" in body);
  const targetIds = canBatch ? ids : [singleId];
  const placeholders = targetIds.map(() => "?").join(", ");

  try {
    const result = await execute(
      `UPDATE diaries SET ${sets.join(", ")} WHERE id IN (${placeholders}) AND user_id = ?`,
      [...params, ...targetIds, user.id]
    );

    if (!result.affectedRows) {
      // affectedRows 为 0 也可能只是「值没变」，再确认一次是否存在
      const exists = await query(
        `SELECT id FROM diaries WHERE id IN (${placeholders}) AND user_id = ? LIMIT 1`,
        [...targetIds, user.id]
      );
      if (!exists.length) return jsonError("日记不存在", 404);
    }

    // ⚠️ 正文被改过 → **重新排进打标队列**（上面已经把 AI 的旧标签清成 NULL 了）。
    //    只改「用户标签」（user_mood）不用重新打标 —— 那是用户自己的选择，
    //    和 AI 读出来的 mood 互不影响。
    if (typeof body.content === "string") {
      try {
        const row = await query(
          "SELECT id, content FROM diaries WHERE id = ? AND user_id = ? LIMIT 1",
          [singleId, user.id]
        );
        if (row.length) {
          await enqueueReview({
            userId: user.id,
            taskKind: "diary_mood",
            content: row[0].content,
            targetId: row[0].id,
          });
        }
      } catch {
        /* 入队失败不影响保存 */
      }
    }

    return json({
      ok: true,
      updated: result.affectedRows || 0,
      reQueuedMood: typeof body.content === "string",
    });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function DELETE(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  // 入参支持两种形式：
  //   单条：?id=12（沿用原有调用）
  //   批量：body { ids: [12, 13] }
  const url = new URL(request.url);
  const queryId = url.searchParams.get("id");
  // ⚠️ ?permanent=1 表示「彻底删除」：不进回收站，删了就没有了
  const permanent = url.searchParams.get("permanent") === "1";
  let rawIds = [];
  if (queryId) {
    rawIds = [queryId];
  } else {
    const body = await readJsonBody(request);
    rawIds = Array.isArray(body.ids) ? body.ids : [body.id];
  }
  const ids = [...new Set(rawIds.map(parseId).filter(Boolean))].slice(0, 200);
  if (!ids.length) return jsonError("缺少日记 id", 400);

  try {
    const placeholders = ids.map(() => "?").join(", ");

    // 「删除」：先取完整内容存进回收站，再删原记录 —— 用户 3 天内还能恢复
    // ⚠️ ?permanent=1（彻底删除）时跳过这一步
    try {
      if (permanent) throw new Error("skip-trash");
      const rows = await query(
        `SELECT id, title, content, mood, user_mood, source, diary_date, created_at FROM diaries
          WHERE id IN (${placeholders}) AND user_id = ?`,
        [...ids, user.id]
      );
      for (const row of rows) {
        await pushToTrash({
          userId: user.id,
          itemType: "diary",
          title: row.title || "无题",
          payload: row,
        });
      }
    } catch {
      /* 回收站写入失败不阻止删除（比如老库还没建 trash 表） */
    }

    const result = await execute(
      `DELETE FROM diaries WHERE id IN (${placeholders}) AND user_id = ?`,
      [...ids, user.id]
    );
    if (!result.affectedRows) return jsonError("日记不存在", 404);
    return json({ ok: true, deleted: result.affectedRows || 0 });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
