"use client";

import React, { memo } from "react";
import dynamic from "next/dynamic";
import ConfirmModal from "@/components/ConfirmModal";
import TrashModal from "@/components/TrashModal";
import DeleteChoiceModal from "@/components/DeleteChoiceModal";
import BioModal from "@/components/BioModal";
import AboutModal from "@/components/AboutModal";
import FavoritesModal from "@/components/FavoritesModal";
import ImageCropper from "@/components/ImageCropper";
import StressMeter from "@/components/StressMeter";
import RelaxPopup from "@/components/RelaxPopup";
import CallConfirmModal from "@/components/CallConfirmModal";
import CompanionCardModal from "@/components/CompanionCardModal";
import MorningDiaryPrompt from "@/components/MorningDiaryPrompt";

// ⚠️ 记忆星云弹窗按需加载 three 3D 渲染，关闭时卸载，重新打开走缓存
const MemoriesModal = dynamic(() => import("@/components/MemoriesModal"), {
  ssr: false,
});

/**
 * 统一弹窗管理器（ModalManager）
 * 集中管理聊天视窗所有的外挂弹窗、裁剪器与操作确认框，
 * 并通过 React.memo 阻断聊天流式打字与滚动时对弹窗子树的无意义比对。
 */
const ChatModals = memo(function ChatModals({
  // 回收站与删除选择
  trashOpen,
  setTrashOpen,
  apiRequest,
  deleteAsk,
  deleteBusy,
  setDeleteAsk,
  handleDeleteChoiceTrash,
  handleDeleteChoicePermanent,

  // 退出确认与通用确认
  signOutConfirm,
  setSignOutConfirm,
  handleSignOut,
  confirmState,
  setConfirmState,

  // 收藏与星云记忆
  favoritesOpen,
  setFavoritesOpen,
  favDiaries,
  handleOpenFavDiary,
  memoriesOpen,
  setMemoriesOpen,
  memories,
  memoriesLoading,
  memoryTotal,
  memoryTruncated,
  addMemory,
  updateMemory,
  restoreMemory,
  deleteMemory,
  handleTalkAboutMemory,
  handleWriteDiaryFromMemory,

  // 压力评估与放松卡片
  stressPopup,
  setStressPopup,
  setStressData,
  stressPing,
  respondStressPopup,

  // 图片裁剪（聊天背景 & AI 头像）
  bgCropSrc,
  setBgCropSrc,
  uploadingBg,
  handleBgCropped,
  aiAvatarCropSrc,
  setAiAvatarCropSrc,
  uploadingAvatar,
  handleAiAvatarCropped,

  // 封面裁剪（用户头像 & 用户封面背景）
  coverAvatar,
  coverBg,

  // 个人签名与关于
  bioModalOpen,
  setBioModalOpen,
  bioInput,
  setBioInput,
  savingBio,
  bioMsg,
  handleSaveBio,
  aboutOpen,
  setAboutOpen,

  // 危机呼叫与晨间日记
  callTarget,
  setCallTarget,
  diaries,
  activeTab,
  handleOpenMorningDiary,

  // 陪伴卡片
  companionCardOpen,
  setCompanionCardOpen,
  companionCardData,

  // 隐藏上传输入控件
  bgFileRef,
  handleBgFileChange,
  aiAvatarFileRef,
  handleAiAvatarFileChange,
}) {
  return (
    <>
      {/* 回收站弹窗 */}
      <TrashModal
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        apiRequest={apiRequest}
      />

      {/* 删除方式选择：彻底删除 vs 回收站 */}
      <DeleteChoiceModal
        open={Boolean(deleteAsk)}
        target={
          deleteAsk?.kind === "diary"
            ? "日记"
            : deleteAsk?.kind === "memory" || deleteAsk?.kind === "memory-batch"
            ? "记忆"
            : "内容"
        }
        name={deleteAsk?.item?.title || ""}
        busy={deleteBusy}
        onCancel={() => setDeleteAsk(null)}
        onTrash={handleDeleteChoiceTrash}
        onPermanent={handleDeleteChoicePermanent}
      />

      {/* 退出登录二次确认弹窗 */}
      <ConfirmModal
        open={signOutConfirm}
        message="确定要退出当前账号吗？"
        confirmText="退出登录"
        onConfirm={async () => {
          setSignOutConfirm(false);
          await handleSignOut();
        }}
        onClose={() => setSignOutConfirm(false)}
      />

      {/* 统一通用确认弹窗 */}
      <ConfirmModal
        open={!!confirmState}
        message={confirmState?.message}
        confirmText={confirmState?.confirmText}
        onConfirm={confirmState?.onConfirm}
        onClose={() => setConfirmState(null)}
      />

      {/* 我的收藏 */}
      <FavoritesModal
        open={favoritesOpen}
        diaries={favDiaries}
        onClose={() => setFavoritesOpen(false)}
        onOpenDiary={handleOpenFavDiary}
      />

      {/* 记忆星云 */}
      {memoriesOpen && (
        <MemoriesModal
          open
          memories={memories}
          loading={memoriesLoading}
          total={memoryTotal}
          truncated={memoryTruncated}
          onClose={() => setMemoriesOpen(false)}
          onAdd={addMemory}
          onUpdate={updateMemory}
          onRestore={restoreMemory}
          onDelete={deleteMemory}
          onTalkAboutMemory={handleTalkAboutMemory}
          onWriteDiaryFromMemory={handleWriteDiaryFromMemory}
        />
      )}

      {/* 压力评估与放松卡片 */}
      <StressMeter
        api={apiRequest}
        onPendingPopup={setStressPopup}
        onData={setStressData}
        refreshKey={stressPing}
      />
      <RelaxPopup
        popup={stressPopup}
        onRespond={respondStressPopup}
        onDone={() => setStressPopup(null)}
        api={apiRequest}
      />

      {/* 聊天背景裁剪 */}
      {bgCropSrc && (
        <ImageCropper
          imageSrc={bgCropSrc}
          cropShape="rect"
          title="裁剪聊天背景"
          maxSide={1280}
          busy={uploadingBg}
          aspectOptions={[
            { label: "横屏 16:9", value: 16 / 9 },
            { label: "竖屏 9:16", value: 9 / 16 },
          ]}
          onCancel={() => setBgCropSrc(null)}
          onConfirm={handleBgCropped}
        />
      )}

      {/* AI 头像裁剪 */}
      {aiAvatarCropSrc && (
        <ImageCropper
          imageSrc={aiAvatarCropSrc}
          aspect={1}
          cropShape="round"
          title="裁剪 AI 头像"
          maxSide={512}
          busy={uploadingAvatar}
          onCancel={() => setAiAvatarCropSrc(null)}
          onConfirm={handleAiAvatarCropped}
        />
      )}

      {/* 封面头像裁剪 */}
      {coverAvatar?.cropSrc && (
        <ImageCropper
          imageSrc={coverAvatar.cropSrc}
          aspect={1}
          cropShape="round"
          title="裁剪头像"
          maxSide={512}
          busy={coverAvatar.uploading}
          onCancel={() => coverAvatar.setCropSrc(null)}
          onConfirm={coverAvatar.handleCropped}
        />
      )}

      {/* 封面背景裁剪 */}
      {coverBg?.cropSrc && (
        <ImageCropper
          imageSrc={coverBg.cropSrc}
          cropShape="rect"
          title="裁剪封面"
          maxSide={1280}
          aspectOptions={[
            { label: "横屏 16:9", value: 16 / 9 },
            { label: "竖屏 9:16", value: 9 / 16 },
          ]}
          busy={coverBg.uploading}
          onCancel={() => coverBg.setCropSrc(null)}
          onConfirm={coverBg.handleCropped}
        />
      )}

      {/* 个性签名 */}
      <BioModal
        open={bioModalOpen}
        value={bioInput}
        onChange={setBioInput}
        saving={savingBio}
        msg={bioMsg}
        onSave={handleSaveBio}
        onClose={() => setBioModalOpen(false)}
      />

      {/* 关于 */}
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />

      {/* 危机干预呼叫确认 */}
      <CallConfirmModal
        open={!!callTarget}
        number={callTarget?.number}
        title={callTarget?.title}
        onClose={() => setCallTarget(null)}
      />

      {/* 晨间小记提示 */}
      <MorningDiaryPrompt
        diaries={diaries}
        activeTab={activeTab}
        onOpenMorningDiary={handleOpenMorningDiary}
      />

      {/* 陪伴卡片 */}
      <CompanionCardModal
        isOpen={companionCardOpen}
        onClose={() => setCompanionCardOpen(false)}
        qaData={companionCardData}
      />

      {/* 常驻文件上传 input 控件 */}
      <input
        ref={bgFileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleBgFileChange}
      />
      <input
        ref={aiAvatarFileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleAiAvatarFileChange}
      />
    </>
  );
});

export default ChatModals;

