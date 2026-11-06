"use client";

import { memo } from "react";
import { stripTtsTags } from "@/lib/tts-tags";

/**
 * 分割 AI 回复的多段文本（按换行符切分，模拟分段发送）
 */
export function splitAiSegments(content) {
  if (!content) return [];
  return String(content)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 解析回复中的表情包标记 [sticker:xxx]
 */
export function parseStickerMark(content) {
  if (!content) return { text: "", category: null };
  const kept = [];
  let category = null;
  for (const line of String(content).split(/\r?\n/)) {
    const m = line.match(/\[sticker:\s*([a-zA-Z]+)\s*\]/);
    if (/^\s*\[sticker:\s*([a-zA-Z]+)\s*\]?\s*$/.test(line)) {
      if (m && m[1]) category = m[1].toLowerCase();
      continue;
    }
    kept.push(line);
  }
  let text = kept.join("\n");
  const m = text.match(/\[sticker:\s*([a-zA-Z]+)\s*\]/);
  if (m) {
    if (!category) category = m[1].toLowerCase();
    text = text.replace(m[0], "");
  }
  return { text: text.trim(), category };
}

// AI 头像：优先用户自定义（profiles.ai_avatar_url），否则默认渐变圆形
export function AiAvatar({ url }) {
  if (url) {
    return (
      <img
        src={url}
        alt="AI"
        className="w-8 h-8 shrink-0 rounded-full object-cover shadow-xs border border-[#f5dfd4]"
      />
    );
  }
  return (
    <div className="w-8 h-8 shrink-0 rounded-full bg-[#FFF5EF] border border-[#f5dfd4] flex items-center justify-center p-0.5 shadow-xs">
      <img src="/logo.png" alt="AI" className="w-full h-full object-contain" />
    </div>
  );
}

export function UserAvatar({ url, name }) {
  if (url) {
    return (
      <img
        src={url}
        alt="我"
        className="w-8 h-8 shrink-0 rounded-full object-cover shadow-xs border border-[#ebd8ce]"
      />
    );
  }
  return (
    <div className="w-8 h-8 shrink-0 rounded-full bg-gradient-to-br from-[#d97c62] to-[#b85a3c] flex items-center justify-center text-white text-sm font-bold shadow-xs">
      {(name || "我").charAt(0).toUpperCase()}
    </div>
  );
}

/**
 * 单条消息气泡（memo 化）：只有与该气泡画面相关的数据变化时才重渲。
 * 侧边栏切换对话、以及流式输出时的高频 setMessages 都不会再让整列气泡重渲。
 * 按钮回调经 handlers（ref，引用恒定）透传，保证调用的始终是最新闭包。
 */
export const MessageRow = memo(
  function MessageRow({
    m,
    isUser,
    ttsTagWords,
    holdTagPartial,
    renderKey,
    revealed,
    stickerSrc,
    highlighted,
    aiBubbleBg,
    aiAvatarUrl,
    userAvatarUrl,
    displayName,
    regenId,
    sending,
    ttsPlayingId,
    ttsPlayingCk,
    ttsLoadingId,
    handlers,
    messageRefs,
  }) {
    // AI 消息按 \n 切成多段，模拟真人连发短消息（表情包标记行不算文字）
    // ⚠️ 朗读标签在这里剥掉：库里存的是带标签的原文（TTS 要靠它控语气），
    //    但屏幕上不能出现 [温柔] 这种东西。用户消息一律不动 —— 用户自己打的括号是内容。
    //    holdTagPartial：正在流式输出的那条要挡住"开了口还没闭合"的半截标签。
    const rawText = parseStickerMark(m.content).text;
    const segments = isUser
      ? []
      : splitAiSegments(
          stripTtsTags(rawText, ttsTagWords, { holdPartial: holdTagPartial })
        );
    // 已完成分段 + 正在输入的分段（如果 revealed 还没到末尾）
    const visibleCount = Math.min(revealed + 1, segments.length);
    const showSegments = segments.slice(0, visibleCount);
    return (
      <div
        ref={(el) => {
          if (messageRefs?.current) {
            messageRefs.current[m.id] = el;
          }
        }}
        className={`flex items-start gap-2 mb-3 group ${
          isUser ? "justify-end" : "justify-start"
        }`}
      >
        {!isUser && <AiAvatar url={aiAvatarUrl} />}
        <div
          className={`flex flex-col max-w-[70%] ${
            isUser ? "items-end" : "items-start"
          }`}
        >
          {/* 用户消息：单气泡 */}
          {isUser && (
            <div
              className={`msg-in max-w-full px-3.5 py-2.5 text-sm leading-6 whitespace-pre-wrap break-words rounded-2xl rounded-br-sm transition-all duration-200 bg-gradient-to-br from-[#c4694e] to-[#b85a3c] text-white shadow-sm shadow-[#b85a3c]/15 ${highlighted ? "ring-2 ring-[#e2a68c]" : ""}`}
            >
              {m.content}
            </div>
          )}

          {/* AI 消息：按分段渲染多个气泡 */}
          {!isUser && showSegments.length === 0 && !m.content && (m.id === regenId || String(m.id).startsWith("temp-")) && (
            // 空临时气泡 / 重新生成中：显示思考点点
            <div className={`msg-in ai-msg-bubble ${aiBubbleBg} px-3.5 py-2.5 rounded-2xl rounded-bl-sm border border-[#f0eae3]/90 dark:border-[#382F28]/80 flex gap-1.5 shadow-xs`}>
              {[0, 150, 300].map((delay) => (
                <span
                  key={delay}
                  className="w-1.5 h-1.5 rounded-full bg-[#d49e8d] animate-bounce"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </div>
          )}

          {!isUser && showSegments.map((seg, i) => (
            <div
              key={`${renderKey}-${i}`}
              className={`msg-in ai-msg-bubble max-w-full px-3.5 py-2.5 text-sm leading-6 break-words rounded-2xl rounded-bl-sm ${aiBubbleBg} text-slate-800 dark:text-[#F5DCD3] ${
                i < showSegments.length - 1 ? "mb-1.5" : ""
              } shadow-xs border border-[#f0eae3]/90 dark:border-[#382F28]/80 ${highlighted ? "ring-2 ring-[#e2a68c]" : ""}`}
            >
              {seg}
            </div>
          ))}

          {/* 表情包：贴在 AI 气泡下方，不加底色、固定小尺寸，避免视觉突兀 */}
          {!isUser && stickerSrc && (
            <img
              src={stickerSrc}
              alt=""
              draggable={false}
              className="mt-1 w-[100px] max-w-[120px] h-auto rounded-2xl select-none"
            />
          )}

          {/* 操作区：播放语音 + 重新生成。电脑端悬停才显示，移动端无 hover → 常显 */}
          {!isUser && !String(m.id).startsWith("temp-") && m.content && (
            <div className="mt-1 flex items-center gap-1 self-start opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity duration-150">
              {/* 喇叭按钮：空闲喇叭 / 加载中旋转 / 播放中暂停；点击区 ≥44px */}
              <button
                type="button"
                onClick={() =>
                  handlers.current.onToggleTts(m.id, parseStickerMark(m.content).text, m.ck)
                }
                title={
                  ttsPlayingId === m.id || ttsPlayingCk === m.ck
                    ? "暂停"
                    : "播放语音"
                }
                aria-label={
                  ttsPlayingId === m.id || ttsPlayingCk === m.ck
                    ? "暂停语音"
                    : "播放语音"
                }
                className="w-11 h-11 sm:w-7 sm:h-7 flex items-center justify-center text-slate-400 dark:text-[#9A8B83] hover:text-[#b85a3c] dark:hover:text-[#EFA896] transition-colors duration-150"
              >
                {ttsLoadingId === m.id ? (
                  <svg
                    className="w-4 h-4 animate-spin text-[#b85a3c]"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M21 12a9 9 0 1 1-6.22-8.56" />
                  </svg>
                ) : ttsPlayingId === m.id || ttsPlayingCk === m.ck ? (
                  <svg
                    className="w-4 h-4 text-[#b85a3c] animate-pulse"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="6" y="4" width="4" height="16" rx="1" />
                    <rect x="14" y="4" width="4" height="16" rx="1" />
                  </svg>
                ) : (
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  </svg>
                )}
              </button>

              <button
                onClick={() => handlers.current.onRegenerate(m.id)}
                disabled={sending || m.id === regenId}
                title="重新生成"
                className="w-11 h-11 sm:w-auto sm:h-auto sm:px-1 flex items-center justify-center gap-1 text-xs text-slate-400 dark:text-[#9A8B83] hover:text-[#b85a3c] dark:hover:text-[#EFA896] transition-colors duration-150 disabled:opacity-50"
              >
                <svg
                  className="w-3.5 h-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
                <span className="hidden sm:inline">重新生成</span>
              </button>

              {/* 💌 生成陪伴卡片（拍立得海报） */}
              <button
                type="button"
                onClick={() => handlers.current?.onOpenCard?.(m.id || m.ck, m)}
                title="导出为陪伴卡片 / 拍立得明信片"
                className="w-11 h-11 sm:w-auto sm:h-auto sm:px-1.5 flex items-center justify-center gap-1 text-xs text-slate-400 hover:text-[#b85a3c] transition-colors duration-150"
              >
                <svg
                  className="w-3.5 h-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
                <span className="hidden sm:inline">陪伴卡片</span>
              </button>
            </div>
          )}

          {/* 🍃 弱网断线温和重试提示：点击自动重新请求 */}
          {!isUser && m.isNetworkError && (
            <button
              type="button"
              onClick={() => handlers.current?.onRegenerate?.(m.id)}
              disabled={sending || m.id === regenId}
              className="mt-1.5 flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#FFF6F0] dark:bg-[#2B201A] border border-[#f5dfd4] dark:border-[#4A372D] text-xs text-[#b85a3c] dark:text-[#EFA896] hover:bg-[#FEEFE6] dark:hover:bg-[#382820] active:scale-[0.98] transition-all shadow-xs cursor-pointer group"
            >
              <svg
                className="w-3.5 h-3.5 transition-transform group-hover:rotate-180 duration-300"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              <span>🍃 网络波动，点击重试</span>
            </button>
          )}
        </div>
        {isUser && <UserAvatar url={userAvatarUrl} name={displayName} />}
      </div>
    );
  },
  // 只比较会影响这条气泡画面的数据；回调与 ref 引用恒定，不参与比较。
  (a, b) =>
    a.m === b.m &&
    a.renderKey === b.renderKey &&
    a.revealed === b.revealed &&
    a.stickerSrc === b.stickerSrc &&
    a.highlighted === b.highlighted &&
    a.regenId === b.regenId &&
    a.sending === b.sending &&
    a.ttsPlayingId === b.ttsPlayingId &&
    a.ttsPlayingCk === b.ttsPlayingCk &&
    a.ttsLoadingId === b.ttsLoadingId &&
    a.m?.isNetworkError === b.m?.isNetworkError &&
    a.aiBubbleBg === b.aiBubbleBg &&
    a.aiAvatarUrl === b.aiAvatarUrl &&
    a.userAvatarUrl === b.userAvatarUrl &&
    a.displayName === b.displayName
);

export default MessageRow;
