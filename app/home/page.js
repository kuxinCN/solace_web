/**
 * `/home` —— 首页（宣传页）的固定地址
 *
 * 和 `/` 的区别：**这里永远显示宣传页，不做任何登录态重定向**。
 *
 * 所以应用内点左上角 Logo 就跳到这里 —— 已登录用户也能正常回到首页，
 * 不会被弹回聊天页（如果 Logo 指向 `/`，已登录时会被重定向回 /chat）。
 */
import Landing from "@/components/Landing";

export const metadata = {
  title: "Solace",
  description: "给每一个不想说话的灵魂，一点慰藉。",
};

export default function HomePage() {
  return <Landing />;
}
