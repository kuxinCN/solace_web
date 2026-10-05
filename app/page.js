/**
 * 根路由 `/` —— 进站欢迎页
 *
 * 行为：
 *   · 打开网站**先看到欢迎页**（不论有没有登录）
 *   · 点箭头后分流：已登录 → `/chat`（不再重新登录），未登录 → `/login`
 *
 * ⚠️ 这里**故意不做重定向**：原来"已登录直接 redirect /chat"的写法会让老用户
 *    永远看不到欢迎页。分流改在点箭头那一刻，由 WelcomeGate 完成。
 *
 * ⚠️ 这是**服务端组件**，登录态在服务端读 Cookie 判断，再作为 prop 传给
 *    WelcomeGate —— 客户端不必再查 /api/auth/session，也就没有
 *    "先渲染一个分支、拿到结果再改成另一个"造成的闪烁。
 *
 * ⚠️ 宣传页 Landing 在 `/home`（不是这里）：应用内点 Logo 走那边，
 *    因为它永不重定向，不会把用户弹去聊天页。
 */
import { cookies } from "next/headers";
import WelcomeGate from "@/components/WelcomeGate";
import { getCurrentUser } from "@/lib/user-auth";

// 依赖 Cookie 判断登录态，必须每次请求都执行，不能静态化
export const dynamic = "force-dynamic";

export default async function RootPage() {
  // Next 14 的 cookies() 是同步的，await 一个非 Promise 值也合法，
  // 这样写是为了以后升 Next 15（cookies() 变 async）时不用再改
  const cookieStore = await cookies();

  // ⚠️ 查登录态必须包 try/catch：
  //    数据库连接异常时不能让首页直接 500 —— 退化成"未登录"、正常播欢迎页就行
  let user = null;
  try {
    user = await getCurrentUser({ cookies: cookieStore });
  } catch (err) {
    console.error("[welcome] 读取登录态失败：", err?.code || err?.message || err);
  }

  return <WelcomeGate authed={!!user} />;
}