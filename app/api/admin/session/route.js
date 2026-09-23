/**
 * 后台登录态：
 *   GET    → 当前是否已登录 / 数据库是否可用（后台页面据此决定显示哪个界面）
 *   POST   → 登录（账号 + 密码 + 动态验证码）
 *   DELETE → 退出登录
 */
import {
  ADMIN_COOKIE,
  adminCookieOptions,
  cleanupExpiredSessions,
  createSession,
  deleteSession,
  getAdminFromRequest,
  getBootstrapState,
  logAudit,
  verifyAdminLogin,
} from "@/lib/admin-auth";
import { describeDbError } from "@/lib/db";
import { buildCookie, cleanString, clientIp, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const state = await getBootstrapState();

  if (!state.dbReady) {
    return json({
      ok: true,
      dbReady: false,
      needsSetup: false,
      authenticated: false,
      username: "",
      error: state.error,
    });
  }

  const admin = await getAdminFromRequest(request);
  return json({
    ok: true,
    dbReady: true,
    needsSetup: state.needsSetup,
    authenticated: Boolean(admin),
    username: admin?.username || "",
  });
}

export async function POST(request) {
  const state = await getBootstrapState();
  if (!state.dbReady) {
    return jsonError(`数据库连接失败：${state.error}`, 503);
  }
  if (state.needsSetup) {
    return jsonError("还没有管理员账号，请先完成初始化", 403);
  }

  const body = await readJsonBody(request);
  const ip = clientIp(request);

  let result;
  try {
    result = await verifyAdminLogin({
      username: cleanString(body.username, 64),
      password: typeof body.password === "string" ? body.password : "",
      code: cleanString(body.code, 12),
    });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }

  if (!result.ok) {
    await logAudit({
      username: cleanString(body.username, 64),
      action: "admin_login_failed",
      detail: result.error,
      ip,
    });
    return jsonError(result.error, 401);
  }

  const { token } = await createSession(result.admin.id, {
    ip,
    userAgent: request.headers.get("user-agent") || "",
  });
  await cleanupExpiredSessions();
  await logAudit({
    adminId: result.admin.id,
    username: result.admin.username,
    action: "admin_login",
    detail: "登录后台成功",
    ip,
  });

  return json(
    { ok: true, username: result.admin.username },
    200,
    { "Set-Cookie": buildCookie(ADMIN_COOKIE, token, adminCookieOptions(request)) }
  );
}

export async function DELETE(request) {
  const token = request.cookies.get(ADMIN_COOKIE)?.value || "";
  const admin = await getAdminFromRequest(request).catch(() => null);

  if (token) {
    try {
      await deleteSession(token);
    } catch {
      /* 数据库异常也要把浏览器上的 cookie 清掉 */
    }
  }
  if (admin) {
    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "admin_logout",
      detail: "退出后台",
      ip: clientIp(request),
    });
  }

  return json(
    { ok: true },
    200,
    {
      // 清除 cookie 时带上与写入时相同的属性，确保浏览器能正确覆盖删除
      "Set-Cookie": buildCookie(ADMIN_COOKIE, "", {
        ...adminCookieOptions(request),
        maxAge: 0,
      }),
    }
  );
}
