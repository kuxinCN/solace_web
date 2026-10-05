/**
 * 用户端表情包资源表：GET /api/stickers
 *
 * 公开接口、**不需要登录**（和 /api/music/playlist 一样）。
 *
 * 返回：`{ enabled, categories: [{ key, catKey, label, items: [{ url }] }] }`
 *   * `key` = 素材目录名 = `[sticker:xxx]` 标记名 = 前端资源表（STICKER_MAP）的 key；
 *   * 只返回**启用中**的分类与素材，空分类直接不返回（前端据此去掉没有图的分类）。
 *
 * ⚠️ 前端必须**进站预取**这个接口：收到 `{"sticker":"分类"}` 那条 SSE 事件时是在流末，
 *    那一刻再去请求就等于丢图 / 拖慢收尾（事件处理是同步的，不能 await）。
 */
import { readStickersPublic } from "@/lib/sticker-store";
import { json } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json({ ok: true, ...(await readStickersPublic()) });
  } catch (err) {
    // 表还没建出来（老库升级中）：返回空列表，前端会保留内置的四张兜底图。
    // ⚠️ 要把原因带出来 —— 否则只能看到"贴纸不发"，没法排查。
    return json({
      ok: true,
      enabled: true,
      categories: [],
      warn:
        "读取表情包失败：" +
        String(err?.code || err?.message || err)
          .replace(/\s+/g, " ")
          .slice(0, 160),
    });
  }
}
