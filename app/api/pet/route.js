/**
 * 用户端桌宠配置：GET /api/pet
 *
 * 公开接口、**不需要登录**（和 /api/music/playlist 一样）—— 桌宠在登录页就该能显示。
 *
 * ⚠️ 一次返回全部：开关 + 当前形象 + 显示边长 + 情绪选项（每项带自己的回复话术池）。
 *    前端**进站只发这一个请求**，之后点情绪不再碰网络 ——
 *    桌宠的响应必须是"立刻就动"，等接口就没有陪伴感了。
 */
import { DEFAULT_PET_IMAGE, DEFAULT_PET_IMAGE_NAME, readPetPublic } from "@/lib/pet-store";
import { json } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json({ ok: true, pet: await readPetPublic() });
  } catch (err) {
    // 表还没建出来（老库升级中）或配置读不到：给一份"用内置默认形象"的最小配置，
    // 用户端照常能显示和互动，只是拿不到后台配的情绪选项
    // （组件在 moods 为空时会回退到内置的 5 条，见 components/ButterflyEffect.jsx）。
    return json({
      ok: true,
      pet: {
        enabled: true,
        imageUrl: DEFAULT_PET_IMAGE,
        imageName: DEFAULT_PET_IMAGE_NAME,
        size: 70,
        lineRepeatHours: 24,
        moods: [],
        warn:
          "读取桌宠配置失败：" +
          String(err?.code || err?.message || err)
            .replace(/\s+/g, " ")
            .slice(0, 160),
      },
    });
  }
}
