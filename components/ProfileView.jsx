"use client";

import { useState, useRef, useEffect } from "react";
import NicknameEditor from "@/components/NicknameEditor";
import ImageCropper from "@/components/ImageCropper";

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
  bioValue,
  onBioChange,
  onSaveBio,
  bioSaving,
  bioMsg,
}) {
  const [gender, setGender] = useState(profile?.gender || "");
  const [birthday, setBirthday] = useState(profile?.birthday || "");
  const [avatarUrl, setAvatarUrl] = useState(profile?.avatar_url || "");
  const [savingProfile, setSavingProfile] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [msg, setMsg] = useState("");
  // 待裁剪原图 dataURL；非空时弹出裁剪弹窗
  const [cropSrc, setCropSrc] = useState(null);

  // 邮箱修改
  const [emailEditing, setEmailEditing] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [emailLoading, setEmailLoading] = useState(false);

  // 密码修改
  const [pwdEditing, setPwdEditing] = useState(false);
  const [newPwd, setNewPwd] = useState("");
  const [pwdLoading, setPwdLoading] = useState(false);

  const fileRef = useRef(null);

  // profile 变化时同步本地状态
  useEffect(() => {
    setGender(profile?.gender || "");
    setBirthday(profile?.birthday || "");
    setAvatarUrl(profile?.avatar_url || "");
  }, [profile]);

  // 选择图片：校验后读出原图 dataURL，弹出裁剪弹窗（不立即上传）
  function handleAvatarChange(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setMsg("请选择图片文件");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setMsg("图片不能超过 5MB");
      return;
    }
    setMsg("");
    const reader = new FileReader();
    reader.onload = () => setCropSrc(reader.result);
    reader.onerror = () => setMsg("图片读取失败");
    reader.readAsDataURL(file);
  }

  // 裁剪确认：上传裁剪结果，实时预览
  async function handleAvatarCropped(dataUrl) {
    setAvatarUploading(true);
    setMsg("");
    try {
      const { url } = await apiRequest("/api/user/upload", {
        method: "POST",
        body: { kind: "avatar", dataUrl },
      });
      setAvatarUrl(url);
      setMsg("头像更新成功");
      setCropSrc(null);
      onSaved?.();
    } catch (err) {
      setMsg("头像上传失败：" + err.message);
    } finally {
      setAvatarUploading(false);
    }
  }

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
    window.location.href = "/";
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

  return (
    <div className="flex flex-col">
      {/* 头像 */}
      <div className="flex flex-col items-center pb-3 border-b border-[#e8eae7]">
        <button
          onClick={() => !avatarUploading && fileRef.current?.click()}
          className="relative w-20 h-20 rounded-full overflow-hidden border border-[#d5d9d7] hover:opacity-80 transition-opacity"
          title="点击更换头像"
        >
          {avatarUrl ? (
            <img
              src={avatarUrl}
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
          {avatarUploading && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center text-white text-xs">
              上传中
            </div>
          )}
        </button>
        <p className="text-xs text-slate-400 mt-2">点击头像可更换</p>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          onChange={handleAvatarChange}
          className="hidden"
        />
      </div>

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
              setPwdEditing(!pwdEditing);
              setMsg("");
            }}
            className="text-xs text-red-500 hover:text-red-700"
          >
            修改
          </button>
        </div>
        <p className="text-sm text-slate-800 mt-1">******</p>
        {pwdEditing && (
          <div className="mt-2 space-y-2">
            <input
              type="password"
              value={newPwd}
              onChange={(e) => setNewPwd(e.target.value)}
              placeholder="输入新密码（至少 6 位）"
              className={inputClass}
            />
            <div className="flex gap-2">
              <button
                onClick={handleUpdatePassword}
                disabled={pwdLoading}
                className={`${btnBase} flex-1 p-2 text-sm`}
              >
                {pwdLoading ? "提交中..." : "确认修改"}
              </button>
              <button
                onClick={() => {
                  setPwdEditing(false);
                  setNewPwd("");
                  setMsg("");
                }}
                className={`${btnBase} flex-1 p-2 text-sm`}
              >
                取消
              </button>
            </div>
          </div>
        )}
      </div>

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
      {cropSrc && (
        <ImageCropper
          imageSrc={cropSrc}
          aspect={1}
          cropShape="round"
          title="裁剪头像"
          maxSide={512}
          busy={avatarUploading}
          onCancel={() => setCropSrc(null)}
          onConfirm={handleAvatarCropped}
        />
      )}
    </div>
  );
}
