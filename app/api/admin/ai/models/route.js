/**
 * 后台「拉取可用模型列表」：GET /api/admin/ai/models?baseUrl=&apiKey=
 *
 * OpenAI 协议里有一个标准接口 `GET {baseUrl}/models`，会返回该 Key 可用的模型列表。
 * 有了它，管理员不用去翻文档抄模型名，点一下就能选。
 *
 * ⚠️ 不是每家服务商都实现了 /models（有的会返回 404 或空列表），
 * 所以这里失败时**照样返回 HTTP 200**，只是 ok:false + 空数组，
 * 前端据此提示"该服务商不支持自动获取，请手动输入模型名"。
 *
 * 参数（都可选）：不传就用后台已保存的配置。
 */
import { getAdminFromRequest } from "@/lib/admin-auth";
import { getGroup } from "@/lib/settings";
import { cleanString, json, jsonError } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 15000;

/** 把用户填的接口地址补成 {base}/models */
function modelsUrl(baseUrl) {
  const base = String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "")
    // 用户可能把完整对话地址粘进来了，这里先还原成版本目录
    .replace(/\/chat\/completions$/i, "");
  if (!base) return "";
  return `${base}/models`;
}

export async function GET(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const params = new URL(request.url).searchParams;

  let saved = null;
  try {
    saved = await getGroup("ai");
  } catch {
    saved = null;
  }

  const baseUrl = cleanString(params.get("baseUrl"), 500) || String(saved?.baseUrl || "").trim();
  const apiKey = cleanString(params.get("apiKey"), 500) || String(saved?.apiKey || "").trim();

  if (!baseUrl) return jsonError("请先填「接口地址」", 400);
  if (!apiKey) return jsonError("请先填「API Key」", 400);

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

    // 标准格式是 { data: [{ id: "gpt-4o-mini", ... }] }；
    // 也兼容 { models: [...] } 或直接给数组的情况
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

    // 去重并按字母排序，方便在后台下拉里找
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
      hint: "连不上上游：检查服务器出网是否被防火墙限制；也可以直接手动输入模型名",
    });
  }
}
