export const metadata = {
  title: "Solace 管理后台",
  description: "Solace 站点配置与运行状态管理",
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }) {
  return <div className="min-h-screen bg-[#fafaf8] text-slate-800">{children}</div>;
}
