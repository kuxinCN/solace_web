import MusicPlayer from "@/components/MusicPlayer";
import ThemeSync from "@/components/ThemeSync";
import PwaRegister from "@/components/PwaRegister";
import "./globals.css";

export const metadata = {
  title: "Solace",
  description: "给每一个不想说话的灵魂，一点慰藉。",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/logo.png", type: "image/png" },
      { url: "/favicon.ico" },
    ],
    shortcut: "/logo.png",
    apple: "/logo.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Solace",
  },
};

const themeInitScript = `
(function() {
  try {
    var path = window.location.pathname;
    if (path === '/' || path === '/home' || path.indexOf('/admin') === 0) {
      // 首页宣传页和管理后台永远保持正常模式，不做深夜模式
      return;
    }
    var mode = localStorage.getItem('solace_theme_mode') || 'day';
    var isDark = false;
    if (mode === 'night') {
      isDark = true;
    } else if (mode === 'system') {
      isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    } else if (mode === 'schedule') {
      var raw = localStorage.getItem('solace_theme_schedule');
      var sch = raw ? JSON.parse(raw) : { start: '20:00', end: '07:00' };
      var now = new Date();
      var curMin = now.getHours() * 60 + now.getMinutes();
      var sParts = (sch.start || '20:00').split(':');
      var eParts = (sch.end || '07:00').split(':');
      var sMin = (parseInt(sParts[0], 10) || 20) * 60 + (parseInt(sParts[1], 10) || 0);
      var eMin = (parseInt(eParts[0], 10) || 7) * 60 + (parseInt(eParts[1], 10) || 0);
      if (sMin > eMin) {
        isDark = (curMin >= sMin || curMin < eMin);
      } else {
        isDark = (curMin >= sMin && curMin < eMin);
      }
    }
    if (isDark) {
      document.documentElement.setAttribute('data-theme', 'espresso');
      document.documentElement.classList.add('theme-espresso');
      document.documentElement.classList.add('dark');
    }
  } catch (e) {}
})();
`;

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <link rel="icon" href="/logo.png" type="image/png" />
        <link rel="manifest" href="/manifest.json" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Solace" />
        <link rel="apple-touch-icon" href="/logo.png" />
        <meta name="theme-color" content="#1C1917" />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="antialiased">
        <PwaRegister />
        <ThemeSync />
        {children}
        <MusicPlayer />
      </body>
    </html>
  );
}
