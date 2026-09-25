/**
 * 音乐自查：GET /api/music/diagnose（需要后台登录）
 *
 * 用途：一次性把"为什么播不出声"需要的信息全列出来，不用再反复猜。
 * 会检查四件事：
 *   ① public/music 目录在不在、能不能读
 *   ② 磁盘上有哪些音频文件、各多大
 *   ③ 数据库里有哪些歌、对应的文件在不在磁盘上
 *   ④ 这次请求看到的 Host / X-Forwarded-Host（判断防盗链会不会误伤站内播放）
 */
import fs from "node:fs";
import path from "node:path";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { query } from "@/lib/db";
import { getGroup } from "@/lib/settings";
import { json, jsonError } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MUSIC_DIR = path.join(process.cwd(), "public", "music");

export async function GET(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const report = {
    ok: true,
    cwd: process.cwd(),
    musicDir: MUSIC_DIR,
    dirExists: false,
    diskFiles: [],
    tracks: [],
    problems: [],
    requestHost: request.headers.get("host") || "",
    forwardedHost: request.headers.get("x-forwarded-host") || "",
    referer: request.headers.get("referer") || "",
  };

  // ① 目录
  try {
    report.dirExists = fs.statSync(MUSIC_DIR).isDirectory();
  } catch (err) {
    report.problems.push(`public/music 目录不存在或读不到：${err?.message || err}`);
  }

  // ② 磁盘文件
  if (report.dirExists) {
    try {
      const files = fs.readdirSync(MUSIC_DIR, { withFileTypes: true });
      report.diskFiles = files
        .filter((item) => item.isFile())
        .map((item) => {
          let size = 0;
          try {
            size = fs.statSync(path.join(MUSIC_DIR, item.name)).size;
          } catch {
            size = 0;
          }
          return { name: item.name, kb: Math.round(size / 1024) };
        });
    } catch (err) {
      report.problems.push(`读目录失败：${err?.message || err}`);
    }
  }

  // ③ 音源设置：判断"为什么没声音"的关键
  try {
    const config = await getGroup("music");
    report.musicSettings = {
      enabled: config?.enabled !== false,
      source: String(config?.source || "local"),
      autoPlay: config?.autoPlay !== false,
      autoFallback: config?.autoFallback !== false,
      defaultVolume: Number(config?.defaultVolume) || 0.5,
    };
    if (report.musicSettings.enabled === false) {
      report.problems.push("后台「背景音乐」总开关是关的，用户端不会显示播放器");
    }
  } catch (err) {
    report.problems.push(`读音乐设置失败：${err?.message || err}`);
  }

  // ④ 数据库记录 vs 磁盘
  try {
    const rows = await query(
      `SELECT id, title, source, url, netease_id, netease_type, enabled
         FROM music_tracks
        ORDER BY sort_order ASC, id ASC
        LIMIT 200`
    );
    const diskNames = new Set(report.diskFiles.map((item) => item.name));

    report.tracks = rows.map((row) => {
      const rawUrl = String(row.url || "");
      const name = rawUrl.startsWith("/music/") ? rawUrl.slice("/music/".length) : "";
      const onDisk = name ? diskNames.has(name) : null;

      if (String(row.source) === "local" && onDisk === false) {
        report.problems.push(`「${row.title}」在数据库里有，但磁盘上没有文件 ${name}`);
      }
      if (String(row.source) === "local" && !name) {
        report.problems.push(`「${row.title}」是本地歌但 url 字段为空`);
      }
      if (Number(row.enabled) !== 1) {
        report.problems.push(`「${row.title}」是停用状态，不会下发给用户端`);
      }

      const isNetease = String(row.source) === "netease";
      return {
        id: row.id,
        title: row.title,
        source: row.source,
        url: rawUrl,
        enabled: Number(row.enabled) === 1,
        fileOnDisk: onDisk,
        playUrl: name ? `/api/music/file?name=${encodeURIComponent(name)}` : null,
        neteaseId: isNetease ? String(row.netease_id || "") : null,
        neteaseType: isNetease ? String(row.netease_type || "2") : null,
        // 可以直接在浏览器打开这个地址，单独试一下这首歌能不能播
        neteasePlayerUrl:
          isNetease && row.netease_id
            ? `https://music.163.com/outchain/player?type=${
                String(row.netease_type || "2") === "0" ? 0 : 2
              }&id=${row.netease_id}&auto=0&height=66`
            : null,
      };
    });
  } catch (err) {
    report.problems.push(`查 music_tracks 失败：${err?.message || err}`);
  }

  // ④ 目录里有没有"孤儿文件"（有文件但库里没记录）
  const usedNames = new Set(
    report.tracks
      .map((t) => (t.url || "").startsWith("/music/") ? t.url.slice("/music/".length) : "")
      .filter(Boolean)
  );
  report.orphanFiles = report.diskFiles
    .filter((f) => !usedNames.has(f.name))
    .map((f) => f.name);

  const enabledTracks = report.tracks.filter((item) => item.enabled);
  const localPlayable = enabledTracks.filter(
    (item) => item.source === "local" || item.source === "url"
  );
  const neteaseReady = enabledTracks.filter(
    (item) => item.source === "netease" && item.neteaseId
  );
  const source = report.musicSettings?.source || "local";

  if (!enabledTracks.length) {
    report.conclusion = "歌单里没有「启用中」的歌曲 —— 去后台「背景音乐」上传或添加。";
  } else if (source === "local" && !localPlayable.length) {
    report.conclusion =
      "⚠️ 音源设置是「本地歌单」，但里面没有可播的歌" +
      (neteaseReady.length ? `（倒是有 ${neteaseReady.length} 首网易云的）` : "") +
      "。解法：要么上传本地歌曲，要么把音源切成「网易云收藏」。前端现在会自动先把网易云展示出来。";
    report.problems.push("音源设置与歌单内容不匹配（详见 conclusion）");
  } else if (source === "netease" && !neteaseReady.length) {
    report.conclusion = "⚠️ 音源设置是「网易云收藏」，但里面没有配好 ID 的歌。";
    report.problems.push("音源设置与歌单内容不匹配（详见 conclusion）");
  } else if (!report.problems.length) {
    report.conclusion =
      source === "netease"
        ? "配置正常。注意：网易云走官方外链播放器，能不能播取决于那首歌的版权和你账号的权限（VIP 歌会提示需要会员，这是官方限制）。"
        : "配置正常。如果还是没声音，请看浮窗底部的诊断行和红字。";
  } else {
    report.conclusion = "上面 problems 里列出的就是要修的问题。";
  }

  return json(report);
}
