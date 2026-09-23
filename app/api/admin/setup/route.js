/**
 * 后台初始化（只在「一个管理员都没有」时开放）：
 *   GET  → 是否需要初始化；需要时生成 TOTP 密钥 + 二维码
 *   POST → 提交账号、密码、验证器上的 6 位码，创建第一个管理员并直接登录
 */
import QRCode from "qrcode";
import {
  ADMIN_COOKIE,
  SETUP_COOKIE,
  adminCookieOptions,
  buildOtpAuthUri,
  cleanupExpiredSessions,
  createAdmin,
  createSession,
  generateTotpSecret,
  getBootstrapState,
  logAudit,
  verifyTotp,
} from "@/lib/admin-auth";
import { getPublicDatabaseConfig } from "@/lib/db";
import { getGroup } from "@/lib/settings";
import { buildCookie, cleanString, clientIp, json, jsonError, readJsonBody, safeEqualText } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SETUP_TTL_SECONDS = 15 * 60;

/** 初始化绑定用的临时 cookie：跟随实际协议决定是否 Secure */
function setupCookieOptions(request, maxAge = SETUP_TTL_SECONDS) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: adminCookieOptions(request).secure,
    path: "/",
    maxAge,
  };
}

export async function GET(request) {
  const state = await getBootstrapState();
  const database = getPublicDatabaseConfig();

  if (!state.dbReady) {
    return json({
      ok: true,
      dbReady: false,
      needsSetup: false,
      database,
      error: state.error,
    });
  }

  if (!state.needsSetup) {
    return json({ ok: true, dbReady: true, needsSetup: false, database });
  }

  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  const existing = request.cookies.get(SETUP_COOKIE)?.value || "";
  const secret = refresh || !existing ? generateTotpSecret() : existing;

  let siteName = "Solace";
  try {
    const siteConfig = await getGroup("site");
    siteName = siteConfig.siteName || siteName;
  } catch {
    /* 配置还没建好时用默认站点名 */
  }

  const otpauth = buildOtpAuthUri("admin", secret, siteName);
  const qrDataUrl = await QRCode.toDataURL(otpauth, { width: 260, margin: 1 });

  return json(
    {
      ok: true,
      dbReady: true,
      needsSetup: true,
      secret,
      otpauth,
      qrDataUrl,
      setupKeyRequired: Boolean(process.env.ADMIN_SETUP_KEY),
      // 没设置初始化口令时给前端一个警告：初始化完成前任何人都能抢注管理员
      setupKeyWarning: !process.env.ADMIN_SETUP_KEY,
      database,
    },
    200,
    {
      "Set-Cookie": buildCookie(SETUP_COOKIE, secret, setupCookieOptions(request)),
    }
  );
}

export async function POST(request) {
  const state = await getBootstrapState();
  if (!state.dbReady) {
    return jsonError(`数据库还连不上，请先完成数据库配置：${state.error}`, 503);
  }
  if (!state.needsSetup) {
    return jsonError("管理员已存在，初始化通道已关闭", 403);
  }

  const body = await readJsonBody(request);

  const expectedSetupKey = String(process.env.ADMIN_SETUP_KEY || "").trim();
  if (expectedSetupKey && !safeEqualText(cleanString(body.setupKey, 128), expectedSetupKey)) {
    return jsonError("初始化口令不正确", 403);
  }

  const secret = request.cookies.get(SETUP_COOKIE)?.value || "";
  if (!secret) {
    return jsonError("绑定信息已过期，请刷新页面重新获取二维码", 400);
  }

  const username = cleanString(body.username, 64);
  const password = typeof body.password === "string" ? body.password : "";
  const code = cleanString(body.code, 12);

  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    return jsonError("账号只能是 3-32 位的字母、数字、下划线、点或短横线", 400);
  }
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return jsonError("密码至少 8 位，并且要同时包含字母和数字", 400);
  }
  if (!verifyTotp(code, secret)) {
    return jsonError("动态验证码不正确，请确认验证器里已添加该账号且手机时间准确", 400);
  }

  let admin;
  try {
    admin = await createAdmin({ username, password, totpSecret: secret });
  } catch (err) {
    if (err.code === "ALREADY_INITIALIZED") return jsonError(err.message, 403);
    throw err;
  }

  const ip = clientIp(request);
  const { token } = await createSession(admin.id, {
    ip,
    userAgent: request.headers.get("user-agent") || "",
  });
  await cleanupExpiredSessions();
  await logAudit({
    adminId: admin.id,
    username: admin.username,
    action: "admin_setup",
    detail: "初始化管理后台并绑定动态验证码",
    ip,
  });

  return json(
    { ok: true, username: admin.username },
    200,
    {
      "Set-Cookie": [
        buildCookie(ADMIN_COOKIE, token, adminCookieOptions(request)),
        buildCookie(SETUP_COOKIE, "", setupCookieOptions(request, 0)),
      ],
    }
  );
}
