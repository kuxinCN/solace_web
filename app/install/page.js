"use client";

/* eslint-disable @next/next/no-html-link-for-pages -- 安装页里的跳转只是普通链接，用原生 <a> 更直观 */

import { useCallback, useEffect, useState } from "react";

/* ------------------------------------------------------------------ 样式 */

const inputClass =
  "w-full border border-[#d5d9d7] bg-white px-2 py-1.5 text-sm text-gray-800 placeholder-gray-400 rounded-lg transition-colors duration-150 focus:outline-none focus:border-[#8fb3c7] focus:ring-1 focus:ring-[#8fb3c7]";

const btnBase =
  "border border-[#d5d9d7] bg-[#fdfdfc] text-slate-700 rounded-lg px-3 py-1.5 text-sm hover:bg-[#e8eff2] hover:text-slate-900 active:bg-[#dbe6ea] active:scale-[0.98] transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed";

const btnPrimary =
  "border border-[#7fa3b8] bg-[#7fa3b8] text-white rounded-lg px-3 py-1.5 text-sm hover:bg-[#6c93a8] active:scale-[0.98] transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed";

const cardClass = "bg-white border border-[#e5e7e4] rounded-xl p-4";

const STEPS = ["数据库", "管理员", "完成"];

/* -------------------------------------------------------------- API 封装 */

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const error = new Error(data?.error || `请求失败（HTTP ${res.status}）`);
    error.status = res.status;
    throw error;
  }
  return data || {};
}

/* ------------------------------------------------------------ 基础 UI 块 */

function Field({ label, hint, children }) {
  return (
    <label className="block mb-3">
      <span className="block text-xs font-medium text-slate-600 mb-1">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-slate-400 mt-1">{hint}</span> : null}
    </label>
  );
}

function Alert({ kind = "error", children }) {
  if (!children) return null;
  const tone =
    kind === "error"
      ? "border-red-200 bg-red-50 text-red-700"
      : kind === "success"
        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
        : kind === "warning"
          ? "border-amber-200 bg-amber-50 text-amber-800"
          : "border-[#cfdde5] bg-[#f2f7fa] text-slate-600";
  return (
    <div className={`border rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words mb-3 ${tone}`}>
      {children}
    </div>
  );
}

function Dot({ ok }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full mr-2 ${ok ? "bg-emerald-500" : "bg-red-400"}`} />
  );
}

function StepBar({ current }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-5">
      {STEPS.map((label, index) => {
        const no = index + 1;
        const active = current === no;
        const done = current > no;
        return (
          <div key={label} className="flex items-center gap-2">
            <span
              className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                done
                  ? "bg-emerald-500 text-white"
                  : active
                    ? "bg-[#7fa3b8] text-white"
                    : "bg-[#e8eae7] text-slate-500"
              }`}
            >
              {done ? "✓" : no}
            </span>
            <span className={`text-xs ${active || done ? "text-slate-700" : "text-slate-400"}`}>
              {label}
            </span>
            {no < STEPS.length ? <span className="w-5 h-px bg-[#e0e2df]" /> : null}
          </div>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- 主体组件 */

