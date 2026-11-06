"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// 输入框：浅灰底 + 圆角（不再有生硬边框），聚焦时提亮为白底
// ⚠️ Placeholder 用 slate-600：WCAG 对比度在 #f6f3f1 底上 ≈ 7:1（slate-400/500 都不到 4.5）
// ⚠️ 聚焦光圈改成聊天页的蓝灰 #60A5FA（半透明）：暖桃色里掺一点冷色，两页过渡不突兀
const inputClass =
  "w-full rounded-xl border border-transparent bg-[#f6f3f1] dark:bg-[#1A1614] dark:border-[#382F28] px-4 py-2.5 text-[15px] text-gray-800 dark:text-[#F5DCD3] placeholder-slate-500 dark:placeholder-[#8C7B73] transition-all duration-150 focus:outline-none focus:bg-white dark:focus:bg-[#231D1A] focus:border-[#a9c3d6] dark:focus:border-[#b85a3c] focus:ring-2 focus:ring-[#60A5FA]/20 dark:focus:ring-[#b85a3c]/20";

const tabClass = (active) =>
  `px-4 py-2.5 text-sm border-b-2 transition-colors duration-200 ${
    active
      ? "text-slate-800 dark:text-[#F5DCD3] font-semibold border-[#e2a68c]"
      : "text-slate-500 dark:text-[#8C7B73] font-normal border-transparent hover:text-slate-700 dark:hover:text-[#EDE5DF]"
  }`;

// 暖言三态：idle 常态 / blink 眨眼（密码框聚焦时也用它）/ sad 出错
const WARM_IMAGES = {
  idle: "/stickers/warm_idle.png",
  blink: "/stickers/warm_blink.png",
  sad: "/stickers/warm_sad.png",
};

async function apiRequest(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) throw new Error(data?.error || `请求失败（HTTP ${res.status}）`);
  return data || {};
}

