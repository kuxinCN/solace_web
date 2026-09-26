"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDraggable } from "@/lib/use-draggable";

/**
 * 背景音乐浮窗（左下角，可收起）
 *
 * 两种音源，同一套 UI：
 *   * `local`（默认）：播放「本地上传 + 外链直链」的歌，支持自动播放、上一首/下一首；
 *   * `netease`：显示「网易云收藏」，用**官方外链播放器 iframe** 嵌入。
 *     ⚠️ 官方没有开放取播放地址的接口，所以我们不做任何解析，只用官方播放器。
 *
 * ⚠️ 关于自动播放：所有现代浏览器都禁止页面一加载就出声。
 *    这里采用通用做法 —— 监听**用户第一次交互**（点击/触摸/按键），
 *    那之后再开始播放。既符合浏览器策略，体感也接近"进站就放"。
 *
 * 设计约定（和产品定位一致）：
 *   * 默认**收起**成一个小图标，不打扰用户；
 *   * 记住音量和上次播到哪首，下次进来接着放；
 *   * 任何播放失败都静默降级（比如外链失效），不弹错误打断用户。
 */
/**
 * 把歌曲地址改写成"一定能播"的形式。
 *
 * ⚠️ 为什么需要它：本地文件在 `public/music/`，地址本来是 `/music/xxx.mp3`。
 *    但宝塔的 Nginx 默认有一条静态后缀规则，会把 `.mp3` 结尾的请求
 *    当静态文件去「站点根/music/」找 —— 我们的文件在 `public/music/`，于是 404，
 *    表现就是"歌单能看到，点了播放没动静"。
 *
 *    统一改写成走 Node 路由 `/api/music/file/xxx.mp3` 就绕开了这条规则。
 *    外链（http/https 开头）原样返回，不动。
 */
function toPlayableUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (value.startsWith("/music/")) {
    // 用 query 传文件名：动态路由目录名带方括号，在部分工具链/打包脚本里容易出问题
    return "/api/music/file?name=" + encodeURIComponent(value.slice("/music/".length));
  }
  return value;
}

