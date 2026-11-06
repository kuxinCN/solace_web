"use client";

/**
 * 日记情绪标签（选择器 + 只读徽章）
 *
 * ⚠️ 顺序是按**情绪强度从低到高**排的（有点沉 → 轻快），但请注意：
 *   * **不标"好 / 坏"、不用红黄绿配色** —— 这个产品的定位是陪伴，
 *     不给用户的情绪打分（"你今天只有 3 分"这种事很伤人）。
 *   * 排成一行只是让用户在固定的位置找到相近的词，不是一条"评分轴"。
 *
 * 这套词和 `lib/ai.js` 的 MOOD_LABELS、`lib/content-review.js` 的 DIARY_MOODS 保持一致。
 * 改词表时三处都要改。
 */
export const MOOD_ORDER = [
  "有点沉",
  "疲惫",
  "烦躁",
  "孤单",
  "说不清",
  "安稳",
  "平静",
  "轻快",
];

const MOOD_SET = new Set(MOOD_ORDER);

/** 只认这 8 个词，别的（脏数据 / 老数据）一律当没选 */
export function normalizeMood(value) {
  const text = String(value || "").trim();
  return MOOD_SET.has(text) ? text : "";
}

/**
 * 一行标签选择器。
 * 再点一次已选中的标签 = 取消选择（用户可能选错了想撤掉）。
 */
export default function MoodPicker({ value, onChange, disabled = false, className = "" }) {
  const current = normalizeMood(value);

  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {MOOD_ORDER.map((mood) => {
        const active = current === mood;
        return (
          <button
            key={mood}
            type="button"
            disabled={disabled}
            onClick={() => onChange?.(active ? "" : mood)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-150 cursor-pointer disabled:opacity-50 ${active
                ? "bg-[#FFF5EF] dark:bg-[#3D2920] text-[#b85a3c] dark:text-[#EFA896] border border-[#f0ded4] dark:border-[#5C3C2E] shadow-xs ring-1 ring-[#b85a3c]/35 dark:ring-[#EFA896]/35 font-semibold scale-[1.02]"
                : "bg-white dark:bg-[#251F1C] text-slate-700 dark:text-[#D1C0B6] border border-[#eddcd2] dark:border-[#3E332B] hover:bg-[#fff9f6] dark:hover:bg-[#302620] hover:text-[#b85a3c] dark:hover:text-[#EFA896] hover:border-[#e2a68c] dark:hover:border-[#EFA896]/40"
              }`}
          >
            {mood}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 标签徽章（只读展示）。
 *
 * @param source  "user" = 用户自己选的 / "ai" = AI 打的
 *
 * ⚠️ 两类标签**必须能区分**：用户在同一个位置可能看到两个标签
 *    （「用户 · 轻快」和「AI · 平静」），不区分的话会以为系统自相矛盾。
 */
export function MoodBadge({ mood, source = "user", className = "" }) {
  const value = normalizeMood(mood);
  if (!value) return null;

  const isUser = source === "user";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium border transition-colors ${isUser
          ? "bg-[#FFF5EF] dark:bg-[#33241D] text-[#b85a3c] dark:text-[#EFA896] border-[#f5dfd4] dark:border-[#4E362A]"
          : "bg-[#f5f1ee] dark:bg-[#251F1C] text-[#8c746b] dark:text-[#BFAFA7] border-[#ebdcd2] dark:border-[#382F28]"
        } ${className}`}
      title={isUser ? "你自己选的标签" : "AI 读出来的标签"}
    >
      <span className="opacity-75">{isUser ? "用户" : "AI"}</span>
      <span className="opacity-40">·</span>
      <span>{value}</span>
    </span>
  );
}
