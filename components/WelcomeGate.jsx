"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import WelcomeOverlay from "@/components/WelcomeOverlay";

/**
 * 进站欢迎页 + 登录态分流。
 *
 * 流程：
 *   打开网站 → 欢迎页 → 点箭头 → 已登录进聊天页 / 未登录进登录页
 *
 * 为什么登录态由父级以 prop 传进来、这里不自己查：
 *   点箭头时才知道该去 /chat 还是 /login。如果在这里现查
 *   /api/auth/session（远端库约 450ms），要么先渲染欢迎页、拿到结果再改主意，
 *   要么先白屏干等 —— 前者会闪。父级 app/page.js 是服务端组件，
 *   读 Cookie 判断登录态不花额外往返，直接传下来最稳，全程零闪烁。
 *
 * 为什么用 sessionStorage 记"看过了"：
 *   新开标签页 → 空 → 播欢迎页；刷新当前页 → 还在 → 不重播；
 *   关掉标签页重开 → 清空 → 再播。
 */
const WELCOMED_KEY = "solace_welcomed";

export default function WelcomeGate({ authed }) {
  const router = useRouter();
  // false = 还没读完 sessionStorage：只渲染纯色底，
  // 既不渲染欢迎页也不渲染别的，避免"先闪一下再跳走"
  const [showWelcome, setShowWelcome] = useState(false);

  useEffect(() => {
    let welcomed = false;
    try {
      welcomed = sessionStorage.getItem(WELCOMED_KEY) === "1";
    } catch {
      // 存储不可用（隐私模式）：当作没看过，正常播欢迎页
    }
    if (welcomed) {
      // 本次会话已经看过：直接分流，不重播。
      // 用 replace 而不是 push —— 不留历史记录，否则用户按返回键会回到这里又被弹走
      router.replace(authed ? "/chat" : "/login");
      return;
    }
    setShowWelcome(true);
  }, [authed, router]);

  function handleFinish() {
    try {
      sessionStorage.setItem(WELCOMED_KEY, "1");
    } catch {
      // 写不进去只影响"下次不重播"，不影响本次进入
    }
    router.push(authed ? "/chat" : "/login");
  }

  // 还没决定去向 / 正在跳转：纯色底（与全站米白一致），不出现任何中间界面
  if (!showWelcome) {
    return <div className="h-screen bg-[#fafaf8]" />;
  }

  return <WelcomeOverlay onFinish={handleFinish} />;
}