/**
 * 用户端语音配置：GET /api/tts/config
 *
 * 公开接口、**不需要登录**（和 /api/pet、/api/music/playlist 一样）。
 *
 * 前端只需要两件事，别的**一律不返回**（尤其别把 apiKey / baseUrl 漏出去）：
 *   ① 用户看到的文本要不要剥朗读标签（开关开着 + 接口类型是小米 MiMo）；
 *   ② 按哪一份词表剥 —— 必须是后台那一份，否则会出现"后台加了词、前端还在漏"。
 *
 * ⚠️ 前端拿到它之后调的是 `lib/tts-tags.js` 里**同一个** `stripTtsTags`：
 *    剥离规则只有一处实现，前后端不会各写一份正则然后慢慢漂移。
 */
import { DEFAULT_EVENT_WORDS, DEFAULT_STYLE_WORDS } from "@/lib/tts-tags";
import { getGroup } from "@/lib/settings";
import { json } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = await getGroup("tts");
    return json({
      ok: true,
      tts: {
        enabled: config?.enabled === true,
        provider: String(config?.provider || ""),
        styleTags: config?.styleTags !== false,
        styleTagWords: String(config?.styleTagWords || DEFAULT_STYLE_WORDS),
        eventTagWords: String(config?.eventTagWords || DEFAULT_EVENT_WORDS),
      },
    });
  } catch (err) {
    // 表还没建好 / 配置读不到：给一份"出厂词表 + 不说自己是 MiMo"的最小配置。
    // ⚠️ provider 故意给空串 —— 前端因此**不剥**标签，而这与服务端"读不到配置就不注入
    //    标签指令"是自洽的：谁也不生成、谁也不剥，行为等于没上这个功能。
    return json({
      ok: true,
      tts: {
        enabled: false,
        provider: "",
        styleTags: true,
        styleTagWords: DEFAULT_STYLE_WORDS,
        eventTagWords: DEFAULT_EVENT_WORDS,
        warn:
          "读取语音配置失败：" +
          String(err?.code || err?.message || err)
            .replace(/\s+/g, " ")
            .slice(0, 160),
      },
    });
  }
}
