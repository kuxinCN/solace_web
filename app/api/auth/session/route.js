/** 当前用户端登录状态：未登录时 user 为 null */
import { prewarmConnections } from "@/lib/ai";
import { getCurrentUser } from "@/lib/user-auth";
import { json } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const user = await getCurrentUser(request);

  // 已登录：聊天页加载时就会轮询本接口，顺手在后台预热到上游 AI 的连接，
  // 用户发首条消息时省掉 DNS+TLS 握手（约 100-300ms）。fire-and-forget。
  if (user) {
    try {
      prewarmConnections({ ai: true });
    } catch {
      /* 预热失败不影响会话检查 */
    }
  }

  return json({
    ok: true,
    user: user
      ? { id: user.id, email: user.email, username: user.username || "", avatarUrl: user.avatarUrl || "" }
      : null,
  });
}
