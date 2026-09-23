/** 当前用户端登录状态：未登录时 user 为 null */
import { getCurrentUser } from "@/lib/user-auth";
import { json } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const user = await getCurrentUser(request);

  return json({
    ok: true,
    user: user
      ? { id: user.id, email: user.email, username: user.username || "", avatarUrl: user.avatarUrl || "" }
      : null,
  });
}
