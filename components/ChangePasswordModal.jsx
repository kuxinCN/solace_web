"use client";

/**
 * 修改密码弹窗（「我的 → 设置」用）
 *
 * 五个输入框（按产品要求）：
 *   ① 原密码
 *   ② 绑定邮箱 —— 只读，输入框**上方**用掩码显示（如 ab***@qq.com）；
 *      右侧「发送验证码」按钮**只有在邮箱格式正确时可点**，否则置灰
 *   ③ 验证码
 *   ④ 新密码
 *   ⑤ 重复新密码
 *
 * 五项全部合法时，「确认修改」才可点；不满足就置灰。
 * 底部两个按钮：取消 / 确认修改。
 */
import { useEffect, useState } from "react";

/** 邮箱掩码：abc@qq.com → ab***@qq.com */
function maskEmail(email) {
  const value = String(email || "").trim();
  const at = value.indexOf("@");
  if (at <= 0) return value;
  const name = value.slice(0, at);
  const domain = value.slice(at);
  if (name.length <= 2) return name.slice(0, 1) + "***" + domain;
  return name.slice(0, 2) + "***" + domain;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ChangePasswordModal({ open, onClose, apiRequest, boundEmail = "" }) {
  const [oldPassword, setOldPassword] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // 每次打开重置表单
  useEffect(() => {
    if (!open) return;
    setOldPassword("");
    // ⚠️ 邮箱**不自动填** —— 需要用户自己确认一遍绑定邮箱；
    //    上方会用掩码显示（如 ab***@qq.com）作为提示
    setEmail("");
    setCode("");
    setPassword("");
    setConfirmPassword("");
    setError("");
    setNotice("");
    setCooldown(0);
  }, [open, boundEmail]);

  // 发送冷却倒计时
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((v) => v - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  if (!open) return null;

  const emailInput = email.trim().toLowerCase();
  const bound = String(boundEmail || "").trim().toLowerCase();
  const emailValid = EMAIL_PATTERN.test(emailInput);
  // ⚠️ 必须是**当前账号绑定的那个邮箱**才能发验证码。
  //    以前只校验格式，用户填了别的邮箱还能点「发送验证码」，
  //    服务端才回"该邮箱尚未注册" —— 属于让用户白跑一趟，体验很差。
  //    拿不到 boundEmail 时（接口异常）退回只校验格式，保证功能还能用。
  const emailMatched = bound ? emailInput === bound : true;
  const canSendByEmail = emailValid && emailMatched;

  // 五项全部合法才允许提交
  const canSubmit =
    oldPassword.length > 0 &&
    canSendByEmail &&
    code.trim().length > 0 &&
    password.length >= 6 &&
    password.length <= 64 &&
    password === confirmPassword;

  const canSendCode = canSendByEmail && !sending && cooldown <= 0 && !busy;

  async function handleSendCode() {
    if (!canSendCode) return;
    setSending(true);
    setError("");
    setNotice("");
    try {
      const result = await apiRequest("/api/auth/send-reset-code", {
        method: "POST",
        body: { email: email.trim() },
      });
      setNotice(result?.message || "验证码已发送，请查收邮箱");
      setCooldown(Number(result?.cooldownSeconds) || 60);
    } catch (err) {
      setError("发送失败：" + err.message);
    } finally {
      setSending(false);
    }
  }

  async function handleSubmit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await apiRequest("/api/user/password", {
        method: "PUT",
        body: {
          oldPassword,
          email: email.trim(),
          code: code.trim(),
          password,
          confirmPassword,
        },
      });
      setNotice(result?.message || "密码修改成功");
      setTimeout(() => onClose?.(), 900);
    } catch (err) {
      setError("修改失败：" + err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[78] flex items-center justify-center bg-black/30 px-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
        <h3 className="text-sm font-bold text-slate-800">修改密码</h3>
        <p className="mt-1 text-[11px] text-slate-400">
          需要验证原密码和绑定邮箱，五项都填对才能提交
        </p>

        {error ? (
          <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>
        ) : null}
        {notice ? (
          <div className="mt-3 rounded-lg bg-[#eef4f1] px-3 py-2 text-xs text-slate-700">
            {notice}
          </div>
        ) : null}

        <div className="mt-3 space-y-3">
          {/* ① 原密码 */}
          <div>
            <label className="mb-1 block text-xs text-slate-500">原密码</label>
            <input
              type="password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              className="w-full rounded-lg border border-[#d5d9d7] bg-[#fdfdfc] px-3 py-2 text-sm outline-none focus:border-[#a9c6da]"
              placeholder="当前正在使用的密码"
              autoComplete="current-password"
            />
          </div>

          {/* ② 绑定邮箱：上方掩码提示 + 右侧发送按钮 */}
          <div>
            <label className="mb-1 block text-xs text-slate-500">
              绑定邮箱
              {boundEmail ? (
                <span className="ml-1 text-slate-400">（{maskEmail(boundEmail)}）</span>
              ) : null}
            </label>
            <div className="flex gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-[#d5d9d7] bg-[#fdfdfc] px-3 py-2 text-sm outline-none focus:border-[#a9c6da]"
                placeholder={
                  boundEmail ? `请输入 ${maskEmail(boundEmail)} 对应的完整邮箱` : "接收验证码的邮箱"
                }
                autoComplete="email"
              />
              <button
                type="button"
                disabled={!canSendCode}
                onClick={handleSendCode}
                className="shrink-0 rounded-lg border border-[#cfe0e8] bg-[#f2f7fa] px-3 py-2 text-xs text-slate-700 transition-colors hover:bg-[#e8eff2] disabled:cursor-not-allowed disabled:opacity-40"
                title={emailValid ? "发送验证码到这个邮箱" : "请先填写正确的邮箱地址"}
              >
                {sending ? "发送中…" : cooldown > 0 ? `${cooldown}s` : "发送验证码"}
              </button>
            </div>
            {email && !emailValid ? (
              <p className="mt-1 text-[11px] text-slate-400">邮箱格式不正确</p>
            ) : null}
            {emailValid && !emailMatched ? (
              <p className="mt-1 text-[11px] text-amber-600">这不是当前账号绑定的邮箱</p>
            ) : null}
          </div>

          {/* ③ 验证码 */}
          <div>
            <label className="mb-1 block text-xs text-slate-500">验证码</label>
            <input
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full rounded-lg border border-[#d5d9d7] bg-[#fdfdfc] px-3 py-2 text-sm tracking-widest outline-none focus:border-[#a9c6da]"
              placeholder="邮箱收到的 6 位数字"
              autoComplete="one-time-code"
            />
          </div>

          {/* ④ 新密码 */}
          <div>
            <label className="mb-1 block text-xs text-slate-500">新密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-[#d5d9d7] bg-[#fdfdfc] px-3 py-2 text-sm outline-none focus:border-[#a9c6da]"
              placeholder="6-64 位"
              autoComplete="new-password"
            />
          </div>

          {/* ⑤ 重复新密码 */}
          <div>
            <label className="mb-1 block text-xs text-slate-500">重复新密码</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full rounded-lg border border-[#d5d9d7] bg-[#fdfdfc] px-3 py-2 text-sm outline-none focus:border-[#a9c6da]"
              placeholder="再输一次"
              autoComplete="new-password"
            />
            {confirmPassword && password !== confirmPassword ? (
              <p className="mt-1 text-[11px] text-red-500">两次输入不一致</p>
            ) : null}
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg border border-[#d5d9d7] px-3 py-1.5 text-xs text-slate-600 transition-colors hover:bg-[#f2f5f4] disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!canSubmit || busy}
            onClick={handleSubmit}
            className="rounded-lg bg-[#7a9fb5] px-3 py-1.5 text-xs text-white transition-colors hover:bg-[#6b8fa5] disabled:cursor-not-allowed disabled:opacity-40"
            title={canSubmit ? "提交修改" : "五项内容都填写正确后才能提交"}
          >
            {busy ? "修改中…" : "确认修改"}
          </button>
        </div>
      </div>
    </div>
  );
}
