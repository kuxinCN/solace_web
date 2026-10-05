/**
 * 文字转语音接口：直接返回音频二进制，前端可以这样用：
 *   const res = await fetch("/api/tts", { method: "POST", headers: {...}, body: JSON.stringify({ text }) });
 *   new Audio(URL.createObjectURL(await res.blob())).play();
 * 配置来自后台「TTS」页面。需要用户端已登录。
 */
import { requestSpeech, prewarmConnections } from "@/lib/ai";
import { getGroup } from "@/lib/settings";
import { isStyleTagsEnabled, stripNonTagBrackets, stripTtsTags, tagWordsFrom } from "@/lib/tts-tags";
import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/user-auth";
import { cleanString, clientIp, jsonError, stripEmoji, stripSymbolNoise } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 限流：按用户 + 按 IP 各一层 */
const USER_RATE_LIMIT = { limit: 20, windowMs: 60 * 1000 };
const IP_RATE_LIMIT = { limit: 40, windowMs: 60 * 1000 };

export async function POST(request) {
  const user = await getCurrentUser(request);
  if (!user) return jsonError("请先登录", 401);

  const ipQuota = rateLimit(`tts:ip:${clientIp(request) || "direct"}`, IP_RATE_LIMIT);
  const userQuota = rateLimit(`tts:user:${user.id}`, USER_RATE_LIMIT);
  const quota = ipQuota.ok ? userQuota : ipQuota;
  if (!quota.ok) {
    return jsonError(`请求过于频繁，请 ${quota.retryAfterSeconds} 秒后再试`, 429);
  }

  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return jsonError("请求体不是合法 JSON", 400);
  }

  // 预热模式：只建立到上游 TTS 的连接，不真正合成（前端发消息时提前调用，降低首句 TTS 延迟）
  if (payload.prewarm === true) {
    prewarmConnections({ tts: true });
    return Response.json({ ok: true, warmed: true });
  }

  const text = cleanString(payload.text, 1000);
  let voice = cleanString(payload.voice, 64);

  if (!text) return jsonError("要合成的文字不能为空", 400);

  // ⚠️ 这一份配置下面要用两次（挑音色 + 判断朗读标签），所以提到最前面**只读一次**。
  //    读不到就当成"不是小米 MiMo"处理：下面会把标签剥掉 ——
  //    宁可少听一点语气，也绝不能把 `[开心]` 念给用户听。
  let ttsConfig = null;
  try {
    ttsConfig = await getGroup("tts");
  } catch {
    ttsConfig = null;
  }

  // ⚠️ 音色跟着 AI 人格走：
  //
  //    前端可以不传 voice（或传 "auto"），由后端根据用户选的「她 / 他」挑音色 ——
  //    后台配了「女性音色 / 男性音色」就用对应那个，没配就回退到「默认音色」。
  //    这样"换个 AI 人格，声音也跟着换"，前端不用跟着改。
  if (!voice || voice === "auto") {
    const persona = String(user.aiPersona || "").trim().toLowerCase();
    const byPersona =
      persona === "female"
        ? ttsConfig?.voiceFemale
        : persona === "male"
          ? ttsConfig?.voiceMale
          : "";
    voice = String(byPersona || ttsConfig?.voice || "").trim();
  }

  // TTS 专用副本：三层净化，都不改动前端的原始数据。
  //   ① stripEmoji：`😊` 会被 MiMo 读成"笑脸"；
  //   ② stripSymbolNoise：**颜文字 / ASCII 画会被一个符号一个符号念出来** ——
  //      实测 `(￣▽￣)ノ 来一个` 念成「侬来一个」，而人设就是爱用颜文字的那种；
  //   ③ stripNonTagBrackets：**人设的"括号动作描写"要么被念出来、要么把整句合成搞成乱码** ——
  //      实测 `（没说话，就坐在你旁边）嗯，那就难过一会儿吧` 听成
  //      「没做我调便宜呀，你想我可能设计彻底的吧？」。
  //
  // ⚠️ 朗读标签要**在这里按接口类型决定去留**：
  //   * 小米 MiMo 认识 `(温柔)` `[叹气]` 这些标签（官方「音频标签控制」），
  //     语气全靠它 —— 所以**必须原样留着**，剥了就等于把功能关了；
  //   * OpenAI 兼容协议不认识，会把标签当普通文字一字一顿念出来 —— 必须剥掉。
  //   为什么非要在服务端再剥一次：库里存的是**带标签的原文**，
  //   用户随时可能把接口类型从 MiMo 换成 OpenAI 兼容，那时翻历史记录朗读就会踩到。
  //   ⚠️ 顺序也重要：**先定标签去留、再去掉非标签的括号内容** ——
  //      后者是"白名单之外一律删"，反过来的话连该留的语气标签一起删了。
  const tagWords = tagWordsFrom(ttsConfig);
  const withoutTags = isStyleTagsEnabled(ttsConfig)
    ? text
    : stripTtsTags(text, tagWords);
  const withoutStageDirections = stripNonTagBrackets(withoutTags, tagWords);
  const speakText = stripSymbolNoise(stripEmoji(withoutStageDirections));
  // 纯 emoji / 纯颜文字 / 纯标签（或整条都是动作描写）的内容净化后为空，直接返回，避免白调一次上游
  if (!speakText) return jsonError("要合成的文字不能为空（剥掉朗读标签后没有可念的内容）", 400);

  const result = await requestSpeech({ text: speakText, voice });
  if (!result.ok) return jsonError(result.error, 400);

  return new Response(result.buffer, {
    status: 200,
    headers: {
      "Content-Type": result.contentType,
      "Content-Length": String(result.buffer.byteLength),
      "Cache-Control": "no-store",
    },
  });
}
