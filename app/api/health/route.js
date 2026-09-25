/**
 * 健康检查接口：GET /api/health
 *
 * 用途：
 *   * 运维排障 —— 一条命令就能判断「应用是否活着 + 数据库是否连得上」；
 *   * 演示/答辩 —— 可以现场展示服务状态；
 *   * 监控接入 —— 宝塔监控、uptime 监控服务可以直接探这个地址。
 *
 * 返回：
 *   200 { ok: true,  database: { ok: true, version } }  一切正常
 *   503 { ok: false, database: { ok: false, error } }   数据库连不上
 *
 * 注意：这个接口不返回任何敏感信息（不含连接地址、账号、密码）。
 */
import { testConnection } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  // ⚠️ 数据审核的自动定时器在这里「懒启动」一次。
  //
  // 为什么选 health 接口：它会被外部监控（UptimeRobot 之类）定期打，
  // 所以即使没人打开后台，定时器也能自然起来。内部是幂等的，
  // 重复调用只做一次判断，开销可以忽略。
  //
  // 为什么不用 instrumentation.js 在应用启动时注册：
  //   Next 会给 server / edge 两套环境各编译一次 instrumentation，
  //   webpack 顺着 scheduler → settings → db 会解析到 node:path，
  //   而 edge 没有这个模块 → 整个 npm run build 失败（已经踩过一次）。
  try {
    const { startReviewScheduler } = await import("@/lib/scheduler");
    startReviewScheduler();
  } catch (err) {
    console.error("[health] 定时器启动失败（不影响健康检查）：", err?.message || err);
  }

  const startedAt = Date.now();
  const result = await testConnection();

  const body = {
    ok: result.ok,
    service: "solace",
    time: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    checks: {
      app: { ok: true },
      database: result.ok
        ? { ok: true, version: result.version }
        : { ok: false, error: result.error },
    },
    latencyMs: Date.now() - startedAt,
  };

  return Response.json(body, {
    status: result.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
