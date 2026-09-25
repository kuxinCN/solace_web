/**
 * 用户端歌单：GET /api/music/playlist
 *
 * 公开接口、**不需要登录** —— 用户在登录页还没进来时就应该能听到音乐。
 *
 * 返回内容分两块：
 *   * `tracks`：本地上传 + 外链直链的歌，前端用它做自动播放 / 切歌；
 *   * `neteaseTracks`：网易云的歌，只给歌曲 ID，由前端用**官方外链播放器**渲染。
 *
 * ⚠️ 关于网易云：官方没有开放"取播放地址"的接口，所以我们**不做任何解析**，
 *    只用官方提供的外链播放器（music.163.com/outchain/player）。这是合规做法。
 */
import { query } from "@/lib/db";
import { getGroup } from "@/lib/settings";
import { json } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let config = null;
  try {
    config = await getGroup("music");
  } catch {
    config = null;
  }

  const music = {
    enabled: config?.enabled !== false,
    source: String(config?.source || "local"),
    autoPlay: config?.autoPlay !== false,
    autoFallback: config?.autoFallback !== false,
    defaultVolume: Number(config?.defaultVolume) || 0.5,
  };

  if (!music.enabled) {
    return json({ ok: true, music, tracks: [], neteaseTracks: [] });
  }

  try {
    const rows = await query(
      `SELECT id, title, artist, source, url, netease_id, netease_type
         FROM music_tracks
        WHERE enabled = 1
        ORDER BY sort_order ASC, id ASC
        LIMIT 200`
    );

    const tracks = [];
    const neteaseTracks = [];

    for (const row of rows) {
      const source = String(row.source || "local");
      if (source === "netease") {
        // 只给 ID 与类型，前端拼官方播放器地址；我们不经手也不解析任何播放链接
        if (row.netease_id) {
          neteaseTracks.push({
            id: row.id,
            title: row.title,
            artist: row.artist || "",
            neteaseId: String(row.netease_id),
            // 2 = 单曲，0 = 歌单（官方 outchain 的 type 参数）
            neteaseType: String(row.netease_type || "2") === "0" ? "0" : "2",
          });
        }
        continue;
      }

      // local 与 url 都直接给一个可播放地址
      if (!row.url) continue;
      tracks.push({
        id: row.id,
        title: row.title,
        artist: row.artist || "",
        source,
        url: String(row.url),
      });
    }

    return json({ ok: true, music, tracks, neteaseTracks });
  } catch (err) {
    // 表还没建出来（老库升级中）或列缺失：当作空歌单，不影响页面。
    // ⚠️ 但要把原因带出来 —— 否则前端只会"看不到播放器"，没法排查。
    return json({
      ok: true,
      music,
      tracks: [],
      neteaseTracks: [],
      warn:
        "读取歌单失败：" +
        String(err?.code || err?.message || err)
          .replace(/\s+/g, " ")
          .slice(0, 160),
    });
  }
}
