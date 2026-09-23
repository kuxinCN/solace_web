"use client";

import ProfileView from "@/components/ProfileView";

// 个人资料弹窗：复用 ProfileView 的内容，仅负责 overlay + 容器
// props: open, onClose, user, profile, onSaved, onSignOut
export default function ProfileModal({ open, onClose, user, profile, onSaved, onSignOut }) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl border border-[#e8eae7] p-5 w-96 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <p className="text-base font-bold text-slate-700">个人资料</p>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 text-lg leading-none"
          >
            ×
          </button>
        </div>

        <ProfileView
          user={user}
          profile={profile}
          onSaved={onSaved}
          onSignOut={onSignOut}
        />
      </div>
    </div>
  );
}
