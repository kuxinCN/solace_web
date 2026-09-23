/**
 * 数据库连接配置：
 *   GET  → 当前生效的配置（密码隐藏）+ 连接状态
 *   POST → { action: "test" | "save", config, keepPassword }
 *
 * 鉴权放宽的例外：当数据库连不上、或还没初始化管理员时，这里允许免登录访问，
 * 否则「数据库配置错了」会导致后台永远进不去，形成死锁。
 * 想收紧的话，在 .env.local 里设置 ADMIN_SETUP_KEY 即可。
 */
import { getAdminFromRequest, getBootstrapState, logAudit } from "@/lib/admin-auth";
import {
  applyDatabaseConfig,
  describeDbError,
  getDatabaseConfig,
  getPublicDatabaseConfig,
  testConnection,
} from "@/lib/db";
import { isProvisioned } from "@/lib/install";
import {
  cleanString,
  clientIp,
  json,
  jsonError,
  readJsonBody,
  safeEqualText,
} from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorize(request, body = {}, options = {}) {
  const requireKey = options.requireKey !== false;

  const admin = await getAdminFromRequest(request);
  if (admin) return { admin };

  const state = await getBootstrapState();

  // 数据库正常、但还没有管理员：说明站点还没初始化完，免登录放行（去走初始化流程）
  if (state.dbReady && state.needsSetup) {
    return { admin: null, bootstrap: true };
  }

  // 数据库正常且已有管理员：改配置必须登录后台
  if (state.dbReady) {
    return { error: "请先登录后台", status: 401 };
  }

  // 数据库连不上：从未成功装过（既没有安装锁也没有 config/db.json）时免登录，
  // 让第一次部署的人能自由试错，否则配错一次就永远进不去。
  if (!isProvisioned()) {
    return { admin: null, bootstrap: true };
  }

  // 装过但现在连不上（后台进不去）属于救急场景：要求提供 ADMIN_SETUP_KEY，
  // 避免有人靠「把数据库换成自己的库」来接管站点。
  const expectedKey = String(process.env.ADMIN_SETUP_KEY || process.env.REINSTALL_KEY || "").trim();
  if (!expectedKey) {
    if (!requireKey) {
      // 只读的 GET 仍然放行：让用户能看到当前配置和连接失败原因（密码是掩码的），
      // 真正保存时（POST）才强制要求口令。
      return { admin: null, bootstrap: true };
    }
    return {
      error:
        "本站在已安装状态下无法连接数据库。出于安全考虑，请先在 .env.local 设置 " +
        "ADMIN_SETUP_KEY（或 REINSTALL_KEY）并重启服务，再用该口令修改数据库配置。",
      status: 403,
    };
  }
  if (requireKey && !safeEqualText(cleanString(body.setupKey, 128), expectedKey)) {
    return { error: "初始化口令不正确", status: 403 };
  }
  return { admin: null, bootstrap: true };
}

export async function GET(request) {
  // 只读接口不校验初始化口令：否则连不上数据库时连配置页面都打不开
  const auth = await authorize(request, {}, { requireKey: false });
  if (auth.error) return jsonError(auth.error, auth.status);

  const config = getPublicDatabaseConfig();
  const test = await testConnection(getDatabaseConfig());

  return json({
    ok: true,
    bootstrapMode: Boolean(auth.bootstrap),
    setupKeyRequired: Boolean(process.env.ADMIN_SETUP_KEY),
    config,
    status: test.ok
      ? { connected: true, version: test.version }
      : { connected: false, error: test.error },
  });
}

export async function POST(request) {
  const body = await readJsonBody(request);
  const auth = await authorize(request, body);
  if (auth.error) return jsonError(auth.error, auth.status);

  const action = cleanString(body.action, 16);
  if (!["test", "save"].includes(action)) return jsonError("action 只能是 test 或 save", 400);

  const incoming = body.config && typeof body.config === "object" ? { ...body.config } : null;
  if (!incoming) return jsonError("缺少数据库配置内容", 400);

  // 密码留空 = 沿用当前密码（前端不会拿到明文，只能这样表达「不修改」）
  if (!String(incoming.password || "") && body.keepPassword !== false) {
    incoming.password = getDatabaseConfig().password;
  }

  if (action === "test") {
    const result = await testConnection(incoming);
    if (!result.ok) return jsonError(result.error, 400);
    return json({
      ok: true,
      status: { connected: true, version: result.version },
      message: "连接成功",
    });
  }

  try {
    const { config, version } = await applyDatabaseConfig(incoming);
    await logAudit({
      adminId: auth.admin?.adminId ?? null,
      username: auth.admin?.username || "(初始化向导)",
      action: "save_database",
      detail: `更新数据库连接为 ${config.user}@${config.host}:${config.port}/${config.database}`,
      ip: clientIp(request),
    });
    return json({
      ok: true,
      config: {
        host: config.host,
        port: config.port,
        user: config.user,
        database: config.database,
        connectionLimit: config.connectionLimit,
        hasPassword: config.password !== "",
      },
      status: { connected: true, version },
      message: "已保存并立即生效",
    });
  } catch (err) {
    if (err.code === "DB_TEST_FAILED") return jsonError(err.message, 400);
    return jsonError(describeDbError(err), 500);
  }
}
