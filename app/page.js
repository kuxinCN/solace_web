/**
 * 根路由 `/` —— 官方宣传落地页（Landing Page）
 *
 * 行为：
 *   · 打开网站直接进入温润典雅的宣传落地页，无需任何开屏等待或点击箭头分流；
 *   · 页面内部可感知登录态：已登录显示「返回对话空间」，未登录显示「即刻进入」；
 *   · 与 `/home` 保持一致，保证用户无论通过根域名还是点击 Logo 都能顺畅访问。
 */
import Landing from "@/components/Landing";

export const metadata = {
  title: "Solace",
  description: "给每一个不想说话的灵魂，一点慰藉。",
};

export default function RootPage() {
  return <Landing />;
}
