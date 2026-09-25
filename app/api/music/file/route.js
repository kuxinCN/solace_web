/**
 * 本地音频文件：GET /api/music/file?name=<文件名>
 *
 * ⚠️ 为什么不直接用 `/music/xxx.mp3`（改这块前先看）：
 *   文件放在 `public/music/`，Next.js 本来能直接 serve。
 *   但**宝塔的 Nginx 默认配置**里有一条静态后缀规则：
 *       location ~ .*\.(gif|jpg|jpeg|png|js|css|mp3|mp4|...)$ { root /www/wwwroot/站点; }
 *   它会让 `/music/xxx.mp3` 去「站点根/music/」找文件 —— 而我们的文件在 `public/music/`，
 *   于是 404，前端看起来就是"歌单加载出来了，但点播放没动静"。
 *
 *   走这个 Node 路由没这个问题：Nginx 只会按 `location /` 反代到 3000，一定能到。
 *
 * ✅ 支持 Range 请求（拖动进度条、iOS Safari 必须要）
 * ✅ 文件名白名单校验 + 最终路径复查，杜绝路径穿越
 *
 * ⚠️ 想让它更快（Nginx 直发磁盘，不经过 Node）可以加一条 alias，
 *    做法写在 `docs/MUSIC.md`；但那时 URL 会变回 `/music/xxx.mp3`，
 *    前端的 toPlayableUrl() 要一起改。
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MUSIC_DIR = path.join(process.cwd(), "public", "music");

const MIME = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

/** 只允许「时间戳-随机串.ext」这种由上传接口生成的文件名 */
function isSafeName(name) {
  return /^\d{6,}-[0-9a-f]{4,16}\.(mp3|m4a|wav|ogg)$/i.test(String(name || ""));
}

/** Node 可读流 → Web ReadableStream */
function toWebStream(nodeStream) {
  if (typeof Readable.toWeb === "function") return Readable.toWeb(nodeStream);
  return nodeStream;
}

export async function GET(request) {
  // ⚠️ 防盗链：只允许**站内页面**发起的请求。
  //
  //    踩过的坑：宝塔的 Nginx 反代经常把 Host 改成 `127.0.0.1:3000`，
  //    这时拿 Referer(`https://solace.l.cd/chat`) 去 includes(host) 永远匹配不上，
  //    结果连站内播放都被 403 —— 所以这里同时看 x-forwarded-host，并把本站域名写进白名单。
  const referer = request.headers.get("referer") || "";
  const origin = request.headers.get("origin") || "";
  const forwardedHost = request.headers.get("x-forwarded-host") || "";
  const host = forwardedHost || request.headers.get("host") || "";

  const allowHosts = [host, forwardedHost, "solace.l.cd", "www.solace.l.cd"].filter(Boolean);
  const sameSite = (value) =>
    Boolean(value) && allowHosts.some((item) => value.includes(item));

  if (!sameSite(referer) && !sameSite(origin)) {
    return new Response("请从站内播放", { status: 403 });
  }

  const name = String(new URL(request.url).searchParams.get("name") || "");

  if (!isSafeName(name)) {
    return new Response("文件不存在", { status: 404 });
  }

  const filePath = path.join(MUSIC_DIR, name);
  // 再复查一次最终路径没跑出音乐目录
  if (!filePath.startsWith(MUSIC_DIR)) {
    return new Response("文件不存在", { status: 404 });
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return new Response("文件不存在", { status: 404 });
  }
  if (!stat.isFile()) return new Response("文件不存在", { status: 404 });

  const size = stat.size;
  const contentType = MIME[path.extname(name).toLowerCase()] || "application/octet-stream";

  // Range 支持：浏览器拖进度条、iOS Safari 都必须有
  const range = request.headers.get("range");
  const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;

  if (match) {
    let start = match[1] ? Number(match[1]) : 0;
    let end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= size) end = size - 1;

    if (start > end) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }

    const stream = fs.createReadStream(filePath, { start, end });
    return new Response(toWebStream(stream), {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=86400",
      },
    });
  }

  const stream = fs.createReadStream(filePath);
  return new Response(toWebStream(stream), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
