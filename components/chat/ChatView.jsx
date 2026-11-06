"use client";

import React from "react";
import MessageFeed from "./MessageFeed";

/**
 * 聊天主视窗组件：顶栏（标题/状态/菜单）、消息流视窗、首次人格引导、底部输入条
 */
export default function ChatView({
  chatBgUrl,
  isSidebarOpen,
  setIsSidebarOpen,
  currentTitle,
  profile,
  displayName,
  autoPlay,
  handleToggleAutoPlay,
  chatMenuOpen,
  setChatMenuOpen,
  aiAvatarFileRef,
  bgFileRef,
  handleAiAvatarFileChange,
  handleBgFileChange,
  // 消息流相关
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
  avatarUrl,
  regenId,
  ttsPlayingId,
  ttsPlayingCk,
  ttsLoadingId,
  // 首次人格
  personaAsking,
  setPersonaAsking,
  handlePickPersona,
  // 输入与发送
  input,
  handleSend,
  setCallTarget,
  btnBase,
  inputClass,
}) {
  return (
    <div className="flex-1 h-full flex flex-col min-w-0 relative">
      {/* 背景图层：独立一层（filter 只作用于图片，不模糊前景），cover 铺满 + 轻微降饱和 */}
      {chatBgUrl && (
        <div
          className="absolute inset-0 pointer-events-none bg-center bg-cover"
          style={{
            backgroundImage: `url(${chatBgUrl})`,
            filter: "blur(0.5px) saturate(0.9)",
          }}
        />
      )}
      {/* 暖色薄遮罩：让背景图醒目但色调统一 */}
      {chatBgUrl && (
        <div className="absolute inset-0 pointer-events-none bg-[rgba(253,251,247,0.45)] dark:bg-[rgba(28,25,23,0.55)]" />
      )}

      {/* 聊天顶栏 */}
      <div className={`relative ${chatMenuOpen ? "z-50" : "z-30"} flex items-center border-b border-[#eee4dc] dark:border-[#382F28] bg-white/70 dark:bg-[#1E1A17]/95 backdrop-blur-sm px-4 py-2.5`}>
        <button
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          title={isSidebarOpen ? "收起侧边栏" : "展开侧边栏"}
          className={`${btnBase} px-2.5 py-1 mr-2 shrink-0 hover:scale-[1.02] cursor-pointer`}
        >
          ☰
        </button>
        <span className="text-[15px] font-semibold text-slate-800 dark:text-[#F5DCD3] truncate tracking-tight">
          {currentTitle || "Solace"}
        </span>
        {profile?.username ? (
          <span className="text-xs text-slate-500 dark:text-[#BFAFA7] truncate ml-auto bg-[#faf4ef] dark:bg-[#28211E] px-2.5 py-0.5 rounded-full border border-[#f0ded4] dark:border-[#3E332B]">
            {displayName}
          </span>
        ) : (
          <span className="ml-auto" />
        )}

        {/* 自动播放语音开关 */}
        <button
          type="button"
          onClick={handleToggleAutoPlay}
          title={autoPlay ? "关闭自动播放语音" : "开启自动播放语音"}
          aria-label={autoPlay ? "关闭自动播放语音" : "开启自动播放语音"}
          aria-pressed={autoPlay}
          className={`${btnBase} w-11 h-11 sm:w-8 sm:h-8 p-0 ml-2 shrink-0 flex items-center justify-center cursor-pointer ${
            autoPlay
              ? "text-[#b85a3c] dark:text-[#EFA896] bg-[#FFF5EF] dark:bg-[#34261F] border-[#f5dfd4] dark:border-[#4B372D]"
              : "text-slate-400 dark:text-[#8D7F77] dark:bg-[#201C19] dark:border-[#382F28]"
          }`}
        >
          {autoPlay ? (
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
              <line x1="23" y1="9" x2="17" y2="15" />
              <line x1="17" y1="9" x2="23" y2="15" />
            </svg>
          )}
        </button>

        {/* 右上角更多操作下拉菜单 */}
        <button
          onClick={() => setChatMenuOpen((v) => !v)}
          title="更多"
          aria-label="更多设置"
          className={`${btnBase} w-11 h-11 sm:w-auto sm:h-auto sm:px-2 sm:py-1 p-0 ml-2 shrink-0 flex items-center justify-center text-lg leading-none hover:scale-[1.02] cursor-pointer ${
            chatMenuOpen ? "text-[#b85a3c] border-[#f0ded4] bg-[#FFF5EF] dark:bg-[#34261F]" : ""
          }`}
        >
          ⋮
        </button>
        {chatMenuOpen && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setChatMenuOpen(false)}
            />
            <div className="absolute right-2 top-full mt-1.5 z-50 w-44 bg-white/95 dark:bg-[#27211E] backdrop-blur-md rounded-2xl shadow-xl border border-[#ede3dc] dark:border-[#3E332B] p-1.5 overflow-hidden">
              <button
                type="button"
                onClick={() => {
                  setChatMenuOpen(false);
                  if (aiAvatarFileRef?.current) {
                    aiAvatarFileRef.current.value = "";
                    aiAvatarFileRef.current.click();
                  }
                }}
                className="w-full text-left px-3 py-2 text-sm text-slate-700 dark:text-[#E8D5CC] rounded-xl hover:bg-[#FAF7F4] dark:hover:bg-[#342A24] hover:text-[#b85a3c] dark:hover:text-[#EFA896] transition-colors cursor-pointer flex items-center justify-between"
              >
                <span>修改 AI 头像</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setChatMenuOpen(false);
                  if (bgFileRef?.current) {
                    bgFileRef.current.value = "";
                    bgFileRef.current.click();
                  }
                }}
                className="w-full text-left px-3 py-2 text-sm text-slate-700 dark:text-[#E8D5CC] rounded-xl hover:bg-[#FAF7F4] dark:hover:bg-[#342A24] hover:text-[#b85a3c] dark:hover:text-[#EFA896] transition-colors cursor-pointer flex items-center justify-between"
              >
                <span>修改聊天背景</span>
              </button>
            </div>
          </>
        )}
      </div>

      {/* 消息展示流 */}
      <MessageFeed
        messages={messages}
        currentId={currentId}
        birthdayGreet={birthdayGreet}
        streamingReply={streamingReply}
        diaryReading={diaryReading}
        messagesLoading={messagesLoading}
        pendingReply={pendingReply}
        sending={sending}
        setInput={setInput}
        pingWarmInput={pingWarmInput}
        messagesScrollRef={messagesScrollRef}
        handleMessagesScroll={handleMessagesScroll}
        bottomRef={bottomRef}
        messageRefs={messageRefs}
        bubbleHandlersRef={bubbleHandlersRef}
        revealedRef={revealedRef}
        pickSticker={pickSticker}
        ttsTagWords={ttsTagWords}
        highlightId={highlightId}
        aiBubbleBg={aiBubbleBg}
        profile={profile}
        avatarUrl={avatarUrl}
        displayName={displayName}
        regenId={regenId}
        ttsPlayingId={ttsPlayingId}
        ttsPlayingCk={ttsPlayingCk}
        ttsLoadingId={ttsLoadingId}
      />

      {/* 首次进入时的 AI 人格选择浮层 */}
      {personaAsking && (
        <div className="modal-fade fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-6">
          <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-[#251F1C] border border-transparent dark:border-[#382F28] p-5 shadow-xl">
            <h3 className="text-base font-bold text-slate-800 dark:text-[#F5DCD3]">想让我以什么身份陪你？</h3>
            <p className="text-xs text-slate-500 dark:text-[#BFAFA7] mt-1 leading-relaxed">
              这是选 <span className="font-medium text-slate-600 dark:text-[#D1C0B6]">AI 的身份</span>，
              <span className="font-medium text-slate-600 dark:text-[#D1C0B6]">不是选你自己的性别</span>。
              选一个你觉得舒服的就好，之后随时能在「我的 → 设置 → AI 提示词性别」里换。
            </p>
            <div className="flex gap-3 mt-4">
              <button
                type="button"
                onClick={() => handlePickPersona("female")}
                className="flex-1 p-3 rounded-xl border border-[#d5d9d7] dark:border-[#3E332B] bg-[#fdfdfc] dark:bg-[#2B231E] text-slate-700 dark:text-[#F5DCD3] hover:bg-[#e8eff2] dark:hover:bg-[#342A24] hover:scale-[1.02] active:scale-[0.98] transition-all duration-150 cursor-pointer"
              >
                <span className="block text-lg">她</span>
                <span className="block text-xs text-slate-500 dark:text-[#BFAFA7] mt-1">温柔的女性朋友</span>
              </button>
              <button
                type="button"
                onClick={() => handlePickPersona("male")}
                className="flex-1 p-3 rounded-xl border border-[#d5d9d7] dark:border-[#3E332B] bg-[#fdfdfc] dark:bg-[#2B231E] text-slate-700 dark:text-[#F5DCD3] hover:bg-[#e8eff2] dark:hover:bg-[#342A24] hover:scale-[1.02] active:scale-[0.98] transition-all duration-150 cursor-pointer"
              >
                <span className="block text-lg">他</span>
                <span className="block text-xs text-slate-500 dark:text-[#BFAFA7] mt-1">温和的男性朋友</span>
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                setPersonaAsking(false);
                try {
                  localStorage.setItem("solace_persona_asked", "1");
                } catch {
                  // 存储不可用不影响
                }
              }}
              className="w-full mt-3 text-xs text-slate-400 dark:text-[#8D7F77] hover:text-slate-600 dark:hover:text-[#F5DCD3] transition-colors cursor-pointer"
            >
              先不选，以后再说
            </button>
          </div>
        </div>
      )}

      {/* 底部输入条与紧急援助热线 */}
      <div data-chat-input-bar className="relative z-10 px-3 pb-2.5">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              pingWarmInput();
            }}
            onFocus={() => pingWarmInput()}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing)
                handleSend();
            }}
            placeholder="说点什么，说什么都可以…"
            className={inputClass}
          />
          <button
            data-chat-send
            onClick={handleSend}
            disabled={sending}
            className="bg-gradient-to-r from-[#c06b50] to-[#b85a3c] text-white rounded-xl px-5 py-2.5 text-sm font-medium shadow-sm shadow-[#b85a3c]/20 hover:from-[#b05f45] hover:to-[#a84f33] active:scale-[0.98] transition-all duration-150 shrink-0 flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sending ? (
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" style={{ animationDelay: "150ms" }} />
                <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" style={{ animationDelay: "300ms" }} />
              </span>
            ) : (
              "发送"
            )}
          </button>
        </div>
        <p className="text-[11px] text-slate-400 dark:text-[#9A8B83] text-center mt-2 leading-relaxed">
          Solace 倾听陪伴你的每一个当下，不能替代专业心理诊疗。如遇紧急困扰，请随时拨打免费援助热线：
          <a
            href="tel:12356"
            onClick={(e) => {
              e.preventDefault();
              setCallTarget({ number: "12356", title: "全国心理援助热线 12356" });
            }}
            className="text-[#b85a3c] dark:text-[#EFA896] hover:underline font-semibold mx-1 cursor-pointer transition-colors"
          >
            12356
          </a>
          /
          <a
            href="tel:4001619995"
            onClick={(e) => {
              e.preventDefault();
              setCallTarget({ number: "400-161-9995", title: "全国心理危机干预热线" });
            }}
            className="text-[#b85a3c] dark:text-[#EFA896] hover:underline font-semibold mx-1 cursor-pointer transition-colors"
          >
            400-161-9995
          </a>
        </p>
      </div>
    </div>
  );
}

