/**
 * 文字转语音接口：直接返回音频二进制，前端可以这样用：
 *   const res = await fetch("/api/tts", { method: "POST", headers: {...}, body: JSON.stringify({ text }) });
 *   new Audio(URL.createObjectURL(await res.blob())).play();
 * 配置来自后台「TTS」页面。需要用户端已登录。
 */
import { requestSpeech } from "@/lib/ai";
import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/user-auth";
import { cleanString, clientIp, jsonError } from "@/lib/util";

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

  const text = cleanString(payload.text, 1000);
  const voice = cleanString(payload.voice, 64);

  if (!text) return jsonError("要合成的文字不能为空", 400);

  const result = await requestSpeech({ text, voice });
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
