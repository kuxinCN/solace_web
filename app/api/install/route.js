/**
 * 安装向导接口:
 *   GET  → 安装状态 + 环境自检 + TOTP 绑定二维码
 *   POST → { action: "test" }    只测试数据库连接
 *          { action: "install" } 写数据库配置 → 自动建表 → 创建管理员 → 写安装锁 → 直接登录
 *
 * 安全约定：
 *   * 一旦安装完成（存在 config/installed.lock 或数据库里已有管理员），本接口直接 403；
 *   * 只有在 .env.local 里设置 ALLOW_REINSTALL=1（需服务器权限）才能重新安装，
 *     重新安装会清空原有的后台管理员账号，页面上会明确警告。
 */
import QRCode from "qrcode";
import {
  ADMIN_COOKIE,
  adminCookieOptions,
  buildOtpAuthUri,
  cleanupExpiredSessions,
  createAdmin,
  createSession,
  generateTotpSecret,
  hashPassword,
  logAudit,
  verifyTotp,
} from "@/lib/admin-auth";
import {
  applyDatabaseConfig,
  describeDbError,
  ensureDatabase,
  getDatabaseConfig,
  getPublicDatabaseConfig,
  testConnection,
  withTransaction,
} from "@/lib/db";
import {
  checkEnvironment,
  getInstallState,
  isProvisioned,
  reinstallAllowed,
  writeInstallLock,
} from "@/lib/install";
import { ensureTables, ensureUserColumns } from "@/lib/schema";
import { getGroup, saveGroup } from "@/lib/settings";
import {
  buildCookie,
  cleanString,
  clientIp,
  json,
  jsonError,
  readJsonBody,
  safeEqualText,
} from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INSTALL_COOKIE = "solace_install";
const INSTALL_TTL_SECONDS = 30 * 60;

function installCookieOptions(request, maxAge = INSTALL_TTL_SECONDS) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: adminCookieOptions(request).secure,
    path: "/",
    maxAge,
  };
}

export async function GET(request) {
  const state = await getInstallState();
  const env = checkEnvironment();
  const database = getPublicDatabaseConfig();

  // 已安装且不允许重装：只回最基本的信息，不生成二维码，也不回传安装锁明细
  if (state.installed && !reinstallAllowed()) {
    return json({
      ok: true,
      installed: true,
      source: state.source,
      installedAt: state.lock?.installedAt || null,
      env,
      reinstallAllowed: false,
    });
  }

  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  const existing = request.cookies.get(INSTALL_COOKIE)?.value || "";
  const secret = refresh || !existing ? generateTotpSecret() : existing;

  let siteName = "Solace";
  try {
    siteName = (await getGroup("site")).siteName || siteName;
  } catch {
    /* 数据库还没配好时用默认站点名 */
  }

  const otpauth = buildOtpAuthUri("admin", secret, siteName);
  const qrDataUrl = await QRCode.toDataURL(otpauth, { width: 260, margin: 1 });

  return json(
    {
      ok: true,
      installed: state.installed,
      source: state.source,
      reinstallAllowed: reinstallAllowed(),
      installedAt: state.lock?.installedAt || null,
      env,
      database,
      dbReady: state.dbReady,
      dbError: state.dbError,
      setupKeyRequired: Boolean(process.env.ADMIN_SETUP_KEY),
      reinstallKeyConfigured: Boolean(process.env.REINSTALL_KEY || process.env.ADMIN_SETUP_KEY),
      secret,
      otpauth,
      qrDataUrl,
    },
    200,
    { "Set-Cookie": buildCookie(INSTALL_COOKIE, secret, installCookieOptions(request)) }
  );
}

