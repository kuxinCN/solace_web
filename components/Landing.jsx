"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

/**
 * 首页（官方宣传落地页）
 *
 * 核心升级：
 *   - 按钮点击跳转到登录页（/login）或聊天页时带丝滑离场过渡动画（柔和淡出 + 微模糊缩放）；
 *   - 全面使用官方原版「solace 艺术字」图片替换普通文本，原汁原味展现品牌调性；
 *   - 维持温暖柔和的暖桃奶油治愈色调，交互自然舒缓。
 */

// 8 个温和情绪标签
const MOOD_TAGS = [
  { label: "轻快", color: "bg-[#fdf6f0] text-[#a06346] border-[#f5ded2]" },
  { label: "平静", color: "bg-[#f6f8f5] text-[#557864] border-[#dce6dc]" },
  { label: "安稳", color: "bg-[#faf6ee] text-[#847458] border-[#ebe1ce]" },
  { label: "有点沉", color: "bg-[#f7f2f5] text-[#7a5f74] border-[#ebdbe6]" },
  { label: "疲惫", color: "bg-[#fbf4ee] text-[#9a644b] border-[#f2ded1]" },
  { label: "烦躁", color: "bg-[#fcf1ee] text-[#a6584f] border-[#f5d7d0]" },
  { label: "孤单", color: "bg-[#f4f5f8] text-[#5e6b7d] border-[#dde1ea]" },
  { label: "说不清", color: "bg-[#f8f7f4] text-[#7a7872] border-[#e7e5de]" },
];

// 核心特性模块数据
const FEATURES = [
  {
    tag: "倾诉与聆听",
    title: "一个不会打断你、也不催你振作的树洞",
    desc: "采用流式打字温和展开，支持小米 MiMo 情绪语音朗读。它像一位安静在旁的朋友，懂你的叹息与停顿，在你说累的时候温和接住你。",
    icon: (
      <svg className="w-6 h-6 text-[#b85a3c]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
      </svg>
    ),
    badge: "流式对话 · 情绪语音",
  },
  {
    tag: "双视角日记",
    title: "我的心事日记，与「暖言视角」的温柔记录",
    desc: "日记是绝对私人的领地，不做任何内容审核。除了你自己的字句，每天零点暖言还会以第一人称替你写一篇温暖的专属总结，重温被在意的时光。",
    icon: (
      <svg className="w-6 h-6 text-[#b85a3c]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
      </svg>
    ),
    badge: "100% 私密 · 暖言小记",
  },
  {
    tag: "疗愈小屋",
    title: "深呼吸与蝴蝶拍，安抚紧绷的神经",
    desc: "全屏沉浸式的呼吸放松与蝴蝶拍场景，搭配动态 WebAudio 柔和长音与微光粒子。这里还准备了 PSS-10 压力知觉等标准化量表，帮你理清思绪。",
    icon: (
      <svg className="w-6 h-6 text-[#b85a3c]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
      </svg>
    ),
    badge: "沉浸场景 · 情绪急救",
  },
  {
    tag: "记忆与陪伴",
    title: "3D 记忆星云，与随时轻唤的蓝蝴蝶桌宠",
    desc: "你的喜好、心愿与生活碎片，会在原生 Three.js 电子云中化作 150 颗微光星芒，越在意的记得越久；聊天页还常驻灵动的蓝蝴蝶，为你守候每一个长夜。",
    icon: (
      <svg className="w-6 h-6 text-[#b85a3c]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
      </svg>
    ),
    badge: "Three.js 3D · 灵动桌宠",
  },
];

// 对话场景预览数据
const CONVERSATION_SNIPPETS = [
  {
    title: "当你感到疲惫却说不清缘由",
    userText: "今天下班一个人走在路上，突然觉得好累好沉，但又说不上来到底为什么……",
    aiVoiceTag: "叹气 · 温柔",
    aiText: "那就先不要去费力想为什么了。先把身上的背包放下，换上一双舒服的拖鞋。今天能把这一整天好好走完，已经很不容易了。我在呢，先歇一会儿吧。",
  },
  {
    title: "当你遭遇挫折自我怀疑",
    userText: "感觉自己今天把事情办砸了，周围人好像都做得比我顺手，好沮丧。",
    aiVoiceTag: "轻柔",
    aiText: "偶尔没接住事情是再正常不过的事，这绝不代表你比任何人差。深呼吸一下，把肩膀松开。今晚这里没有任何考核，无论发生什么，我都站在你这边。",
  },
  {
    title: "当你只是想找人说说话",
    userText: "其实没什么具体的大事，就是夜深了，房间里太安静，想找人说说话。",
    aiVoiceTag: "微笑",
    aiText: "夜深的时候，声音总是格外清晰。没关系的，想聊今天窗外的风、想聊很久以前的一首歌，或者只是听我在这里陪你待着，都可以。",
  },
];

