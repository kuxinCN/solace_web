"use client";

import { useState, useEffect } from 'react';

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

export default function NicknameEditor({ onSaved }) {
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
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
      setMsg('昵称不能为空');
      return;
    }
    if (!regex.test(trimmed)) {
      setMsg('只能包含中文、英文或数字，不能有特殊符号');
      return;
    }

    setLoading(true);
    setMsg('');

    try {
      const session = await apiRequest("/api/auth/session");
      if (!session.user) {
        setMsg('请先登录');
        return;
      }

      await apiRequest("/api/user/profile", {
        method: "PUT",
        body: { username: trimmed },
      });

      setMsg('保存成功');
      onSaved?.();
    } catch (err) {
      setMsg('保存失败：' + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-3 space-y-2">
      <label className="block text-sm text-gray-600">显示名称</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="输入新昵称（中文/英文/数字）"
        className="border p-2 rounded w-full text-black bg-white"
      />
      <button
        onClick={handleSave}
        disabled={loading}
        className="bg-blue-500 text-white px-4 py-2 rounded w-full"
      >
        {loading ? '保存中...' : '保存'}
      </button>
      {msg && <p className="text-sm text-red-500">{msg}</p>}
    </div>
  );
}
