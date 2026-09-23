/** 用户端退出登录 */
import { USER_COOKIE, deleteUserSession, userCookieOptions } from "@/lib/user-auth";
import { buildCookie, json } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const token = request.cookies.get(USER_COOKIE)?.value || "";

  if (token) {
    try {
      await deleteUserSession(token);
    } catch {
      /* 数据库异常也要把浏览器上的 cookie 清掉 */
    }
  }

  return json({ ok: true }, 200, {
    "Set-Cookie": buildCookie(USER_COOKIE, "", { ...userCookieOptions(request), maxAge: 0 }),
  });
}