export default function InstallPage() {
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState(null);
  const [step, setStep] = useState(1);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [db, setDb] = useState({
    host: "127.0.0.1",
    port: "3306",
    user: "",
    password: "",
    database: "solace",
  });
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);

  const [admin, setAdmin] = useState({
    username: "admin",
    password: "",
    confirm: "",
    code: "",
    siteName: "Solace",
  });
  // 首次安装时的 ADMIN_SETUP_KEY，以及重新安装时的 REINSTALL_KEY
  const [keys, setKeys] = useState({ setupKey: "", reinstallKey: "" });
  // 数据库还不存在时，让安装向导顺便建库（需要该账号有建库权限）
  const [createDatabase, setCreateDatabase] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError("");
    try {
      const data = await api(`/api/install${refresh ? "?refresh=1" : ""}`);
      setInfo(data);
      if (data.database) {
        setDb({
          host: data.database.host || "127.0.0.1",
          port: String(data.database.port || 3306),
          user: data.database.user || "",
          password: "",
          database: data.database.database || "solace",
        });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleTest() {
    setTesting(true);
    setError("");
    setNotice("");
    try {
      const data = await api("/api/install", {
        method: "POST",
        body: { action: "test", database: db, keepPassword: true, createDatabase },
      });
      setTested(true);
      setNotice(data.message || "连接成功");
    } catch (err) {
      setTested(false);
      setError(err.message);
    } finally {
      setTesting(false);
    }
  }

  async function handleInstall() {
    setError("");
    setNotice("");

    if (admin.password !== admin.confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    if (admin.password.length < 8) {
      setError("密码至少 8 位");
      return;
    }

    setInstalling(true);
    try {
      const data = await api("/api/install", {
        method: "POST",
        body: {
          action: "install",
          database: db,
          keepPassword: true,
          createDatabase,
          setupKey: keys.setupKey,
          reinstallKey: keys.reinstallKey,
          admin: {
            username: admin.username,
            password: admin.password,
            code: admin.code,
            siteName: admin.siteName,
          },
        },
      });
      setResult(data);
      setStep(3);
      setNotice("安装完成");
    } catch (err) {
      setError(err.message);
    } finally {
      setInstalling(false);
    }
  }

  /* ------------------------------------------------------------ 渲染分支 */

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-sm text-slate-500">正在读取安装状态...</p>
      </div>
    );
  }

  // 已安装，且没有开启重新安装
  if (info?.installed && !info?.reinstallAllowed) {
    const installedAt = info.installedAt
      ? new Date(info.installedAt).toLocaleString()
      : "（安装时间记录在数据库中）";
    return (
      <div className="min-h-screen px-4 py-12">
        <div className="max-w-xl mx-auto">
          <h1 className="text-2xl font-bold mb-1">Solace 已完成安装</h1>
          <p className="text-xs text-slate-500 mb-6">
            安装入口已经关闭，这里不会再执行任何安装动作。
          </p>

          <section className={cardClass}>
            <Alert kind="success">本站已安装完成</Alert>
            <ul className="text-xs text-slate-600 space-y-2">
              <li>安装时间：{installedAt}</li>
              <li className="text-slate-400">
                出于安全考虑，这里不再显示数据库连接信息与管理员账号，需要时请登录后台查看。
              </li>
            </ul>
            <div className="mt-4">
              <a href="/admin" className={btnPrimary}>
                进入管理后台
              </a>
            </div>
          </section>

          <section className={`${cardClass} mt-4`}>
            <h2 className="text-sm font-bold mb-2">只是想改数据库配置？</h2>
            <p className="text-xs text-slate-600">
              如果站点本身没问题，只是数据库地址/密码变了导致连不上，不用重装：
              直接打开 <a href="/admin" className="text-[#5b8aa6] underline">/admin</a>，
              那里会引导你填新的数据库信息（已装过的站点需要先填「初始化口令」ADMIN_SETUP_KEY）。
            </p>
          </section>

          <section className={`${cardClass} mt-4`}>
            <h2 className="text-sm font-bold mb-2">如果确实需要重新安装</h2>
            <p className="text-xs text-slate-500 mb-2">
              重新安装会<strong>清空现有的后台管理员账号</strong>（用户端数据不受影响），
              所以需要服务器权限才能开启：
            </p>
            <ol className="text-xs text-slate-600 space-y-2 list-decimal list-inside">
              <li>
                在项目根目录的 <code>.env.local</code> 里加两行：
                <br />
                <code>ALLOW_REINSTALL=1</code>
                <br />
                <code>REINSTALL_KEY=自己定一串随机口令</code>
                <br />
                （只删 <code>config/installed.lock</code> 是不够的：数据库里已有管理员同样会被判定为「已安装」）
              </li>
              <li>
                重启服务：<code>pm2 reload solace</code>
              </li>
              <li>刷新本页面重新走流程，并在表单里填上刚设的「重装口令」</li>
              <li className="text-amber-700">装完后记得把这一行删掉，避免被外人利用</li>
            </ol>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 py-10">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-bold mb-1">Solace 安装向导</h1>
        <p className="text-xs text-slate-500 mb-6">
          填好数据库和后台管理员，剩下的（建表、写入配置、绑定验证器）都自动完成。
        </p>

        <StepBar current={step} />

        {info?.reinstallAllowed && info?.installed ? (
          <Alert kind="warning">
            当前处于<strong>重新安装模式</strong>（检测到 ALLOW_REINSTALL=1）。
            继续安装会清空现有的后台管理员账号，扫描新二维码后才能登录。装完请把该环境变量删掉。
          </Alert>
        ) : null}

        {error ? <Alert kind="error">{error}</Alert> : null}
        {notice && step !== 3 ? <Alert kind="success">{notice}</Alert> : null}

        {/* ---------------- 第 1 步：数据库 ---------------- */}
        {step === 1 ? (
          <>
            <section className={`${cardClass} mb-4`}>
              <h2 className="text-sm font-bold mb-3">环境自检</h2>
              <ul className="text-xs text-slate-600 space-y-2">
                <li>
                  <Dot ok={info?.env?.nodeOk} />
                  Node.js {info?.env?.node}
                  {info?.env?.nodeOk ? "" : "（需要 18.17 以上，请先升级 Node）"}
                </li>
                <li>
                  <Dot ok={info?.env?.configWritable} />
                  项目 config 目录可写
                  {info?.env?.configWritable
                    ? ""
                    : `（失败：${info?.env?.configError || "权限不足"}，安装过程需要写入 config/db.json）`}
                </li>
                <li>
                  <Dot ok />运行模式 {info?.env?.nodeEnv}｜{info?.env?.platform}
                </li>
              </ul>
            </section>

            <section className={cardClass}>
              <h2 className="text-sm font-bold mb-1">数据库连接</h2>
              <p className="text-xs text-slate-500 mb-3">
                数据库本身要在宝塔面板里先创建好（库名、用户名、密码）。
                <strong>下面的表不用手动导</strong>，点「开始安装」会自动建好全部数据表。
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
                <Field label="主机">
                  <input
                    value={db.host}
                    onChange={(e) => {
                      setDb({ ...db, host: e.target.value });
                      setTested(false);
                    }}
                    className={inputClass}
                  />
                </Field>
                <Field label="端口">
                  <input
                    value={db.port}
                    onChange={(e) => {
                      setDb({ ...db, port: e.target.value });
                      setTested(false);
                    }}
                    className={inputClass}
                  />
                </Field>
                <Field label="用户名">
                  <input
                    value={db.user}
                    onChange={(e) => {
                      setDb({ ...db, user: e.target.value });
                      setTested(false);
                    }}
                    className={inputClass}
                  />
                </Field>
                <Field label="密码">
                  <input
                    type="password"
                    value={db.password}
                    onChange={(e) => {
                      setDb({ ...db, password: e.target.value });
                      setTested(false);
                    }}
                    className={inputClass}
                  />
                </Field>
                <Field label="数据库名">
                  <input
                    value={db.database}
                    onChange={(e) => {
                      setDb({ ...db, database: e.target.value });
                      setTested(false);
                    }}
                    className={inputClass}
                  />
                </Field>
              </div>

              <label className="flex items-start gap-2 mt-1 mb-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={createDatabase}
                  onChange={(e) => {
                    setCreateDatabase(e.target.checked);
                    setTested(false);
                  }}
                  className="mt-0.5 w-4 h-4 accent-[#7fa3b8]"
                />
                <span className="text-xs text-slate-600">
                  这个数据库还不存在，安装时帮我创建（已存在会自动跳过）。
                  需要该账号有建库权限 —— 宝塔里直接用 <code>root</code> + root 密码最省事。
                </span>
              </label>

              <div className="flex items-center gap-3 mt-2">
                <button type="button" className={btnBase} disabled={testing} onClick={handleTest}>
                  {testing ? "测试中..." : "测试连接"}
                </button>
                <button
                  type="button"
                  className={btnPrimary}
                  onClick={() => {
                    setError("");
                    setNotice("");
                    if (!tested) {
                      setNotice("还没测试连接也没关系，下一步会真正校验；建议先点一次「测试连接」。");
                    }
                    setStep(2);
                  }}
                >
                  下一步：设置管理员
                </button>
                {tested ? <span className="text-xs text-emerald-600">连接已通过</span> : null}
              </div>
            </section>
          </>
        ) : null}

        {/* ---------------- 第 2 步：管理员 ---------------- */}
        {step === 2 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <section className={cardClass}>
              <h2 className="text-sm font-bold mb-3">后台管理员</h2>
              <Field label="站点名称" hint="会出现在验证码邮件里">
                <input
                  value={admin.siteName}
                  onChange={(e) => setAdmin({ ...admin, siteName: e.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field label="管理员账号" hint="3-32 位字母、数字、下划线、点或短横线">
                <input
                  value={admin.username}
                  onChange={(e) => setAdmin({ ...admin, username: e.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field label="密码" hint="至少 8 位，同时包含字母和数字">
                <input
                  type="password"
                  value={admin.password}
                  onChange={(e) => setAdmin({ ...admin, password: e.target.value })}
                  className={inputClass}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="确认密码">
                <input
                  type="password"
                  value={admin.confirm}
                  onChange={(e) => setAdmin({ ...admin, confirm: e.target.value })}
                  className={inputClass}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="验证器上的 6 位动态码" hint="绑好右侧二维码后，把 App 上显示的码填这里">
                <input
                  inputMode="numeric"
                  value={admin.code}
                  onChange={(e) =>
                    setAdmin({ ...admin, code: e.target.value.replace(/\D/g, "").slice(0, 6) })
                  }
                  className={`${inputClass} tracking-[0.4em] text-center font-mono`}
                />
              </Field>

              {info?.installed && info?.reinstallAllowed ? (
                <Field
                  label="重装口令（REINSTALL_KEY）"
                  hint={
                    info.reinstallKeyConfigured
                      ? "服务器上已设置重装口令，必须填对才能重置管理员"
                      : "服务器还没设置 REINSTALL_KEY：请先在 .env.local 里加一行 REINSTALL_KEY=随机口令 并重启服务"
                  }
                >
                  <input
                    type="password"
                    value={keys.reinstallKey}
                    onChange={(e) => setKeys({ ...keys, reinstallKey: e.target.value })}
                    className={inputClass}
                  />
                </Field>
              ) : null}

              {!info?.installed && info?.setupKeyRequired ? (
                <Field label="初始化口令（ADMIN_SETUP_KEY）" hint="服务器上设置了该口令，安装时必须填写">
                  <input
                    type="password"
                    value={keys.setupKey}
                    onChange={(e) => setKeys({ ...keys, setupKey: e.target.value })}
                    className={inputClass}
                  />
                </Field>
              ) : null}
            </section>

            <section className={cardClass}>
              <h2 className="text-sm font-bold mb-3">绑定动态验证码</h2>
              {info?.qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={info.qrDataUrl}
                  alt="TOTP 二维码"
                  className="w-52 h-52 mx-auto border border-[#eceeec] rounded-lg"
                />
              ) : (
                <p className="text-xs text-slate-400">二维码加载中...</p>
              )}
              <p className="text-xs text-slate-500 mt-3">
                用微软 Authenticator / Google Authenticator 等 App 扫码添加：
              </p>
              <p className="text-xs font-mono break-all bg-[#f7f7f4] border border-[#eceeec] rounded p-2 mt-1">
                {info?.secret || "-"}
              </p>
              <button
                type="button"
                className={`${btnBase} w-full mt-3`}
                onClick={() => load(true)}
                disabled={loading}
              >
                重新生成密钥
              </button>
              <p className="text-xs text-slate-400 mt-3">
                密钥只在绑定阶段展示，安装完成后不再显示，请务必扫码成功。
              </p>
            </section>

            <div className="md:col-span-2 flex flex-wrap items-center gap-3">
              <button type="button" className={btnBase} onClick={() => setStep(1)} disabled={installing}>
                返回上一步
              </button>
              <button type="button" className={btnPrimary} onClick={handleInstall} disabled={installing}>
                {installing ? "正在安装..." : "开始安装"}
              </button>
              <span className="text-xs text-slate-500">
                会依次执行：保存数据库配置 → 自动建表 → 创建管理员 → 写入安装锁
              </span>
            </div>
          </div>
        ) : null}

        {/* ---------------- 第 3 步：完成 ---------------- */}
        {step === 3 && result ? (
          <>
            <section className={`${cardClass} mb-4`}>
              <Alert kind="success">🎉 安装完成，已自动登录后台</Alert>
              {result.warning ? <Alert kind="warning">{result.warning}</Alert> : null}
              <ul className="text-xs text-slate-600 space-y-2">
                <li>
                  数据库：{result.database?.user}@{result.database?.host}:{result.database?.port}/
                  {result.database?.database}（MySQL {result.database?.version}）
                </li>
                <li>已创建数据表：{(result.tables || []).join("、")}</li>
                <li>
                  管理员账号：<strong>{result.username}</strong>（以后登录需要账号 + 密码 + 动态验证码）
                </li>
              </ul>
              <div className="mt-4 flex flex-wrap gap-3">
                <a href="/admin" className={btnPrimary}>
                  进入管理后台
                </a>
                <a href="/" className={btnBase}>
                  打开网站首页
                </a>
              </div>
            </section>

            <section className={`${cardClass} mb-4`}>
              <h2 className="text-sm font-bold mb-2">⚠️ 建议动手关掉安装入口</h2>
              <p className="text-xs text-slate-600 mb-3">
                安装完成后，安装接口已经会直接拒绝再次安装（返回 403），所以不删也安全。
                但最彻底的做法是把安装页面的文件删掉，让 <code>/install</code> 彻底不存在：
              </p>
              <pre className="text-xs bg-[#f7f7f4] border border-[#eceeec] rounded-lg p-3 overflow-x-auto">
{`cd /www/wwwroot/solace
rm -rf app/install app/api/install
npm run build
pm2 reload solace`}
              </pre>
              <p className="text-xs text-slate-500 mt-2">
                删完必须重新执行 <code>npm run build</code>，否则旧路由还在构建产物里。
              </p>
              <p className="text-xs text-slate-600 mt-3 mb-1">
                不想重新构建的话，也可以在宝塔的站点配置里直接屏蔽这两个路径（改完重载 Nginx 即可）：
              </p>
              <pre className="text-xs bg-[#f7f7f4] border border-[#eceeec] rounded-lg p-3 overflow-x-auto">
{`location ^~ /install { return 404; }
location ^~ /api/install { return 404; }`}
              </pre>
            </section>

            <section className={cardClass}>
              <h2 className="text-sm font-bold mb-2">接下来建议做的事</h2>
              <ol className="text-xs text-slate-600 space-y-2 list-decimal list-inside">
                <li>
                  进后台「对话 AI」页面填接口地址、API Key、模型名 —— 保存后用户端聊天立即生效
                </li>
                <li>进后台「邮箱 / 验证码」页面配网易 SMTP（授权码不是登录密码），并发一封测试邮件</li>
                <li>
                  如果 <code>.env.local</code> 里没有 <code>ADMIN_SETUP_KEY</code> 和 <code>CODE_SECRET</code>，建议补上
                </li>
                <li>域名解析、SSL 证书、以及后台路径的访问限制（详见项目里的 DEPLOY.md）</li>
              </ol>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
