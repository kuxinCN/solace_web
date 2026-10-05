/**
 * 后台「记忆汇总」手动触发接口。
 *
 * 干什么：
 *   立刻跑一次"昨日对话 → 记忆汇总"（T+1 每日批量提炼），
 *   用于验证 / 补跑（调度器默认每天零点后自动跑一次，这里可以手动补一次）。
 *
 * ⚠️ 只做触发，不做审核 —— 提炼结果直接写入 user_memories（category='daily'），
 *    不会进入内容审核队列。
 */
import { getAdminFromRequest } from "@/lib/admin-auth";
import { generateDailyMemories } from "@/lib/daily-memory";
import { json, jsonError } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  try {
    const summary = await generateDailyMemories();
    return json({ ok: true, ...summary });
  } catch (err) {
    return jsonError(`记忆汇总失败：${err?.message || err}`, 500);
  }
}