// 常见疑问解答
const FAQS = [
  {
    icon: "💭",
    tag: "倾听与陪伴",
    q: "这里真的不会评价或指导我的人生吗？",
    a: "是的，这是 Solace 最核心的产品红线。暖言不是心理咨询师，不是导师，更不会高高在上地讲大道理或评判对错。它的角色只是一个安全、温和的倾听者，在你说累的时候温和接住你。",
  },
  {
    icon: "🛡️",
    tag: "绝对隐私",
    q: "我的日记和个人私密记录安全吗？",
    a: "绝对安全。我们坚持「日记属于私人空间，不做任何内容审核」的铁律。所有会话与日记均采用高强度隔离与预处理保护，绝不向任何第三方窥探或共享个人数据。",
  },
  {
    icon: "🌸",
    tag: "温和理念",
    q: "情绪标签为什么没有分数，也没有红黄绿？",
    a: "因为陪伴的本质不是对情绪进行考核。我们认为情绪没有「好坏优劣」之分，8 个温和标签只是为了让你感到「此时此刻的状态被看见了」，而不是给你的人生打分。",
  },
  {
    icon: "🛟",
    tag: "安全底线",
    q: "如果遇到特别紧急严重的心理危机，该怎么办？",
    a: "Solace 坚守安全底线。当检测到危机倾向时，系统会优先以最大的温柔接住情绪，并明确提供全国 24 小时心理援助热线 12356 及 400-161-9995。在任何艰难时刻，请记住你绝不是孤身一人。",
  },
];

