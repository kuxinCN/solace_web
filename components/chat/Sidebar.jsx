"use client";

import React from "react";

// 今天 / 昨天 / X天前 / 具体日期（今年 M/D，跨年 YYYY/M/D）。
// 侧边栏行内时间与分组标题共用，保证两处口径一致。
export function friendlyTimeLabel(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today - that) / 86400000);
  if (diffDays <= 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays <= 6) return `${diffDays}天前`;
  return d.getFullYear() === now.getFullYear()
    ? `${d.getMonth() + 1}/${d.getDate()}`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

// 截取命中关键词附近的一小段文字，用于搜索结果预览
export function snippetAround(content, keyword) {
  const text = content || "";
  const idx = text.toLowerCase().indexOf(keyword);
  if (idx < 0) return text.slice(0, 30);
  const start = Math.max(0, idx - 8);
  const end = Math.min(text.length, idx + keyword.length + 20);
  return (start > 0 ? "…" : "") + text.slice(start, end);
}

// 单条对话行：复选框(多选) / 标题(或重命名输入框) / 摘要 / 时间 / ··· 菜单
export function ConvRow({
  c,
  snippet,
  selected,
  multi,
  currentId,
  renaming,
  renameValue,
  menuOpen,
  onOpen,
  onToggleSelect,
  onMenu,
  onRename,
  onRenameCommit,
  onRenameCancel,
  setRenameValue,
  onPin,
  onMultiSelect,
  onShare,
  onDelete,
  closeMenu,
}) {
  const timeLabel = friendlyTimeLabel(c.last_message_at || c.created_at);

  return (
    <div
      onClick={multi ? onToggleSelect : onOpen}
      className={`group relative flex items-center gap-1.5 rounded-xl p-2.5 mb-1 cursor-pointer transition-all duration-150 ${
        multi && selected
          ? "bg-[#faeee7] dark:bg-[#342721] text-slate-900 dark:text-[#F5DCD3] border border-[#f2ded5] dark:border-[#4B372D]"
          : c.id === currentId
          ? "bg-white dark:bg-[#2A231F] text-slate-900 dark:text-[#FFF5F0] font-medium shadow-xs border-l-[3px] border-l-[#b85a3c] dark:border-l-[#D97C62] border-y border-r border-[#ece3dc] dark:border-[#3A3029]"
          : "text-slate-700 dark:text-[#D1C0B6] hover:bg-white/70 dark:hover:bg-[#251F1C] hover:shadow-2xs"
      }`}
    >
      {/* 多选复选框 */}
      {multi && (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
          className="w-4 h-4 accent-[#b85a3c] shrink-0"
        />
      )}

      {/* 主体：标题 / 重命名输入框 + 摘要 */}
      <div className="min-w-0 flex-1">
        {renaming ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRenameCommit(c.id);
              if (e.key === "Escape") onRenameCancel();
            }}
            className="w-full border border-[#e2a68c] rounded-lg px-2 py-1 text-sm bg-white dark:bg-[#231E1B] text-slate-800 dark:text-[#F5DCD3] outline-none focus:ring-1 focus:ring-[#e2a68c]"
          />
        ) : (
          <p className="truncate text-sm">{c.title}</p>
        )}
        {snippet && !renaming && (
          <p className="text-xs text-slate-400 dark:text-[#8D7F77] truncate font-normal">{snippet}</p>
        )}
      </div>

      {/* 右侧：时间 + ··· 菜单（多选/重命名时隐藏） */}
      {!multi && !renaming && (
        <div className="flex items-center gap-1 shrink-0">
          {timeLabel && (
            <span className="text-[10px] text-slate-400 dark:text-[#8D7F77]">{timeLabel}</span>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMenu();
            }}
            title="更多操作"
            className="text-slate-400 dark:text-[#8D7F77] hover:text-slate-700 dark:hover:text-[#F5DCD3] px-1 rounded transition-colors duration-150 cursor-pointer"
          >
            ⋯
          </button>
        </div>
      )}

      {/* 下拉菜单 */}
      {menuOpen && !multi && !renaming && (
        <>
          <div className="fixed inset-0 z-40" onClick={closeMenu} />
          <div className="absolute right-0 top-8 z-50 w-32 bg-white dark:bg-[#27211E] rounded-lg shadow-lg border border-[#e8eae7] dark:border-[#3E332B] py-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRename(c);
              }}
              className="w-full text-left px-3 py-1.5 text-sm text-slate-700 dark:text-[#E8D5CC] hover:bg-[#eef1f2] dark:hover:bg-[#342A24] cursor-pointer"
            >
              重命名
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onPin(c.id);
              }}
              className="w-full text-left px-3 py-1.5 text-sm text-slate-700 dark:text-[#E8D5CC] hover:bg-[#eef1f2] dark:hover:bg-[#342A24] cursor-pointer"
            >
              {c.pinned ? "取消置顶" : "置顶"}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onShare(c);
              }}
              className="w-full text-left px-3 py-1.5 text-sm text-slate-700 dark:text-[#E8D5CC] hover:bg-[#eef1f2] dark:hover:bg-[#342A24] cursor-pointer"
            >
              分享
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onMultiSelect();
              }}
              className="w-full text-left px-3 py-1.5 text-sm text-slate-700 dark:text-[#E8D5CC] hover:bg-[#eef1f2] dark:hover:bg-[#342A24] cursor-pointer"
            >
              多选
            </button>
            <div className="my-0.5 border-t border-[#e8eae7] dark:border-[#382F28]" />
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(c.id);
              }}
              className="w-full text-left px-3 py-1.5 text-sm text-[#c0654a] dark:text-[#EFA896] hover:bg-[#fbeee8] dark:hover:bg-[#3D2920] cursor-pointer"
            >
              删除
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// 置顶区 + 时间轴分组布局
export function ConversationGroups({
  conversations,
  multiSelectMode,
  selectedIds,
  currentId,
  renamingId,
  renameValue,
  menuOpenId,
  timeGroupLabel,
  onOpen,
  onToggleSelect,
  setMenuOpenId,
  setRename,
  onRename,
  onRenameCommit,
  onRenameCancel,
  onPin,
  onMultiSelect,
  onShare,
  onDelete,
}) {
  const pinned = conversations
    .filter((c) => c.pinned)
    .sort((a, b) => new Date(b.pinned_at || 0) - new Date(a.pinned_at || 0));
  const unpinned = conversations
    .filter((c) => !c.pinned)
    .sort(
      (a, b) =>
        new Date(b.last_message_at || b.created_at || 0) -
        new Date(a.last_message_at || a.created_at || 0)
    );

  // 按活动时间标签分组
  const groups = {};
  for (const c of unpinned) {
    const label = timeGroupLabel(c.last_message_at || c.created_at);
    if (!groups[label]) groups[label] = [];
    groups[label].push(c);
  }

  const renderRow = (c) => (
    <ConvRow
      key={c.id}
      c={c}
      snippet=""
      selected={selectedIds.includes(c.id)}
      multi={multiSelectMode}
      currentId={currentId}
      renaming={renamingId === c.id}
      renameValue={renameValue}
      menuOpen={menuOpenId === c.id}
      onOpen={() => onOpen(c)}
      onToggleSelect={() => onToggleSelect(c.id)}
      onMenu={() => setMenuOpenId(menuOpenId === c.id ? null : c.id)}
      onRename={() => onRename(c)}
      onRenameCommit={() => onRenameCommit(c.id)}
      onRenameCancel={onRenameCancel}
      setRenameValue={setRename}
      onPin={() => onPin(c.id)}
      onMultiSelect={onMultiSelect}
      onShare={() => onShare(c)}
      onDelete={() => onDelete(c.id)}
      closeMenu={() => setMenuOpenId(null)}
    />
  );

  return (
    <>
      {/* 置顶区 */}
      {pinned.length > 0 && (
        <div className="mb-1">
          <p className="text-[11px] text-slate-400 dark:text-[#A89890] px-2 py-1 font-medium">置顶</p>
          {pinned.map(renderRow)}
          <div className="border-t border-[#e0e3e0] dark:border-[#382F28] my-1.5 mx-2" />
        </div>
      )}

      {/* 时间轴分组 */}
      {Object.keys(groups).map((label) => (
        <div key={label} className="mb-1">
          <p className="text-[11px] text-slate-400 dark:text-[#A89890] px-2 py-1 font-medium">{label}</p>
          {groups[label].map(renderRow)}
          <div className="border-t border-[#eceee9] dark:border-[#332A24] my-1 mx-2" />
        </div>
      ))}
    </>
  );
}

