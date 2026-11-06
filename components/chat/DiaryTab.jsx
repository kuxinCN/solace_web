"use client";

import React from "react";
import MoodPicker, { MoodBadge } from "@/components/MoodPicker";
import DiaryReleaseZone, { releaseIsBlank } from "./DiaryReleaseZone";

// 日期格式化为 "2026年9月18日"
export function formatDateCN(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 日记板块完整组件：包含名片微组件、日记双 Tab、日记列表、写日记/编辑/查看详情与涂抹释放
 */
export default function DiaryTab({
  isMobile,
  avatarUrl,
  displayName,
  profile,
  openBioModal,
  diaryTab,
  setDiaryTab,
  diaryTabList,
  sortedDiaries,
  diaryView,
  setDiaryView,
  diaryCreating,
  setDiaryCreating,
  diaryEdit,
  setDiaryEdit,
  diaryMultiMode,
  setDiaryMultiMode,
  selectedDiaryIds,
  setSelectedDiaryIds,
  toggleDiaryMultiMode,
  toggleDiarySelectAll,
  toggleDiarySelect,
  handleOpenDiary,
  toggleDiaryFlag,
  handleDeleteDiary,
  handlePinSelectedDiaries,
  handleDeleteSelectedDiaries,
  selectedDiariesAllPinned,
  // 表单状态
  diaryTitle,
  setDiaryTitle,
  diaryContent,
  setDiaryContent,
  diaryMood,
  setDiaryMood,
  savingDiary,
  handleSaveDiary,
  handleDiaryRelease,
  diaryEditTitle,
  setDiaryEditTitle,
  diaryEditContent,
  setDiaryEditContent,
  diaryEditMood,
  setDiaryEditMood,
  handleSaveEditDiary,
  handleReadDiary,
  diaryReading,
  btnBase,
  inputClass,
}) {
  return (
    <div className="tab-fade h-full max-w-5xl mx-auto flex flex-col px-4 py-5">
      {/* 顶部个性化卡片：头像 + 昵称 + 个性签名 */}
      <div className="flex items-center gap-4 bg-white/95 dark:bg-[#201C19] rounded-2xl shadow-xs border border-[#eee4dc] dark:border-[#382F28] px-5 py-4 mb-4 shrink-0">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt="我"
            className="w-[60px] h-[60px] rounded-full object-cover shrink-0 shadow-xs border border-[#ebd8ce] dark:border-[#42352E]"
          />
        ) : (
          <div className="w-[60px] h-[60px] rounded-full bg-gradient-to-br from-[#d97c62] to-[#b85a3c] flex items-center justify-center text-white text-xl font-bold shrink-0 shadow-xs">
            {(displayName || "我").charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <p className="text-base font-bold text-slate-800 dark:text-[#F5DCD3] truncate">
            {profile?.username || "未设置昵称"}
          </p>
          <p
            onClick={openBioModal}
            title="点击修改签名"
            className="text-xs text-slate-400 dark:text-[#9A8B83] truncate mt-0.5 cursor-pointer hover:text-slate-600 dark:hover:text-[#F5DCD3] transition-colors duration-150"
          >
            {profile?.bio || "写一句想说的话吧"}
          </p>
        </div>
      </div>

      {/* 顶部双 Tab：【我的日记】/【暖言小记】 */}
      <div className="shrink-0 mb-4 flex items-center gap-1.5 p-1 rounded-2xl bg-[#f5ece5]/80 dark:bg-[#251F1C] border border-[#efe3d8]/80 dark:border-[#382F28]">
        {[
          { key: "user", label: "我的日记" },
          { key: "ai", label: "暖言小记" },
        ].map((tab) => {
          const active = diaryTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => {
                if (diaryTab === tab.key) return;
                setDiaryTab(tab.key);
                setDiaryView(null);
                setDiaryCreating(false);
                setDiaryEdit(false);
                setDiaryMultiMode(false);
                setSelectedDiaryIds([]);
              }}
              className={`flex-1 rounded-xl py-2 text-sm font-medium transition-all duration-150 cursor-pointer ${
                active
                  ? "bg-white dark:bg-[#342A24] text-[#b85a3c] dark:text-[#EFA896] font-semibold shadow-xs"
                  : "text-slate-600 dark:text-[#BFAFA7] hover:text-slate-900 dark:hover:text-[#F5DCD3] hover:bg-white/50 dark:hover:bg-white/5"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* 双栏：左列表 35% / 右详情 65% */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-4">
        {/* 左栏：日记列表 */}
        {(!isMobile || (!diaryView && !diaryCreating)) && (
          <div className="w-full lg:w-[35%] shrink-0 flex flex-col min-h-0">
            <div className="flex items-center gap-2 shrink-0 mb-3">
              {diaryTab === "user" && (
                <button
                  onClick={() => {
                    setDiaryTitle("");
                    setDiaryContent("");
                    setDiaryView(null);
                    setDiaryCreating(true);
                  }}
                  className="flex-1 bg-gradient-to-r from-[#c06b50] to-[#b85a3c] text-white rounded-xl py-2.5 text-sm font-medium shadow-sm shadow-[#b85a3c]/20 hover:from-[#b05f45] hover:to-[#a84f33] active:scale-[0.99] transition-all duration-150 cursor-pointer"
                >
                  ＋ 写日记
                </button>
              )}
              {diaryTab === "ai" && (
                <p className="flex-1 text-xs text-slate-400 dark:text-[#9A8B83] px-1">
                  暖言会在每天夜里，把当天聊到的写进这里
                </p>
              )}
              {diaryTabList.length > 0 && (
                <button
                  onClick={toggleDiaryMultiMode}
                  className={`shrink-0 rounded-xl px-3 py-2.5 text-sm border active:scale-[0.98] transition-all duration-150 cursor-pointer ${
                    diaryMultiMode
                      ? "border-[#e2a68c] dark:border-[#523B30] bg-[#FFF5EF] dark:bg-[#342721] text-[#b85a3c] dark:text-[#EFA896]"
                      : "border-[#ebe3dc] dark:border-[#382F28] bg-white dark:bg-[#201C19] text-slate-600 dark:text-[#D1C0B6] hover:bg-[#FAF7F4] dark:hover:bg-[#2A231F]"
                  }`}
                >
                  {diaryMultiMode ? "取消" : "多选"}
                </button>
              )}
            </div>

            {/* 多选工具条 */}
            {diaryMultiMode && diaryTabList.length > 0 && (
              <div className="flex items-center gap-3 shrink-0 mb-2 px-1">
                <button
                  onClick={toggleDiarySelectAll}
                  className="text-xs text-[#b85a3c] dark:text-[#EFA896] hover:underline transition-colors cursor-pointer"
                >
                  {selectedDiaryIds.length === diaryTabList.length ? "取消全选" : "全选"}
                </button>
                <span className="text-xs text-slate-400 dark:text-[#8D7F77]">共 {diaryTabList.length} 篇</span>
              </div>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
              {diaryTabList.length === 0 && (
                <div className="msg-in text-center py-8">
                  <svg
                    width="72"
                    height="72"
                    viewBox="0 0 72 72"
                    fill="none"
                    aria-hidden="true"
                    className="mx-auto"
                  >
                    <rect
                      x="14"
                      y="10"
                      width="34"
                      height="46"
                      rx="4"
                      stroke="#d97c62"
                      strokeWidth="2"
                    />
                    <line
                      x1="20"
                      y1="20"
                      x2="42"
                      y2="20"
                      stroke="#d97c62"
                      strokeWidth="2"
                      strokeLinecap="round"
                      opacity="0.45"
                    />
                    <line
                      x1="20"
                      y1="28"
                      x2="38"
                      y2="28"
                      stroke="#d97c62"
                      strokeWidth="2"
                      strokeLinecap="round"
                      opacity="0.45"
                    />
                    <line
                      x1="20"
                      y1="36"
                      x2="40"
                      y2="36"
                      stroke="#d97c62"
                      strokeWidth="2"
                      strokeLinecap="round"
                      opacity="0.45"
                    />
                    <line
                      x1="43"
                      y1="57"
                      x2="58"
                      y2="29"
                      stroke="#d97c62"
                      strokeWidth="3"
                      strokeLinecap="round"
                    />
                    <line
                      x1="58"
                      y1="29"
                      x2="61"
                      y2="22"
                      stroke="#b85a3c"
                      strokeWidth="3"
                      strokeLinecap="round"
                    />
                    <path
                      d="M56 18c-2.8-2.2-4.5-3.9-4.5-6a3.5 3.5 0 0 1 4.5-3.3 3.5 3.5 0 0 1 4.5 3.3c0 2.1-1.7 3.8-4.5 6z"
                      fill="#b85a3c"
                      opacity="0.85"
                    />
                  </svg>
                  <p className="text-sm text-slate-400 dark:text-[#8D7F77] mt-3">
                    {diaryTab === "ai"
                      ? "暖言还没为你写过日记，多聊聊，今晚就有了。"
                      : "还没有日记，慢慢写一篇吧。"}
                  </p>
                  {diaryTab === "user" && (
                    <button
                      onClick={() => {
                        setDiaryTitle("");
                        setDiaryContent("");
                        setDiaryView(null);
                        setDiaryCreating(true);
                      }}
                      className="mt-4 border border-[#e2a68c] dark:border-[#4B392F] bg-[#FFF5EF] dark:bg-[#251F1C] text-[#b85a3c] dark:text-[#EFA896] rounded-xl px-5 py-2 text-sm font-medium hover:bg-[#faeee7] dark:hover:bg-[#302620] active:scale-[0.98] transition-all duration-150 cursor-pointer shadow-2xs"
                    >
                      写第一篇
                    </button>
                  )}
                </div>
              )}
              {sortedDiaries.map((d) => {
                const selected = diaryView?.id === d.id;
                const checked = selectedDiaryIds.includes(d.id);
                const pinned = d.is_pinned === 1 || d.is_pinned === true;
                const favorited = d.is_favorited === 1 || d.is_favorited === true;
                const isAiDiary = d.source === "ai";
                return (
                  <div
                    key={d.id}
                    onClick={() => {
                      if (diaryMultiMode) {
                        toggleDiarySelect(d.id);
                        return;
                      }
                      setDiaryCreating(false);
                      handleOpenDiary(d);
                    }}
                    className={`group relative rounded-xl border px-3 py-2.5 cursor-pointer transition-all duration-150 ${
                      (diaryMultiMode && checked) || selected
                        ? "bg-[#FFF5EF] dark:bg-[#342721] border-[#e2a68c] dark:border-[#523B30] shadow-xs"
                        : isAiDiary
                          ? "bg-[#FAF7F4] dark:bg-[#201B18] border-[#eee4dc] dark:border-[#382F28] hover:bg-[#f6ede5] dark:hover:bg-[#2A231F]"
                          : "bg-white dark:bg-[#251F1C] border-[#eee4dc] dark:border-[#382F28] hover:bg-[#FAF7F4] dark:hover:bg-[#2E2520] hover:shadow-2xs"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {diaryMultiMode && (
                        <span
                          className={`w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center shrink-0 transition-all duration-150 ${
                            checked
                              ? "border-[#b85a3c] bg-[#b85a3c]"
                              : "border-[#cfd8dd] dark:border-[#4E3E34] bg-white dark:bg-[#201B18]"
                          }`}
                        >
                          {checked && (
                            <svg
                              className="w-3 h-3 text-white"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="3.5"
                            >
                              <path
                                d="M20 6L9 17l-5-5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </span>
                      )}
                      <p
                        className={`text-sm text-slate-700 dark:text-[#F5DCD3] truncate font-medium flex-1 min-w-0 ${
                          diaryMultiMode ? "pr-1" : "pr-[76px]"
                        }`}
                      >
                        {isAiDiary && (
                          <span className="mr-1.5 align-middle inline-flex items-center rounded px-1.5 py-[1px] text-[10px] font-normal text-[#b85a3c] dark:text-[#EFA896] bg-[#FFF5EF] dark:bg-[#3A2A22] border border-[#f5dfd4] dark:border-[#533D32]">
                            暖言
                          </span>
                        )}
                        {d.title}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 mt-1">
                      <span className="flex shrink-0 items-center gap-1">
                        <MoodBadge mood={d.user_mood} source="user" />
                        <MoodBadge mood={d.mood} source="ai" />
                      </span>
                      <p className="flex-1 min-w-0 truncate text-xs text-slate-400 dark:text-[#9A8B83]">
                        {(d.content || "").slice(0, 30) || "（空）"}
                        {(d.content || "").length > 30 ? "…" : ""}
                      </p>
                      <span className="shrink-0 text-xs text-slate-300 dark:text-[#807068]">
                        {formatDateCN(d.diary_date || d.created_at)}
                      </span>
                    </div>

                    {!diaryMultiMode && (
                      <div className="absolute top-2 right-2 flex items-center gap-0.5">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleDiaryFlag(d, "is_pinned");
                          }}
                          title={pinned ? "取消置顶" : "置顶"}
                          className={`w-6 h-6 rounded-md flex items-center justify-center transition-all duration-150 ${
                            pinned
                              ? "text-[#b85a3c] bg-[#FFF5EF] dark:bg-[#342721] opacity-100"
                              : "text-slate-300 hover:text-[#b85a3c] hover:bg-[#FFF5EF] dark:hover:bg-[#342721] opacity-0 group-hover:opacity-100"
                          }`}
                        >
                          <svg
                            className="w-3.5 h-3.5"
                            viewBox="0 0 24 24"
                            fill={pinned ? "currentColor" : "none"}
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M12 17v5" />
                            <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a1 1 0 0 0 0-2H8a1 1 0 0 0 0 2h1z" />
                          </svg>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleDiaryFlag(d, "is_favorited");
                          }}
                          title={favorited ? "取消收藏" : "收藏"}
                          className={`w-6 h-6 rounded-md flex items-center justify-center transition-all duration-150 ${
                            favorited
                              ? "text-[#c68b2e] bg-[#fdf5e4] dark:bg-[#3D301E] opacity-100"
                              : "text-slate-300 hover:text-[#c68b2e] hover:bg-[#fdf5e4] dark:hover:bg-[#3D301E] opacity-0 group-hover:opacity-100"
                          }`}
                        >
                          <svg
                            className="w-3.5 h-3.5"
                            viewBox="0 0 24 24"
                            fill={favorited ? "currentColor" : "none"}
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                          </svg>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteDiary(d);
                          }}
                          title="删除这篇日记"
                          className="w-6 h-6 rounded-md flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 opacity-0 group-hover:opacity-100 transition-all duration-150"
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
                            <path d="M3 6h18" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            <line x1="10" y1="11" x2="10" y2="17" />
                            <line x1="14" y1="11" x2="14" y2="17" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 多选底部固定操作栏 */}
            {diaryMultiMode && selectedDiaryIds.length > 0 && (
              <div className="shrink-0 mt-2 flex items-center gap-2 px-3 py-2 rounded-xl bg-[#faeee7] dark:bg-[#342721] border border-[#f2ded5] dark:border-[#4B372D]">
                <span className="text-xs text-slate-500 dark:text-[#BFAFA7]">
                  已选中 {selectedDiaryIds.length} 条
                </span>
                <button
                  onClick={handlePinSelectedDiaries}
                  className="ml-auto border border-[#e2a68c] dark:border-[#523B30] bg-white dark:bg-[#251F1C] text-[#b85a3c] dark:text-[#EFA896] rounded-lg px-2.5 py-1.5 text-xs hover:bg-[#FFF5EF] dark:hover:bg-[#302620] active:scale-[0.98] transition-all duration-150 cursor-pointer"
                >
                  {selectedDiariesAllPinned ? "取消置顶" : "置顶选中"}
                </button>
                <button
                  onClick={handleDeleteSelectedDiaries}
                  className="border border-[#e8a38c] bg-[#b85a3c] text-white rounded-lg px-2.5 py-1.5 text-xs hover:bg-[#a34f33] active:scale-[0.98] shadow-sm transition-all duration-150 cursor-pointer"
                >
                  删除选中
                </button>
              </div>
            )}
          </div>
        )}

        {/* 右栏：详情 / 编辑 / 新建 */}
        {(!isMobile || diaryView || diaryCreating) && (
          <div className="w-full lg:flex-1 min-w-0 bg-white dark:bg-[#201C19] rounded-2xl shadow-sm border border-[#e8eae7] dark:border-[#382F28] p-5 overflow-y-auto relative">
            {isMobile && (
              <button
                onClick={() => {
                  setDiaryView(null);
                  setDiaryEdit(false);
                  setDiaryCreating(false);
                }}
                className="absolute top-3 right-3 z-10 text-xs text-slate-500 dark:text-[#A89890] border border-[#e8eae7] dark:border-[#382F28] bg-[#fafaf8] dark:bg-[#251F1C] rounded-lg px-2.5 py-1.5 hover:bg-[#f0f4f6] dark:hover:bg-[#302620] transition-colors duration-150"
              >
                ← 返回
              </button>
            )}

            {((!isMobile && !diaryView) || diaryCreating) ? (
              /* 新建表单 */
              <div>
                <h2 className="text-lg font-bold text-slate-800 dark:text-[#F5DCD3] mb-3">
                  写日记
                </h2>
                <DiaryReleaseZone
                  onRelease={() => handleDiaryRelease("new")}
                  isEmpty={() => releaseIsBlank(diaryTitle) && releaseIsBlank(diaryContent)}
                >
                  <input
                    type="text"
                    value={diaryTitle}
                    onChange={(e) => setDiaryTitle(e.target.value)}
                    placeholder="日记标题"
                    className={`${inputClass} mb-3`}
                  />
                  <textarea
                    value={diaryContent}
                    onChange={(e) => setDiaryContent(e.target.value)}
                    placeholder="今天发生了什么？慢慢写，我在。"
                    className={`${inputClass} resize-none`}
                    rows={10}
                  />

                  <div className="mb-3">
                    <p className="text-xs text-slate-500 dark:text-[#BFAFA7] mb-1.5 font-medium">今天的心情（可跳过）</p>
                    <MoodPicker value={diaryMood} onChange={setDiaryMood} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => handleSaveDiary(false)}
                      disabled={savingDiary}
                      className="border border-[#e2a68c] dark:border-[#4B392F] bg-white dark:bg-[#251F1C] text-[#b85a3c] dark:text-[#EFA896] rounded-xl py-2.5 text-sm font-semibold hover:bg-[#fff9f6] dark:hover:bg-[#302620] active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 cursor-pointer"
                    >
                      {savingDiary ? "保存中..." : "保存日记"}
                    </button>
                    <button
                      onClick={() => handleSaveDiary(true)}
                      disabled={savingDiary}
                      className="border border-[#b85a3c] dark:border-[#D97C62] bg-gradient-to-r from-[#c06b50] to-[#b85a3c] text-white rounded-xl py-2.5 text-sm font-semibold shadow-sm shadow-[#b85a3c]/20 hover:from-[#b05f45] hover:to-[#a84f33] active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 cursor-pointer"
                    >
                      {savingDiary ? "保存中..." : "保存并发送给 AI"}
                    </button>
                  </div>
                </DiaryReleaseZone>
              </div>
            ) : diaryView && diaryEdit ? (
              /* 编辑态 */
              <div>
                <h2 className="text-lg font-bold text-slate-800 dark:text-[#F5DCD3] mb-3">
                  编辑日记
                </h2>
                <DiaryReleaseZone
                  onRelease={() => handleDiaryRelease("edit")}
                  isEmpty={() => releaseIsBlank(diaryEditTitle) && releaseIsBlank(diaryEditContent)}
                >
                  <input
                    type="text"
                    value={diaryEditTitle}
                    onChange={(e) => setDiaryEditTitle(e.target.value)}
                    placeholder="日记标题"
                    className={`${inputClass} mb-3`}
                  />
                  <textarea
                    value={diaryEditContent}
                    onChange={(e) => setDiaryEditContent(e.target.value)}
                    placeholder="今天发生了什么？慢慢写，我在。"
                    className={`${inputClass} resize-none`}
                    rows={10}
                  />
                  <div className="mb-3">
                    <p className="text-xs text-slate-500 dark:text-[#BFAFA7] mb-1.5 font-medium">心情标签</p>
                    <MoodPicker value={diaryEditMood} onChange={setDiaryEditMood} />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleSaveEditDiary}
                      disabled={savingDiary}
                      className="border border-[#b85a3c] dark:border-[#D97C62] bg-gradient-to-r from-[#c06b50] to-[#b85a3c] text-white rounded-xl px-5 py-2 text-sm font-semibold shadow-sm shadow-[#b85a3c]/20 hover:from-[#b05f45] hover:to-[#a84f33] active:scale-[0.98] disabled:opacity-50 transition-all cursor-pointer"
                    >
                      {savingDiary ? "保存中..." : "保存"}
                    </button>
                    <button
                      onClick={() => setDiaryEdit(false)}
                      className={`${btnBase} px-4 py-2 text-sm`}
                    >
                      取消
                    </button>
                  </div>
                </DiaryReleaseZone>
              </div>
            ) : diaryView ? (
              /* 详情态 */
              <div>
                <p className="text-xs text-slate-400 dark:text-[#8D7F77] mb-1">
                  {formatDateCN(diaryView.diary_date || diaryView.created_at)}
                  {diaryView.source === "ai" ? (
                    <span className="ml-1 text-slate-400 dark:text-[#8D7F77]">· 这天的聊天整理</span>
                  ) : null}
                </p>
                <div className="flex items-start justify-between gap-2 mb-3">
                  <h2 className="text-xl font-bold text-slate-800 dark:text-[#F5DCD3] break-words">
                    {diaryView.title}
                  </h2>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1 pt-1">
                    {diaryView.source === "ai" ? (
                      <span
                        className="rounded-full bg-[#f3f0f8] dark:bg-[#342738] px-2 py-0.5 text-[11px] text-[#8a7aa8] dark:text-[#C4B3DD]"
                        title="这篇是 AI 根据你那天和它聊的内容整理的"
                      >
                        AI 生成
                        {diaryView.diary_date
                          ? ` · ${String(diaryView.diary_date).slice(5).replace("-", "/")}`
                          : ""}
                      </span>
                    ) : null}
                    <MoodBadge mood={diaryView.user_mood} source="user" />
                    <MoodBadge mood={diaryView.mood} source="ai" />
                  </div>
                </div>
                <div className="text-sm text-slate-700 dark:text-[#E8D5CC] leading-7 whitespace-pre-wrap break-words mb-4">
                  {diaryView.content}
                </div>
                <div className="flex flex-wrap gap-2 border-t border-[#e8eae7] dark:border-[#382F28] pt-3">
                  <button
                    onClick={() => {
                      setDiaryEdit(true);
                      setDiaryEditTitle(diaryView.title || "");
                      setDiaryEditContent(diaryView.content || "");
                      setDiaryEditMood(diaryView.user_mood || "");
                    }}
                    className={`${btnBase} px-3 py-1.5 text-sm`}
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => handleDeleteDiary()}
                    className={`${btnBase} px-3 py-1.5 text-sm text-[#c0654a] dark:text-[#EFA896] hover:bg-[#fbeee8] dark:hover:bg-[#3D2920]`}
                  >
                    删除
                  </button>
                  <button
                    onClick={handleReadDiary}
                    disabled={diaryReading}
                    className="border border-[#e2a68c] dark:border-[#4B392F] bg-white dark:bg-[#251F1C] text-[#b85a3c] dark:text-[#EFA896] rounded-xl px-3 py-1.5 text-sm hover:bg-[#fff9f6] dark:hover:bg-[#302620] disabled:opacity-50 transition-all cursor-pointer"
                  >
                    {diaryReading ? "正在读…" : "让AI读读这篇"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