export async function POST(request) {
  const state = await getInstallState();
  if (state.installed && !reinstallAllowed()) {
    return jsonError(
      "本站已完成安装。如需重新安装，请先删除 config/installed.lock，" +
        "或在 .env.local 中设置 ALLOW_REINSTALL=1 后重启服务。",
      403
    );
  }

  const env = checkEnvironment();
  if (!env.configWritable) {
    return jsonError(
      `项目目录不可写（需要写入 config/ 目录）：${env.configError || "权限不足"}，` +
        "请检查目录权限后再安装。",
      500
    );
  }

  const body = await readJsonBody(request);
  const action = cleanString(body.action, 16) || "install";
  if (!["test", "install"].includes(action)) {
    return jsonError("action 只能是 test 或 install", 400);
  }

  // 口令校验（测试连接与正式安装都要过这一关）：
  //   * 重新安装模式：必须提供 REINSTALL_KEY（回退 ADMIN_SETUP_KEY），否则谁都能重置管理员；
  //   * 「曾经装成功过、但现在连不上数据库」：视为疑似已安装，同样要求 ADMIN_SETUP_KEY，
  //     防止有人靠把数据库地址改到自己的库来接管站点；
  //   * 首次安装且配置了 ADMIN_SETUP_KEY：与 /admin 的初始化流程保持一致。
  const isReinstall = state.installed === true;
  const provisioned = isProvisioned();
  const expectedSetupKey = String(process.env.ADMIN_SETUP_KEY || "").trim();
  const expectedReinstallKey = String(
    process.env.REINSTALL_KEY || process.env.ADMIN_SETUP_KEY || ""
  ).trim();

  if (isReinstall) {
    if (!expectedReinstallKey) {
      return jsonError(
        "重新安装需要先在 .env.local 里设置 REINSTALL_KEY=（一串随机口令）并重启服务，" +
          "避免安装入口被外人利用来重置管理员。",
        403
      );
    }
    if (!safeEqualText(cleanString(body.reinstallKey, 128), expectedReinstallKey)) {
      return jsonError("重装口令不正确", 403);
    }
  } else if (provisioned && !state.dbReady) {
    if (!expectedSetupKey) {
      return jsonError(
        "本站在已配置过数据库的情况下连不上数据库。出于安全考虑，请先在 .env.local 设置 " +
          "ADMIN_SETUP_KEY=（一串随机口令）并重启服务，再回来重新配置数据库。",
        403
      );
    }
    if (!safeEqualText(cleanString(body.setupKey, 128), expectedSetupKey)) {
      return jsonError("初始化口令不正确", 403);
    }
  } else if (expectedSetupKey && !safeEqualText(cleanString(body.setupKey, 128), expectedSetupKey)) {
    return jsonError("初始化口令不正确", 403);
  }

  const incoming =
    body.database && typeof body.database === "object" && !Array.isArray(body.database)
      ? { ...body.database }
      : null;
  if (!incoming) return jsonError("缺少数据库配置", 400);

  // 密码留空 = 沿用已有配置里的密码
  if (!String(incoming.password || "") && body.keepPassword !== false) {
    incoming.password = getDatabaseConfig().password;
  }

  // 勾选了「帮我创建数据库」时，先用同一套账号把库建出来
  // （需要该账号有建库权限，root 一定有；库已存在会直接跳过）
  if (body.createDatabase === true) {
    const created = await ensureDatabase(incoming);
    if (!created.ok) {
      return jsonError(
        `自动创建数据库失败：${created.error}。` +
          "你可以换一个有建库权限的账号（例如 root）重试，或者先到宝塔面板里手动建好这个库。",
        400
      );
    }
  }

  if (action === "test") {
    const result = await testConnection(incoming);
    if (!result.ok) return jsonError(result.error, 400);
    return json({
      ok: true,
      message: `连接成功，MySQL 版本 ${result.version}`,
      version: result.version,
    });
  }

  // ---------------- 正式安装 ----------------

  const adminInput = body.admin && typeof body.admin === "object" ? body.admin : {};
  const username = cleanString(adminInput.username, 64);
  const password = typeof adminInput.password === "string" ? adminInput.password : "";
  const code = cleanString(adminInput.code, 12);
  const siteName = cleanString(adminInput.siteName, 40) || "Solace";

  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    return jsonError("管理员账号只能是 3-32 位的字母、数字、下划线、点或短横线", 400);
  }
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return jsonError("管理员密码至少 8 位，并且要同时包含字母和数字", 400);
  }

  const secret = request.cookies.get(INSTALL_COOKIE)?.value || "";
  if (!secret) {
    return jsonError("绑定信息已过期，请刷新页面重新获取二维码", 400);
  }
  if (!verifyTotp(code, secret)) {
    return jsonError("动态验证码不正确，请确认验证器里已添加该账号且手机时间准确", 400);
  }

  // 1) 写数据库配置并热切换连接池（内部会先真实测试连接）
  let dbResult;
  try {
    dbResult = await applyDatabaseConfig(incoming);
  } catch (err) {
    if (err.code === "DB_TEST_FAILED") return jsonError(err.message, 400);
    return jsonError(describeDbError(err), 500);
  }

  // 2) 自动建表
  let tableResult;
  try {
    tableResult = await ensureTables();
  } catch (err) {
    return jsonError(`建表失败：${describeDbError(err)}`, 500);
  }
  if (tableResult.missing.length) {
    return jsonError(`以下数据表创建失败：${tableResult.missing.join("、")}`, 500);
  }

  // 2.1) 补上后来新增的 users 列（只有老部署升级时会用到，新装无事发生）
  try {
    await ensureUserColumns();
  } catch (err) {
    return jsonError(`升级 users 表失败：${describeDbError(err)}`, 500);
  }

  // 3) 创建管理员（重新安装模式下会先清空旧的管理员与登录会话）
  const passwordHash = await hashPassword(password);
  const needReset = state.installed === true;
  let adminId;

  try {
    if (needReset) {
      adminId = await withTransaction(async (conn) => {
        await conn.execute("DELETE FROM admin_sessions");
        await conn.execute("DELETE FROM admin_users");
        const [result] = await conn.execute(
          "INSERT INTO admin_users (username, password_hash, totp_secret) VALUES (?, ?, ?)",
          [username, passwordHash, secret]
        );
        return result.insertId;
      });
    } else {
      const created = await createAdmin({ username, password, totpSecret: secret });
      adminId = created.id;
    }
  } catch (err) {
    if (err.code === "ALREADY_INITIALIZED") {
      return jsonError(
        "数据库里已经存在管理员账号。如果确实要重装，请在 .env.local 设置 ALLOW_REINSTALL=1 后重试。",
        403
      );
    }
    return jsonError(`创建管理员失败：${describeDbError(err)}`, 500);
  }

  // 4) 写入站点名称（失败不影响安装）
  try {
    await saveGroup("site", { siteName });
  } catch {
    /* 忽略 */
  }

  // 5) 写安装锁：从此以后 /install 与 /api/install 都会拒绝再次安装。
  //    即使这一步失败，数据库里已有管理员同样会被判定为「已安装」，所以不算致命，提示用户手动处理即可。
  let lock = null;
  let warning = "";
  try {
    lock = writeInstallLock({
      siteName,
      adminUsername: username,
      host: dbResult.config.host,
      port: dbResult.config.port,
      database: dbResult.config.database,
      mysqlVersion: dbResult.version,
    });
  } catch (err) {
    warning =
      `安装锁文件 config/installed.lock 写入失败（${err?.message || err}）。` +
      "建议手动处理：删除 app/install 与 app/api/install 目录后重新执行 npm run build，确保安装入口彻底关闭。";
  }

  // 6) 直接登录进后台
  const ip = clientIp(request);
  const { token } = await createSession(adminId, {
    ip,
    userAgent: request.headers.get("user-agent") || "",
  });
  await cleanupExpiredSessions();
  await logAudit({
    adminId,
    username,
    action: "install",
    detail: `安装完成：${dbResult.config.host}:${dbResult.config.port}/${dbResult.config.database}`,
    ip,
  });

  return json(
    {
      ok: true,
      message: "安装完成",
      username,
      siteName,
      installedAt: lock?.installedAt || new Date().toISOString(),
      warning,
      tables: tableResult.tables,
      database: {
        host: dbResult.config.host,
        port: dbResult.config.port,
        database: dbResult.config.database,
        user: dbResult.config.user,
        version: dbResult.version,
      },
    },
    200,
    {
      "Set-Cookie": [
        buildCookie(ADMIN_COOKIE, token, adminCookieOptions(request)),
        buildCookie(INSTALL_COOKIE, "", installCookieOptions(request, 0)),
      ],
    }
  );
}
