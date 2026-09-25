/**
 * 首页（宣传页）
 *
 * ⚠️ 这是**占位版本** —— 正式首页由组员在做，做好之后**直接替换本文件**即可，
 *    不需要动路由（`/` 和 `/home` 都渲染这个组件）。
 *
 * 两条路由都用它：
 *   · `/`      → 智能入口：已登录会被重定向到 /chat，未登录显示这个页面
 *   · `/home`  → 永远显示这个页面（应用内点左上角 Logo 回到这里）
 *
 * 为什么要有 `/home`：
 *   如果 Logo 指向 `/`，已登录用户会被 `redirect("/chat")` 弹回聊天页，
 *   等于"点不动"。所以宣传页必须有一个不会被重定向的独立地址。
 *
 * 这是服务端组件，不需要 "use client"。
 */
export default function Landing() {
  return (
    <main className="min-h-screen flex flex-col bg-[#fafaf8]">
      {/* 顶部：品牌字 */}
      <header className="h-[60px] shrink-0 flex items-center px-6 border-b border-[#e8eae7]">
        <span className="font-display text-xl font-bold tracking-wide text-[#5b8aa6] select-none">
          Solace
        </span>
      </header>

      {/* 主体：一句话 + 入口按钮 */}
      <section className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <h1 className="font-display text-3xl sm:text-5xl font-bold tracking-wide text-slate-800 leading-snug">
          给每一个不想说话的灵魂，
          <br className="hidden sm:block" />
          一点慰藉。
        </h1>

        <p className="mt-6 max-w-xl text-sm leading-relaxed text-slate-500">
          一个安静的陪伴空间。你可以写日记、和它说说话，
          <br className="hidden sm:block" />
          或者什么都不做，只是待一会儿。
        </p>

        <a
          href="/login"
          className="mt-10 rounded-full bg-[#7a9fb5] px-9 py-3 text-sm text-white transition-colors duration-200 hover:bg-[#6b8fa5]"
        >
          开始使用
        </a>
      </section>

      {/* 底部：占位提示（正式首页替换本文件后可以删掉这一段） */}
      <footer className="shrink-0 px-6 py-6 text-center text-[11px] text-slate-300">
        首页建设中 · 当前为占位页
      </footer>
    </main>
  );
}
