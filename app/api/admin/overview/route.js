/**
 * 后台首页概览：环境信息 + 数据库状态 + 各模块配置是否就绪。
 * 这里只回传「是否配置」，不包含任何密钥内容。
 */
import { getAdminFromRequest, listAuditLogs } from "@/lib/admin-auth";
import { describeDbError, getPublicDatabaseConfig, query } from "@/lib/db";
import { ensureUserColumnsOnce } from "@/lib/schema";
import { getGroup } from "@/lib/settings";
import { json, jsonError } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function safeGroup(name) {
  try {
    return await getGroup(name);
  } catch {
    return null;
  }
}

export async function GET(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const database = getPublicDatabaseConfig();
  let dbStatus = { connected: false, version: "", error: "" };
  let adminCount = 0;
  let lastLoginAt = null;
  let logs = [];

  try {
    // 老部署升级时先补上新列，避免后台各处查询报 Unknown column
    await ensureUserColumnsOnce();

    const versionRows = await query("SELECT VERSION() AS version");
    dbStatus = { connected: true, version: versionRows[0]?.version || "", error: "" };

    const countRows = await query("SELECT COUNT(*) AS total FROM admin_users");
    adminCount = Number(countRows[0]?.total ?? 0);

    const lastRows = await query(
      "SELECT last_login_at FROM admin_users WHERE id = ? LIMIT 1",
      [admin.adminId]
    );
    lastLoginAt = lastRows[0]?.last_login_at || null;

    logs = await listAuditLogs(8);
  } catch (err) {
    dbStatus = { connected: false, version: "", error: describeDbError(err, { detailed: true }) };
  }

  const [ai, tts, smtp, login, site] = await Promise.all([
    safeGroup("ai"),
    safeGroup("tts"),
    safeGroup("smtp"),
    safeGroup("login"),
    safeGroup("site"),
  ]);

  return json({
    ok: true,
    env: {
      nodeVersion: process.version,
      platform: `${process.platform} ${process.arch}`,
      nextEnv: process.env.NODE_ENV || "development",
      uptimeSeconds: Math.round(process.uptime()),
      serverTime: new Date().toISOString(),
    },
    database: { ...database, ...dbStatus },
    admin: { username: admin.username, adminCount, lastLoginAt },
    readiness: {
      ai: ai
        ? {
            enabled: ai.enabled === true,
            configured: Boolean(ai.apiKey && ai.baseUrl && ai.model),
            model: ai.model,
            baseUrl: ai.baseUrl,
          }
        : null,
      tts: tts
        ? {
            enabled: tts.enabled === true,
            configured: Boolean(tts.apiKey && tts.baseUrl && tts.model && tts.voice),
            model: tts.model,
            voice: tts.voice,
          }
        : null,
      smtp: smtp
        ? {
            enabled: smtp.enabled === true,
            configured: Boolean(smtp.host && smtp.user && smtp.password),
            host: smtp.host,
            port: smtp.port,
            user: smtp.user,
          }
        : null,
      login: login
        ? {
            codeLength: login.codeLength,
            codeTtlSeconds: login.codeTtlSeconds,
            sendCooldownSeconds: login.sendCooldownSeconds,
            dailyLimitPerEmail: login.dailyLimitPerEmail,
          }
        : null,
      site: site ? { siteName: site.siteName, adminNotice: site.adminNotice } : null,
    },
    logs,
  });
}
