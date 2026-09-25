/**
 * 导入音乐包：POST /api/admin/music/import
 * body：导出接口产出的 JSON（`files` 里是 base64 音频）
 *
 * 两种模式：
 *   * 默认「合并」：同名音频文件跳过，元数据按「标题+歌手」去重后新增；
 *   * `?mode=replace`：先清空歌单表和音乐目录，再全量导入（换服务器时用）。
 *
 * 安全：
 *   * 只接受 `kind: "solace-music-pack"` 的包，避免随便一个 JSON 就往磁盘写文件；
 *   * 文件名做白名单校验（只允许 `时间戳-随机串.ext` 这种形态），防目录穿越；
 *   * 扩展名仍然限定在 mp3 / m4a / wav / ogg。
 */
import fs from "node:fs";
import path from "node:path";
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import { describeDbError, execute, query } from "@/lib/db";
import { cleanString, clientIp, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MUSIC_DIR = path.join(process.cwd(), "public", "music");
const ALLOWED_EXT = [".mp3", ".m4a", ".wav", ".ogg"];
const SOURCES = ["local", "url", "netease"];
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 单个音频 20MB
const MAX_FILES = 200;

/** 文件名只允许 `数字-十六进制.ext`（上传接口生成的形态），杜绝路径穿越 */
function isSafeFilename(name) {
  return /^\d{6,}-[0-9a-f]{4,16}\.(mp3|m4a|wav|ogg)$/i.test(String(name || ""));
}

export async function POST(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const mode = new URL(request.url).searchParams.get("mode") === "replace" ? "replace" : "merge";

  let pack = null;
  try {
    // readJsonBody 内部直接调 request.json()，没有额外的体积限制；
    // 几百 MB 的音乐包会占用较多内存，属预期行为 —— 这个接口只在换服务器/备份时用。
    pack = await readJsonBody(request);
  } catch {
    return jsonError("音乐包解析失败（可能是文件太大或格式不对）", 400);
  }

  if (!pack || pack.kind !== "solace-music-pack") {
    return jsonError("这不是 Solace 音乐包（kind 不匹配）", 400);
  }

  const tracks = Array.isArray(pack.tracks) ? pack.tracks : [];
  const files = pack.files && typeof pack.files === "object" ? pack.files : {};
  if (!tracks.length) return jsonError("音乐包里没有歌曲", 400);

  const result = { mode, addedTracks: 0, addedFiles: 0, skippedFiles: 0, skippedTracks: 0 };

  try {
    fs.mkdirSync(MUSIC_DIR, { recursive: true });

    // replace 模式：先清空
    if (mode === "replace") {
      await execute("DELETE FROM music_tracks");
      try {
        for (const name of fs.readdirSync(MUSIC_DIR)) {
          const target = path.join(MUSIC_DIR, name);
          if (fs.statSync(target).isFile()) fs.unlinkSync(target);
        }
      } catch {
        /* 目录读不到就算了 */
      }
    }

    // 已存在的文件名与标题（用于合并模式去重）
    const existingFiles = new Set(
      mode === "replace" ? [] : (() => {
        try {
          return fs.readdirSync(MUSIC_DIR);
        } catch {
          return [];
        }
      })()
    );
    const existingTracks = new Set();
    if (mode === "merge") {
      const rows = await query("SELECT title, artist FROM music_tracks LIMIT 500");
      for (const row of rows) {
        existingTracks.add(`${row.title}||${row.artist || ""}`);
      }
    }

    // ① 先落音频文件
    const acceptedFiles = new Set();
    let count = 0;
    for (const [name, base64] of Object.entries(files)) {
      if (count >= MAX_FILES) break;
      count += 1;

      if (!isSafeFilename(name)) {
        result.skippedFiles += 1;
        continue;
      }
      const ext = path.extname(name).toLowerCase();
      if (!ALLOWED_EXT.includes(ext)) {
        result.skippedFiles += 1;
        continue;
      }
      if (existingFiles.has(name)) {
        result.skippedFiles += 1;
        acceptedFiles.add(name); // 文件已存在，元数据仍可继续导入
        continue;
      }

      let buffer;
      try {
        buffer = Buffer.from(String(base64 || ""), "base64");
      } catch {
        result.skippedFiles += 1;
        continue;
      }
      if (!buffer.length || buffer.length > MAX_FILE_BYTES) {
        result.skippedFiles += 1;
        continue;
      }

      try {
        fs.writeFileSync(path.join(MUSIC_DIR, name), buffer);
        acceptedFiles.add(name);
        result.addedFiles += 1;
      } catch {
        result.skippedFiles += 1;
      }
    }

    // ② 再写歌单元数据（只导入了文件的本地歌曲才入，避免出现"有记录没文件"）
    for (const item of tracks) {
      const source = SOURCES.includes(String(item.source)) ? String(item.source) : "url";
      const title = cleanString(item.title, 160) || "未命名";
      const artist = cleanString(item.artist, 160) || null;

      if (source === "local") {
        const name = String(item.url || "").slice("/music/".length);
        if (!acceptedFiles.has(name)) {
          result.skippedTracks += 1;
          continue;
        }
      }

      const key = `${title}||${artist || ""}`;
      if (mode === "merge" && existingTracks.has(key)) {
        result.skippedTracks += 1;
        continue;
      }

      await execute(
        `INSERT INTO music_tracks (title, artist, source, url, netease_id, sort_order, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          title,
          artist,
          source,
          source === "local" ? String(item.url || "") : cleanString(item.url, 800) || null,
          cleanString(item.neteaseId, 32) || null,
          Number.isInteger(Number(item.sortOrder)) ? Number(item.sortOrder) : 0,
          item.enabled === false ? 0 : 1,
        ]
      );
      existingTracks.add(key);
      result.addedTracks += 1;
    }

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "import_music",
      detail: `${mode}：新增歌曲 ${result.addedTracks} 首 / 文件 ${result.addedFiles} 个`,
      ip: clientIp(request),
    });

    return json({ ok: true, ...result, skipped: Array.isArray(pack.skipped) ? pack.skipped : [] });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
