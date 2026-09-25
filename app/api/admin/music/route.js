/**
 * 后台歌单管理：GET 列表 / POST 新增 / PATCH 修改 / DELETE 删除
 *
 * 支持三种来源：
 *   * `local`   —— 本地上传（走 /api/admin/music/upload，会写文件到 public/music/）
 *   * `url`     —— 外链直链（比如你自己的 CDN 上的音频）
 *   * `netease` —— 网易云歌曲 ID，前端用**官方外链播放器**渲染
 *
 * ⚠️ 网易云不做任何地址解析：官方没有开放播放接口，
 *    我们只存 ID，由前端 iframe 调官方播放器。
 *
 * 删除 `local` 歌曲时会连带删掉磁盘上的音频文件，避免留下孤儿文件占空间。
 */
import fs from "node:fs";
import path from "node:path";
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import { describeDbError, execute, query } from "@/lib/db";
import { cleanString, clientIp, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MUSIC_DIR = path.join(process.cwd(), "public", "music");
const SOURCES = ["local", "url", "netease"];

function parseId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return 0;
  const id = Number.parseInt(text, 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

/** 从歌单里的 /music/xxx.mp3 反推磁盘路径，并做目录穿越防护 */
function resolveLocalFile(url) {
  const relative = String(url || "").trim();
  if (!relative.startsWith("/music/")) return null;
  const filename = relative.slice("/music/".length);
  if (!filename || filename.includes("/") || filename.includes("..")) return null;
  return path.join(MUSIC_DIR, filename);
}

export async function GET(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  try {
    const tracks = await query(
      `SELECT id, title, artist, source, url, netease_id, netease_type, sort_order, enabled, admin_note, created_at
         FROM music_tracks
        ORDER BY sort_order ASC, id ASC
        LIMIT 300`
    );

    let diskCount = 0;
    let diskBytes = 0;
    try {
      const files = fs.readdirSync(MUSIC_DIR, { withFileTypes: true });
      for (const item of files) {
        if (!item.isFile()) continue;
        diskCount += 1;
        try {
          diskBytes += fs.statSync(path.join(MUSIC_DIR, item.name)).size;
        } catch {
          /* 单个文件读不到就跳过 */
        }
      }
    } catch {
      /* 目录还不存在 */
    }

    return json({
      ok: true,
      tracks,
      disk: { count: diskCount, mb: Math.round((diskBytes / 1024 / 1024) * 10) / 10 },
    });
  } catch (err) {
    // 表还没建出来时按空歌单返回，后台页面照样能打开
    return json({ ok: true, tracks: [], disk: { count: 0, mb: 0 }, note: describeDbError(err) });
  }
}

export async function POST(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);
  const source = cleanString(body.source, 16) || "url";
  const title = cleanString(body.title, 160) || "未命名";
  const artist = cleanString(body.artist, 160) || null;

  if (!SOURCES.includes(source)) {
    return jsonError("来源只能是 local / url / netease", 400);
  }
  if (source === "local") {
    return jsonError("本地上传请用「上传音频」按钮，接口是 /api/admin/music/upload", 400);
  }

  let url = null;
  let neteaseId = null;

  if (source === "url") {
    const raw = cleanString(body.url, 800);
    if (!/^https?:\/\//i.test(raw)) return jsonError("外链必须是 http(s) 开头的完整地址", 400);
    url = raw;
  } else {
    // 网易云：只接受歌曲 ID（数字），不接受也不知道怎么解析播放地址
    // ⚠️ 长度上限要够：完整网易云链接有 40+ 字符，
    //    以前截到 32 会把 "?id=1901371647" 砍成 "?id=1"，于是链接永远识别不了
    const raw = cleanString(body.neteaseId || body.url, 800);
    const match = raw.match(/^\d{4,20}$/) || raw.match(/[?&]id=(\d{4,20})/);
    if (!match) {
      return jsonError("请填网易云歌曲 ID（那串数字），或粘贴含 id= 的歌曲链接", 400);
    }
    neteaseId = match[1] || match[0];
  }

  // 网易云播放器类型：2 = 单曲，0 = 歌单（对应官方 outchain 的 type 参数）
  const neteaseType = String(body.neteaseType || "2").trim() === "0" ? "0" : "2";
  // 管理员备注：只在后台显示，用户端拿不到（/api/music/playlist 不返回这个字段）
  const adminNote = cleanString(body.adminNote, 500) || null;

  try {
    const sortOrder = Number.isInteger(Number(body.sortOrder)) ? Number(body.sortOrder) : 0;
    const result = await execute(
      `INSERT INTO music_tracks (title, artist, source, url, netease_id, netease_type, sort_order, enabled, admin_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title,
        artist,
        source,
        url,
        neteaseId,
        neteaseType,
        sortOrder,
        body.enabled === false ? 0 : 1,
        adminNote,
      ]
    );

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "add_music",
      detail: `${title}（${source}）`,
      ip: clientIp(request),
    });

    return json({ ok: true, id: result.insertId });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function PATCH(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);
  const id = parseId(body.id);
  if (!id) return jsonError("缺少歌曲 id", 400);

  const sets = [];
  const params = [];

  if (typeof body.title === "string") {
    sets.push("title = ?");
    params.push(cleanString(body.title, 160) || "未命名");
  }
  if (typeof body.artist === "string") {
    sets.push("artist = ?");
    params.push(cleanString(body.artist, 160) || null);
  }
  if (body.sortOrder !== undefined) {
    sets.push("sort_order = ?");
    params.push(Number.isInteger(Number(body.sortOrder)) ? Number(body.sortOrder) : 0);
  }
  if (body.enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(body.enabled === true || body.enabled === 1 || body.enabled === "1" ? 1 : 0);
  }
  if (typeof body.url === "string") {
    const raw = cleanString(body.url, 800);
    if (raw && !/^https?:\/\//i.test(raw)) return jsonError("外链必须是 http(s) 开头的完整地址", 400);
    sets.push("url = ?");
    params.push(raw || null);
  }

  if (!sets.length) return jsonError("没有需要修改的内容", 400);

  try {
    const result = await execute(`UPDATE music_tracks SET ${sets.join(", ")} WHERE id = ?`, [
      ...params,
      id,
    ]);
    if (!result.affectedRows) {
      const exists = await query("SELECT id FROM music_tracks WHERE id = ? LIMIT 1", [id]);
      if (!exists.length) return jsonError("歌曲不存在", 404);
    }

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "update_music",
      detail: `#${id} ${sets.join(", ")}`,
      ip: clientIp(request),
    });

    return json({ ok: true });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function DELETE(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const id = parseId(new URL(request.url).searchParams.get("id"));
  if (!id) return jsonError("缺少歌曲 id", 400);

  try {
    const rows = await query(
      "SELECT id, title, source, url FROM music_tracks WHERE id = ? LIMIT 1",
      [id]
    );
    const track = rows[0];
    if (!track) return jsonError("歌曲不存在", 404);

    await execute("DELETE FROM music_tracks WHERE id = ?", [id]);

    // 本地上传的歌，连带把磁盘文件删掉，避免留下孤儿文件
    let fileRemoved = false;
    if (String(track.source) === "local") {
      const filePath = resolveLocalFile(track.url);
      if (filePath) {
        try {
          fs.unlinkSync(filePath);
          fileRemoved = true;
        } catch {
          /* 文件本来就不在就算了 */
        }
      }
    }

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "delete_music",
      detail: `${track.title}（${track.source}${fileRemoved ? "，已删文件" : ""}）`,
      ip: clientIp(request),
    });

    return json({ ok: true, fileRemoved });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
