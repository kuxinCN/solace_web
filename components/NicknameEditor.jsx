"use client";

import { useState, useEffect } from "react";

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

export default function NicknameEditor({ onSaved }) {
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // 加载当前昵称
    async function load() {
      try {
        const session = await apiRequest("/api/auth/session");
        if (!session.user) return;
        const { profile } = await apiRequest("/api/user/profile");
        if (profile?.username) setName(profile.username);
      } catch {
        // 加载失败静默处理（未登录或网络异常）
      }
    }
    load();
  }, []);

  const handleSave = async () => {
    const trimmed = name.trim();
    const regex = /^[\u4e00-\u9fa5a-zA-Z0-9]+$/;

    if (!trimmed) {
      setMsg("昵称不能为空");
      return;
    }
    if (!regex.test(trimmed)) {
      setMsg("只能包含中文、英文或数字，不能有特殊符号");
      return;
    }

    setLoading(true);
    setMsg("");

    try {
      const session = await apiRequest("/api/auth/session");
      if (!session.user) {
        setMsg("请先登录");
        return;
      }

      await apiRequest("/api/user/profile", {
        method: "PUT",
        body: { username: trimmed },
      });

      setMsg("保存成功");
      onSaved?.();
    } catch (err) {
      setMsg("保存失败：" + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="输入新昵称（中文/英文/数字）"
        maxLength={20}
        className="w-full border border-[#d5d9d7] dark:border-[#3a322d] bg-white dark:bg-[#1a1614] p-2 text-sm text-slate-800 dark:text-[#F5DCD3] placeholder-gray-400 dark:placeholder-[#7e6f66] rounded-lg transition-colors duration-150 focus:outline-none focus:border-[#8fb3c7] dark:focus:border-[#e2a68c] focus:ring-1 focus:ring-[#8fb3c7] dark:focus:ring-[#e2a68c]/30"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={loading}
          className="border border-[#d5d9d7] dark:border-[#3a322d] bg-[#fdfdfc] dark:bg-[#2c2420] text-slate-700 dark:text-[#F5DCD3] rounded-lg hover:bg-[#e8eff2] dark:hover:bg-[#382f2a] hover:text-slate-900 dark:hover:text-white active:scale-[0.98] transition-all duration-150 disabled:opacity-50 px-3 py-1.5 text-sm shadow-2xs"
        >
          {loading ? "保存中..." : "保存昵称"}
        </button>
        {msg && (
          <p
            className={`text-xs ${
              msg.startsWith("保存失败") ||
              msg.startsWith("只能") ||
              msg.startsWith("昵称") ||
              msg.startsWith("请先")
                ? "text-red-400"
                : "text-emerald-500"
            }`}
          >
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}
