/**
 * 后台「语音试听」：用配置好的 TTS 接口合成一小段语音，返回 base64 供浏览器播放。
 * 只用于试听，不落库。
 */
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import { requestSpeech } from "@/lib/ai";
import {
  cleanString,
  clientIp,
  json,
  jsonError,
  readJsonBody,
  stripEmoji,
} from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PREVIEW_CHARS = 120;

export async function POST(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);
  const text = cleanString(body.text || "你好，这里是 Solace 的语音试听。", MAX_PREVIEW_CHARS);
  const voice = cleanString(body.voice, 64);

  if (!text) return jsonError("试听文字不能为空", 400);

  // 试听同样移除 emoji，避免 MiMo 把表情读成“笑脸”
  const speakText = stripEmoji(text);
  if (!speakText) return jsonError("试听文字不能为空", 400);

  const result = await requestSpeech({ text: speakText, voice });
  if (!result.ok) {
    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "test_tts_failed",
      detail: result.error,
      ip: clientIp(request),
    });
    return jsonError(result.error, 400);
  }

  await logAudit({
    adminId: admin.adminId,
    username: admin.username,
    action: "test_tts",
    detail: `试听 ${speakText.length} 字`,
    ip: clientIp(request),
  });

  return json({
    ok: true,
    contentType: result.contentType,
    audio: `data:${result.contentType};base64,${result.buffer.toString("base64")}`,
    bytes: result.buffer.byteLength,
  });
}