export default function Home() {
  const router = useRouter();
  // "code" = 邮箱验证码登录（首次登录自动建号）；"password" = 账号密码登录（管理员分配）
  const [mode, setMode] = useState("code");

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");

  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState(""); // "success" | "error"
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);

  // 暖言表情状态机：ambientBlink = 每 3~5 秒自动眨一下；
  // passwordFocused = 密码框聚焦时闭眼；sad = 出错（优先级最高）。
  const [ambientBlink, setAmbientBlink] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);
  const [sad, setSad] = useState(false);
  const [bubble, setBubble] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const bubbleTimer = useRef(null);

  // 登录态检查中：session 接口返回前渲染纯色加载页，不渲染登录表单
  const [checking, setChecking] = useState(true);

  // 「忘记密码」弹窗：step = "send"(发验证码) / "reset"(填验证码+新密码) / "done"(成功)
  const [showReset, setShowReset] = useState(false);
  const [resetStep, setResetStep] = useState("send");
  const [resetEmail, setResetEmail] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [resetError, setResetError] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetCountdown, setResetCountdown] = useState(0);

  // 已经登录的话直接进聊天页（客户端跳转，不刷新）；确认未登录才显示登录表单
  useEffect(() => {
    let alive = true;
    fetch("/api/auth/session", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!alive) return;
        if (data?.user) {
          router.push("/chat");
        } else {
          setChecking(false);
        }
      })
      .catch(() => {
        // 网络异常时放开表单，用户仍可尝试登录
        if (alive) setChecking(false);
      });
    return () => {
      alive = false;
    };
  }, [router]);

  // 读取跳转提示（如邮箱修改后需要重新登录）
  useEffect(() => {
    const hint = sessionStorage.getItem("solace_login_hint");
    if (hint) {
      setMessage(hint);
      setMessageType("success");
      sessionStorage.removeItem("solace_login_hint");
    }
  }, []);

  // 「获取验证码」之后的倒计时
  useEffect(() => {
    if (countdown <= 0) return undefined;
    const timer = setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  // 找回密码弹窗里「重新发送」的倒计时
  useEffect(() => {
    if (resetCountdown <= 0) return undefined;
    const timer = setTimeout(() => setResetCountdown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [resetCountdown]);

  // 自动眨眼：每 3~5 秒闭眼 1.5 秒，然后继续下一次随机等待。
  useEffect(() => {
    let blinkTimer;
    let restoreTimer;
    let cancelled = false;

    const schedule = () => {
      blinkTimer = setTimeout(() => {
        if (cancelled) return;
        setAmbientBlink(true);
        restoreTimer = setTimeout(() => {
          if (cancelled) return;
          setAmbientBlink(false);
          schedule();
        }, 1500);
      }, 3000 + Math.random() * 2000);
    };

    schedule();
    return () => {
      cancelled = true;
      clearTimeout(blinkTimer);
      clearTimeout(restoreTimer);
    };
  }, []);

  useEffect(
    () => () => {
      if (bubbleTimer.current) clearTimeout(bubbleTimer.current);
    },
    []
  );

  // 三张立绘各 ~300KB：先预取，避免第一次眨眼时换图闪白
  useEffect(() => {
    Object.values(WARM_IMAGES).forEach((src) => {
      const img = new window.Image();
      img.src = src;
    });
  }, []);

  // 气泡台词：定时自动收起；再来一句会打断上一句的计时
  function say(text, duration = 4000) {
    if (bubbleTimer.current) clearTimeout(bubbleTimer.current);
    setBubble(text);
    bubbleTimer.current = setTimeout(() => setBubble(""), duration);
  }

  function silence() {
    if (bubbleTimer.current) clearTimeout(bubbleTimer.current);
    setBubble("");
  }

  // 表情优先级：出错 > 闭眼 > 常态
  const warmMood = sad ? "sad" : passwordFocused || ambientBlink ? "blink" : "idle";

  function showMessage(text, type) {
    setMessage(text);
    setMessageType(type);
  }

  function switchMode(next) {
    setMode(next);
    showMessage("", "");
    setSad(false);
    silence();
  }

  async function handleSendCode() {
    if (!email) {
      showMessage("请先填写邮箱", "error");
      setSad(true);
      say("还没写邮箱呢");
      return;
    }
    setSending(true);
    showMessage("", "");
    try {
      const data = await apiRequest("/api/auth/send-code", {
        method: "POST",
        body: { email },
      });
      showMessage(data.message || "验证码已发送至你的邮箱", "success");
      const cd = Number(data.cooldownSeconds);
      setCountdown(Number.isFinite(cd) && cd > 0 ? cd : 60);
      setSad(false);
      say("去邮箱看看吧");
    } catch (err) {
      showMessage(err.message || "验证码发送失败", "error");
      setSad(true);
      say("刚才没发成功");
    } finally {
      setSending(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    showMessage("", "");

    try {
      if (mode === "code") {
        if (!email || !code) {
          throw new Error("请填写邮箱和验证码");
        }
        await apiRequest("/api/auth/verify", {
          method: "POST",
          body: { email, code },
        });
      } else {
        if (!account || !password) {
          throw new Error("请填写账号和密码");
        }
        await apiRequest("/api/auth/login", {
          method: "POST",
          body: { account, password },
        });
      }

      setSad(false);
      say("欢迎回来！");
      router.push("/chat");
    } catch (err) {
      showMessage(err.message || "登录失败，请重试", "error");
      setSad(true);
      say(err.message ? "好像哪里不对" : "登录没成功");
    } finally {
      setLoading(false);
    }
  }

  function openReset() {
    setResetStep("send");
    setResetEmail(account.includes("@") ? account : "");
    setResetCode("");
    setNewPassword("");
    setConfirmPassword("");
    setResetError("");
    setShowReset(true);
  }

  function closeReset() {
    setShowReset(false);
  }

  async function handleSendResetCode() {
    const target = resetEmail.trim();
    if (!target) {
      setResetError("请先填写注册邮箱");
      return;
    }
    setResetBusy(true);
    setResetError("");
    try {
      const data = await apiRequest("/api/auth/send-reset-code", {
        method: "POST",
        body: { email: target },
      });
      setResetStep("reset");
      const cooldown = Number(data?.cooldownSeconds);
      setResetCountdown(Number.isFinite(cooldown) && cooldown > 0 ? cooldown : 60);
    } catch (err) {
      setResetError(err.message || "验证码发送失败");
    } finally {
      setResetBusy(false);
    }
  }

  async function handleResendResetCode() {
    setResetBusy(true);
    setResetError("");
    try {
      const data = await apiRequest("/api/auth/send-reset-code", {
        method: "POST",
        body: { email: resetEmail.trim() },
      });
      const cooldown = Number(data?.cooldownSeconds);
      setResetCountdown(Number.isFinite(cooldown) && cooldown > 0 ? cooldown : 60);
    } catch (err) {
      setResetError(err.message || "验证码发送失败");
    } finally {
      setResetBusy(false);
    }
  }

  async function handleResetPassword() {
    if (!resetCode.trim()) {
      setResetError("请输入邮箱收到的验证码");
      return;
    }
    if (newPassword.length < 6) {
      setResetError("新密码至少需要 6 位");
      return;
    }
    if (newPassword !== confirmPassword) {
      setResetError("两次输入的密码不一致");
      return;
    }

    setResetBusy(true);
    setResetError("");
    try {
      await apiRequest("/api/auth/reset-password", {
        method: "POST",
        body: {
          email: resetEmail.trim(),
          code: resetCode.trim(),
          password: newPassword,
        },
      });
      setResetStep("done");
    } catch (err) {
      setResetError(err.message || "密码重置失败");
    } finally {
      setResetBusy(false);
    }
  }

  function handleResetDone() {
    setShowReset(false);
    switchMode("password");
    setAccount(resetEmail.trim());
    setPassword("");
  }

  // 登录态检查中：纯色加载页
  if (checking) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#fafaf8] text-slate-800">
        <div className="flex flex-col items-center gap-3">
          <img src="/logo.png" alt="Solace" className="w-12 h-12 object-contain animate-pulse" />
          <span className="font-display text-2xl font-bold text-[#4a7791]">Solace</span>
          <span className="text-sm text-slate-500">加载中…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-gradient-to-br from-[#FFF8F5] via-[#FCF8F6] to-[#F0F4F8] text-slate-800">
      {/* 纯 CSS 装饰：两团柔光，替代图片背景 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-24 -top-32 h-[420px] w-[420px] rounded-full bg-[#FBE4DA]/60 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-40 -right-24 h-[460px] w-[460px] rounded-full bg-[#CFE0F5]/60 blur-3xl"
      />
      {/* 右下角掺一点聊天页的蓝灰 #60A5FA：暖桃 → 蓝灰的过渡 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-16 right-[28%] h-[220px] w-[220px] rounded-full bg-[#60A5FA]/10 blur-3xl"
      />

      <style jsx>{`
        .warm-float {
          animation: warm-float 6s ease-in-out infinite;
          will-change: transform;
        }
        @keyframes warm-float {
          0%,
          100% {
            transform: translateY(0) scale(1);
          }
          50% {
            transform: translateY(-14px) scale(1.015);
          }
        }
        .glass-card {
          box-shadow: 0 24px 60px -28px rgba(184, 133, 118, 0.45),
            0 2px 10px rgba(150, 140, 132, 0.06);
        }
        @media (prefers-reduced-motion: reduce) {
          .warm-float {
            animation: none;
          }
        }
      `}</style>

      {/* 左上角：回首页 */}
      <a
        href="/"
        className="absolute left-5 top-5 z-20 flex items-center gap-1.5 rounded-full bg-white/60 px-3.5 py-1.5 text-xs text-slate-600 backdrop-blur-sm transition-colors duration-150 hover:bg-white/90 hover:text-slate-800 sm:left-6 sm:top-6"
      >
        <span>←</span>
        <span>返回首页</span>
      </a>

      <div className="relative flex min-h-screen flex-col lg:flex-row">
        {/* 左：人物展示 */}
        <section className="flex flex-col items-center justify-center px-6 pb-1 pt-6 sm:pt-10 lg:w-[55%] lg:py-0">
          <div className="flex h-6 items-center justify-center">
            {bubble && (
              <span
                role="status"
                aria-live="polite"
                className="rounded-full bg-white/85 px-3 py-1 text-[11px] leading-none text-slate-700 shadow-sm backdrop-blur-sm"
              >
                {bubble}
              </span>
            )}
          </div>

          <div className="warm-float">
            <img
              src={WARM_IMAGES[warmMood]}
              alt="暖言"
              draggable={false}
              className="h-[120px] max-h-[120px] w-auto select-none object-contain sm:h-[170px] sm:max-h-[170px] lg:h-[330px] lg:max-h-[46vh]"
            />
          </div>
          <p className="mt-3 text-[13px] tracking-[0.32em] text-slate-600 lg:mt-6 lg:text-sm">
            暖言，你的温柔陪伴者
          </p>
        </section>

        {/* 右：玻璃拟物化登录卡片 */}
        <section className="flex flex-1 items-center justify-center px-5 pb-8 pt-2 sm:pb-14 lg:w-[45%] lg:flex-none lg:px-10 lg:py-0">
          <div className="glass-card w-full max-w-[400px] rounded-[20px] border border-white/70 bg-white/70 p-6 backdrop-blur-[10px] sm:p-8">
            {/* 卡片头部：精巧比例的 Logo 与官方艺术字 Solace */}
            <div className="mb-5 text-center flex flex-col items-center">
              <img
                src="/logo.png"
                alt="Solace Logo"
                className="w-12 h-12 object-contain drop-shadow-xs mb-1"
              />
              <img
                src="/solace-wordmark.png"
                alt="Solace"
                className="h-8 w-auto object-contain mt-0.5"
                style={{ height: "30px", width: "auto" }}
              />
            </div>

            <div
              role="tablist"
              aria-label="登录方式"
              className="mb-5 flex justify-center border-b border-[#ece7e3]"
            >
              <button
                type="button"
                role="tab"
                aria-selected={mode === "code"}
                onClick={() => switchMode("code")}
                className={`${tabClass(mode === "code")} mr-2`}
              >
                邮箱验证码
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "password"}
                onClick={() => switchMode("password")}
                className={tabClass(mode === "password")}
              >
                账号密码
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              {mode === "code" ? (
                <>
                  <input
                    type="email"
                    placeholder="邮箱"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    required
                    className={inputClass}
                  />

                  <div className="flex gap-2">
                    <input
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="邮箱验证码"
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
                      required
                      className={`${inputClass} flex-1 min-w-0`}
                    />
                    <button
                      type="button"
                      onClick={handleSendCode}
                      disabled={sending || countdown > 0}
                      className="shrink-0 w-[104px] rounded-xl border border-[#e5b9a5] dark:border-[#523A30] bg-[#fdf3ee] dark:bg-[#2A221D] px-2 py-2.5 text-sm text-[#9a5540] dark:text-[#EFA896] transition-all duration-150 hover:bg-[#fbe8df] dark:hover:bg-[#352923] active:scale-[0.98] disabled:bg-[#f7f4f2] dark:disabled:bg-[#201B18] disabled:border-[#eee7e2] dark:disabled:border-[#332A24] disabled:text-gray-500 dark:disabled:text-[#6E5D55] disabled:cursor-not-allowed disabled:active:scale-100"
                    >
                      {countdown > 0 ? `${countdown} 秒` : sending ? "发送中" : "获取验证码"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <input
                    placeholder="账号或邮箱"
                    value={account}
                    onChange={(e) => setAccount(e.target.value)}
                    autoComplete="username"
                    required
                    className={inputClass}
                  />
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      placeholder="密码"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      required
                      onFocus={() => {
                        if (bubbleTimer.current) clearTimeout(bubbleTimer.current);
                        setPasswordFocused(true);
                        setBubble("我闭上眼睛啦");
                      }}
                      onBlur={() => {
                        setPasswordFocused(false);
                        setBubble((current) => (current === "我闭上眼睛啦" ? "" : current));
                      }}
                      className={`${inputClass} pr-11`}
                    />
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setShowPassword((value) => !value)}
                      aria-label={showPassword ? "隐藏密码" : "显示密码"}
                      aria-pressed={showPassword}
                      className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-slate-600 dark:text-[#9A8B83] transition-colors hover:bg-[#ece7e3] dark:hover:bg-[#2A231F] hover:text-slate-800 dark:hover:text-[#F5DCD3] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]/50"
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className="h-5 w-5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        {showPassword ? (
                          <>
                            <path d="M3 3l18 18" />
                            <path d="M10.6 6.1A9.9 9.9 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3.2 3.9" />
                            <path d="M6.1 6.9A16.6 16.6 0 0 0 2.5 12S6 18.5 12 18.5c1 0 2-.2 2.9-.6" />
                            <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
                          </>
                        ) : (
                          <>
                            <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
                            <circle cx="12" cy="12" r="2.8" />
                          </>
                        )}
                      </svg>
                    </button>
                  </div>
                </>
              )}

              <button
                type="submit"
                disabled={loading}
                className="mt-1 w-full rounded-xl border border-[#b85a3c] bg-[#b85a3c] py-2.5 text-sm font-medium text-white shadow-[0_10px_24px_-14px_rgba(96,165,250,0.45)] transition-all duration-150 hover:border-[#a34f33] hover:bg-[#a34f33] hover:scale-[1.01] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]/50 active:scale-[0.99] disabled:cursor-not-allowed disabled:border-[#d8b3a7] disabled:bg-[#d8b3a7] disabled:hover:scale-100"
              >
                {loading ? "处理中..." : "进入 Solace"}
              </button>
            </form>

            {message && (
              <p
                aria-live="polite"
                className={`mt-4 text-center text-sm ${
                  messageType === "success" ? "text-green-700" : "text-red-600"
                }`}
              >
                {message}
              </p>
            )}

            <p className="mt-6 text-center text-xs text-slate-600">
              {mode === "code" ? (
                "首次登录会自动为你创建账号，不需要单独注册"
              ) : (
                <button
                  type="button"
                  onClick={openReset}
                  className="text-[#9a5540] hover:text-[#7f422f] hover:underline transition-colors"
                >
                  忘记密码？
                </button>
              )}
            </p>
          </div>
        </section>
      </div>

      {/* 忘记密码弹窗 */}
      {showReset && (
        <div
          className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 px-4"
          onClick={resetStep === "done" ? undefined : closeReset}
        >
          <div
            className="bg-white rounded-2xl shadow-xl border border-[#e8eae7] p-5 w-80 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-bold text-slate-800 mb-1">找回密码</h2>

            {resetStep === "send" && (
              <>
                <p className="text-xs text-slate-600 mb-4 leading-5">
                  输入你注册时使用的邮箱，我们会发送验证码到该邮箱。
                </p>
                <input
                  type="email"
                  autoComplete="email"
                  placeholder="注册邮箱"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  className={inputClass}
                  autoFocus
                />
                {resetError && (
                  <p aria-live="polite" className="mt-2 text-xs text-red-600 leading-5">
                    {resetError}
                  </p>
                )}
                <div className="flex gap-2 justify-end mt-5">
                  <button
                    type="button"
                    onClick={closeReset}
                    className="border border-[#d5d9d7] bg-[#fdfdfc] text-slate-500 rounded-lg px-4 py-2 text-sm hover:bg-[#eef1f2] hover:text-slate-700 active:scale-[0.98] transition-all duration-150"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleSendResetCode}
                    disabled={resetBusy}
                    className="border border-[#b85a3c] bg-[#b85a3c] text-white rounded-lg px-4 py-2 text-sm hover:bg-[#a34f33] hover:border-[#a34f33] hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]/50 active:scale-[0.98] shadow-sm transition-all duration-150 disabled:bg-[#d8b3a7] disabled:border-[#d8b3a7] disabled:cursor-not-allowed disabled:hover:scale-100"
                  >
                    {resetBusy ? "发送中" : "发送验证码"}
                  </button>
                </div>
              </>
            )}

            {resetStep === "reset" && (
              <>
                <p className="text-xs text-slate-600 mb-4 leading-5">
                  验证码已发送至
                  <span className="text-slate-600"> {resetEmail} </span>
                  <button
                    type="button"
                    onClick={() => setResetStep("send")}
                    className="text-[#3f6f8c] hover:underline"
                  >
                    （更换邮箱）
                  </button>
                </p>
                <div className="flex flex-col gap-2">
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="邮箱验证码"
                    value={resetCode}
                    onChange={(e) =>
                      setResetCode(e.target.value.replace(/\D/g, "").slice(0, 8))
                    }
                    className={inputClass}
                    autoFocus
                  />
                  <input
                    type="password"
                    autoComplete="new-password"
                    placeholder="新密码（至少 6 位）"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className={inputClass}
                  />
                  <input
                    type="password"
                    autoComplete="new-password"
                    placeholder="确认新密码"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className={inputClass}
                  />
                </div>
                {resetError && (
                  <p aria-live="polite" className="mt-2 text-xs text-red-600 leading-5">
                    {resetError}
                  </p>
                )}
                <div className="flex gap-2 justify-between items-center mt-5">
                  <button
                    type="button"
                    onClick={handleResendResetCode}
                    disabled={resetBusy || resetCountdown > 0}
                    className="text-xs text-[#3f6f8c] hover:text-[#2f5b74] hover:underline disabled:text-gray-500 disabled:no-underline disabled:cursor-not-allowed transition-colors"
                  >
                    {resetCountdown > 0 ? `重新发送（${resetCountdown} 秒）` : "重新发送验证码"}
                  </button>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={closeReset}
                      className="border border-[#d5d9d7] bg-[#fdfdfc] text-slate-500 rounded-lg px-4 py-2 text-sm hover:bg-[#eef1f2] hover:text-slate-700 active:scale-[0.98] transition-all duration-150"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={handleResetPassword}
                      disabled={resetBusy}
                      className="border border-[#b85a3c] bg-[#b85a3c] text-white rounded-lg px-4 py-2 text-sm hover:bg-[#a34f33] hover:border-[#a34f33] hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]/50 active:scale-[0.98] shadow-sm transition-all duration-150 disabled:bg-[#d8b3a7] disabled:border-[#d8b3a7] disabled:cursor-not-allowed disabled:hover:scale-100"
                    >
                      {resetBusy ? "提交中" : "确认重置"}
                    </button>
                  </div>
                </div>
              </>
            )}

            {resetStep === "done" && (
              <>
                <div className="flex items-center gap-2 mt-3 mb-2">
                  <span className="flex items-center justify-center w-8 h-8 rounded-full bg-green-100 text-green-600 text-base">
                    ✓
                  </span>
                  <p className="text-sm text-slate-700 leading-6">
                    密码已重置，请用新密码登录。
                  </p>
                </div>
                <div className="flex justify-end mt-4">
                  <button
                    type="button"
                    onClick={handleResetDone}
                    className="border border-[#b85a3c] bg-[#b85a3c] text-white rounded-lg px-4 py-2 text-sm hover:bg-[#a34f33] hover:border-[#a34f33] hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]/50 active:scale-[0.98] shadow-sm transition-all duration-150"
                  >
                    返回登录
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
