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
