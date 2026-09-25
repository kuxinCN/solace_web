/**
 * 取网易云内容的名称：GET /api/admin/music/netease-info?type=2&id=1901371647
 *
 * ⚠️ 说明（合规相关，改这块前先看）：
 *   网易云**官方没有开放"按 ID 取歌名"的接口** —— 开放平台要单独申请资质。
 *   这里用的是最保守的做法：请求官方**公开网页**（歌曲页 / 歌单页），
 *   从 HTML 的 `<title>` 里读出名字。
 *
 *   ✅ 只读标题，**不碰任何播放地址**，不做任何绕过限制的解析；
 *   ✅ 拿不到就返回 ok:false，让管理员手动填 —— 不重试、不伪造。
 *
 * 结果只用来给后台表单**预填**，管理员可以随便改。
 */
import { getAdminFromRequest } from "@/lib/admin-auth";
import { json, jsonError } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 从 HTML 里抠 <title> 并做实体解码 */
function pickTitle(html) {
  const match = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  return match[1]
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function GET(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const url = new URL(request.url);
  const type = url.searchParams.get("type") === "0" ? "0" : "2";
  const id = String(url.searchParams.get("id") || "").trim();

  // 顺手支持粘贴完整链接
  const matched = id.match(/[?&]id=(\d{4,20})/) || id.match(/^(\d{4,20})$/);
  const realId = matched ? matched[1] : "";
  if (!realId) return jsonError("请填写正确的 ID（纯数字，或含 id= 的链接）", 400);

  const pageUrl =
    type === "0"
      ? `https://music.163.com/playlist?id=${realId}`
      : `https://music.163.com/song?id=${realId}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(pageUrl, {
      signal: controller.signal,
      cache: "no-store",
      headers: {
        // 用普通浏览器 UA，避免被判定成爬虫
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    });

    if (!res.ok) {
      return json({ ok: false, error: `网易云返回 HTTP ${res.status}，请手动填写` }, 200);
    }

    const html = await res.text();
    let title = pickTitle(html);

    // 标题格式通常是「歌名 - 歌手 - 单曲 - 网易云音乐」或「歌单名 - 歌单 - 网易云音乐」
    title = title
      .replace(/\s*-\s*网易云音乐\s*$/i, "")
      .replace(/\s*-\s*单曲\s*$/i, "")
      .replace(/\s*-\s*歌单\s*$/i, "")
      .replace(/\s*-\s*MV\s*$/i, "")
      .replace(/\s*-\s*专辑\s*$/i, "")
      .trim();

    if (!title || title.includes("网易云音乐")) {
      return json({ ok: false, error: "没能读到名字，请手动填写" }, 200);
    }

    // 「歌名 - 歌手」拆开
    const parts = title.split(/\s+-\s+/);
    const name = (parts[0] || "").trim();
    const artist = parts.length > 1 ? parts.slice(1).join(" - ").trim() : "";

    return json({ ok: true, title: name, artist, raw: title, page: pageUrl });
  } catch (err) {
    return json(
      {
        ok: false,
        error:
          "取不到（服务器访问不了网易云或超时）：" +
          String(err?.message || err)
            .replace(/\s+/g, " ")
            .slice(0, 100),
      },
      200
    );
  } finally {
    clearTimeout(timer);
  }
}
