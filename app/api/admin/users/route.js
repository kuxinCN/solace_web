/**
 * 后台「用户管理」：
 *   GET    → 用户列表（关键词搜索 + 分页；密码默认打码，?revealPassword=1 才返回明文）
 *   POST   → 手动添加用户
 *   PATCH  → 修改用户（密码留空 = 不修改）
 *   DELETE → ?id= 删除用户（连同其会话/消息/日记，靠外键级联删除）
 *
 * 关于密码：按需求用 lib/secret-box.js 做**可逆加密**（AES-256-GCM），所以后台能解密查看。
 * 这比明文存储强（翻数据库看不到裸密码），但**不等于安全**——密钥在服务器的 .env.local 里，
 * 拿到密钥的人就能解出全部密码。更安全的做法是只存 bcrypt 哈希（后台只能重置、不能查看）。
 */
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import { describeDbError, execute, query } from "@/lib/db";
import { decryptText, encryptText, usingDefaultKey } from "@/lib/secret-box";
import { ensureUserColumnsOnce } from "@/lib/schema";
import { getGroup } from "@/lib/settings";
import {
  cleanString,
  clientIp,
  json,
  jsonError,
  readJsonBody,
} from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCOUNT_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;
const BIRTHDAY_PATTERN = /^\d{4}(-\d{2}){0,2}$/;
const MIN_PASSWORD_LENGTH = 6;
// 加密后是 base64 存在 VARCHAR(255) 里，太长会溢出，所以限制明文长度
const MAX_PASSWORD_LENGTH = 64;

const SELECT_FIELDS =
  "id, email, account, username, avatar_url, gender, birthday, phone, remark, status, source, created_at, last_login_at, password_enc";

function shapeUser(row, revealPassword) {
  const { password_enc: passwordEnc, ...rest } = row;
  const hasPassword = Boolean(passwordEnc);
  const plain = revealPassword && hasPassword ? decryptText(passwordEnc) : "";

  return {
    ...rest,
    status: Number(rest.status) === 1 ? 1 : 0,
    hasPassword,
    // 只有 revealPassword=1 时才带明文；解不出来（密钥变过）时 passwordReadable 为 false
    password: plain,
    passwordReadable: hasPassword ? plain !== "" : true,
  };
}

export async function GET(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const url = new URL(request.url);
  const keyword = cleanString(url.searchParams.get("keyword"), 64);
  const revealPassword = url.searchParams.get("revealPassword") === "1";
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(5, Number.parseInt(url.searchParams.get("pageSize") || "20", 10) || 20)
  );

  try {
    // 老部署升级到本版本时 users 表可能缺新列，这里顺手补一次（进程内只跑一次）
    try {
      await ensureUserColumnsOnce();
    } catch {
      /* 补列失败不阻塞列表，后面的查询会暴露具体错误 */
    }

    const conditions = [];
    const params = [];
    if (keyword) {
      conditions.push("(email LIKE ? OR account LIKE ? OR username LIKE ? OR phone LIKE ?)");
      // 转义 LIKE 的通配符，避免用户输入的 % 或 _ 造成意外匹配
      const escaped = keyword.replace(/[\\%_]/g, (char) => `\\${char}`);
      const like = `%${escaped}%`;
      params.push(like, like, like, like);
    }
    const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRows = await query(`SELECT COUNT(*) AS total FROM users ${whereSql}`, params);
    const total = Number(countRows[0]?.total || 0);

    const offset = (page - 1) * pageSize;
    const rows = await query(
      `SELECT ${SELECT_FIELDS} FROM users ${whereSql} ORDER BY id DESC LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );

    const userSettings = await getGroup("users");

    if (revealPassword) {
      await logAudit({
        adminId: admin.adminId,
        username: admin.username,
        action: "reveal_user_password",
        detail: `查看用户密码明文（第 ${page} 页，共 ${rows.length} 条）`,
        ip: clientIp(request),
      });
    }

    return json({
      ok: true,
      users: rows.map((row) => shapeUser(row, revealPassword)),
      total,
      page,
      pageSize,
      revealPassword,
      visibleFields: userSettings.visibleFields,
      keyIsDefault: usingDefaultKey(),
    });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}

export async function POST(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);
  const email = cleanString(body.email, 190).toLowerCase();
  const account = cleanString(body.account, 64);
  const password = typeof body.password === "string" ? body.password : "";
  const username = cleanString(body.username, 64);
  const gender = cleanString(body.gender, 16);
  const birthday = cleanString(body.birthday, 10);
  const phone = cleanString(body.phone, 32);
  const remark = cleanString(body.remark, 255);
  const status = body.status === 0 || body.status === false ? 0 : 1;

  if (!EMAIL_PATTERN.test(email)) {
    return jsonError("请填写正确的邮箱（必填：邮箱验证码登录和账号找回都用它）", 400);
  }
  if (account && !ACCOUNT_PATTERN.test(account)) {
    return jsonError("账号只能是 3-32 位的字母、数字、下划线、点或短横线", 400);
  }
  if (password && password.length < MIN_PASSWORD_LENGTH) {
    return jsonError(`密码至少 ${MIN_PASSWORD_LENGTH} 位（留空表示该用户只能用邮箱验证码登录）`, 400);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return jsonError(`密码太长了，请控制在 ${MAX_PASSWORD_LENGTH} 位以内`, 400);
  }
  if (birthday && !BIRTHDAY_PATTERN.test(birthday)) {
    return jsonError("出生年月格式应为 1998-05 或 1998-05-20", 400);
  }

  try {
    const result = await execute(
      `INSERT INTO users (email, account, password_enc, username, gender, birthday, phone, remark, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin')`,
      [
        email,
        account || null,
        password ? encryptText(password) : "",
        username || null,
        gender || null,
        birthday || null,
        phone || null,
        remark || null,
        status,
      ]
    );

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "add_user",
      detail: `新增用户 ${email}${account ? `（账号 ${account}）` : ""}`,
      ip: clientIp(request),
    });

    return json({ ok: true, id: result.insertId, message: "用户已添加" });
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") {
      return jsonError("这个邮箱或账号已经被占用了", 400);
    }
    return jsonError(describeDbError(err), 500);
  }
}

