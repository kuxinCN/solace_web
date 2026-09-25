"use client";

import { useState, useRef, useEffect } from "react";

/** kind -> 数据库列名（乐观值登记用） */
const KIND_COLUMN = {
  avatar: "avatar_url",
  aiAvatar: "ai_avatar_url",
  background: "chat_background_url",
  diaryBackground: "diary_background_url",
};

/**
 * 本地图片写入登记表（key = 数据库列名，value = { url, seq }）。
 *
 * 为什么需要它：上传是后台进行的，远端 MySQL 写大字段可能要数秒到数十秒。
 * 在写入落库之前，任何一次「读取用户资料」拿到的都是旧快照；
 * 若该请求发起于本次本地写入之前、却在写入之后才返回，就会把
 * 刚乐观显示的新图冲掉 —— 表现为「一下改成功了，过一会又变回原来的」。
 *
 * 因此记录每次本地写入的值与递增序号：资料请求返回时，
 * 只要期间发生过更新的本地写入，就以本地值为准，丢弃这份过期快照。
 * 放在模块作用域（而非组件内），组件重挂载 / 切换 tab 后依然有效。
 */
const localImageWrites = {};
let imageWriteSeq = 0;

/** 当前写入序号（发起资料请求前记录，返回后用于判断期间是否发生过本地写入） */
export function currentImageWriteSeq() {
  return imageWriteSeq;
}

/** 登记一次本地图片写入（乐观更新、失败回滚、恢复默认都算） */
export function markLocalImageWrite(column, url) {
  if (!column) return;
  imageWriteSeq += 1;
  localImageWrites[column] = { url, seq: imageWriteSeq };
}

/**
 * 把「发起于 startedSeq 之后」的本地写入合并进服务端资料，
 * 避免过期快照覆盖新图。
 */
export function mergeLocalImageWrites(profile, startedSeq = 0) {
  if (!profile) return profile;
  let merged = null;
  for (const column of Object.keys(localImageWrites)) {
    const entry = localImageWrites[column];
    if (entry.seq <= startedSeq) continue;
    if (!merged) merged = { ...profile };
    merged[column] = entry.url;
  }
  return merged || profile;
}

/**
 * 共享头像上传逻辑：选图 → 裁剪 → 上传 → 刷新。
 * 供 ProfileView（设置页头像）和 page.js 封面头像共同调用，避免重复实现。
 *
 * @param {Object} options
 * @param {string} [options.kind="avatar"] 上传类型：avatar / aiAvatar / background / diaryBackground
 * @param {string} [options.initialUrl=""] 初始头像 URL
 * @param {Function} [options.onSaved] 上传成功回调（用于刷新 profile）
 * @param {Function} [options.onError] 错误回调，返回错误消息字符串
 */
export function useAvatarUpload({ kind = "avatar", initialUrl = "", onSaved, onError } = {}) {
  const [cropSrc, setCropSrc] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(initialUrl);
  const [msg, setMsg] = useState("");
  const fileRef = useRef(null);

  // 外部 initialUrl 变化时同步（profile 刷新后）
  useEffect(() => {
    setAvatarUrl(initialUrl);
  }, [initialUrl]);

  function openPicker() {
    if (uploading) return;
    fileRef.current?.click();
  }

  function handleFileChange(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setMsg("请选择图片文件");
      onError?.("请选择图片文件");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setMsg("图片不能超过 5MB");
      onError?.("图片不能超过 5MB");
      return;
    }
    setMsg("");
    const reader = new FileReader();
    reader.onload = () => setCropSrc(reader.result);
    reader.onerror = () => {
      setMsg("图片读取失败");
      onError?.("图片读取失败");
    };
    reader.readAsDataURL(file);
  }

  async function handleCropped(dataUrl) {
    // 乐观更新：裁剪确认瞬间用本地 dataURL 立即刷新界面，上传在后台并发进行
    const prevUrl = avatarUrl;        // 保存旧图 URL 供回滚
    const column = KIND_COLUMN[kind]; // 对应的数据库列
    setAvatarUrl(dataUrl);            // 零延迟显示新图
    setCropSrc(null);                 // 立刻关闭裁剪弹窗
    setUploading(true);               // 内部锁定，防止重复操作
    setMsg("");
    markLocalImageWrite(column, dataUrl); // 登记本地写入，防止慢上传期间被旧快照冲掉
    try {
      const res = await fetch("/api/user/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, dataUrl }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `上传失败（HTTP ${res.status}）`);
      // 上传成功：服务端已落库，刷新资料即拿到同一个值，无视觉变化
      onSaved?.();
    } catch (err) {
      // 上传失败：把回滚后的旧图也登记为最新本地值，再回滚界面
      markLocalImageWrite(column, prevUrl);
      setAvatarUrl(prevUrl);
      const text = "上传失败，请重试";
      setMsg(text);
      onError?.(text);
    } finally {
      setUploading(false);
    }
  }

  return {
    cropSrc,
    setCropSrc,
    uploading,
    avatarUrl,
    setAvatarUrl,
    msg,
    setMsg,
    fileRef,
    openPicker,
    handleFileChange,
    handleCropped,
  };
}
