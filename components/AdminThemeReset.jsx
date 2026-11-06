"use client";

import { useEffect } from "react";

/**
 * 管理后台主题重置器：
 * 保证进入 /admin 任意页面时强制回归正常浅色模式，不进深夜模式
 */
export default function AdminThemeReset() {
  useEffect(() => {
    const root = document.documentElement;
    root.removeAttribute("data-theme");
    root.classList.remove("dark", "theme-espresso");
  }, []);

  return null;
}