export async function PATCH(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);
  const id = Number.parseInt(String(body.id ?? ""), 10);
  if (!Number.isInteger(id) || id <= 0) return jsonError("缺少用户 id", 400);

  const sets = [];
  const params = [];
  const assign = (column, value) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };

  if (typeof body.email === "string") {
    const email = cleanString(body.email, 190).toLowerCase();
    if (!EMAIL_PATTERN.test(email)) return jsonError("邮箱格式不正确", 400);
    assign("email", email);
  }
  if (typeof body.account === "string") {
    const account = cleanString(body.account, 64);
    if (account && !ACCOUNT_PATTERN.test(account)) {
      return jsonError("账号只能是 3-32 位的字母、数字、下划线、点或短横线", 400);
    }
    assign("account", account || null);
  }
  if (typeof body.username === "string") assign("username", cleanString(body.username, 64) || null);
  if (typeof body.gender === "string") assign("gender", cleanString(body.gender, 16) || null);
  if (typeof body.birthday === "string") {
    const birthday = cleanString(body.birthday, 10);
    if (birthday && !BIRTHDAY_PATTERN.test(birthday)) {
      return jsonError("出生年月格式应为 1998-05 或 1998-05-20", 400);
    }
    assign("birthday", birthday || null);
  }
  if (typeof body.phone === "string") assign("phone", cleanString(body.phone, 32) || null);
  if (typeof body.remark === "string") assign("remark", cleanString(body.remark, 255) || null);
  if (body.status !== undefined) {
    assign("status", body.status === 0 || body.status === false ? 0 : 1);
  }

  // 密码：留空 = 不修改；传了内容则重设；clearPassword=true 表示清空（该用户只能用验证码登录）
  if (body.clearPassword === true) {
    assign("password_enc", "");
  } else if (typeof body.password === "string" && body.password !== "") {
    if (body.password.length < MIN_PASSWORD_LENGTH) {
      return jsonError(`密码至少 ${MIN_PASSWORD_LENGTH} 位`, 400);
    }
    if (body.password.length > MAX_PASSWORD_LENGTH) {
      return jsonError(`密码太长了，请控制在 ${MAX_PASSWORD_LENGTH} 位以内`, 400);
    }
    assign("password_enc", encryptText(body.password));
  }

  if (!sets.length) return jsonError("没有需要修改的内容", 400);

  try {
    const result = await execute(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, [
      ...params,
      id,
    ]);

    if (!result.affectedRows) {
      // affectedRows 为 0 也可能只是「值没变化」，所以再确认一次是否真的存在
      const exists = await query("SELECT id FROM users WHERE id = ? LIMIT 1", [id]);
      if (!exists.length) return jsonError("用户不存在", 404);
    }

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "update_user",
      detail: `修改用户 #${id}（${sets.map((s) => s.split(" =")[0]).join(", ")}）`,
      ip: clientIp(request),
    });

    return json({ ok: true, message: "已保存" });
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") {
      return jsonError("这个邮箱或账号已经被占用了", 400);
    }
    return jsonError(describeDbError(err), 500);
  }
}

export async function DELETE(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const id = Number.parseInt(new URL(request.url).searchParams.get("id") || "", 10);
  if (!Number.isInteger(id) || id <= 0) return jsonError("缺少用户 id", 400);

  try {
    // 外键都是 ON DELETE CASCADE，删用户会一并删掉它的会话、聊天消息和日记
    const result = await execute("DELETE FROM users WHERE id = ?", [id]);
    if (!result.affectedRows) return jsonError("用户不存在", 404);

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "delete_user",
      detail: `删除用户 #${id}（连同其会话与日记）`,
      ip: clientIp(request),
    });

    return json({ ok: true, message: "用户及其聊天、日记已删除" });
  } catch (err) {
    return jsonError(describeDbError(err), 500);
  }
}
