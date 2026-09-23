/**
 * 日记情绪标签：POST /api/user/diaries/mood
 * body: { id: 日记 id }
 *
 * 设计说明（重要，别改坏）：
 *   * 标签是「温和的描述」而不是「评分」——输出的是"有点沉""平静"这类词，
 *     没有分数、没有好坏、也没有趋势对比，避免让用户觉得自己的情绪被评判；
 *   * 标签只用于让用户「被看见」，不触发任何自动建议或提醒；
 *   * 已经有标签的日记不重复调用 AI（省额度）；日记正文被修改后标签会被清空重算。
 */
import { analyzeDiaryMood } from "@/lib/ai";
import { describeDbError, execute, query } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { ensureDiaryColumnsOnce } from "@/lib/schema";
import { getCurrentUser } from "@/lib/user-auth";
import { json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return 0;
  const id = Number.parseInt(text, 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

export async function POST(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  // 每次分析都要调用 AI（花钱），按用户限流
  const quota = rateLimit(`diary-mood:${user.id}`, {
    limit: 20,
    windowMs: 60 * 60 * 1000,
  });
  if (!quota.ok) {
    return jsonError(`操作太频繁，请 ${quota.retryAfterSeconds} 秒后再试`, 429);
  }

  // 老部署升级时自动补 mood 列
  await ensureDiaryColumnsOnce();

  const body = await readJsonBody(request);
  const id = parseId(body.id);
  if (!id) return jsonError("缺少日记 id", 400);

  try {
    const rows = await query(
      "SELECT id, content, mood FROM diaries WHERE id = ? AND user_id = ? LIMIT 1",
      [id, user.id]
    );
    const diary = rows[0];
    if (!diary) return jsonError("日记不存在", 404);

    // 已有标签就直接返回，不重复消耗额度
    if (diary.mood) {
      return json({ ok: true, mood: diary.mood, cached: true });
    }

    const result = await analyzeDiaryMood({ text: diary.content });
    if (!result.ok) {
      return jsonError(result.error || "暂时无法分析，请稍后再试", 502);
    }

    await execute("UPDATE diaries SET mood = ? WHERE id = ? AND user_id = ?", [
      result.mood,
      id,
      user.id,
    ]);

    return json({ ok: true, mood: result.mood, cached: false });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
