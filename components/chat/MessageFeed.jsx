"use client";

import React from "react";
import MessageRow, { AiAvatar, splitAiSegments, parseStickerMark } from "./MessageRow";
import { stripTtsTags } from "@/lib/tts-tags";

/**
 * 消息流列表视窗组件：负责渲染消息列表、破冰欢迎词、生日祝福、思考气泡与自动滚动底锚
 */
export default function MessageFeed({
  messages,
  currentId,
  birthdayGreet,
  streamingReply,
  diaryReading,
  messagesLoading,
  pendingReply,
  sending,
  setInput,
  pingWarmInput,
  messagesScrollRef,
  handleMessagesScroll,
  bottomRef,
  messageRefs,
  bubbleHandlersRef,
  revealedRef,
  pickSticker,
  ttsTagWords,
  highlightId,
  aiBubbleBg,
  profile,
  avatarUrl,
  displayName,
  regenId,
  ttsPlayingId,
  ttsPlayingCk,
  ttsLoadingId,
}) {
  return (
    <div
      ref={messagesScrollRef}
      onScroll={handleMessagesScroll}
      className="relative flex-1 overflow-y-auto px-4 py-4"
    >
      {/* 新对话模式的欢迎词：居中、引导提示与快捷破冰气泡 */}
      {!currentId &&
        messages.length === 0 &&
        !birthdayGreet &&
        !streamingReply &&
        !diaryReading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-6 pointer-events-none">
            <div className="w-14 h-14 rounded-2xl bg-[#fff2ec] dark:bg-[#2A221E] border border-[#f5dfd4] dark:border-[#42352D] flex items-center justify-center mb-4 shadow-sm shadow-[#b85a3c]/10">
              <img src="/logo.png" alt="Solace" className="w-9 h-9 object-contain" />
            </div>
            <p className="text-xl sm:text-2xl leading-9 text-slate-800 dark:text-[#F5DCD3] text-center font-medium tracking-tight">
              你来啦，今天打算和我分享什么？
            </p>
            <p className="text-xs sm:text-sm text-slate-500 dark:text-[#BFAFA7] mt-2 text-center max-w-sm">
              这里没有评判，也没有大道理。无论开心、疲惫还是说不清的心情，我都陪着你。
            </p>
            <div className="pointer-events-auto mt-6 flex flex-wrap justify-center gap-2 max-w-lg">
              {[
                "今天遇到一件事，想找人说说",
                "有点累，心里乱糟糟的不知从何说起",
                "今晚只想安静地待着，你在就好",
              ].map((starter) => (
                <button
                  key={starter}
                  type="button"
                  onClick={() => {
                    setInput(starter);
                    pingWarmInput();
                  }}
                  className="text-xs rounded-full bg-white/90 dark:bg-[#241F1C] border border-[#eddcd2] dark:border-[#3E342D] px-3.5 py-1.5 text-slate-600 dark:text-[#D9C8BE] hover:text-[#b85a3c] dark:hover:text-[#EFA896] hover:border-[#e2a68c] dark:hover:border-[#EFA896]/50 hover:bg-[#fff9f6] dark:hover:bg-[#302620] transition-all shadow-2xs hover:scale-[1.02] active:scale-95 cursor-pointer"
                >
                  ✦ {starter}
                </button>
              ))}
            </div>
          </div>
        )}

      {messages.map((m, index) => {
        const isUser = m.role === "user";
        // ck 是临时气泡"转正"时保持不变的渲染 key，避免 DOM 卸载导致的闪烁
        const renderKey = m.ck || m.id;
        // 正在流式输出的那条（最后一条 AI 气泡）：半截标签先不显示，免得屏幕上一闪而过
        const holdTagPartial = sending && !isUser && index === messages.length - 1;
        // AI 消息按 \n 切成多段，模拟真人连发短消息（表情包标记行不算文字）
        const parsed = isUser ? null : parseStickerMark(m.content);
        // 朗读标签展示前剥掉（与 MessageRow 共用同一个函数与同一份词表）
        const displayText =
          !isUser
            ? stripTtsTags(parsed.text, ttsTagWords, { holdPartial: holdTagPartial })
            : parsed?.text;
        const segments = isUser ? [] : splitAiSegments(displayText);
        const revealed = isUser ? 0 : revealedRef?.current?.[renderKey] ?? segments.length;
        // 回复里带了表情包标记：挑一张同分类的图（同一条回复固定同一张）
        const stickerSrc = parsed?.category && pickSticker
          ? pickSticker(`${renderKey}|${parsed.category}`, parsed.category)
          : null;
        return (
          <MessageRow
            key={renderKey}
            m={m}
            isUser={isUser}
            renderKey={renderKey}
            revealed={revealed}
            stickerSrc={stickerSrc}
            ttsTagWords={ttsTagWords}
            holdTagPartial={holdTagPartial}
            highlighted={highlightId === m.id}
            aiBubbleBg={aiBubbleBg}
            aiAvatarUrl={profile?.ai_avatar_url}
            userAvatarUrl={avatarUrl}
            displayName={displayName}
            regenId={regenId}
            sending={sending}
            ttsPlayingId={ttsPlayingId}
            ttsPlayingCk={ttsPlayingCk}
            ttsLoadingId={ttsLoadingId}
            handlers={bubbleHandlersRef}
            messageRefs={messageRefs}
          />
        );
      })}

      {/* 生日祝福：样式与普通 AI 回复完全一致（同一个 MessageRow） */}
      {birthdayGreet && (
        <MessageRow
          key={birthdayGreet.ck}
          m={birthdayGreet}
          isUser={false}
          renderKey={birthdayGreet.ck}
          revealed={999}
          stickerSrc={null}
          ttsTagWords={ttsTagWords}
          holdTagPartial={false}
          highlighted={false}
          aiBubbleBg={aiBubbleBg}
          aiAvatarUrl={profile?.ai_avatar_url}
          userAvatarUrl={avatarUrl}
          displayName={displayName}
          regenId={regenId}
          sending={sending}
          ttsPlayingId={ttsPlayingId}
          ttsPlayingCk={ttsPlayingCk}
          ttsLoadingId={ttsLoadingId}
          handlers={bubbleHandlersRef}
          messageRefs={messageRefs}
        />
      )}

      {/* 缓存未命中：先用 5 个灰色气泡占位，避免切换对话瞬间白屏 */}
      {messagesLoading && messages.length === 0 && (
        <div aria-hidden="true">
          {["w-40", "w-56", "w-32", "w-48", "w-36"].map((w, i) => (
            <div
              key={w}
              className={`flex items-start mb-3 ${
                i % 2 === 0 ? "justify-start" : "justify-end"
              }`}
            >
              <div className={`${w} h-9 rounded-2xl bg-slate-200/70 dark:bg-[#2F2722]`} />
            </div>
          ))}
        </div>
      )}

      {/* AI 思考中气泡 */}
      {pendingReply && (
        <div className="flex items-start gap-2 mb-3 justify-start">
          <AiAvatar url={profile?.ai_avatar_url} />
          <div className={`ai-msg-bubble ${aiBubbleBg} px-3 py-2 rounded-2xl rounded-bl-md flex gap-1 shadow-xs border border-[#f0eae3]/90 dark:border-[#382F28]/80`}>
            {[0, 150, 300].map((delay) => (
              <span
                key={delay}
                className="w-1.5 h-1.5 rounded-full bg-slate-400 dark:bg-[#A89890] animate-bounce"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}

