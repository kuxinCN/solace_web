"use client";

/**
 * 心理画像展示块（后台用）。
 *
 * ⚠️ **为什么标签和依据要一起显示**：
 *    只给一排「压力水平：高 / 情绪风险：中」，运营看到的第一反应是
 *    "凭什么"。而这个画像会影响每一次 AI 回复的语气 —— 判错了是要影响用户的。
 *    所以把 `basis`（哪几个分数、用了哪条规则）和 `sourceScores`（原始分数）
 *    一起摆出来，让人能自己核对。
 *
 * ⚠️ 这是**只读展示**：画像由本地规则引擎按固定公式算出（见 lib/portrait.js），
 *    后台不提供"手动改标签"的入口 —— 能改就意味着同一套规则算出来的东西
 *    在不同用户身上不一致，那就不可解释了。
 */
import { useState } from "react";

const BTN =
  "rounded-lg border border-[#e2e5e2] bg-white px-2 py-1 text-[11px] text-slate-500 transition hover:border-[#c9d2c9] hover:text-slate-700";

/** 每个维度一个淡色标签（不做红黄绿分级 —— 画像不是打分） */
const LEVEL_TONE = {
  高: "bg-[#fdf3f0] text-[#a97a6b]",
  中: "bg-[#f8f5ec] text-[#8a7a4a]",
  低: "bg-[#eef6f1] text-[#5a8a74]",
  内向: "bg-[#eef4f6] text-[#5b8aa6]",
  外向: "bg-[#f4f1ec] text-[#8a7a5a]",
  直接: "bg-[#eef4f6] text-[#5b8aa6]",
  温和: "bg-[#f6eef2] text-[#96708a]",
  // 年龄段单独一套蓝色系（越年轻越冷）。⚠️ 刻意不用红黄 ——
  // 年龄只是"该用什么说话方式"的依据，不是"好坏"的判定。
  青少年: "bg-[#eef4fb] text-[#4a6fa5]",
  青年: "bg-[#f0f5fa] text-[#5a7fa0]",
  成年: "bg-[#f2f5f8] text-[#6a8090]",
  中年: "bg-[#f4f4f2] text-[#7a7a72]",
  老年: "bg-[#f3f2f6] text-[#75708a]",
};

const TONE_DEFAULT = "bg-slate-100 text-slate-500";

/** 维度固定顺序（必须和 lib/portrait.js 的 PORTRAIT_KEYS 一致 —— 顺序就是优先级） */
const KEYS = ["年龄段", "压力水平", "情绪风险", "人格倾向", "沟通偏好"];

function formatTime(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return String(value);
  }
}

export default function PortraitPanel({ portrait, version, updatedAt }) {
  const [showBasis, setShowBasis] = useState(false);

  const labels = portrait?.portrait || null;
  const basis = portrait?.basis || {};
  const scores = portrait?.sourceScores || {};
  const needsAttention = Boolean(portrait?.needsAttention);

  /* ---- 还没算过 ---- */
  if (!labels) {
    return (
      <div className="rounded-xl border border-[#eceeec] bg-white p-4">
        <p className="text-sm font-semibold text-slate-700">心理画像</p>
        <p className="mt-1 text-[11px] leading-5 text-slate-400">
          还没有画像。用户在「治愈小屋」做完量表测评（或压力值有明显变化）之后会自动生成。
          <br />
          ⚠️ 这个画像**用户端看不到**，只在这里展示。
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[#eceeec] bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-slate-700">心理画像</p>
        <span className="text-[11px] text-slate-400">
          {version || "—"} · 更新于 {formatTime(updatedAt) || "—"}
        </span>

        {needsAttention ? (
          <span
            className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700"
            title="PHQ-9 第 9 题（自伤念头）有分 —— 建议人工关注"
          >
            需关注
          </span>
        ) : null}

        <button
          type="button"
          className={`${BTN} ml-auto`}
          onClick={() => setShowBasis((v) => !v)}
        >
          {showBasis ? "收起依据" : "看判定依据"}
        </button>
      </div>

      {/* ---- 四个标签 ---- */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {KEYS.map((key) => {
          const value = String(labels[key] || "").trim();
          return (
            <div key={key} className="rounded-lg bg-[#fafcfb] px-3 py-2">
              <p className="text-[11px] text-slate-400">{key}</p>
              {value ? (
                <span
                  className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs ${
                    LEVEL_TONE[value] || TONE_DEFAULT
                  }`}
                >
                  {value}
                </span>
              ) : (
                <p className="mt-1 text-xs text-slate-300">无数据</p>
              )}
            </div>
          );
        })}
      </div>

      {/* ---- 判定依据 ---- */}
      {showBasis ? (
        <div className="mt-3 space-y-2 border-t border-[#f2f4f2] pt-3">
          <div>
            <p className="mb-1 text-[11px] font-medium text-slate-500">原始分数</p>
            <p className="text-[11px] leading-6 text-slate-500">
              PSS-10：<span className="text-slate-700">{scores.PSS ?? "未测"}</span>
              {" ｜ "}GAD-7：<span className="text-slate-700">{scores.GAD ?? "未测"}</span>
              {" ｜ "}PHQ-9：<span className="text-slate-700">{scores.PHQ ?? "未测"}</span>
              {" ｜ "}第 9 题：
              <span className="text-slate-700">{scores.PHQ9SelfHarm ?? "—"}</span>
              {" ｜ "}压力值：
              <span className="text-slate-700">{scores.chatStress ?? "—"}</span>
              {" ｜ "}MBTI：<span className="text-slate-700">{scores.MBTI ?? "未测"}</span>
            </p>
          </div>

          <div>
            <p className="mb-1 text-[11px] font-medium text-slate-500">每个标签是凭什么判的</p>
            <ul className="space-y-1">
              {KEYS.map((key) => (
                <li key={key} className="text-[11px] leading-6 text-slate-500">
                  <span className="text-slate-700">{key}</span>
                  {" → "}
                  {basis[key] || "—"}
                </li>
              ))}
            </ul>
          </div>

          <p className="text-[11px] leading-5 text-slate-400">
            ⚠️ 这套判定是**本地规则引擎**按固定公式算的，不经过 AI，同样的分数永远得到同样的标签
            （规则见 <span className="font-mono">lib/portrait.js</span>）。
            这些标签会自动拼进和这个用户聊天时的 system prompt。
          </p>
        </div>
      ) : null}
    </div>
  );
}
