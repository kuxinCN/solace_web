export const metadata = {
  title: "Solace 安装向导",
  description: "首次部署时的初始化安装",
  robots: { index: false, follow: false },
};

export default function InstallLayout({ children }) {
  return <div className="min-h-screen bg-[#fafaf8] text-slate-800">{children}</div>;
}
