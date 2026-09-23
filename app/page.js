"use client";

import { useEffect, useState } from "react";
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

  // 已经登录的话直接进聊天页
  useEffect(() => {
    let alive = true;
    fetch("/api/auth/session", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (alive && data?.user) window.location.href = "/chat";
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

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
        {mode === "code"
          ? "首次登录会自动为你创建账号，不需要单独注册"
          : "账号由管理员分配；忘记密码请联系管理员"}
      </p>

      {/* 全屏欢迎过渡页：点击「开始我们的故事」后才跳转 /chat */}
      {showWelcome && (
        <WelcomeOverlay onFinish={() => (window.location.href = "/chat")} />
      )}
    </div>
  );
}
