/**
 * 根路由 `/` —— 智能入口
 *
 * 行为：
 *   · **已登录** → 直接重定向到 `/chat`（在服务端完成，用户看不到任何中间页面闪烁）
 *   · **未登录** → 显示首页（宣传页）
 *
 * ⚠️ 这是**服务端组件**，所以登录状态是在服务端读 Cookie 判断的，
 *    不会出现"先闪一下宣传页再跳走"的观感问题。
 *
 * ⚠️ 为什么应用内点 Logo 是去 `/home` 而不是这里：
 *    因为已登录时这里会重定向到 /chat，Logo 指回 `/` 就变成"点不动"了。
 *    `/home` 渲染的是同一个 Landing 组件，但永远不做重定向。
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Landing from "@/components/Landing";
import { getCurrentUser } from "@/lib/user-auth";

// 依赖 Cookie 判断登录态，必须每次请求都执行，不能静态化
export const dynamic = "force-dynamic";

export default async function RootPage() {
  // Next 14 的 cookies() 是同步的，await 一个非 Promise 值也完全合法，
  // 这样写是为了以后升到 Next 15（cookies() 变 async）时不用再改。
  const cookieStore = await cookies();

  // ⚠️ 查登录态必须包 try/catch：
  //    数据库连接异常时不能让首页直接 500 —— 退化成"未登录"、正常显示宣传页就行。
  //    （注意 redirect() 会抛特殊的 NEXT_REDIRECT 控制流错误，所以必须放在 try 外面）
  let user = null;
  try {
    user = await getCurrentUser({ cookies: cookieStore });
  } catch (err) {
    console.error("[home] 读取登录态失败：", err?.code || err?.message || err);
  }

  if (user) redirect("/chat");

  return <Landing />;
}
