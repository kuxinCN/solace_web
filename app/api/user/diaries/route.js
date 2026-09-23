/** 日记：列表 / 新增 / 编辑 / 删除 */
import { describeDbError, execute, query } from "@/lib/db";
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

export async function GET(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  try {
    const diaries = await query(
      "SELECT id, user_id, title, content, created_at FROM diaries WHERE user_id = ? ORDER BY id DESC",
      [user.id]
    );
    return json({ ok: true, diaries });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function POST(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const body = await readJsonBody(request);
  const title = cleanString(body.title, 120) || "无题";
  const content = cleanString(body.content, MAX_CONTENT_CHARS);

  if (!content) return jsonError("先写点什么吧，哪怕一句也好", 400);

  try {
    const result = await execute(
      "INSERT INTO diaries (user_id, title, content) VALUES (?, ?, ?)",
      [user.id, title, content]
    );
    return json({
      ok: true,
      diary: { id: result.insertId, user_id: user.id, title, content },
    });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function PATCH(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const body = await readJsonBody(request);
  const id = parseId(body.id);
  if (!id) return jsonError("缺少日记 id", 400);

  const sets = [];
  const params = [];

  if (typeof body.title === "string") {
    sets.push("title = ?");
    params.push(cleanString(body.title, 120) || "无题");
  }
  if (typeof body.content === "string") {
    const content = cleanString(body.content, MAX_CONTENT_CHARS);
    if (!content) return jsonError("正文不能为空", 400);
    sets.push("content = ?");
    params.push(content);
  }
  if (!sets.length) return jsonError("没有需要修改的内容", 400);

  try {
    const result = await execute(
      `UPDATE diaries SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`,
      [...params, id, user.id]
    );

    if (!result.affectedRows) {
      // affectedRows 为 0 也可能只是「内容没变」，再确认一次是否存在
      const exists = await query("SELECT id FROM diaries WHERE id = ? AND user_id = ? LIMIT 1", [
        id,
        user.id,
      ]);
      if (!exists.length) return jsonError("日记不存在", 404);
    }
    return json({ ok: true });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function DELETE(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const id = parseId(new URL(request.url).searchParams.get("id"));
  if (!id) return jsonError("缺少日记 id", 400);

  try {
    const result = await execute("DELETE FROM diaries WHERE id = ? AND user_id = ?", [id, user.id]);
    if (!result.affectedRows) return jsonError("日记不存在", 404);
    return json({ ok: true });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
