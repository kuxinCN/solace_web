"use client";

import { useCallback, useEffect, useState } from "react";
import NicknameEditor from "@/components/NicknameEditor";
import ImageCropper from "@/components/ImageCropper";
import TrashModal from "@/components/TrashModal";
import ChangePasswordModal from "@/components/ChangePasswordModal";
import { useAvatarUpload } from "@/lib/use-avatar-upload";

async function apiRequest(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw new Error(data?.error || `请求失败（HTTP ${res.status}）`);
  return data || {};
}

// 计算年龄：年份相减，今年生日未到则减 1；闰年由 Date 自动处理
function calcAge(birthDate) {
  const today = new Date();
  const birth = new Date(birthDate);
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

// 格式化生日显示：23岁 · 2002年5月12日；非法则返回"未设置"
function formatBirthday(dateStr) {
  if (!dateStr) return "未设置";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "未设置";
  const age = calcAge(dateStr);
  // 年龄为负或超过 150 视为非法（防止脏数据算出 -16784 这种）
  if (!Number.isFinite(age) || age < 0 || age > 150) return "未设置";
  return `${age}岁 · ${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

// 今日日期字符串 YYYY-MM-DD，用于 input[type=date] 的 max
function todayStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const btnBase =
  "border border-[#d5d9d7] bg-[#fdfdfc] text-slate-700 rounded-lg hover:bg-[#e8eff2] hover:text-slate-900 active:bg-[#dbe6ea] active:scale-[0.98] transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed";

const inputClass =
  "w-full border border-[#d5d9d7] bg-white p-2 text-sm text-gray-800 placeholder-gray-400 rounded-lg transition-colors duration-150 focus:outline-none focus:border-[#8fb3c7] focus:ring-1 focus:ring-[#8fb3c7]";

// 个人资料内容视图：从 ProfileModal 抽取
// props: user, profile, onSaved, onSignOut（onSignOut 仅在未传 hideSignOut 时渲染退出按钮）
// hideSignOut: 退出登录按钮移到页面右栏时传入 true，隐藏卡片内退出按钮
// 签名相关 props（可选）：bioValue/onBioChange/onSaveBio/bioSaving/bioMsg，
// 传入 onSaveBio 时在昵称与性别之间渲染个性签名区块，保存逻辑由父组件提供
export default function ProfileView({
  user,
  profile,
  onSaved,
  onSignOut,
  hideSignOut,
  hideAvatar,
  bioValue,
  onBioChange,
  onSaveBio,
  bioSaving,
  bioMsg,
}) {
  const [gender, setGender] = useState(profile?.gender || "");
  const [birthday, setBirthday] = useState(profile?.birthday || "");
  const [persona, setPersona] = useState(profile?.ai_persona || "");
  const [dangerBusy, setDangerBusy] = useState("");
  // 修改密码弹窗（五项校验 + 邮箱验证码）
  const [pwdAsk, setPwdAsk] = useState(false);
  // 绑定邮箱：给修改密码弹窗做掩码提示用；拿不到也不影响（弹窗里能自己填）
  const boundEmail = String(user?.email || "");
  // 注销账号确认弹窗（自定义，不用 window.prompt）
  const [dangerAsk, setDangerAsk] = useState(false);
  const [dangerInput, setDangerInput] = useState("");
  const [trashOpen, setTrashOpen] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [msg, setMsg] = useState("");

  // 邮箱修改
  const [emailEditing, setEmailEditing] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [emailLoading, setEmailLoading] = useState(false);

  // 密码修改
  const [pwdEditing, setPwdEditing] = useState(false);
  const [newPwd, setNewPwd] = useState("");
  const [pwdLoading, setPwdLoading] = useState(false);

  // 头像上传：复用共享 hook
  const avatar = useAvatarUpload({
    kind: "avatar",
    initialUrl: profile?.avatar_url || "",
    onSaved: () => {
      setMsg("头像更新成功");
      onSaved?.();
    },
    onError: (text) => setMsg(text),
  });

  // profile 变化时同步本地状态
  useEffect(() => {
    setGender(profile?.gender || "");
    setBirthday(profile?.birthday || "");
    setPersona(profile?.ai_persona || "");
  }, [profile]);

  // 保存性别和生日（保存前校验生日合法性）
  async function handleSaveProfile() {
    setMsg("");
    // 生日非空时校验：不能早于 1900-01-01、不能晚于今天
    if (birthday) {
      const d = new Date(birthday);
      if (isNaN(d.getTime())) {
        setMsg("生日日期不合法");
        return;
      }
      if (d < new Date("1900-01-01") || d > new Date()) {
        setMsg("生日需在 1900-01-01 与今天之间");
        return;
      }
    }
    setSavingProfile(true);
    try {
      await apiRequest("/api/user/profile", {
        method: "PUT",
        body: { gender, birthday },
      });
      setMsg("保存成功");
      onSaved?.();
    } catch (err) {
      setMsg("保存失败：" + err.message);
    } finally {
      setSavingProfile(false);
    }
  }

  // 修改邮箱：成功后退出登录并跳转登录页
  async function handleUpdateEmail() {
    const email = newEmail.trim();
    if (!email) {
      setMsg("请输入新邮箱");
      return;
    }
    setEmailLoading(true);
    setMsg("");
    try {
      await apiRequest("/api/user/email", {
        method: "PUT",
        body: { email },
      });
    } catch (err) {
      setMsg("邮箱修改失败：" + err.message);
      return;
    } finally {
      setEmailLoading(false);
    }
    try {
      await apiRequest("/api/auth/logout", { method: "POST" });
    } catch {}
    sessionStorage.setItem(
      "solace_login_hint",
      "邮箱已修改，请用新邮箱重新登录"
    );
    window.location.href = "/login";
  }

  // 修改密码：成功后提示，不退出登录
  async function handleUpdatePassword() {
    if (newPwd.length < 6) {
      setMsg("密码至少 6 位");
      return;
    }
    setPwdLoading(true);
    setMsg("");
    try {
      await apiRequest("/api/user/password", {
        method: "PUT",
        body: { password: newPwd },
      });
      setMsg("密码修改成功");
      setPwdEditing(false);
      setNewPwd("");
    } catch (err) {
      setMsg("密码修改失败：" + err.message);
    } finally {
      setPwdLoading(false);
    }
  }

  // 切换 AI 人格：点一下立即保存（这是高频操作，不再让用户点第二次按钮）
  async function handlePickPersona(next) {
    if (next === persona) return;
    setPersona(next);
    setMsg("");
    try {
      await apiRequest("/api/user/profile", {
        method: "PUT",
        body: { aiPersona: next },
      });
      setMsg(next === "male" ? 'AI 提示词已切换为「他」' : 'AI 提示词已切换为「她」');
      onSaved?.();
    } catch (err) {
      setPersona(profile?.ai_persona || "");
      setMsg("切换失败：" + err.message);
    }
  }

  /**
   * 回收站弹窗用的请求函数：自动带 Cookie，非 2xx 时抛错。
   * 单独定义一个，是为了让 TrashModal 不用关心 fetch 细节。
   */
  const trashRequest = useCallback(async (url, options = {}) => {
    const res = await fetch(url, {
      method: options.method || "GET",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `请求失败（HTTP ${res.status}）`);
    return data || {};
  }, []);

  // 导出我的数据：GET 请求会自动带 Cookie 并触发浏览器下载，不用处理响应
  function handleExportData() {
    window.open("/api/user/export", "_blank");
  }

  /** 点「注销账号」：打开自定义确认弹窗（和站内其他确认框风格一致，不用 window.prompt） */
  function handleDeleteAccount() {
    setDangerAsk(true);
    setDangerInput("");
    setMsg("");
  }

  /** 真正执行注销 */
  async function performDeleteAccount() {
    const word = "注销我的账号";
    if (dangerInput.trim() !== word) {
      setMsg(`请准确输入「${word}」再确认`);
      return;
    }
    setDangerBusy("delete");
    setMsg("");
    try {
      await apiRequest("/api/user/account", {
        method: "DELETE",
        body: { confirm: word },
      });
      sessionStorage.setItem("solace_login_hint", "账号已注销，感谢你曾经来过");
      window.location.href = "/login";
    } catch (err) {
      setMsg("注销失败：" + err.message);
      setDangerBusy("");
    }
  }

  return (
    <div className="flex flex-col">
      {/* 头像（设置页用 hideAvatar 隐藏，改由封面头像入口承担） */}
      {!hideAvatar && (
        <div className="flex flex-col items-center pb-3 border-b border-[#e8eae7]">
          <button
            onClick={avatar.openPicker}
            className="relative w-20 h-20 rounded-full overflow-hidden border border-[#d5d9d7] hover:opacity-80 transition-opacity"
            title="点击更换头像"
          >
            {avatar.avatarUrl ? (
              <img
                src={avatar.avatarUrl}
                alt="头像"
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-[#b6cdd9] to-[#9db5c3] flex items-center justify-center text-white text-2xl font-bold">
                {(profile?.username || user?.email || "我")
                  .charAt(0)
                  .toUpperCase()}
              </div>
            )}
          </button>
          <p className="text-xs text-slate-400 mt-2">点击头像可更换</p>
          <input
            ref={avatar.fileRef}
            type="file"
            accept="image/*"
            onChange={avatar.handleFileChange}
            className="hidden"
          />
        </div>
      )}

      {/* 昵称：复用 NicknameEditor */}
      <div className="pb-3 border-b border-[#e8eae7]">
        <p className="text-sm text-gray-600 mb-1">昵称</p>
        <NicknameEditor onSaved={onSaved} />
      </div>

      {/* 个性签名：样式与昵称/性别/生日一致，保存逻辑由父组件提供 */}
      {onSaveBio && (
        <div className="pb-3 border-b border-[#e8eae7]">
          <label className="block text-sm text-gray-600 mb-1">个性签名</label>
          <input
            type="text"
            value={bioValue}
            onChange={(e) => onBioChange(e.target.value)}
            placeholder="写一句想说的话吧"
            maxLength={50}
            className={inputClass}
          />
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={onSaveBio}
              disabled={bioSaving}
              className={`${btnBase} px-3 py-1.5 text-sm`}
            >
              {bioSaving ? "保存中..." : "保存签名"}
            </button>
            {bioMsg && (
              <p
                className={`text-xs ${
                  bioMsg.startsWith("保存失败")
                    ? "text-red-400"
                    : "text-emerald-500"
                }`}
              >
                {bioMsg}
              </p>
            )}
          </div>
        </div>
      )}

      {/* 性别 */}
      <div className="pb-3 border-b border-[#e8eae7]">
        <label className="block text-sm text-gray-600 mb-1">性别</label>
        <select
          value={gender}
          onChange={(e) => setGender(e.target.value)}
          className={inputClass}
        >
          <option value="">未设置</option>
          <option value="男">男</option>
          <option value="女">女</option>
          <option value="保密">保密</option>
        </select>
      </div>

      {/* AI 提示词性别：两个选项直接切换，选完立即保存 */}
      {/* ⚠️ 这是给 AI「提示词」选的性别，和用户本人的性别完全无关 */}
      <div className="pb-3 border-b border-[#e8eae7]">
        <label className="block text-sm text-gray-600 mb-1">AI 提示词性别</label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handlePickPersona("female")}
            className={`flex-1 p-2 rounded-lg border text-sm transition-colors ${
              persona === "female"
                ? "border-[#a9c6da] bg-[#e3edf3] text-slate-800 font-medium"
                : "border-[#d5d9d7] bg-[#fdfdfc] text-slate-500 hover:bg-[#f1f5f7]"
            }`}
          >
            她（温柔的女性朋友）
          </button>
          <button
            type="button"
            onClick={() => handlePickPersona("male")}
            className={`flex-1 p-2 rounded-lg border text-sm transition-colors ${
              persona === "male"
                ? "border-[#a9c6da] bg-[#e3edf3] text-slate-800 font-medium"
                : "border-[#d5d9d7] bg-[#fdfdfc] text-slate-500 hover:bg-[#f1f5f7]"
            }`}
          >
            他（温和的男性朋友）
          </button>
        </div>
        <p className="text-xs text-slate-400 mt-1">
          这只决定 AI 用什么身份和你说话（决定用哪一份提示词），**和你的性别无关**。
          选完立即生效，也可以在聊天输入框旁随时切换。
        </p>
      </div>

      {/* 生日 */}
      <div className="pb-3 border-b border-[#e8eae7]">
        <label className="block text-sm text-gray-600 mb-1">生日</label>
        <input
          type="date"
          value={birthday}
          min="1900-01-01"
          max={todayStr()}
          onChange={(e) => setBirthday(e.target.value)}
          onKeyDown={(e) => e.preventDefault()}
          className={inputClass}
        />
        <p className="text-xs text-slate-500 mt-1">
          {formatBirthday(birthday)}
        </p>
      </div>

      {/* 性别/生日保存按钮 */}
      <button
        onClick={handleSaveProfile}
        disabled={savingProfile}
        className={`${btnBase} w-full p-2 my-3`}
      >
        {savingProfile ? "保存中..." : "保存性别和生日"}
      </button>

      {/* 邮箱 */}
      <div className="pb-3 border-b border-[#e8eae7]">
        <div className="flex items-center justify-between">
          <label className="text-sm text-gray-600">邮箱</label>
          <button
            onClick={() => {
              setEmailEditing(!emailEditing);
              setMsg("");
            }}
            className="text-xs text-red-500 hover:text-red-700"
          >
            修改
          </button>
        </div>
        <p className="text-sm text-slate-800 mt-1 break-all">
          {user?.email || "未设置"}
        </p>
        {emailEditing && (
          <div className="mt-2 space-y-2">
            <input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="输入新邮箱"
              className={inputClass}
            />
            <div className="flex gap-2">
              <button
                onClick={handleUpdateEmail}
                disabled={emailLoading}
                className={`${btnBase} flex-1 p-2 text-sm`}
              >
                {emailLoading ? "提交中..." : "确认修改"}
              </button>
              <button
                onClick={() => {
                  setEmailEditing(false);
                  setNewEmail("");
                  setMsg("");
                }}
                className={`${btnBase} flex-1 p-2 text-sm`}
              >
                取消
              </button>
            </div>
            <p className="text-xs text-slate-400">
              修改成功后会自动退出，请用新邮箱重新登录
            </p>
          </div>
        )}
      </div>

      {/* 密码 */}
      <div className="pb-3 border-b border-[#e8eae7]">
        <div className="flex items-center justify-between">
          <label className="text-sm text-gray-600">密码</label>
          <button
            onClick={() => {
              setPwdAsk(true);
              setMsg("");
            }}
            className="text-xs text-red-500 hover:text-red-700"
          >
            修改
          </button>
        </div>
        <p className="text-sm text-slate-800 mt-1">******</p>
        {/* 修改密码已改成弹窗：原密码 + 邮箱验证码 + 两次新密码，见 ChangePasswordModal */}
      </div>

      {/* 我的数据：回收站 + 导出 */}
      <div className="pb-3 border-b border-[#e8eae7] mt-3">
        <label className="block text-sm text-gray-600 mb-2">我的数据</label>
        <button
          type="button"
          onClick={() => setTrashOpen(true)}
          className={`${btnBase} w-full p-2 text-sm mb-2`}
        >
          回收站（删除的内容保留 3 天）
        </button>
        <button
          type="button"
          onClick={handleExportData}
          className={`${btnBase} w-full p-2 text-sm`}
        >
          导出我的全部数据（JSON）
        </button>
        <p className="text-xs text-slate-400 mt-1">
          下载一份包含你所有对话、消息、日记的文件；密码与图片不包含在内
        </p>
      </div>

      {/* 危险操作：注销账号 */}
      <div className="pb-3 mt-3">
        <label className="block text-sm text-red-600 mb-2">危险操作</label>
        <button
          type="button"
          onClick={handleDeleteAccount}
          disabled={dangerBusy === "delete"}
          className="w-full p-2 text-sm rounded-lg border border-[#e5c9c9] bg-[#fdf6f6] text-red-600 hover:bg-[#fbecec] transition-colors disabled:opacity-50"
        >
          {dangerBusy === "delete" ? "注销中..." : "注销账号（删除全部数据）"}
        </button>
        <p className="text-xs text-slate-400 mt-1">
          注销后数据无法恢复，请谨慎操作
        </p>
      </div>

      {/* 回收站弹窗 */}
      <TrashModal open={trashOpen} onClose={() => setTrashOpen(false)} apiRequest={trashRequest} />

      {/* 修改密码弹窗：原密码 / 绑定邮箱 / 验证码 / 新密码 / 重复新密码 */}
      <ChangePasswordModal
        open={pwdAsk}
        onClose={() => setPwdAsk(false)}
        apiRequest={trashRequest}
        boundEmail={boundEmail}
      />

      {/* 注销账号确认弹窗：风格与站内其他确认框保持一致 */}
      {dangerAsk ? (
        <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/30 px-6">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-sm font-bold text-red-600">注销账号</h3>
            <p className="mt-2 text-xs leading-relaxed text-slate-600">
              注销后，你的账号、全部对话、消息、日记都会被
              <span className="text-red-500">永久删除，无法恢复</span>。
            </p>
            <p className="mt-3 text-xs text-slate-500">
              如果确定，请准确输入：
              <span className="ml-1 rounded bg-[#f4f6f5] px-1.5 py-0.5 font-mono text-slate-700">
                注销我的账号
              </span>
            </p>
            <input
              autoFocus
              value={dangerInput}
              onChange={(e) => setDangerInput(e.target.value)}
              className="mt-2 w-full rounded-lg border border-[#d5d9d7] bg-[#fdfdfc] px-3 py-2 text-sm outline-none focus:border-[#a9c6da]"
              placeholder="在这里输入上面那句话"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={dangerBusy === "delete"}
                onClick={() => {
                  setDangerAsk(false);
                  setDangerInput("");
                }}
                className="rounded-lg border border-[#d5d9d7] px-3 py-1.5 text-xs text-slate-600 transition-colors hover:bg-[#f2f5f4] disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={dangerBusy === "delete" || dangerInput.trim() !== "注销我的账号"}
                onClick={performDeleteAccount}
                className="rounded-lg bg-red-500 px-3 py-1.5 text-xs text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {dangerBusy === "delete" ? "注销中…" : "确认注销"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 提示信息 */}
      {msg && (
        <p className="text-sm text-red-500 text-center border-t border-[#e8eae7] pt-3">
          {msg}
        </p>
      )}

      {/* 退出登录：页面右栏接管时隐藏（hideSignOut） */}
      {!hideSignOut && onSignOut && (
        <button
          onClick={onSignOut}
          className="w-full mt-2 border border-[#e8eae7] bg-[#fafaf8] text-slate-500 rounded-lg py-2 text-sm hover:bg-[#f0eef0] hover:text-red-500 transition-colors duration-150"
        >
          退出登录
        </button>
      )}

      {/* 头像裁剪弹窗：圆形 1:1 */}
      {avatar.cropSrc && (
        <ImageCropper
          imageSrc={avatar.cropSrc}
          aspect={1}
          cropShape="round"
          title="裁剪头像"
          maxSide={512}
          busy={avatar.uploading}
          onCancel={() => avatar.setCropSrc(null)}
          onConfirm={avatar.handleCropped}
        />
      )}
    </div>
  );
}