export default function MusicPlayer() {
  const pathname = usePathname();
  const [data, setData] = useState(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [volume, setVolume] = useState(0.5);

  const audioRef = useRef(null);
  const unlockedRef = useRef(false);
  // 网易云可达性：null = 还没探测 / true = 能访问 / false = 访问不了
  const [neteaseReachable, setNeteaseReachable] = useState(null);
  // 播放失败时的提示 —— 不再静默吞掉，否则"点了没反应"根本没法排查
  const [errorMsg, setErrorMsg] = useState("");

  // ---------- 网易云可达性探测（用于自动降级） ----------
  // 音源选「网易云收藏」时先确认用户这边能不能访问 music.163.com：
  // 访问不了就把界面降级成本地歌单，避免浮窗里一片空白、用户以为坏了。
  // 这个行为可以在后台关掉（autoFallback = false）。
  //
  // ⚠️ 这里曾经写过「手机浏览器直接当作访问不了」—— **那是错的，已经撤掉**。
  //    当时的假设是"网易云外链播放器在手机上用不了"，但实测反例很明确：
  //    手机上访问别的带网易云的网站是能正常播放的。
  //    所以不要凭猜测降级 —— 只在**确实探测不通**时才降级（下面的逻辑）。
  useEffect(() => {
    if (data?.music?.source !== "netease") return;
    if (data?.music?.autoFallback === false) return;

    let alive = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);

    fetch("https://music.163.com/favicon.ico", {
      mode: "no-cors", // 跨域读不到内容，但能判断"通不通"
      cache: "no-store",
      signal: controller.signal,
    })
      .then(() => {
        if (alive) setNeteaseReachable(true);
      })
      .catch(() => {
        if (alive) setNeteaseReachable(false);
      })
      .finally(() => clearTimeout(timer));

    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [data?.music?.source, data?.music?.autoFallback]);

  // ---------- 拉歌单 ----------
  useEffect(() => {
    let alive = true;
    fetch("/api/music/playlist", { cache: "no-store" })
      .then((r) => r.json())
      .then((res) => {
        if (!alive) return;
        setData(res);
        setVolume(Number(res?.music?.defaultVolume) || 0.5);
        // 恢复上次播到哪首
        const savedIndex = Number(localStorage.getItem("solace_music_index"));
        if (Number.isInteger(savedIndex) && savedIndex >= 0) setIndex(savedIndex);
        const savedVolume = Number(localStorage.getItem("solace_music_volume"));
        if (Number.isFinite(savedVolume) && savedVolume >= 0) setVolume(savedVolume);
      })
      .catch(() => {
        /* 拿不到歌单就整个不显示 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const tracks = data?.tracks || [];
  const neteaseTracks = data?.neteaseTracks || [];
  const musicConfig = data?.music || {};

  // ⚠️ 索引必须夹在合法范围内：localStorage 里可能存着上一份歌单的序号，
  //    换过歌单之后 index 越界 → current 为 null → 点播放毫无反应（以前就是静默 return）
  const safeIndex = tracks.length ? Math.min(Math.max(index, 0), tracks.length - 1) : 0;
  const current = tracks[safeIndex] || null;

  // ---------- 播放控制 ----------
  const play = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!current) {
      // 以前这里是静默 return，用户点了完全没反应、也看不到原因
      setErrorMsg(
        tracks.length ? "这首歌不在歌单里，试试切换上一首/下一首" : "歌单是空的"
      );
      return;
    }
    setErrorMsg("");

    // preload="none" 时首次播放要显式 load 一次，
    // 否则个别浏览器会认为"没有可用的源"直接抛 NotSupportedError
    try {
      if (audio.readyState === 0) audio.load();
    } catch {
      /* 忽略 */
    }
    try {
      await audio.play();
      setPlaying(true);
    } catch (err) {
      // ⚠️ 把失败原因显示出来，不要静默 —— 否则用户"点了没动静"没法排查
      setPlaying(false);
      const name = err?.name || "";
      if (name === "NotAllowedError") {
        setErrorMsg("浏览器拦住了播放，请再点一次播放键");
      } else if (name === "NotSupportedError") {
        setErrorMsg("这个地址没法播放（格式不支持或文件不存在）");
      } else {
        setErrorMsg("播放失败：" + (err?.message || name || "未知原因"));
      }
    }
  }, [current]);

  function pause() {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    setPlaying(false);
  }

  function toggle() {
    if (playing) pause();
    else play();
  }

  function switchTo(nextIndex) {
    if (!tracks.length) return;
    const safe = (nextIndex + tracks.length) % tracks.length;
    setIndex(safe);
    localStorage.setItem("solace_music_index", String(safe));
  }

  // 换歌后如果本来在播，就接着播
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    audio.load();
    if (playing) {
      audio.play().catch(() => setPlaying(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, current?.url]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = Math.min(1, Math.max(0, volume));
    localStorage.setItem("solace_music_volume", String(volume));
  }, [volume]);

  // ---------- 首次交互后自动播放 ----------
  useEffect(() => {
    if (!musicConfig.autoPlay) return;
    if (!tracks.length) return;
    if (unlockedRef.current) return;

    const unlock = () => {
      if (unlockedRef.current) return;
      unlockedRef.current = true;
      // 记住用户开过音乐，下次进站交互后自动接上
      localStorage.setItem("solace_music_on", "1");
      play();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("touchstart", unlock);
      window.removeEventListener("keydown", unlock);
    };

    // 只在用户"上次开过音乐"或首次访问时挂监听，避免用户明确暂停后又被自动唤醒
    const wasOn = localStorage.getItem("solace_music_on");
    if (wasOn === "0") return;

    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("touchstart", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("touchstart", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [musicConfig.autoPlay, tracks.length, play]);

  // ⚠️ 浮窗的位置交给 useDraggable：**收起成小球时可以拖着换地方**，
  //    位置记在 localStorage，刷新 / 换页面都还在原地。
  //    拖动能力在 lib/use-draggable.js，压力读数那个小球用的是同一套。
  //
  //    ⚠️ **这两个 hook 必须放在下面那些 `return null` 之前** ——
  //    放到提前返回之后会**直接违反 Hooks 规则（构建报 Error）**：
  //    React 要求每次渲染的 hook 调用顺序完全一致，
  //    而 early return 会让"有歌可播"和"没歌可播"这两种渲染走过的 hook 数量不一样。
  const ball = useDraggable({
    storageKey: "solace_music_ball",
    defaultLeft: 16,
    defaultBottom: 96,
  });

  // ⚠️ 面板展开 / 收起时容器尺寸会变（40px ↔ 320px），位置要**重新夹一次边界** ——
  //    否则"拖到屏幕右边再展开"时，面板会有一部分跑到屏幕外，
  //    而那时小球已经变成面板了，**用户没东西可拖，位置就卡死了**。
  useEffect(() => {
    ball.reclamp();
  }, [expanded]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data || !musicConfig.enabled) return null;
  // 后台和安装页不显示播放器
  if (pathname?.startsWith("/admin") || pathname?.startsWith("/install")) return null;
  if (!tracks.length && !neteaseTracks.length) return null;

  // 音源设置是「本地歌单」，但一首可播的本地歌都没有、却配了网易云歌 ——
  // 这时直接把网易云展示出来，总比给用户一个"歌单是空的"强
  const autoNetease =
    musicConfig.source !== "netease" && tracks.length === 0 && neteaseTracks.length > 0;

  const showNetease =
    (musicConfig.source === "netease" || autoNetease) && neteaseReachable !== false;

  const fellBack = musicConfig.source === "netease" && neteaseReachable === false;

  return (
    <div ref={ball.ref} style={ball.style} className="fixed z-40 select-none">
      <audio
        ref={audioRef}
        src={current?.url ? toPlayableUrl(current.url) : undefined}
        preload="none"
        onEnded={() => switchTo(index + 1)}
        onError={() => {
          setPlaying(false);
          // 最常见的原因：文件没上传成功，或路径不对（404）
          setErrorMsg(
            `这首歌加载失败：${current?.url || "地址为空"}（检查文件是否存在）`
          );
        }}
        loop={tracks.length === 1}
      />

      {/* 收起状态：一个小圆图标（**可以拖动**） */}
      {!expanded ? (
        <button
          {...ball.handlers}
          type="button"
          onClick={() => {
            // ⚠️ 刚才是"拖"就不算"点" —— 否则每次挪完位置都会顺手把面板展开
            if (ball.shouldIgnoreClick()) return;
            setExpanded(true);
          }}
          title="背景音乐（可以拖动）"
          className={`w-10 h-10 cursor-grab rounded-full bg-white/90 backdrop-blur border border-[#d5d9d7] shadow-md flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-white transition-colors ${
            ball.dragging ? "cursor-grabbing" : ""
          }`}
        >
          <span className={playing ? "animate-pulse" : ""}>♪</span>
        </button>
      ) : null}

      {/* ⚠️ 面板**始终挂载**，收起时只是用 CSS 挪出可视区，而不是卸载它。
          原因：网易云是 iframe —— 一旦被卸载，用户在它里面点的播放就断了，
          表现就是"一收起浮窗，网易云的歌就停了"。
          挪走之后 iframe 还活着，播放能继续。 */}
      <div
        className={
          expanded
            ? "w-80 rounded-2xl bg-white/95 backdrop-blur shadow-xl border border-[#e6e8e6] overflow-hidden"
            : "pointer-events-none absolute -left-[9999px] top-0 w-80 opacity-0"
        }
        aria-hidden={!expanded}
      >
          {/* 头部：标题 + 收起 */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-[#f0f2f0]">
            <span className="text-xs font-medium text-slate-600">
              {showNetease ? "网易云收藏" : "背景音乐"}
            </span>
            <div className="flex items-center gap-2">
              {fellBack ? (
                <span
                  className="text-[10px] text-amber-600"
                  title="已自动切到本地歌单 —— 因为探测到当前网络访问不了网易云（music.163.com）。如果你能正常打开网易云，可以在后台把「网易云访问不了时自动降级」关掉"
                >
                  已切到本地
                </span>
              ) : null}
              {autoNetease ? (
                <span
                  className="text-[10px] text-amber-600"
                  title="本地歌单里没有可播的歌，已自动显示网易云收藏"
                >
                  本地无歌曲
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setExpanded(false);
                  setListOpen(false);
                }}
                className="text-slate-400 hover:text-slate-600 text-base leading-none px-1"
                title="收起"
              >
                ×
              </button>
            </div>
          </div>

          {showNetease ? (
            /* 网易云：官方外链播放器。
               ✅ 用户可以直接点里面的播放/暂停/上一首/下一首/列表切歌；
               ⚠️ 但我们（代码）控制不了它，也没法把它混进自动播放队列 —— 这是跨域限制。 */
            <div className="px-3 py-3">
              {neteaseTracks.length === 0 ? (
                <p className="text-xs text-slate-400">还没有添加网易云歌曲</p>
              ) : (
                <div className="space-y-3 max-h-72 overflow-y-auto">
                  {neteaseTracks.map((item) => {
                    // type=0 是歌单，需要更高的容器才能显示列表
                    const isPlaylist = item.neteaseType === "0";
                    const height = isPlaylist ? 430 : 86;
                    return (
                      <div key={item.id}>
                        {/* 歌名做成链接：手机上点击会唤起网易云 App，
                            万一播放器在某个环境下不好用，也有条保底路径 */}
                        <a
                          href={
                            isPlaylist
                              ? `https://music.163.com/playlist?id=${encodeURIComponent(
                                  item.neteaseId
                                )}`
                              : `https://music.163.com/song?id=${encodeURIComponent(
                                  item.neteaseId
                                )}`
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block text-xs text-slate-600 mb-1 truncate hover:text-[#5b8aa6] hover:underline"
                          title="在网易云里打开（手机上会唤起 App）"
                        >
                          {isPlaylist ? "🎵 " : ""}
                          {item.title}
                          {item.artist ? ` · ${item.artist}` : ""}
                        </a>
                        <iframe
                          title={item.title}
                          frameBorder="0"
                          border="0"
                          marginWidth="0"
                          marginHeight="0"
                          width="100%"
                          height={height}
                          src={`https://music.163.com/outchain/player?type=${
                            item.neteaseType || "2"
                          }&id=${encodeURIComponent(item.neteaseId)}&auto=0&height=${
                            isPlaylist ? 430 : 66
                          }`}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                点播放器里的按钮即可播放、暂停、切歌
              </p>
            </div>
          ) : (
            /* 本地 / 外链：完整播放控制 */
            <div className="px-3 py-3">
              <p className="text-sm text-slate-700 truncate">
                {current ? current.title : "还没有可播放的本地歌曲"}
              </p>
              {!current ? (
                <p className="mt-2 rounded-lg bg-[#f7f9f8] px-2 py-1.5 text-[11px] leading-relaxed text-slate-500">
                  后台「背景音乐」里上传本地歌曲，或把音源切换成「网易云收藏」。
                </p>
              ) : null}
              <p className="text-xs text-slate-400 truncate mt-0.5">
                {current?.artist || " "}
              </p>

              {errorMsg ? (
                <p className="mt-2 rounded-lg bg-[#fdf6f6] px-2 py-1.5 text-[11px] leading-relaxed break-all text-red-500">
                  {errorMsg}
                </p>
              ) : null}

              {/* 诊断信息：万一还是不出声，看这一行就知道卡在哪 */}
              <p className="mt-2 text-[10px] leading-relaxed text-slate-300 break-all">
                共 {tracks.length} 首 · 第 {safeIndex + 1} 首 · 音量{" "}
                {Math.round(volume * 100)}% · {toPlayableUrl(current?.url) || "无地址"}
              </p>

              <div className="flex items-center justify-between gap-2 mt-3 px-2">
                <button
                  type="button"
                  onClick={() => switchTo(index - 1)}
                  disabled={tracks.length <= 1}
                  className="w-8 h-8 rounded-full flex items-center justify-center text-slate-500 hover:bg-[#f1f5f7] disabled:opacity-30 transition-colors"
                  title="上一首"
                >
                  ⏮
                </button>
                <button
                  type="button"
                  onClick={toggle}
                  disabled={!current}
                  className="w-10 h-10 rounded-full bg-[#7fa3b8] text-white flex items-center justify-center hover:bg-[#6d92a8] disabled:opacity-40 transition-colors"
                  title={playing ? "暂停" : "播放"}
                >
                  {playing ? "⏸" : "▶"}
                </button>
                <button
                  type="button"
                  onClick={() => switchTo(index + 1)}
                  disabled={tracks.length <= 1}
                  className="w-8 h-8 rounded-full flex items-center justify-center text-slate-500 hover:bg-[#f1f5f7] disabled:opacity-30 transition-colors"
                  title="下一首"
                >
                  ⏭
                </button>
              </div>

              <div className="flex items-center gap-2 mt-3">
                <span className="text-xs text-slate-400">音量</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={volume}
                  onChange={(e) => setVolume(Number(e.target.value))}
                  className="flex-1 accent-[#7fa3b8]"
                />
              </div>

              <button
                type="button"
                onClick={() => setListOpen((v) => !v)}
                className="w-full mt-3 text-xs text-slate-500 hover:text-slate-700 py-1.5 rounded-lg hover:bg-[#f1f5f7] transition-colors"
              >
                {listOpen ? "收起歌单" : `歌单（${tracks.length} 首）`}
              </button>

              {listOpen ? (
                <ul className="mt-1 max-h-40 overflow-y-auto space-y-0.5">
                  {tracks.map((item, i) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => switchTo(i)}
                        className={`w-full text-left text-xs px-2 py-1.5 rounded-lg truncate transition-colors ${
                          i === index
                            ? "bg-[#e3edf3] text-slate-800"
                            : "text-slate-600 hover:bg-[#f1f5f7]"
                        }`}
                      >
                        {i + 1}. {item.title}
                        {item.artist ? ` · ${item.artist}` : ""}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              <button
                type="button"
                onClick={() => {
                  // ⚠️ 这个按钮以前会 pause() —— 用户点「关闭」的本意往往只是
                  //    "把窗口收起来"，结果音乐也跟着停了（网易云的 iframe 还会被卸载）。
                  //    现在改成**只收起窗口，继续播放**。
                  //    真要停音乐：点上方的暂停按钮，或者把音量拖到 0。
                  setExpanded(false);
                  setListOpen(false);
                }}
                className="w-full mt-2 text-[11px] text-slate-400 hover:text-slate-600 py-1 transition-colors"
                title="只是收起浮窗，音乐继续播放"
              >
                收起浮窗（音乐继续）
              </button>
            </div>
          )}
        </div>
    </div>
  );
}