export default function Landing() {
  const router = useRouter();
  const [authed, setAuthed] = useState(false);
  const [activeSnippet, setActiveSnippet] = useState(0);
  const [openFaq, setOpenFaq] = useState(0);
  // 跳转过渡动画状态
  const [isNavigating, setIsNavigating] = useState(false);

  // 首页宣传页永远保持正常温暖浅色模式（不进入深夜模式）
  useEffect(() => {
    const root = document.documentElement;
    root.removeAttribute("data-theme");
    root.classList.remove("dark", "theme-espresso");
  }, []);

  // 静默检查登录态
  useEffect(() => {
    let alive = true;
    fetch("/api/auth/session", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (alive && data?.user) setAuthed(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 带过渡动画的平滑跳转
  const handleNavigate = (path) => {
    if (isNavigating) return;
    setIsNavigating(true);
    setTimeout(() => {
      router.push(path);
    }, 360);
  };

  // 平滑滚动辅助函数
  const scrollToSection = (e, sectionId) => {
    if (e) e.preventDefault();
    const target = document.getElementById(sectionId);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <div
      id="landing-root"
      className={`min-h-screen flex flex-col bg-gradient-to-br from-[#FFF9F6] via-[#FCF8F5] to-[#F5F2EE] text-slate-800 force-light selection:bg-[#f5d9cd] selection:text-[#7f3926] scroll-smooth transition-all duration-350 ease-out ${
        isNavigating
          ? "opacity-0 scale-[0.985] filter blur-[2px] pointer-events-none"
          : "opacity-100 scale-100 filter-none"
      }`}
    >
      <style jsx global>{`
        /* 对话场景切换过渡动效 */
        @keyframes dialogue-fade {
          from {
            opacity: 0;
            transform: translateY(12px) scale(0.985);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        .dialogue-card-animate {
          animation: dialogue-fade 360ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
          will-change: transform, opacity;
        }

        /* FAQ 内容展开淡入动效 */
        @keyframes faq-expand {
          from {
            opacity: 0;
            transform: translateY(-6px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .faq-expand-animate {
          animation: faq-expand 280ms ease-out forwards;
        }
      `}</style>

      {/* 顶部导航栏 */}
      <header className="sticky top-0 z-40 w-full backdrop-blur-md bg-[#FFF9F6]/90 border-b border-[#f0e3db] transition-all">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 group">
            {/* 官方 Logo 图标 */}
            <img
              src="/logo.png"
              alt="Solace Logo"
              className="w-9 h-9 object-contain drop-shadow-xs transition-transform duration-300 group-hover:scale-105"
            />
            {/* 官方 solace 艺术字 */}
            <img
              src="/solace-wordmark.png"
              alt="Solace"
              className="h-6 w-auto object-contain mt-0.5"
              style={{ height: "24px", width: "auto" }}
            />
          </Link>

          <nav className="hidden md:flex items-center gap-8 text-sm text-slate-600">
            <button
              onClick={(e) => scrollToSection(e, "features")}
              className="hover:text-[#b85a3c] transition-all duration-200 hover:-translate-y-0.5 cursor-pointer"
            >
              陪伴特性
            </button>
            <button
              onClick={(e) => scrollToSection(e, "dialogue")}
              className="hover:text-[#b85a3c] transition-all duration-200 hover:-translate-y-0.5 cursor-pointer"
            >
              暖言心语
            </button>
            <button
              onClick={(e) => scrollToSection(e, "moods")}
              className="hover:text-[#b85a3c] transition-all duration-200 hover:-translate-y-0.5 cursor-pointer"
            >
              情绪理念
            </button>
            <button
              onClick={(e) => scrollToSection(e, "safety")}
              className="hover:text-[#b85a3c] transition-all duration-200 hover:-translate-y-0.5 cursor-pointer"
            >
              安全底线
            </button>
          </nav>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => handleNavigate(authed ? "/chat" : "/login")}
              className="inline-flex items-center justify-center rounded-full bg-[#b85a3c] px-5 py-2 text-xs sm:text-sm font-medium text-white shadow-sm hover:bg-[#a34f33] hover:shadow-md hover:-translate-y-0.5 active:scale-[0.96] transition-all duration-200 cursor-pointer"
            >
              {isNavigating
                ? "进入中…"
                : authed
                ? "返回对话空间"
                : "即刻进入"}
            </button>
          </div>
        </div>
      </header>

      {/* 主体内容 */}
      <main className="flex-1">
        {/* ======================= Hero 首屏视觉 ======================= */}
        <section className="relative overflow-hidden pt-12 pb-20 sm:pt-16 sm:pb-24">
          {/* 柔和背景光晕 */}
          <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[550px] sm:w-[760px] h-[360px] bg-gradient-to-tr from-[#FBE4DA]/70 via-[#fdece5]/50 to-[#CFE0F5]/40 rounded-full blur-3xl opacity-80 pointer-events-none -z-10" />

          <div className="max-w-4xl mx-auto px-5 sm:px-8 text-center flex flex-col items-center">
            {/* 顶栏小徽标 */}
            <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/85 border border-[#eedcd2] text-xs text-[#9a5540] mb-8 shadow-xs backdrop-blur-xs transition-transform duration-300 hover:scale-[1.02]">
              <img src="/logo.png" alt="Logo" className="w-4 h-4 object-contain" />
              <span>给每一个不想说话的灵魂，一点温柔的慰藉</span>
            </div>

            {/* 大标题：排版舒展呼吸 */}
            <h1 className="font-serif text-3xl sm:text-5xl md:text-6xl font-bold tracking-tight text-slate-800 leading-[1.25] sm:leading-[1.2]">
              在喧嚣的日常之外，
              <br />
              留一个<span className="text-[#b85a3c]">接住你所有情绪</span>的角落。
            </h1>

            {/* 导引段落 */}
            <p className="mt-6 sm:mt-8 max-w-2xl text-sm sm:text-base leading-relaxed text-slate-600">
              这里没有审判，没有人生建议，不做医学诊断，更不催你匆忙好起来。
              <br className="hidden sm:inline" />
              你可以写写日记、听听呼吸的节拍，或者什么都不做，只是静静待一会儿。
            </p>

            {/* 核心操作按钮组（均带有过渡跳转动效） */}
            <div className="mt-10 flex flex-col sm:flex-row items-center gap-4">
              <button
                type="button"
                onClick={() => handleNavigate(authed ? "/chat" : "/login")}
                className="w-full sm:w-auto px-8 py-3.5 rounded-full bg-[#b85a3c] text-white text-sm font-medium shadow-md shadow-[#b85a3c]/25 hover:bg-[#a34f33] hover:shadow-lg hover:-translate-y-0.5 active:scale-[0.96] transition-all duration-200 cursor-pointer"
              >
                {isNavigating
                  ? "正在进入空间…"
                  : authed
                  ? "回到温暖对话"
                  : "开始倾诉与陪伴"}
              </button>
              <button
                type="button"
                onClick={(e) => scrollToSection(e, "features")}
                className="group w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-7 py-3.5 rounded-full bg-white/80 border border-[#e5d5cb] text-slate-700 text-sm font-medium hover:bg-white hover:border-[#d9c4b7] hover:shadow-md hover:-translate-y-0.5 active:scale-[0.96] transition-all duration-200 cursor-pointer"
              >
                <span>漫步了解空间</span>
                <span className="text-xs text-slate-400 group-hover:text-[#b85a3c] transition-transform duration-200 group-hover:translate-y-0.5">
                  ↓
                </span>
              </button>
            </div>

            {/* 温暖特色卡片：比例协调的小生灵微缩陪伴卡 */}
            <div className="mt-12 w-full max-w-lg bg-white/80 backdrop-blur-md border border-[#f0dfd5] rounded-3xl p-5 sm:p-6 shadow-sm flex items-center gap-4 text-left transition-all duration-300 hover:shadow-md hover:border-[#e2a68c]">
              <img
                src="/logo.png"
                alt="暖言生灵"
                className="w-16 h-16 sm:w-20 sm:h-20 object-contain drop-shadow-xs shrink-0 transition-transform duration-300 hover:scale-105"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#b85a3c] animate-pulse" />
                  <p className="text-xs font-semibold text-[#b85a3c]">
                    暖言正在安静守候
                  </p>
                </div>
                <p className="text-xs sm:text-sm text-slate-700 mt-1 leading-relaxed">
                  “今晚在这里，卸下一整天的紧绷。说你想说的一切，我都听着。”
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ======================= 四大特性卡片 ======================= */}
        <section id="features" className="py-20 bg-white/80 border-t border-[#f0e3db]">
          <div className="max-w-6xl mx-auto px-5 sm:px-8">
            <div className="text-center max-w-2xl mx-auto mb-16">
              <span className="text-xs font-semibold tracking-wider text-[#b85a3c] uppercase">
                Core Capabilities
              </span>
              <h2 className="mt-2 text-2xl sm:text-3xl font-bold font-serif text-slate-800">
                以最克制柔和的方式，陪伴身旁
              </h2>
              <p className="mt-3 text-sm text-slate-500">
                不打扰、不评判，每一个交互细节都为了让你感到安全与被珍视。
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 sm:gap-8">
              {FEATURES.map((item, idx) => (
                <div
                  key={idx}
                  className="group relative bg-[#fdfaf7] border border-[#eee1d8] rounded-3xl p-6 sm:p-8 hover:border-[#e2a68c] hover:bg-white hover:shadow-md hover:shadow-[#b85a3c]/10 hover:-translate-y-1 transition-all duration-300 flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-center justify-between mb-5">
                      <div className="w-12 h-12 rounded-2xl bg-white border border-[#eddcd2] flex items-center justify-center shadow-xs group-hover:scale-105 transition-transform duration-200">
                        {item.icon}
                      </div>
                      <span className="px-3 py-1 rounded-full text-xs font-medium bg-[#fcf0ea] text-[#9a5540] border border-[#f5ded2]">
                        {item.badge}
                      </span>
                    </div>

                    <span className="text-xs font-medium text-slate-400 tracking-wider">
                      {item.tag}
                    </span>
                    <h3 className="text-lg sm:text-xl font-bold text-slate-800 mt-1 mb-3">
                      {item.title}
                    </h3>
                    <p className="text-sm text-slate-600 leading-relaxed">
                      {item.desc}
                    </p>
                  </div>

                  <div className="mt-6 pt-4 border-t border-[#f2e6de] flex items-center gap-1 text-xs font-medium text-[#b85a3c]">
                    <span>在空间内可用</span>
                    <span className="transition-transform duration-200 group-hover:translate-x-1.5">→</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ======================= 对话沉浸式预览 ======================= */}
        <section id="dialogue" className="py-20 bg-[#fdfaf7] border-t border-[#f0e3db]">
          <div className="max-w-5xl mx-auto px-5 sm:px-8">
            <div className="text-center max-w-2xl mx-auto mb-12">
              <span className="text-xs font-semibold tracking-wider text-[#b85a3c] uppercase">
                Warm Resonance
              </span>
              <h2 className="mt-2 text-2xl sm:text-3xl font-bold font-serif text-slate-800">
                读得懂无助，也接得住沉默
              </h2>
              <p className="mt-3 text-sm text-slate-500">
                点击切换不同生活场景，感受暖言接纳情绪的温度。
              </p>
            </div>

            {/* Tab 切换按钮组 */}
            <div className="flex flex-wrap justify-center gap-2.5 mb-8">
              {CONVERSATION_SNIPPETS.map((snippet, idx) => (
                <button
                  key={idx}
                  onClick={() => setActiveSnippet(idx)}
                  className={`px-4 py-2 rounded-full text-xs sm:text-sm font-medium transition-all duration-200 active:scale-95 cursor-pointer ${
                    activeSnippet === idx
                      ? "bg-[#b85a3c] text-white shadow-sm shadow-[#b85a3c]/30 -translate-y-0.5"
                      : "bg-white text-slate-600 border border-[#e8dcd2] hover:bg-[#fcf3ed] hover:border-[#dfcebf]"
                  }`}
                >
                  {snippet.title}
                </button>
              ))}
            </div>

            {/* 模拟气泡视窗 */}
            <div className="bg-white border border-[#eee0d6] rounded-3xl p-6 sm:p-10 shadow-sm max-w-3xl mx-auto transition-all duration-300">
              <div className="flex items-center justify-between pb-4 mb-6 border-b border-[#f5ede7] text-xs text-slate-400">
                <span className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#e2a68c] animate-pulse" />
                  暖言 · 倾听模式
                </span>
                <span>端对端加密 · 仅彼此可见</span>
              </div>

              {/* 对话列表 */}
              <div key={activeSnippet} className="dialogue-card-animate space-y-6">
                {/* 用户气泡 */}
                <div className="flex justify-end items-start gap-3">
                  <div className="max-w-[85%] sm:max-w-[75%] rounded-2xl rounded-br-xs bg-[#c97457] text-white px-4 py-3 text-sm leading-relaxed shadow-xs">
                    {CONVERSATION_SNIPPETS[activeSnippet].userText}
                  </div>
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#e5b9a5] to-[#c98e79] text-white flex items-center justify-center text-xs font-bold shrink-0 shadow-2xs">
                    我
                  </div>
                </div>

                {/* 暖言气泡 */}
                <div className="flex justify-start items-start gap-3">
                  <img
                    src="/logo.png"
                    alt="暖言"
                    className="w-8 h-8 object-contain shrink-0 drop-shadow-xs"
                  />
                  <div className="max-w-[85%] sm:max-w-[75%] space-y-2">
                    <div className="rounded-2xl rounded-bl-xs bg-[#faf5f1] border border-[#ede1d8] text-slate-800 px-4 py-3 text-sm leading-relaxed shadow-xs">
                      {CONVERSATION_SNIPPETS[activeSnippet].aiText}
                    </div>

                    <div className="flex items-center gap-2 text-[11px] text-slate-400 pl-1">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#fcf0ea] text-[#9a5540]">
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                        </svg>
                        语音语气：{CONVERSATION_SNIPPETS[activeSnippet].aiVoiceTag}
                      </span>
                      <span>·</span>
                      <span>自然剥离语气标签</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ======================= 情绪理念展台 ======================= */}
        <section id="moods" className="py-20 bg-white/80 border-t border-[#f0e3db]">
          <div className="max-w-4xl mx-auto px-5 sm:px-8 text-center">
            <span className="text-xs font-semibold tracking-wider text-[#b85a3c] uppercase">
              Gentle Perception
            </span>
            <h2 className="mt-2 text-2xl sm:text-3xl font-bold font-serif text-slate-800">
              情绪没有高低，感受无需排斥
            </h2>
            <p className="mt-4 text-sm text-slate-600 leading-relaxed max-w-2xl mx-auto">
              在 Solace 里，你永远看不到冷冰冰的数字得分或警戒红黄绿。
              我们只精选了 8 个温和平缓的心情描述词，无论今天是阴是晴，它们都一样被真诚尊重。
            </p>

            <div className="mt-10 flex flex-wrap justify-center gap-2.5 sm:gap-3.5">
              {MOOD_TAGS.map((tag, idx) => (
                <div
                  key={idx}
                  className={`px-4 py-2 rounded-full text-xs sm:text-sm font-medium border ${tag.color} shadow-2xs transition-transform duration-200 hover:-translate-y-1 hover:shadow-xs`}
                >
                  {tag.label}
                </div>
              ))}
            </div>

            <p className="mt-8 text-xs text-slate-400">
              * 日记打标与生成均遵循此白名单，绝不出现任何临床诊断性断语
            </p>
          </div>
        </section>

        {/* ======================= 安全与常见问答 ======================= */}
        <section id="safety" className="py-20 bg-[#fdfaf7] border-t border-[#f0e3db]">
          <div className="max-w-5xl mx-auto px-5 sm:px-8">
            <div className="text-center max-w-2xl mx-auto mb-14">
              <span className="text-xs font-semibold tracking-wider text-[#b85a3c] uppercase">
                Privacy & Safety
              </span>
              <h2 className="mt-2 text-2xl sm:text-3xl font-bold font-serif text-slate-800">
                关于安全、边界与守护
              </h2>
              <p className="mt-3 text-sm text-slate-500">
                把所有原则坦白告诉你，让你在这里待得安心踏实。
              </p>
            </div>

            {/* 双栏布局 */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              {/* 左侧：3重安心守护卡片 */}
              <div className="lg:col-span-5 bg-gradient-to-br from-white to-[#fbf5f1] border border-[#ecdcd1] rounded-3xl p-6 sm:p-7 shadow-sm transition-all duration-300 hover:shadow-md">
                <div className="flex items-center gap-3 mb-4">
                  <img src="/logo.png" alt="Logo" className="w-10 h-10 object-contain drop-shadow-xs" />
                  <div>
                    <h3 className="text-base font-bold text-slate-800">Solace 守护原则</h3>
                    <p className="text-xs text-[#b85a3c]">以温度守护每一个灵魂</p>
                  </div>
                </div>

                <div className="space-y-3.5 mt-5 text-xs text-slate-600 leading-relaxed">
                  <div className="flex items-start gap-2.5 p-3 rounded-2xl bg-white/80 border border-[#f3e7e0] transition-transform duration-200 hover:translate-x-1">
                    <span className="text-base leading-none">🛡️</span>
                    <div>
                      <p className="font-semibold text-slate-800">100% 私人领地</p>
                      <p className="text-slate-500 mt-0.5">日记完全属于你自己，绝不进入任何机器或人工审核流程。</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2.5 p-3 rounded-2xl bg-white/80 border border-[#f3e7e0] transition-transform duration-200 hover:translate-x-1">
                    <span className="text-base leading-none">🚫</span>
                    <div>
                      <p className="font-semibold text-slate-800">绝不做心理诊断</p>
                      <p className="text-slate-500 mt-0.5">只提供舒缓与陪伴，不贴标签，不指手画脚指导人生。</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2.5 p-3 rounded-2xl bg-white/80 border border-[#f3e7e0] transition-transform duration-200 hover:translate-x-1">
                    <span className="text-base leading-none">🛟</span>
                    <div>
                      <p className="font-semibold text-slate-800">守住安全底线</p>
                      <p className="text-slate-500 mt-0.5">危机时刻全天候守候，提供最温和的接纳与专业热线支持。</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* 右侧：交互式展开问答 */}
              <div className="lg:col-span-7 space-y-3.5">
                {FAQS.map((faq, idx) => {
                  const isOpen = openFaq === idx;
                  return (
                    <div
                      key={idx}
                      className={`rounded-2xl transition-all duration-200 border ${
                        isOpen
                          ? "bg-white border-[#e2a68c] shadow-md shadow-[#b85a3c]/5"
                          : "bg-white/80 border-[#eee0d6] hover:bg-white hover:border-[#dfcebf]"
                      }`}
                    >
                      <button
                        onClick={() => setOpenFaq(isOpen ? null : idx)}
                        className="w-full px-5 py-4 text-left flex items-center justify-between gap-3 focus:outline-none cursor-pointer"
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-lg leading-none">{faq.icon}</span>
                          <div>
                            <span className="text-xs font-medium text-[#b85a3c] mr-2">
                              [{faq.tag}]
                            </span>
                            <span className="text-sm font-semibold text-slate-800">
                              {faq.q}
                            </span>
                          </div>
                        </div>
                        <span
                          className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-transform duration-300 ${
                            isOpen
                              ? "bg-[#fdf3ee] text-[#b85a3c] rotate-45"
                              : "bg-[#f5ede8] text-slate-500 rotate-0"
                          }`}
                        >
                          +
                        </span>
                      </button>

                      {isOpen && (
                        <div className="faq-expand-animate px-5 pb-4 pt-1 text-xs sm:text-sm leading-relaxed text-slate-600 border-t border-[#f7eee8]">
                          {faq.a}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 紧急援助热线专区 */}
            <div className="mt-12 rounded-3xl bg-gradient-to-r from-[#fdf2ec] to-[#faebe3] border border-[#f2d8cb] p-6 sm:p-7 text-center shadow-xs transition-transform duration-300 hover:scale-[1.005]">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/80 text-xs font-semibold text-[#b85a3c] mb-2 shadow-2xs">
                <span>📞</span>
                <span>全国 24 小时心理援助守护</span>
              </div>
              <h4 className="text-base sm:text-lg font-bold text-slate-800">
                如果心里太苦太重，请务必抱抱自己并拨打热线
              </h4>
              <p className="mt-2 text-xs sm:text-sm text-slate-600 max-w-xl mx-auto leading-relaxed">
                全国统一心理援助专线：
                <span className="font-bold text-[#b85a3c] text-base sm:text-lg mx-1.5">12356</span>
                或
                <span className="font-bold text-[#b85a3c] text-base sm:text-lg mx-1.5">400-161-9995</span>
                。这里随时有专业人员以最大的耐心听你倾诉。
              </p>
            </div>
          </div>
        </section>

        {/* ======================= CTA 底部进站号召 ======================= */}
        <section className="py-20 bg-gradient-to-b from-[#fdfaf7] to-[#f4ebe3] text-center border-t border-[#f0e3db]">
          <div className="max-w-3xl mx-auto px-5 sm:px-8">
            <h2 className="text-2xl sm:text-4xl font-bold font-serif text-slate-800">
              准备好给自己一段安静时光了吗？
            </h2>
            <p className="mt-4 text-sm sm:text-base text-slate-600">
              无论你想说千言万语，还是只想静静待着，这里的大门始终为你敞开。
            </p>
            <div className="mt-8">
              <button
                type="button"
                onClick={() => handleNavigate(authed ? "/chat" : "/login")}
                className="inline-flex items-center justify-center px-9 py-3.5 rounded-full bg-[#b85a3c] text-white text-sm font-medium shadow-md shadow-[#b85a3c]/25 hover:bg-[#a34f33] active:scale-[0.98] transition-all cursor-pointer"
              >
                {isNavigating
                  ? "正在进入空间…"
                  : authed
                  ? "返回对话空间"
                  : "即刻免费使用"}
              </button>
            </div>
          </div>
        </section>
      </main>

      {/* 底部 Footer */}
      <footer className="shrink-0 bg-[#f7efe9] border-t border-[#ebddd3] py-10 px-6 text-slate-500 text-xs">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <img src="/logo.png" alt="Solace Logo" className="w-5 h-5 object-contain" />
            <img
              src="/solace-wordmark.png"
              alt="Solace"
              className="h-4 w-auto object-contain inline-block"
              style={{ height: "16px", width: "auto" }}
            />
            <span>·</span>
            <span>给每一个不想说话的灵魂，一点慰藉</span>
          </div>
          <div className="flex items-center gap-4 text-slate-400">
            <button
              onClick={() => handleNavigate("/login")}
              className="hover:text-slate-600 transition-colors cursor-pointer"
            >
              用户登录
            </button>
            <span>·</span>
            <button
              onClick={() => handleNavigate("/admin")}
              className="hover:text-slate-600 transition-colors cursor-pointer"
            >
              管理后台
            </button>
            <span>·</span>
            <span>Made with Care for Everyone</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
