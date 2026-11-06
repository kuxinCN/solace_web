"use client";

import { useEffect, useState, useRef } from "react";

export default function PwaRegister() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [showBanner, setShowBanner] = useState(false);
  const [showIosGuide, setShowIosGuide] = useState(false);
  const [isIos, setIsIos] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // 1. 判断是否已处于独立应用（PWA）模式
    const standalone =
      window.navigator.standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: fullscreen)").matches;
    setIsStandalone(standalone);

    const ios = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
    setIsIos(ios);

    // 2. 屏蔽 iOS Safari 在独立 PWA 模式下的橡皮筋整体下拉阻尼感
    if (ios && standalone) {
      const preventRubberBand = (e) => {
        let el = e.target;
        let canScroll = false;
        while (el && el !== document.body && el !== document.documentElement) {
          const style = window.getComputedStyle(el);
          const oy = style.overflowY;
          if (
            (oy === "auto" || oy === "scroll") &&
            el.scrollHeight > el.clientHeight
          ) {
            canScroll = true;
            break;
          }
          el = el.parentElement;
        }
        if (!canScroll) {
          if (e.cancelable) e.preventDefault();
        }
      };
      document.addEventListener("touchmove", preventRubberBand, { passive: false });
      return () => {
        document.removeEventListener("touchmove", preventRubberBand);
      };
    }

    // 3. 注册 Service Worker（支持 https 和本地开发）
    const isSecure =
      window.location.protocol === "https:" ||
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";

    if ("serviceWorker" in navigator && isSecure) {
      const handleLoad = () => {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
      };
      if (document.readyState === "complete") {
        handleLoad();
      } else {
        window.addEventListener("load", handleLoad);
      }
    }

    // 4. 监听 Chrome 移动端 beforeinstallprompt 事件（解决手机 Chrome 不弹安装标识问题）
    const handleBeforeInstallPrompt = (e) => {
      // 阻止旧版浏览器默认 mini-infobar，由我们接管展示温和安装引导
      e.preventDefault();
      setDeferredPrompt(e);

      // 若用户近期没有主动关闭（3天内），则在移动端展示安装引导
      try {
        const dismissedAt = localStorage.getItem("solace_pwa_dismissed");
        if (dismissedAt && Date.now() - Number(dismissedAt) < 3 * 24 * 60 * 60 * 1000) {
          return;
        }
      } catch {}

      // 仅在移动端或非独立模式下提醒
      if (!standalone) {
        setShowBanner(true);
      }
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);

    // 5. 监听应用安装完成事件
    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      setShowBanner(false);
      setIsStandalone(true);
    };
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  // 触发安装操作
  const handleInstallClick = async () => {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      try { navigator.vibrate(12); } catch {}
    }

    // Android / 移动端 Chrome：唤起系统原生安装确认框
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice?.outcome === "accepted") {
        setShowBanner(false);
      }
      setDeferredPrompt(null);
      return;
    }

    // iOS Safari：展示添加到主屏幕的图文步骤引导
    if (isIos) {
      setShowIosGuide(true);
    }
  };

  // 关闭安装横幅
  const handleDismiss = () => {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      try { navigator.vibrate(10); } catch {}
    }
    setShowBanner(false);
    try {
      localStorage.setItem("solace_pwa_dismissed", String(Date.now()));
    } catch {}
  };

  // 如果已经是在独立应用模式下运行，不需要任何引导
  if (isStandalone) return null;

  return (
    <>
      {/* 移动端 PWA 安装引导小胶囊 / 横幅 */}
      {showBanner && (
        <div
          role="region"
          aria-label="安装应用提示"
          className="fixed bottom-4 left-3 right-3 sm:left-auto sm:right-6 sm:bottom-6 sm:w-96 z-50 bg-stone-900/95 dark:bg-stone-950/95 backdrop-blur-md border border-stone-700/60 text-white rounded-2xl p-3.5 shadow-2xl flex items-center justify-between gap-3 animate-fade-in"
          style={{ boxShadow: "0 10px 35px -5px rgba(0,0,0,0.5)" }}
        >
          <div className="flex items-center gap-3 min-w-0">
            <img
              src="/logo.png"
              alt="Solace"
              className="w-10 h-10 rounded-xl object-contain bg-stone-800/80 p-1 flex-shrink-0"
            />
            <div className="min-w-0">
              <div className="text-xs font-semibold text-stone-100 flex items-center gap-1.5">
                <span>添加 Solace 到手机</span>
                <span className="text-[10px] px-1.5 py-0.2 bg-amber-500/20 text-amber-300 rounded-full border border-amber-500/30">
                  App 体验
                </span>
              </div>
              <p className="text-[11px] text-stone-400 truncate mt-0.5">
                全屏沉浸陪伴 · 离线极速秒开
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={handleInstallClick}
              className="px-3 py-1.5 rounded-xl text-xs font-medium text-white bg-gradient-to-r from-[#d97c62] to-[#b85a3c] hover:opacity-95 shadow-sm active:scale-95 transition-all cursor-pointer whitespace-nowrap"
            >
              立即安装
            </button>
            <button
              onClick={handleDismiss}
              aria-label="稍后提示"
              className="p-1.5 text-stone-400 hover:text-stone-200 rounded-lg hover:bg-stone-800/60 active:scale-90 transition-all cursor-pointer"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* iOS Safari 添加到主屏幕图文指引浮层 */}
      {showIosGuide && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4 animate-fade-in"
          onClick={() => setShowIosGuide(false)}
        >
          <div
            className="w-full max-w-sm bg-stone-900 border border-stone-700/80 rounded-2xl p-5 text-white shadow-2xl relative mb-2 sm:mb-0"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 border-b border-stone-800">
              <div className="flex items-center gap-2.5">
                <img src="/logo.png" alt="Solace" className="w-7 h-7 rounded-lg object-contain" />
                <span className="text-sm font-semibold text-stone-100">添加至 iPhone 主屏幕</span>
              </div>
              <button
                onClick={() => setShowIosGuide(false)}
                className="text-stone-400 hover:text-stone-200 p-1 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3.5 my-4 text-xs text-stone-300 leading-relaxed">
              <div className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-stone-800 text-stone-300 flex items-center justify-center text-[11px] font-bold flex-shrink-0 mt-0.5">
                  1
                </span>
                <span>
                  点击 Safari 底部栏正中央的 <span className="text-stone-100 font-semibold underline">「分享」</span> 图标（方框带向上箭头）。
                </span>
              </div>
              <div className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-stone-800 text-stone-300 flex items-center justify-center text-[11px] font-bold flex-shrink-0 mt-0.5">
                  2
                </span>
                <span>
                  在菜单面板中向下滚动，找到并轻点 <span className="text-stone-100 font-semibold underline">「添加到主屏幕」</span>。
                </span>
              </div>
              <div className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-stone-800 text-stone-300 flex items-center justify-center text-[11px] font-bold flex-shrink-0 mt-0.5">
                  3
                </span>
                <span>
                  点击右上角 <span className="text-[#d97c62] font-semibold">「添加」</span>，即可像原生 App 一样直接从桌面全屏启动！
                </span>
              </div>
            </div>

            <button
              onClick={() => setShowIosGuide(false)}
              className="w-full py-2.5 rounded-xl text-xs font-medium text-white bg-gradient-to-r from-[#d97c62] to-[#b85a3c] shadow-sm cursor-pointer"
            >
              我知道了
            </button>
          </div>
        </div>
      )}
    </>
  );
}
