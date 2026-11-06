"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { getStoredTheme, applyTheme } from "@/lib/theme";

/**
 * 全局主题同步管理器：
 * 1. 首页（/ 或 /home）与管理后台（/admin*）强制回归正常浅色模式，不进深夜模式
 * 2. 在对话/日记等陪伴界面负责定时刻度（20:00 - 07:00）的周期性自适应检测，到点无感平滑切换
 * 3. 监听系统深浅色主题变化（prefers-color-scheme），在「随光而变」模式下即时响应
 * 4. 监听跨标签页 localStorage 变更，保持多窗口体验一致
 */
export default function ThemeSync() {
  const pathname = usePathname();

  useEffect(() => {
    // 首页（/ 或 /home）与管理后台（/admin*）强制保持正常浅色模式
    if (pathname === "/" || pathname === "/home" || pathname?.startsWith("/admin")) {
      const root = document.documentElement;
      root.removeAttribute("data-theme");
      root.classList.remove("dark", "theme-espresso");
      return;
    }

    // 挂载或路径切换到用户空间（如 /chat）后根据当前配置再次核验生效
    const { mode, schedule } = getStoredTheme();
    applyTheme(mode, schedule);

    // 1. 定时检查定时刻度（每 30 秒检测一次）
    const interval = setInterval(() => {
      if (
        window.location.pathname === "/" ||
        window.location.pathname === "/home" ||
        window.location.pathname?.startsWith("/admin")
      ) {
        return;
      }
      const cur = getStoredTheme();
      if (cur.mode === "schedule") {
        applyTheme("schedule", cur.schedule);
      }
    }, 30000);

    // 2. 监听系统色彩偏好变更
    const mql = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const handleSystemChange = () => {
      if (
        window.location.pathname === "/" ||
        window.location.pathname === "/home" ||
        window.location.pathname?.startsWith("/admin")
      ) {
        return;
      }
      const cur = getStoredTheme();
      if (cur.mode === "system") {
        applyTheme("system", cur.schedule);
      }
    };
    mql?.addEventListener?.("change", handleSystemChange);

    // 3. 跨标签页同步
    const handleStorage = (e) => {
      if (e.key === "solace_theme_mode" || e.key === "solace_theme_schedule") {
        if (
          window.location.pathname === "/" ||
          window.location.pathname === "/home" ||
          window.location.pathname?.startsWith("/admin")
        ) {
          return;
        }
        const cur = getStoredTheme();
        applyTheme(cur.mode, cur.schedule);
      }
    };
    window.addEventListener("storage", handleStorage);

    return () => {
      clearInterval(interval);
      mql?.removeEventListener?.("change", handleSystemChange);
      window.removeEventListener("storage", handleStorage);
    };
  }, [pathname]);

  return null;
}
