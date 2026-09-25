/**
 * 导出音乐包：GET /api/admin/music/export
 *
 * 为什么需要它：音频文件存在磁盘上，**数据库备份不包含它们**。
 * 换服务器、重装系统时，光恢复数据库会丢掉所有音乐。这个接口把歌单元数据
 * 与音频内容一起打包成 JSON 下载，导入接口能原样还原。
 *
 * ⚠️ 为什么用 JSON + base64 而不是 zip：
 *    纯 Node 环境没有内置 zip 能力，引入第三方库又多一个依赖；
 *    JSON + base64 体积会大 33%，但零依赖、跨平台、导入解析也简单。
 *    这个接口是给「备份 / 迁移」用的，不是日常下载，体积可以接受。
 *
 * ⚠️ 音频仍然**不进数据库**：它会被 Nginx 直接 serve，
 *    比走 Node 读 BLOB 快一个数量级，也不会占满只有 5 个连接的连接池。
 */
import fs from "node:fs";
import path from "node:path";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { query } from "@/lib/db";
import { jsonError } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MUSIC_DIR = path.join(process.cwd(), "public", "music");
const MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 单次导出上限 500MB，防止把内存撑爆

/** /music/xxx.mp3 → 磁盘绝对路径（带目录穿越防护） */
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

  let tracks = [];
  try {
    tracks = await query(
      `SELECT id, title, artist, source, url, netease_id, sort_order, enabled
         FROM music_tracks
        ORDER BY sort_order ASC, id ASC`
    );
  } catch (err) {
    return jsonError(`读取歌单失败：${err?.message || err}`, 500);
  }

  const files = {};
  let totalBytes = 0;
  const skipped = [];

  for (const track of tracks) {
    if (String(track.source) !== "local" || !track.url) continue;

    const filename = String(track.url).slice("/music/".length);
    const filePath = resolveLocalFile(track.url);
    if (!filePath) continue;

    try {
      const buffer = fs.readFileSync(filePath);
      totalBytes += buffer.length;
      if (totalBytes > MAX_TOTAL_BYTES) {
        skipped.push(`${track.title}（超出 500MB 上限）`);
        continue;
      }
      files[filename] = buffer.toString("base64");
    } catch {
      skipped.push(`${track.title}（文件不存在）`);
    }
  }

  const payload = {
    kind: "solace-music-pack",
    version: 1,
    exportedAt: new Date().toISOString(),
    note: "这是 Solace 的背景音乐导出包，用「导入音乐包」可以原样还原。音频以 base64 存储。",
    trackCount: tracks.length,
    fileCount: Object.keys(files).length,
    totalBytes,
    skipped,
    tracks: tracks.map((track) => ({
      title: track.title,
      artist: track.artist || "",
      source: track.source,
      url: track.url || "",
      neteaseId: track.netease_id || "",
      sortOrder: Number(track.sort_order) || 0,
      enabled: Number(track.enabled) === 1,
    })),
    files,
  };

  const filename = `solace-music-${new Date().toISOString().slice(0, 10)}.json`;

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