/**
 * 完整侧边栏组件（含桌面端与小屏抽屉）
 */
export default function Sidebar({
  isMobile,
  isSidebarOpen,
  setIsSidebarOpen,
  conversations,
  currentId,
  search,
  setSearch,
  searchResults,
  hint,
  multiSelectMode,
  setMultiSelectMode,
  selectedIds,
  renamingId,
  setRenamingId,
  renameValue,
  setRenameValue,
  menuOpenId,
  setMenuOpenId,
  handleNewConversation,
  handleSelectAll,
  handleExitMultiSelect,
  handlePinSelected,
  handleDeleteSelected,
  handleOpenResult,
  handleToggleSelect,
  handleRename,
  handleTogglePin,
  handleShare,
  handleDelete,
  timeGroupLabel,
  btnBase,
  searchInputClass,
}) {
  const sidebarContent = (
    <>
      <button
        onClick={() => {
          handleNewConversation();
          if (isMobile) setIsSidebarOpen(false);
        }}
        className="w-full flex items-center justify-center gap-2 p-2.5 mb-2.5 rounded-xl bg-gradient-to-r from-[#c06b50] to-[#b85a3c] text-white text-sm font-medium shadow-sm shadow-[#b85a3c]/20 hover:from-[#b05f45] hover:to-[#a84f33] active:scale-[0.98] transition-all duration-150 cursor-pointer"
      >
        <span className="text-base leading-none">＋</span>
        <span>新建对话</span>
      </button>

      <div className="relative mb-2">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <circle cx="11" cy="11" r="7" />
          <line x1="20" y1="20" x2="16.2" y2="16.2" />
        </svg>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索对话或消息内容"
          className={searchInputClass}
        />
      </div>

      {hint && <p className="text-xs text-slate-500 dark:text-[#BFAFA7] mb-2">{hint}</p>}

      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 && (
          <div className="space-y-2 py-1 px-1">
            <div className="h-10 bg-slate-100/80 dark:bg-[#251F1C]/80 rounded-xl animate-pulse" />
            <div className="h-10 bg-slate-100/60 dark:bg-[#251F1C]/60 rounded-xl animate-pulse" />
            <div className="h-10 bg-slate-100/40 dark:bg-[#251F1C]/40 rounded-xl animate-pulse" />
          </div>
        )}

        {/* 多选模式操作栏 */}
        {multiSelectMode && conversations.length > 0 && (
          <div className="flex items-center gap-1 mb-2 p-1.5 rounded-xl bg-[#faede6] dark:bg-[#342721] border border-[#f0ded4] dark:border-[#4B372D] sticky top-0 z-10 shadow-2xs">
            <button
              onClick={handleSelectAll}
              className={`${btnBase} px-2 py-1 text-xs hover:scale-[1.02]`}
            >
              {selectedIds.length === conversations.length ? "取消全选" : "全选"}
            </button>
            <button
              onClick={handleExitMultiSelect}
              className={`${btnBase} px-2 py-1 text-xs hover:scale-[1.02]`}
            >
              取消
            </button>
            <span className="text-xs text-slate-400 dark:text-[#9A8B83] ml-auto mr-1">
              已选 {selectedIds.length}
            </span>
            <button
              onClick={handlePinSelected}
              disabled={selectedIds.length === 0}
              className={`${btnBase} px-2 py-1 text-xs hover:scale-[1.02]`}
            >
              置顶
            </button>
            <button
              onClick={handleDeleteSelected}
              disabled={selectedIds.length === 0}
              className="border border-[#e8a38c] bg-[#b85a3c] text-white rounded-lg px-2 py-1 text-xs hover:bg-[#a34f33] disabled:opacity-50 transition-all duration-150 cursor-pointer"
            >
              删除
            </button>
          </div>
        )}

        {/* 搜索模式：扁平列表 */}
        {search && searchResults.length === 0 && (
          <p className="text-sm text-slate-400 dark:text-[#8D7F77]">没有匹配的对话</p>
        )}
        {search &&
          searchResults.map(({ conversation: c, messageId, snippet }) => (
            <ConvRow
              key={c.id}
              c={c}
              snippet={snippet}
              selected={selectedIds.includes(c.id)}
              multi={multiSelectMode}
              currentId={currentId}
              renaming={renamingId === c.id}
              renameValue={renameValue}
              menuOpen={menuOpenId === c.id}
              onOpen={() => {
                handleOpenResult({ conversation: c, messageId });
                if (isMobile) setIsSidebarOpen(false);
              }}
              onToggleSelect={() => handleToggleSelect(c.id)}
              onMenu={() => setMenuOpenId(menuOpenId === c.id ? null : c.id)}
              onRename={() => {
                setRenamingId(c.id);
                setRenameValue(c.title || "");
                setMenuOpenId(null);
              }}
              onRenameCommit={() => handleRename(c.id)}
              onRenameCancel={() => setRenamingId(null)}
              setRenameValue={setRenameValue}
              onPin={() => {
                handleTogglePin(c.id);
                setMenuOpenId(null);
              }}
              onMultiSelect={() => {
                setMultiSelectMode(true);
                setMenuOpenId(null);
              }}
              onShare={() => {
                handleShare(c);
                setMenuOpenId(null);
              }}
              onDelete={() => {
                handleDelete(c.id);
                setMenuOpenId(null);
              }}
              closeMenu={() => setMenuOpenId(null)}
            />
          ))}

        {/* 非搜索模式：置顶区 + 时间轴分组 */}
        {!search && conversations.length > 0 && (
          <ConversationGroups
            conversations={conversations}
            multiSelectMode={multiSelectMode}
            selectedIds={selectedIds}
            currentId={currentId}
            renamingId={renamingId}
            renameValue={renameValue}
            menuOpenId={menuOpenId}
            timeGroupLabel={timeGroupLabel}
            onOpen={(c) => {
              handleOpenResult({ conversation: c, messageId: null });
              if (isMobile) setIsSidebarOpen(false);
            }}
            onToggleSelect={handleToggleSelect}
            setMenuOpenId={setMenuOpenId}
            setRename={setRenameValue}
            onRename={(c) => {
              setRenamingId(c.id);
              setRenameValue(c.title || "");
              setMenuOpenId(null);
            }}
            onRenameCommit={handleRename}
            onRenameCancel={() => setRenamingId(null)}
            onPin={handleTogglePin}
            onMultiSelect={() => {
              setMultiSelectMode(true);
              setMenuOpenId(null);
            }}
            onShare={handleShare}
            onDelete={handleDelete}
          />
        )}
      </div>
    </>
  );

  return (
    <>
      {/* 桌面端内联侧边栏 */}
      {!isMobile && (
        <div
          className={`${
            isSidebarOpen ? "w-64" : "w-0"
          } h-full shrink-0 overflow-hidden border-r border-[#eee4dc] dark:border-[#382F28] bg-[#FAF7F4] dark:bg-[#1E1A17] transition-all duration-300`}
        >
          <div className="w-64 h-full p-2 flex flex-col">
            {sidebarContent}
          </div>
        </div>
      )}

      {/* 移动端侧边抽屉 */}
      {isMobile && isSidebarOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/30 z-30"
            onClick={() => setIsSidebarOpen(false)}
          />
          <div className="fixed left-0 top-[60px] bottom-0 w-64 z-40 overflow-y-auto border-r border-[#e8eae7] dark:border-[#382F28] bg-[#f7f7f4] dark:bg-[#1E1A17] p-2 flex flex-col">
            {sidebarContent}
          </div>
        </>
      )}
    </>
  );
}

