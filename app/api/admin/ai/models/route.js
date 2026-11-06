/**
 * 后台「拉取可用模型列表」：
 *   GET  /api/admin/ai/models?baseUrl=&apiKey=
 *   POST /api/admin/ai/models  body: { baseUrl, apiKey }
 *
 * 优先按照前端当前输入框传入的 baseUrl 和 apiKey 向服务商请求模型列表，
 * 未传或留空时回退已保存的配置。避免修改配置后必须先点保存的割裂体验。
 */
import { getAdminFromRequest } from "@/lib/admin-auth";
import { getGroup } from "@/lib/settings";
import { cleanString, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 15000;

/** 把用户填的接口地址补成 {base}/models */
function modelsUrl(baseUrl) {
  const base = String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "");
  if (!base) return "";
  return `${base}/models`;
}

async function handleFetchModels(reqBaseUrl, reqApiKey) {
  let saved = null;
  try {
    saved = await getGroup("ai");
  } catch {
    saved = null;
  }

  const baseUrl = cleanString(reqBaseUrl, 500) || String(saved?.baseUrl || "").trim();
  const apiKey = cleanString(reqApiKey, 500) || String(saved?.apiKey || "").trim();

  if (!baseUrl) return jsonError("请先填写「接口地址」", 400);
  if (!apiKey) return jsonError("请先填写「API Key」", 400);

  const url = modelsUrl(baseUrl);
  const startedAt = Date.now();

  try {
    const res = await fetch(url, {
      method: "GET",
      signal:
        typeof AbortSignal?.timeout === "function"
          ? AbortSignal.timeout(TIMEOUT_MS)
          : undefined,
      headers: { Authorization: `Bearer ${apiKey}` },
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
      return json({
        ok: false,
        models: [],
        latencyMs,
        url,
        error: `上游返回 ${res.status}：${
          data?.error?.message || String(raw || "").slice(0, 200) || "(无内容)"
        }`,
        hint: "该服务商可能不支持自动获取模型列表，直接手动输入模型名即可",
      });
    }

    const list = Array.isArray(data)
      ? data
      : Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.models)
          ? data.models
          : [];

    const models = list
      .map((item) => (typeof item === "string" ? item : item?.id || item?.name || ""))
      .filter((id) => typeof id === "string" && id.trim())
      .map((id) => id.trim());

    const unique = [...new Set(models)].sort();

    return json({
      ok: true,
      models: unique,
      count: unique.length,
      latencyMs,
      url,
      hint: unique.length ? "" : "上游返回了空列表，请手动输入模型名",
    });
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const message =
      err?.name === "TimeoutError"
        ? `请求超时（${TIMEOUT_MS / 1000} 秒没有响应）`
        : err?.message || String(err);
    return json({
      ok: false,
      models: [],
      latencyMs,
      url,
      error: message,
      hint: "连不上上游：检查网络地址是否正确，或直接手动输入模型名",
    });
  }
}

export async function GET(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const params = new URL(request.url).searchParams;
  return handleFetchModels(params.get("baseUrl"), params.get("apiKey"));
}

export async function POST(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request).catch(() => ({}));
  return handleFetchModels(body?.baseUrl, body?.apiKey);
}
