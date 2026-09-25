/**
 * 后台「对话 AI 连通性测试」：POST /api/admin/ai/test
 *
 * 解决的问题：以前填完配置保存了，聊两句却只回兜底文案，
 * 完全不知道是 Key 错了、模型名错了、还是服务器连不上。
 * 现在点一下「测试连接」，直接把真实结果（含上游原始报错）显示出来。
 *
 * body（字段全部可选）：
 *   { baseUrl, apiKey, model }
 *   —— 传了就用传的（页面上"改了还没保存"的值），没传就用已保存的配置。
 *
 * 返回：
 *   成功 { ok: true,  latencyMs, model, url, reply, usage }
 *   失败 { ok: false, latencyMs, status?, error, hint }
 *   注意：失败时 HTTP 状态仍是 200，便于前端统一处理（真正的状态码在 status 字段里）。
 *
 * 成本控制：只发一句「你好」，不带系统提示词，max_tokens 限到 32。
 */
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import { chatCompletionsUrl } from "@/lib/ai";
import { getGroup } from "@/lib/settings";
import { cleanString, clientIp, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEST_PROMPT = "你好";
const TIMEOUT_MS = 20000;

/** 按上游状态码给一句人话提示 */
function hintForStatus(status) {
  if (status === 401 || status === 403) return "Key 不对或没有权限：确认 Key 完整、前后没有多余空格";
  if (status === 404)
    return "地址不对：只填到版本目录（如 https://open.bigmodel.cn/api/paas/v4），不要带 /chat/completions";
  if (status === 429) return "触发限流或额度用尽：去服务商控制台看余额与限额";
  if (status === 400) return "参数有误：最常见的是模型名不存在，换个模型名试试";
  if (status >= 500) return "上游服务异常：稍后重试";
  return "把上面的报错原文发给我，或去服务商控制台核对配置";
}

export async function POST(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);

  let saved = null;
  try {
    saved = await getGroup("ai");
  } catch {
    saved = null;
  }

  const baseUrl = cleanString(body.baseUrl, 500) || String(saved?.baseUrl || "").trim();
  const apiKey = cleanString(body.apiKey, 500) || String(saved?.apiKey || "").trim();
  const model = cleanString(body.model, 120) || String(saved?.model || "").trim();

  if (!baseUrl) return jsonError("请先填「接口地址」", 400);
  if (!apiKey) return jsonError("请先填「API Key」", 400);
  if (!model) return jsonError("请先填「模型名」", 400);

  const url = chatCompletionsUrl(baseUrl);
  const startedAt = Date.now();

  try {
    const res = await fetch(url, {
      method: "POST",
      signal:
        typeof AbortSignal?.timeout === "function"
          ? AbortSignal.timeout(TIMEOUT_MS)
          : undefined,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: TEST_PROMPT }],
        max_tokens: 32,
        stream: false,
      }),
    });

    const latencyMs = Date.now() - startedAt;
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }

    if (!res.ok) {
      const upstreamMessage =
        data?.error?.message ||
        data?.error?.code ||
        data?.message ||
        String(raw || "").slice(0, 300) ||
        "(上游没有返回内容)";

      await logAudit({
        adminId: admin.adminId,
        username: admin.username,
        action: "test_ai_failed",
        detail: `HTTP ${res.status}｜${upstreamMessage}`,
        ip: clientIp(request),
      });

      return json({
        ok: false,
        latencyMs,
        status: res.status,
        error: `上游返回 ${res.status}：${upstreamMessage}`,
        hint: hintForStatus(res.status),
        url,
      });
    }

    const reply =
      data?.choices?.[0]?.message?.content ||
      data?.choices?.[0]?.message?.reasoning_content ||
      "";

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "test_ai",
      detail: `模型 ${model}｜${latencyMs}ms｜回复「${String(reply).slice(0, 40)}」`,
      ip: clientIp(request),
    });

    return json({
      ok: true,
      latencyMs,
      model,
      url,
      reply: String(reply).slice(0, 200),
      usage: data?.usage || null,
    });
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const message =
      err?.name === "TimeoutError"
        ? `请求超时（${TIMEOUT_MS / 1000} 秒没有响应）`
        : err?.message || String(err);

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "test_ai_failed",
      detail: message,
      ip: clientIp(request),
    });

    return json({
      ok: false,
      latencyMs,
      error: message,
      hint: "连不上上游：检查服务器出网是否被防火墙限制，或用 ping/nslookup 确认域名能解析",
      url,
    });
  }
}
