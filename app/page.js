"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import WelcomeOverlay from "@/components/WelcomeOverlay";

// 输入框：白底 + 深色文字 + 中灰占位符 + 聚焦边框反馈
const inputClass =
  "border border-[#d5d9d7] bg-white p-2 text-gray-800 placeholder-gray-500 transition-colors duration-150 focus:outline-none focus:border-[#8fb3c7] focus:ring-1 focus:ring-[#8fb3c7]";

const tabClass = (active) =>
  `px-4 py-2 border-b-2 transition-colors duration-200 ${
    active
      ? "text-slate-900 font-bold border-[#7fa3b8]"
      : "text-slate-400 font-normal border-transparent hover:text-slate-600"
  }`;

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

  // 登录成功后先显示全屏欢迎过渡页，点击按钮才进入 /chat
  const [showWelcome, setShowWelcome] = useState(false);

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

  // 已经登录的话直接进聊天页（客户端跳转，不刷新）
  useEffect(() => {
    let alive = true;
    fetch("/api/auth/session", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (alive && data?.user) router.push("/chat");
      })
      .catch(() => {});
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

  function showMessage(text, type) {
    setMessage(text);
    setMessageType(type);
  }

  function switchMode(next) {
    setMode(next);
    showMessage("", "");
  }

  async function handleSendCode() {
    const target = email.trim();
    if (!target) {
      showMessage("请先填写邮箱", "error");
      return;
    }

    setSending(true);
    showMessage("", "");
    try {
      const data = await apiRequest("/api/auth/send-code", {
        method: "POST",
        body: { email: target },
      });
      showMessage(data?.message || "验证码已发送，请查收邮箱", "success");
      const cooldown = Number(data?.cooldownSeconds);
      setCountdown(Number.isFinite(cooldown) && cooldown > 0 ? cooldown : 60);
    } catch (err) {
      showMessage(err.message || "验证码发送失败", "error");
    } finally {
      setSending(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (loading) return;

    setMessage("");
    setMessageType("");
    setLoading(true);

    try {
      if (mode === "code") {
        const data = await apiRequest("/api/auth/verify", {
          method: "POST",
          body: { email: email.trim(), code: code.trim() },
        });
        showMessage(data?.created ? "账号已创建" : "登录成功", "success");
      } else {
        await apiRequest("/api/auth/login", {
          method: "POST",
          body: { account: account.trim(), password },
        });
        showMessage("登录成功", "success");
      }
      setShowWelcome(true);
    } catch (err) {
      showMessage("登录失败：" + err.message, "error");
    }

    setLoading(false);
  }

  // ===== 忘记密码 =====
  function openReset() {
    setResetStep("send");
    setResetEmail("");
    setResetCode("");
    setNewPassword("");
    setConfirmPassword("");
    setResetError("");
    setResetBusy(false);
    setResetCountdown(0);
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

  // 第二步里「重新发送验证码」：邮箱已确认，直接再发一次
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

  // 重置成功：关闭弹窗，切到账号密码登录并预填邮箱
  function handleResetDone() {
    setShowReset(false);
    switchMode("password");
    setAccount(resetEmail.trim());
    setPassword("");
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-[#fafaf8] text-slate-800">
      <h1 className="text-6xl font-bold tracking-tight mb-2">Solace</h1>
      <p className="text-lg text-gray-500 mb-8">
        给每一个不想说话的灵魂，一点慰藉。
      </p>

      <div className="flex mb-4 border-b border-[#e0e2df]">
        <button
          type="button"
          onClick={() => switchMode("code")}
          className={`${tabClass(mode === "code")} mr-2`}
        >
          邮箱验证码
        </button>
        <button
          type="button"
          onClick={() => switchMode("password")}
          className={tabClass(mode === "password")}
        >
          账号密码
        </button>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3 w-72">
        {mode === "code" ? (
          <>
            <input
              type="email"
              placeholder="邮箱"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className={inputClass}
            />

            <div className="flex gap-2">
              <input
                inputMode="numeric"
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
                className="shrink-0 w-[96px] border border-[#d5d9d7] bg-[#fdfdfc] p-2 text-sm text-slate-700 hover:bg-gray-200 hover:text-slate-900 active:bg-[#dbe6ea] active:scale-[0.98] transition-colors transition-transform duration-150 disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed"
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
            <input
              type="password"
              placeholder="密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              className={inputClass}
            />
          </>
        )}

        <button
          type="submit"
          disabled={loading}
          className="border border-[#d5d9d7] bg-[#fdfdfc] p-2 text-slate-700 hover:bg-gray-200 hover:text-slate-900 active:bg-[#dbe6ea] active:scale-[0.98] transition-colors transition-transform duration-150 disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed"
        >
          {loading ? "处理中..." : "进入 Solace"}
        </button>
      </form>

      {message && (
        <p
          className={`mt-4 text-sm text-center w-72 ${
            messageType === "success" ? "text-green-600" : "text-red-600"
          }`}
        >
          {message}
        </p>
      )}

      <p className="mt-6 text-xs text-gray-400 text-center w-72">
        {mode === "code" ? (
          "首次登录会自动为你创建账号，不需要单独注册"
        ) : (
          <>
            账号由管理员分配；
            <button
              type="button"
              onClick={openReset}
              className="text-[#7fa3b8] hover:text-[#5d88a3] hover:underline transition-colors"
            >
              忘记密码
            </button>
          </>
        )}
      </p>

      {/* 全屏欢迎过渡页：点击「开始我们的故事」后才跳转 /chat */}
      {showWelcome && (
        <WelcomeOverlay onFinish={() => router.push("/chat")} />
      )}

      {/* 忘记密码弹窗：三步（发码 → 验证码+新密码 → 成功） */}
      {showReset && (
        <div
          className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50"
          onClick={resetStep === "done" ? undefined : closeReset}
        >
          <div
            className="bg-white rounded-2xl shadow-xl border border-[#e8eae7] p-5 w-80 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-bold text-slate-800 mb-1">找回密码</h2>

            {resetStep === "send" && (
              <>
                <p className="text-xs text-slate-400 mb-4 leading-5">
                  输入你注册时使用的邮箱，我们会发送验证码到该邮箱。
                </p>
                <input
                  type="email"
                  placeholder="注册邮箱"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  className={inputClass}
                  autoFocus
                />
                {resetError && (
                  <p className="mt-2 text-xs text-red-600 leading-5">{resetError}</p>
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
                    className="border border-[#e8b4a0] bg-[#f5b8a0] text-white rounded-lg px-4 py-2 text-sm hover:bg-[#f0a48a] hover:scale-[1.02] active:scale-[0.98] shadow-sm transition-all duration-150 disabled:bg-[#f3cdbf] disabled:border-[#f3cdbf] disabled:cursor-not-allowed disabled:hover:scale-100"
                  >
                    {resetBusy ? "发送中" : "发送验证码"}
                  </button>
                </div>
              </>
            )}

            {resetStep === "reset" && (
              <>
                <p className="text-xs text-slate-400 mb-4 leading-5">
                  验证码已发送至
                  <span className="text-slate-600"> {resetEmail} </span>
                  <button
                    type="button"
                    onClick={() => setResetStep("send")}
                    className="text-[#7fa3b8] hover:underline"
                  >
                    （更换邮箱）
                  </button>
                </p>
                <div className="flex flex-col gap-2">
                  <input
                    inputMode="numeric"
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
                    placeholder="新密码（至少 6 位）"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className={inputClass}
                  />
                  <input
                    type="password"
                    placeholder="确认新密码"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className={inputClass}
                  />
                </div>
                {resetError && (
                  <p className="mt-2 text-xs text-red-600 leading-5">{resetError}</p>
                )}
                <div className="flex gap-2 justify-between items-center mt-5">
                  <button
                    type="button"
                    onClick={handleResendResetCode}
                    disabled={resetBusy || resetCountdown > 0}
                    className="text-xs text-[#7fa3b8] hover:text-[#5d88a3] hover:underline disabled:text-gray-400 disabled:no-underline disabled:cursor-not-allowed transition-colors"
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
                      className="border border-[#e8b4a0] bg-[#f5b8a0] text-white rounded-lg px-4 py-2 text-sm hover:bg-[#f0a48a] hover:scale-[1.02] active:scale-[0.98] shadow-sm transition-all duration-150 disabled:bg-[#f3cdbf] disabled:border-[#f3cdbf] disabled:cursor-not-allowed disabled:hover:scale-100"
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
                    className="border border-[#e8b4a0] bg-[#f5b8a0] text-white rounded-lg px-4 py-2 text-sm hover:bg-[#f0a48a] hover:scale-[1.02] active:scale-[0.98] shadow-sm transition-all duration-150"
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
