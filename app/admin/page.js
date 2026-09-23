"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------ 样式 */

const inputClass =
  "w-full border border-[#d5d9d7] bg-white px-2 py-1.5 text-sm text-gray-800 placeholder-gray-400 rounded-lg transition-colors duration-150 focus:outline-none focus:border-[#8fb3c7] focus:ring-1 focus:ring-[#8fb3c7]";

const btnBase =
  "border border-[#d5d9d7] bg-[#fdfdfc] text-slate-700 rounded-lg px-3 py-1.5 text-sm hover:bg-[#e8eff2] hover:text-slate-900 active:bg-[#dbe6ea] active:scale-[0.98] transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed";

const btnPrimary =
  "border border-[#7fa3b8] bg-[#7fa3b8] text-white rounded-lg px-3 py-1.5 text-sm hover:bg-[#6c93a8] active:scale-[0.98] transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed";

const cardClass = "bg-white border border-[#e5e7e4] rounded-xl p-4";

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

/* ------------------------------------------------------------ 字段定义表 */

const FIELDS = {
  ai: [
    { key: "enabled", label: "启用对话 AI", type: "boolean", hint: "关闭后 /api/chat 只会返回兜底文案" },
    { key: "baseUrl", label: "接口地址", type: "text", hint: "只填到版本目录（如 https://open.bigmodel.cn/api/paas/v4），程序自动拼 /chat/completions" },
    { key: "apiKey", label: "API Key", type: "secret" },
    { key: "model", label: "模型名", type: "text", hint: "例如 glm-4-flash、gpt-4o-mini" },
    { key: "temperature", label: "温度（0-2）", type: "number", step: "0.1" },
    { key: "maxTokens", label: "最大回复长度", type: "number" },
    { key: "timeoutSeconds", label: "超时（秒）", type: "number" },
    { key: "provider", label: "服务商备注", type: "text", hint: "仅作记录，不影响调用" },
  ],
  tts: [
    { key: "enabled", label: "启用语音合成", type: "boolean" },
    { key: "baseUrl", label: "接口地址", type: "text", hint: "程序会自动拼 /audio/speech（OpenAI 兼容格式）" },
    { key: "apiKey", label: "API Key", type: "secret" },
    { key: "model", label: "模型名", type: "text", hint: "例如 tts-1，按服务商文档填写" },
    { key: "voice", label: "默认音色", type: "text", hint: "例如 alloy、zh-CN-XiaoxiaoNeural" },
    { key: "speed", label: "语速（0.5-2）", type: "number", step: "0.1" },
    { key: "format", label: "音频格式", type: "text", hint: "常见为 mp3" },
    { key: "timeoutSeconds", label: "超时（秒）", type: "number" },
  ],
  smtp: [
    { key: "enabled", label: "启用邮件发送", type: "boolean", hint: "开启后后台才能发测试邮件，下一轮用户端验证码也要靠它" },
    { key: "host", label: "SMTP 服务器", type: "text", hint: "网易：smtp.163.com 或 smtp.126.com" },
    { key: "port", label: "端口", type: "number", hint: "SSL 用 465，STARTTLS 用 587" },
    { key: "secure", label: "使用 SSL（465 端口选这个）", type: "boolean" },
    { key: "user", label: "发信邮箱", type: "text", hint: "例如 yourname@163.com" },
    { key: "password", label: "SMTP 授权码", type: "secret", hint: "网易邮箱要填授权码，不是登录密码" },
    { key: "fromName", label: "发件人显示名", type: "text" },
    { key: "fromEmail", label: "发件人邮箱", type: "text", hint: "网易邮箱要求与发信邮箱一致" },
  ],
  login: [
    { key: "codeLength", label: "验证码位数（4-8）", type: "number" },
    { key: "codeTtlSeconds", label: "有效期（秒）", type: "number", hint: "默认 300 秒" },
    { key: "sendCooldownSeconds", label: "发送冷却（秒）", type: "number", hint: "同一邮箱两次发送的最小间隔" },
    { key: "dailyLimitPerEmail", label: "单邮箱每日上限", type: "number" },
    { key: "emailSubject", label: "邮件标题", type: "text" },
    { key: "emailIntro", label: "邮件正文开头", type: "textarea", hint: "可用占位符 {code} {minutes} {siteName}" },
  ],
  site: [
    { key: "siteName", label: "站点名称", type: "text" },
    { key: "adminNotice", label: "后台公告", type: "textarea", hint: "显示在概览页，可留空" },
  ],
};

const TABS = [
  { id: "overview", label: "概览" },
  { id: "database", label: "数据库" },
  { id: "ai", label: "对话 AI" },
  { id: "tts", label: "语音 TTS" },
  { id: "mail", label: "邮箱 / 验证码" },
  { id: "users", label: "用户管理" },
  { id: "userdata", label: "用户数据" },
  { id: "site", label: "站点信息" },
  { id: "logs", label: "操作日志" },
];

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
        : "border-[#cfdde5] bg-[#f2f7fa] text-slate-600";
  return (
    <div className={`border rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words mb-3 ${tone}`}>
      {children}
    </div>
  );
}

function StatusDot({ ok }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full mr-2 ${ok ? "bg-emerald-500" : "bg-slate-300"}`}
    />
  );
}

/* -------------------------------------------------------- 通用配置表单块 */

function SettingsGroup({ group, title, description, settings, onSaved, setError, setNotice, children }) {
  const fields = FIELDS[group] || [];
  const source = (settings && settings[group]) || {};
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft({});
  }, [settings]);

  const rawValue = (key) =>
    Object.prototype.hasOwnProperty.call(draft, key) ? draft[key] : source[key];
  const textValue = (key) => {
    const value = rawValue(key);
    return value === undefined || value === null ? "" : String(value);
  };
  const boolValue = (key) => Boolean(rawValue(key));
  const touched = (key) => Object.prototype.hasOwnProperty.call(draft, key);

  function setValue(key, value) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const values = {};
      for (const field of fields) {
        if (!touched(field.key)) continue;
        const value = draft[field.key];

        if (field.type === "boolean") {
          values[field.key] = Boolean(value);
          continue;
        }
        // 密钥与数字字段留空 = 不修改；普通文本留空 = 真正清空该字段
        if (
          typeof value === "string" &&
          value.trim() === "" &&
          (field.type === "secret" || field.type === "number")
        ) {
          continue;
        }
        values[field.key] = value;
      }

      if (!Object.keys(values).length) {
        setNotice(`${title}：没有需要保存的修改`);
        return;
      }

      await api("/api/admin/settings", {
        method: "PUT",
        body: { group, values },
      });
      setNotice(`${title} 已保存`);
      if (onSaved) await onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={`${cardClass} mb-4`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <h2 className="text-sm font-bold text-slate-800">{title}</h2>
          {description ? <p className="text-xs text-slate-500 mt-1">{description}</p> : null}
        </div>
        <button type="button" onClick={handleSave} disabled={saving} className={btnPrimary}>
          {saving ? "保存中..." : "保存"}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
        {fields.map((field) => {
          if (field.type === "boolean") {
            return (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <span className="inline-flex items-center gap-2 h-[34px]">
                  <input
                    type="checkbox"
                    checked={boolValue(field.key)}
                    onChange={(e) => setValue(field.key, e.target.checked)}
                    className="w-4 h-4 accent-[#7fa3b8]"
                  />
                  <span className="text-xs text-slate-500">
                    {boolValue(field.key) ? "已开启" : "已关闭"}
                  </span>
                </span>
              </Field>
            );
          }

          if (field.type === "textarea") {
            return (
              <div key={field.key} className="md:col-span-2">
                <Field label={field.label} hint={field.hint}>
                  <textarea
                    rows={3}
                    value={textValue(field.key)}
                    onChange={(e) => setValue(field.key, e.target.value)}
                    className={`${inputClass} resize-none`}
                  />
                </Field>
              </div>
            );
          }

          const isSecret = field.type === "secret";
          const configured = Boolean(source[`${field.key}Configured`]);
          const placeholder = isSecret
            ? configured
              ? "已配置，留空表示不修改"
              : "尚未配置"
            : field.hint || "";

          return (
            <Field key={field.key} label={field.label} hint={field.hint}>
              <input
                type={isSecret ? "password" : field.type === "number" ? "number" : "text"}
                step={field.step}
                value={textValue(field.key)}
                placeholder={placeholder}
                onChange={(e) => setValue(field.key, e.target.value)}
                className={inputClass}
              />
            </Field>
          );
        })}
      </div>

      {children}
    </section>
  );
}

/* ------------------------------------------------------------ 数据库表单 */

function DatabasePanel({ onChanged, setError, setNotice, bootstrap = false }) {
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState("");
  const [localError, setLocalError] = useState("");
  const [setupKeyRequired, setSetupKeyRequired] = useState(false);
  const [setupKey, setSetupKey] = useState("");

  const load = useCallback(async () => {
    setLocalError("");
    try {
      const data = await api("/api/admin/database");
      setConfig(data.config);
      setStatus(data.status);
      setSetupKeyRequired(Boolean(data.setupKeyRequired));
      setForm({
        host: data.config.host,
        port: String(data.config.port),
        user: data.config.user,
        password: "",
        database: data.config.database,
        connectionLimit: String(data.config.connectionLimit),
      });
    } catch (err) {
      setLocalError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function update(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(action) {
    if (!form) return;
    setBusy(action);
    setLocalError("");
    setNotice("");
    try {
      const data = await api("/api/admin/database", {
        method: "POST",
        body: {
          action,
          keepPassword: true,
          setupKey,
          config: {
            host: form.host,
            port: form.port === "" ? undefined : Number(form.port),
            user: form.user,
            password: form.password,
            database: form.database,
            connectionLimit: form.connectionLimit === "" ? undefined : Number(form.connectionLimit),
          },
        },
      });
      setStatus(data.status || null);
      if (action === "save") {
        setNotice(data.message || "数据库配置已保存");
        await load();
        if (onChanged) await onChanged();
      } else {
        setNotice("连接测试成功");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  if (!form) {
    return (
      <section className={cardClass}>
        <Alert kind="error">{localError || "正在读取数据库配置..."}</Alert>
      </section>
    );
  }

  return (
    <section className={cardClass}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <h2 className="text-sm font-bold text-slate-800">数据库连接</h2>
          <p className="text-xs text-slate-500 mt-1">
            保存在服务器文件 <code className="text-slate-600">{config?.configFilePath || "config/db.json"}</code>
            （不写进数据库，也不提交到仓库）。保存前会真实测试连接，连接不通不会改动现有配置。
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button type="button" className={btnBase} disabled={busy !== ""} onClick={() => submit("test")}>
            {busy === "test" ? "测试中..." : "测试连接"}
          </button>
          <button type="button" className={btnPrimary} disabled={busy !== ""} onClick={() => submit("save")}>
            {busy === "save" ? "保存中..." : "保存并生效"}
          </button>
        </div>
      </div>

      {localError ? <Alert kind="error">{localError}</Alert> : null}

      <Alert kind={status?.connected ? "success" : "error"}>
        {status?.connected
          ? `当前连接正常，MySQL 版本 ${status.version}`
          : status?.error
            ? `当前连接失败：${status.error}`
            : "尚未检测连接状态"}
      </Alert>

      {setupKeyRequired && bootstrap ? (
        <Field label="初始化口令（ADMIN_SETUP_KEY）" hint="未登录状态下操作数据库配置时需要">
          <input
            type="password"
            value={setupKey}
            onChange={(e) => setSetupKey(e.target.value)}
            className={inputClass}
          />
        </Field>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
        <Field label="主机">
          <input value={form.host} onChange={(e) => update("host", e.target.value)} className={inputClass} />
        </Field>
        <Field label="端口">
          <input value={form.port} onChange={(e) => update("port", e.target.value)} className={inputClass} />
        </Field>
        <Field label="用户名">
          <input value={form.user} onChange={(e) => update("user", e.target.value)} className={inputClass} />
        </Field>
        <Field label="密码" hint={config?.hasPassword ? "已配置，留空表示不修改" : "尚未配置"}>
          <input
            type="password"
            value={form.password}
            placeholder={config?.hasPassword ? "留空表示不修改" : "请输入数据库密码"}
            onChange={(e) => update("password", e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="数据库名">
          <input
            value={form.database}
            onChange={(e) => update("database", e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="连接池大小" hint="宝塔小内存服务器建议 5 左右">
          <input
            value={form.connectionLimit}
            onChange={(e) => update("connectionLimit", e.target.value)}
            className={inputClass}
          />
        </Field>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- 概览面板 */

function OverviewPanel({ overview, onReload }) {
  if (!overview) {
    return (
      <section className={cardClass}>
        <Alert kind="info">正在读取运行状态...</Alert>
      </section>
    );
  }

  const { env, database, admin, readiness } = overview;

  const rows = [
    {
      label: "数据库",
      ok: database.connected,
      detail: database.connected
        ? `${database.user}@${database.host}:${database.port}/${database.database}（MySQL ${database.version}）`
        : database.error,
    },
    {
      label: "对话 AI",
      ok: Boolean(readiness.ai?.enabled && readiness.ai?.configured),
      detail: readiness.ai
        ? `模型 ${readiness.ai.model || "未填"}｜${readiness.ai.configured ? "配置完整" : "配置不完整（缺 Key / 地址 / 模型）"}｜${readiness.ai.enabled ? "已启用" : "已关闭"}`
        : "读取失败",
    },
    {
      label: "语音 TTS",
      ok: Boolean(readiness.tts?.enabled && readiness.tts?.configured),
      detail: readiness.tts
        ? `模型 ${readiness.tts.model || "未填"}｜音色 ${readiness.tts.voice || "未填"}｜${readiness.tts.configured ? "配置完整" : "配置不完整（缺 Key / 地址 / 模型 / 音色）"}｜${readiness.tts.enabled ? "已启用" : "已关闭"}`
        : "读取失败",
    },
    {
      label: "邮件 SMTP",
      ok: Boolean(readiness.smtp?.enabled && readiness.smtp?.configured),
      detail: readiness.smtp
        ? `${readiness.smtp.host}:${readiness.smtp.port}｜账号 ${readiness.smtp.user || "未填"}｜${readiness.smtp.configured ? "配置完整" : "配置不完整（缺服务器 / 账号 / 授权码）"}｜${readiness.smtp.enabled ? "已启用" : "已关闭"}`
        : "读取失败",
    },
  ];

  return (
    <div className="space-y-4">
      {readiness.site?.adminNotice ? (
        <Alert kind="info">{readiness.site.adminNotice}</Alert>
      ) : null}

      <section className={cardClass}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-slate-800">模块状态</h2>
          <button type="button" className={btnBase} onClick={onReload}>
            刷新
          </button>
        </div>
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.label} className="text-sm">
              <div className="font-medium text-slate-700">
                <StatusDot ok={row.ok} />
                {row.label}
              </div>
              <div className="text-xs text-slate-500 pl-4 break-words">{row.detail || "-"}</div>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section className={cardClass}>
          <h2 className="text-sm font-bold text-slate-800 mb-3">服务器环境</h2>
          <dl className="text-xs text-slate-600 space-y-2">
            <div className="flex justify-between gap-3">
              <dt>Node 版本</dt>
              <dd className="font-mono">{env.nodeVersion}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>运行平台</dt>
              <dd className="font-mono">{env.platform}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>NODE_ENV</dt>
              <dd className="font-mono">{env.nextEnv}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>已运行</dt>
              <dd className="font-mono">{Math.floor(env.uptimeSeconds / 60)} 分钟</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>服务器时间</dt>
              <dd className="font-mono">{new Date(env.serverTime).toLocaleString()}</dd>
            </div>
          </dl>
        </section>

        <section className={cardClass}>
          <h2 className="text-sm font-bold text-slate-800 mb-3">账号</h2>
          <dl className="text-xs text-slate-600 space-y-2">
            <div className="flex justify-between gap-3">
              <dt>当前登录</dt>
              <dd className="font-mono">{admin.username}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>管理员数量</dt>
              <dd className="font-mono">{admin.adminCount}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>上次登录</dt>
              <dd className="font-mono">{admin.lastLoginAt ? String(admin.lastLoginAt) : "-"}</dd>
            </div>
          </dl>
        </section>
      </div>

      <LogsPanel logs={overview.logs} compact />
    </div>
  );
}

/* ---------------------------------------------------------------- 日志表 */

function LogsPanel({ logs, compact = false }) {
  const [rows, setRows] = useState(logs || null);

  useEffect(() => {
    if (logs) setRows(logs);
  }, [logs]);

  useEffect(() => {
    if (compact) return;
    api("/api/admin/logs?limit=100")
      .then((data) => setRows(data.logs || []))
      .catch(() => setRows([]));
  }, [compact]);

  if (!rows) return null;

  return (
    <section className={cardClass}>
      <h2 className="text-sm font-bold text-slate-800 mb-3">
        {compact ? "最近操作" : "操作日志（最近 100 条）"}
      </h2>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-400">暂无记录</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 border-b border-[#eceeec]">
                <th className="text-left py-2 pr-3 font-medium">时间</th>
                <th className="text-left py-2 pr-3 font-medium">账号</th>
                <th className="text-left py-2 pr-3 font-medium">操作</th>
                <th className="text-left py-2 pr-3 font-medium">详情</th>
                <th className="text-left py-2 font-medium">IP</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-[#f2f3f1] text-slate-600">
                  <td className="py-1.5 pr-3 whitespace-nowrap font-mono">{String(row.created_at)}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{row.username || "-"}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{row.action}</td>
                  <td className="py-1.5 pr-3">{row.detail || "-"}</td>
                  <td className="py-1.5 whitespace-nowrap font-mono">{row.ip || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------ 用户管理 */

const GENDER_OPTIONS = ["", "男", "女", "其他", "保密"];

// 可开关的字段（邮箱、账号、密码是强制显示的，不在这里）
const FIELD_LABELS = [
  { key: "nickname", label: "昵称" },
  { key: "gender", label: "性别" },
  { key: "birthday", label: "出生年月" },
  { key: "phone", label: "手机号" },
  { key: "remark", label: "备注" },
  { key: "status", label: "账号状态" },
  { key: "createdAt", label: "注册时间" },
  { key: "lastLoginAt", label: "最后登录" },
];

const EMPTY_USER_FORM = {
  id: null,
  email: "",
  account: "",
  password: "",
  username: "",
  gender: "",
  birthday: "",
  phone: "",
  remark: "",
  status: 1,
};

function UsersPanel({ setError, setNotice, onViewData }) {
  const [data, setData] = useState(null);
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [reveal, setReveal] = useState(false);
  const [fields, setFields] = useState(null); // 已保存的开关
  const [draftFields, setDraftFields] = useState(null); // 正在编辑、还没保存的开关
  const [savingFields, setSavingFields] = useState(false);
  const [form, setForm] = useState(null); // null 表示弹窗关闭
  const [busy, setBusy] = useState(false);
  const pageSize = 20;

  async function load(overrides = {}) {
    const nextPage = overrides.page ?? page;
    const nextKeyword = overrides.keyword ?? keyword;
    const nextReveal = overrides.reveal ?? reveal;

    try {
      const query = new URLSearchParams({
        keyword: nextKeyword,
        page: String(nextPage),
        pageSize: String(pageSize),
        revealPassword: nextReveal ? "1" : "0",
      });
      const result = await api(`/api/admin/users?${query.toString()}`);
      setData(result);
      setPage(result.page || nextPage);
      setKeyword(nextKeyword);
      setReveal(Boolean(result.revealPassword));
      setFields(result.visibleFields || {});
      setDraftFields((prev) => prev || result.visibleFields || {});
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // 只在挂载时拉一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = fields || data?.visibleFields || {};
  // 复选框编辑 draft，保存后才影响列表的显示
  const editing = draftFields || visible;
  const users = data?.users || [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  async function saveFields() {
    if (!editing) return;

    setSavingFields(true);
    setError("");
    setNotice("");
    try {
      await api("/api/admin/settings", {
        method: "PUT",
        body: { group: "users", values: { visibleFields: editing } },
      });
      setNotice("字段显示开关已保存");
      setDraftFields(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingFields(false);
    }
  }

  async function submitForm(event) {
    event.preventDefault();
    if (!form) return;

    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (form.id) {
        const body = {
          id: form.id,
          email: form.email,
          account: form.account,
          username: form.username,
          gender: form.gender,
          birthday: form.birthday,
          phone: form.phone,
          remark: form.remark,
          status: form.status,
        };
        if (form.password) body.password = form.password;
        await api("/api/admin/users", { method: "PATCH", body });
      } else {
        await api("/api/admin/users", {
          method: "POST",
          body: {
            email: form.email,
            account: form.account,
            password: form.password,
            username: form.username,
            gender: form.gender,
            birthday: form.birthday,
            phone: form.phone,
            remark: form.remark,
            status: form.status,
          },
        });
      }
      setNotice(form.id ? "用户已更新" : "用户已添加");
      setForm(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeUser(user) {
    const ok = window.confirm(
      `确定删除用户「${user.email}」吗？\n他的聊天记录和日记也会一起删除，且不可恢复。`
    );
    if (!ok) return;

    setError("");
    setNotice("");
    try {
      await api(`/api/admin/users?id=${encodeURIComponent(user.id)}`, { method: "DELETE" });
      setNotice("用户已删除");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleStatus(user) {
    setError("");
    setNotice("");
    try {
      await api("/api/admin/users", {
        method: "PATCH",
        body: { id: user.id, status: user.status === 1 ? 0 : 1 },
      });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function clearPassword(user) {
    if (!window.confirm("确定清空该用户的密码吗？之后他只能用邮箱验证码登录。")) return;
    setError("");
    setNotice("");
    try {
      await api("/api/admin/users", {
        method: "PATCH",
        body: { id: user.id, clearPassword: true },
      });
      setNotice("密码已清空");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <section className={cardClass}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h2 className="text-sm font-bold text-slate-800">信息显示开关</h2>
            <p className="text-xs text-slate-500 mt-1">
              邮箱、账号、密码是<strong>强制显示</strong>的，不受这里控制；下面这些字段可以选择性显示。
            </p>
          </div>
          <button
            type="button"
            className={btnPrimary}
            onClick={saveFields}
            disabled={savingFields}
          >
            {savingFields ? "保存中..." : "保存开关"}
          </button>
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {FIELD_LABELS.map((item) => (
            <label
              key={item.key}
              className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer"
            >
              <input
                type="checkbox"
                className="w-4 h-4 accent-[#7fa3b8]"
                checked={editing[item.key] !== false}
                onChange={(e) =>
                  setDraftFields((prev) => ({
                    ...(prev || visible),
                    [item.key]: e.target.checked,
                  }))
                }
              />
              {item.label}
            </label>
          ))}
        </div>

        {data?.keyIsDefault ? (
          <p className="text-xs text-amber-700 mt-3">
            提示：当前使用的是默认加密密钥。建议在 <code>.env.local</code> 里设置{" "}
            <code>USER_PASSWORD_KEY</code>（或 <code>CODE_SECRET</code>）来提高强度；
            注意设置后要先重启服务，已经存过的密码需要用新密钥重新保存一次才能解开。
          </p>
        ) : null}
      </section>

      <section className={cardClass}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <h2 className="text-sm font-bold text-slate-800 mr-auto">
            用户列表（共 {data?.total ?? 0} 人）
          </h2>
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") load({ page: 1 });
            }}
            placeholder="搜索邮箱 / 账号 / 昵称 / 手机号"
            className={`${inputClass} w-56`}
          />
          <button type="button" className={btnBase} onClick={() => load({ page: 1 })}>
            搜索
          </button>
          <button
            type="button"
            className={btnBase}
            onClick={() => load({ reveal: !reveal })}
          >
            {reveal ? "隐藏密码" : "显示密码"}
          </button>
          <button
            type="button"
            className={btnPrimary}
            onClick={() => setForm({ ...EMPTY_USER_FORM })}
          >
            + 添加用户
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 border-b border-[#eceeec]">
                <th className="text-left py-2 pr-3 font-medium">ID</th>
                <th className="text-left py-2 pr-3 font-medium">邮箱</th>
                <th className="text-left py-2 pr-3 font-medium">账号</th>
                <th className="text-left py-2 pr-3 font-medium">密码</th>
                {visible.gender ? <th className="text-left py-2 pr-3 font-medium">性别</th> : null}
                {visible.birthday ? (
                  <th className="text-left py-2 pr-3 font-medium">出生年月</th>
                ) : null}
                {visible.nickname ? (
                  <th className="text-left py-2 pr-3 font-medium">昵称</th>
                ) : null}
                {visible.phone ? <th className="text-left py-2 pr-3 font-medium">手机号</th> : null}
                {visible.remark ? <th className="text-left py-2 pr-3 font-medium">备注</th> : null}
                {visible.status ? <th className="text-left py-2 pr-3 font-medium">状态</th> : null}
                {visible.createdAt ? (
                  <th className="text-left py-2 pr-3 font-medium">注册时间</th>
                ) : null}
                {visible.lastLoginAt ? (
                  <th className="text-left py-2 pr-3 font-medium">最后登录</th>
                ) : null}
                <th className="text-left py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr>
                  <td colSpan={13} className="py-4 text-slate-400">
                    {data ? "暂无用户" : "加载中..."}
                  </td>
                </tr>
              ) : null}

              {users.map((user) => (
                <tr key={user.id} className="border-b border-[#f2f3f1] text-slate-600 align-top">
                  <td className="py-2 pr-3 font-mono">{user.id}</td>
                  <td className="py-2 pr-3 break-all">{user.email}</td>
                  <td className="py-2 pr-3 font-mono">{user.account || "-"}</td>
                  <td className="py-2 pr-3 font-mono break-all">
                    {!user.hasPassword ? (
                      <span className="text-slate-400">未设置</span>
                    ) : reveal ? (
                      user.passwordReadable ? (
                        user.password
                      ) : (
                        <span className="text-amber-700">解密失败（密钥变过）</span>
                      )
                    ) : (
                      "••••••"
                    )}
                  </td>
                  {visible.gender ? <td className="py-2 pr-3">{user.gender || "-"}</td> : null}
                  {visible.birthday ? <td className="py-2 pr-3">{user.birthday || "-"}</td> : null}
                  {visible.nickname ? (
                    <td className="py-2 pr-3">{user.username || "-"}</td>
                  ) : null}
                  {visible.phone ? <td className="py-2 pr-3">{user.phone || "-"}</td> : null}
                  {visible.remark ? <td className="py-2 pr-3">{user.remark || "-"}</td> : null}
                  {visible.status ? (
                    <td className="py-2 pr-3">
                      {user.status === 1 ? (
                        <span className="text-emerald-600">正常</span>
                      ) : (
                        <span className="text-red-600">已禁用</span>
                      )}
                    </td>
                  ) : null}
                  {visible.createdAt ? (
                    <td className="py-2 pr-3 font-mono whitespace-nowrap">
                      {user.created_at || "-"}
                    </td>
                  ) : null}
                  {visible.lastLoginAt ? (
                    <td className="py-2 pr-3 font-mono whitespace-nowrap">
                      {user.last_login_at || "-"}
                    </td>
                  ) : null}
                  <td className="py-2 whitespace-nowrap">
                    {onViewData ? (
                      <button
                        type="button"
                        className="text-[#5b8aa6] hover:underline mr-2"
                        onClick={() => onViewData(user.id)}
                      >
                        查看数据
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="text-[#5b8aa6] hover:underline mr-2"
                      onClick={() =>
                        setForm({
                          id: user.id,
                          email: user.email || "",
                          account: user.account || "",
                          password: "",
                          username: user.username || "",
                          gender: user.gender || "",
                          birthday: user.birthday || "",
                          phone: user.phone || "",
                          remark: user.remark || "",
                          status: user.status === 1 ? 1 : 0,
                        })
                      }
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="text-[#5b8aa6] hover:underline mr-2"
                      onClick={() => toggleStatus(user)}
                    >
                      {user.status === 1 ? "禁用" : "启用"}
                    </button>
                    <button
                      type="button"
                      className="text-[#5b8aa6] hover:underline mr-2"
                      onClick={() => clearPassword(user)}
                    >
                      清空密码
                    </button>
                    <button
                      type="button"
                      className="text-red-500 hover:underline"
                      onClick={() => removeUser(user)}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {totalPages > 1 ? (
          <div className="flex items-center gap-2 mt-3 text-xs text-slate-500">
            <button
              type="button"
              className={btnBase}
              disabled={page <= 1}
              onClick={() => load({ page: page - 1 })}
            >
              上一页
            </button>
            <span>
              第 {page} / {totalPages} 页
            </span>
            <button
              type="button"
              className={btnBase}
              disabled={page >= totalPages}
              onClick={() => load({ page: page + 1 })}
            >
              下一页
            </button>
          </div>
        ) : null}
      </section>

      {form ? (
        <div
          className="fixed inset-0 bg-black/20 flex items-center justify-center z-50"
          onClick={() => setForm(null)}
        >
          <form
            onSubmit={submitForm}
            className="bg-white rounded-xl p-4 w-[460px] max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-bold text-slate-800 mb-3">
              {form.id ? `编辑用户 #${form.id}` : "添加用户"}
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
              <Field label="邮箱（必填）" hint="用于邮箱验证码登录">
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className={inputClass}
                  required
                />
              </Field>
              <Field label="登录账号" hint="3-32 位字母数字，可留空">
                <input
                  value={form.account}
                  onChange={(e) => setForm({ ...form, account: e.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field
                label={form.id ? "重置密码（留空 = 不修改）" : "登录密码"}
                hint="至少 6 位；留空表示该用户只能用邮箱验证码登录"
              >
                <input
                  type="text"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  className={inputClass}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="昵称 / 显示名">
                <input
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field label="性别">
                <select
                  value={form.gender}
                  onChange={(e) => setForm({ ...form, gender: e.target.value })}
                  className={inputClass}
                >
                  {GENDER_OPTIONS.map((item) => (
                    <option key={item || "empty"} value={item}>
                      {item || "未填写"}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="出生年月" hint="例如 2003-05 或 2003-05-20">
                <input
                  value={form.birthday}
                  onChange={(e) => setForm({ ...form, birthday: e.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field label="手机号">
                <input
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field label="账号状态">
                <select
                  value={String(form.status)}
                  onChange={(e) => setForm({ ...form, status: Number(e.target.value) })}
                  className={inputClass}
                >
                  <option value="1">正常（可登录）</option>
                  <option value="0">禁用（不能登录）</option>
                </select>
              </Field>
              <div className="md:col-span-2">
                <Field label="备注">
                  <textarea
                    rows={2}
                    value={form.remark}
                    onChange={(e) => setForm({ ...form, remark: e.target.value })}
                    className={`${inputClass} resize-none`}
                  />
                </Field>
              </div>
            </div>

            <div className="flex items-center gap-2 mt-2">
              <button type="submit" className={btnPrimary} disabled={busy}>
                {busy ? "保存中..." : "保存"}
              </button>
              <button type="button" className={btnBase} onClick={() => setForm(null)}>
                取消
              </button>
            </div>

            <p className="text-xs text-slate-400 mt-3">
              密码在数据库里是加密存储的，后台点「显示密码」可以看到明文（加密密钥在服务器的 .env.local 里）。
            </p>
          </form>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------- 用户数据查看 */

function UserDataPanel({ initialUserId, setError, setNotice }) {
  const [keyword, setKeyword] = useState("");
  const [candidates, setCandidates] = useState([]);
  const [searching, setSearching] = useState(false);
  const [userId, setUserId] = useState(initialUserId || null);
  const [profile, setProfile] = useState(null);
  const [diaries, setDiaries] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [activeConv, setActiveConv] = useState(null);
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  // 防止快速切换用户时，旧请求的响应盖掉新数据
  const requestIdRef = useRef(0);

  async function openConversation(targetId, conversation) {
    setActiveConv(conversation);
    setMessages([]);
    try {
      const data = await api(
        `/api/admin/user-data?type=messages&userId=${targetId}&conversationId=${conversation.id}`
      );
      setMessages(data.messages || []);
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadUser(targetId) {
    if (!targetId) return;

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setBusy(true);
    setError("");
    setNotice("");
    setUserId(targetId);
    // 先清空上一个用户的数据，避免请求失败时新旧数据混在一起
    setProfile(null);
    setDiaries([]);
    setConversations([]);
    setActiveConv(null);
    setMessages([]);

    try {
      const [profileData, diariesData, conversationsData] = await Promise.all([
        api(`/api/admin/user-data?type=profile&userId=${targetId}`),
        api(`/api/admin/user-data?type=diaries&userId=${targetId}`),
        api(`/api/admin/user-data?type=conversations&userId=${targetId}`),
      ]);

      // 期间如果又点了别的用户，就丢弃这次结果
      if (requestIdRef.current !== requestId) return;

      setProfile(profileData);
      setDiaries(diariesData.diaries || []);
      setConversations(conversationsData.conversations || []);
    } catch (err) {
      if (requestIdRef.current === requestId) setError(err.message);
    } finally {
      if (requestIdRef.current === requestId) setBusy(false);
    }
  }

  useEffect(() => {
    if (initialUserId) loadUser(initialUserId);
    // 只在外部传入（从「用户管理」跳过来）时加载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUserId]);

  async function searchUsers() {
    setSearching(true);
    setError("");
    try {
      const data = await api(
        `/api/admin/users?keyword=${encodeURIComponent(keyword)}&page=1&pageSize=20`
      );
      setCandidates(data.users || []);
      if (!data.users?.length) setNotice("没有搜到用户");
    } catch (err) {
      setError(err.message);
    } finally {
      setSearching(false);
    }
  }

  async function removeItem(type, id, label) {
    if (!window.confirm(`确定删除${label}吗？此操作不可恢复。`)) return;

    setError("");
    setNotice("");
    try {
      await api(`/api/admin/user-data?type=${type}&id=${id}`, { method: "DELETE" });
      setNotice("已删除");

      if (userId) {
        // 删的是消息时，记住当前展开的会话，刷新后重新打开它
        const keepConversation = type === "message" ? activeConv : null;
        await loadUser(userId);
        if (keepConversation) await openConversation(userId, keepConversation);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <section className={cardClass}>
        <h2 className="text-sm font-bold text-slate-800 mb-1">选择用户</h2>
        <p className="text-xs text-slate-500 mb-3">
          搜索后点用户即可查看他的日记与聊天记录（也可以从「用户管理」点「查看数据」直接跳过来）。
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") searchUsers();
            }}
            placeholder="输入邮箱 / 账号 / 昵称，然后点搜索"
            className={`${inputClass} w-64`}
          />
          <button type="button" className={btnBase} onClick={searchUsers} disabled={searching}>
            {searching ? "搜索中..." : "搜索"}
          </button>
        </div>

        {candidates.length > 0 ? (
          <div className="flex flex-wrap gap-2 mt-3">
            {candidates.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => loadUser(item.id)}
                className={
                  userId === item.id
                    ? "px-3 py-1.5 text-xs rounded-lg bg-[#e3edf2] text-slate-900 font-bold"
                    : "px-3 py-1.5 text-xs rounded-lg border border-[#e5e7e4] text-slate-600 hover:bg-[#eef1f2]"
                }
              >
                #{item.id} {item.email}
                {item.username ? `（${item.username}）` : ""}
              </button>
            ))}
          </div>
        ) : null}
      </section>

      {busy ? (
        <section className={cardClass}>
          <p className="text-xs text-slate-400">加载中...</p>
        </section>
      ) : null}

      {profile ? (
        <>
          <section className={cardClass}>
            <div className="flex items-center gap-3 mb-3">
              <h2 className="text-sm font-bold text-slate-800">用户信息 #{profile.user.id}</h2>
              <button
                type="button"
                className={`${btnBase} ml-auto`}
                onClick={() => loadUser(userId)}
              >
                刷新
              </button>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-slate-600">
              <div>
                <span className="text-slate-400 block">邮箱</span>
                <span className="break-all">{profile.user.email}</span>
              </div>
              <div>
                <span className="text-slate-400 block">账号</span>
                {profile.user.account || "-"}
              </div>
              <div>
                <span className="text-slate-400 block">昵称</span>
                {profile.user.username || "-"}
              </div>
              <div>
                <span className="text-slate-400 block">性别</span>
                {profile.user.gender || "-"}
              </div>
              <div>
                <span className="text-slate-400 block">出生年月</span>
                {profile.user.birthday || "-"}
              </div>
              <div>
                <span className="text-slate-400 block">手机号</span>
                {profile.user.phone || "-"}
              </div>
              <div>
                <span className="text-slate-400 block">状态</span>
                {profile.user.status === 1 ? "正常" : "已禁用"}
              </div>
              <div>
                <span className="text-slate-400 block">注册时间</span>
                <span className="font-mono">{profile.user.created_at || "-"}</span>
              </div>
              <div className="col-span-2 md:col-span-4">
                <span className="text-slate-400 block">备注</span>
                {profile.user.remark || "-"}
              </div>
            </div>

            <div className="flex flex-wrap gap-4 mt-4 pt-3 border-t border-[#eceeec] text-xs text-slate-500">
              <span>
                日记 <strong className="text-slate-800">{profile.stats?.diaries ?? 0}</strong> 篇
              </span>
              <span>
                会话 <strong className="text-slate-800">{profile.stats?.conversations ?? 0}</strong> 个
              </span>
              <span>
                消息 <strong className="text-slate-800">{profile.stats?.messages ?? 0}</strong> 条
              </span>
            </div>
          </section>

          <section className={cardClass}>
            <h2 className="text-sm font-bold text-slate-800 mb-3">
              📓 日记（{diaries.length}）
            </h2>
            {diaries.length === 0 ? (
              <p className="text-xs text-slate-400">这个用户还没有写过日记</p>
            ) : (
              <div className="space-y-2 max-h-[360px] overflow-y-auto">
                {diaries.map((item) => (
                  <div key={item.id} className="border border-[#eceeec] rounded-lg p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm text-slate-800 font-medium break-all">
                          {item.title}
                        </p>
                        <p className="text-xs text-slate-400 font-mono mt-0.5">
                          #{item.id}｜{item.created_at}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="text-red-500 hover:underline text-xs shrink-0"
                        onClick={() => removeItem("diary", item.id, "这篇日记")}
                      >
                        删除
                      </button>
                    </div>
                    <p className="text-xs text-slate-600 whitespace-pre-wrap break-words mt-2">
                      {item.content}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className={cardClass}>
            <h2 className="text-sm font-bold text-slate-800 mb-3">
              💬 聊天会话（{conversations.length}）
            </h2>
            {conversations.length === 0 ? (
              <p className="text-xs text-slate-400">这个用户还没有聊过天</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-500 border-b border-[#eceeec]">
                      <th className="text-left py-2 pr-3 font-medium">ID</th>
                      <th className="text-left py-2 pr-3 font-medium">标题</th>
                      <th className="text-left py-2 pr-3 font-medium">消息数</th>
                      <th className="text-left py-2 pr-3 font-medium">创建时间</th>
                      <th className="text-left py-2 font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {conversations.map((item) => (
                      <tr key={item.id} className="border-b border-[#f2f3f1] text-slate-600">
                        <td className="py-2 pr-3 font-mono">{item.id}</td>
                        <td className="py-2 pr-3 break-all">{item.title}</td>
                        <td className="py-2 pr-3">{item.message_count}</td>
                        <td className="py-2 pr-3 font-mono whitespace-nowrap">
                          {item.created_at}
                        </td>
                        <td className="py-2 whitespace-nowrap">
                          <button
                            type="button"
                            className="text-[#5b8aa6] hover:underline mr-2"
                            onClick={() => openConversation(userId, item)}
                          >
                            查看消息
                          </button>
                          <button
                            type="button"
                            className="text-red-500 hover:underline"
                            onClick={() =>
                              removeItem("conversation", item.id, "整个会话（消息会一起删除）")
                            }
                          >
                            删除
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {activeConv ? (
              <div className="mt-4 border-t border-[#eceeec] pt-3">
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="text-xs font-bold text-slate-700">
                    会话 #{activeConv.id}「{activeConv.title}」的消息（{messages.length}）
                  </h3>
                  <button
                    type="button"
                    className="text-xs text-slate-400 hover:text-slate-700 ml-auto"
                    onClick={() => {
                      setActiveConv(null);
                      setMessages([]);
                    }}
                  >
                    收起
                  </button>
                </div>

                {messages.length === 0 ? (
                  <p className="text-xs text-slate-400">没有消息</p>
                ) : (
                  <div className="space-y-2 max-h-[420px] overflow-y-auto">
                    {messages.map((item) => (
                      <div
                        key={item.id}
                        className={`rounded-lg p-2 text-xs ${
                          item.role === "user" ? "bg-[#eef4f8]" : "bg-[#f6f6f4]"
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-mono text-slate-500">
                            #{item.id} {item.role === "user" ? "用户" : "AI"}
                          </span>
                          <span className="text-slate-400 font-mono">{item.created_at}</span>
                          <button
                            type="button"
                            className="text-red-500 hover:underline ml-auto"
                            onClick={() => removeItem("message", item.id, "这条消息")}
                          >
                            删除
                          </button>
                        </div>
                        <p className="text-slate-700 whitespace-pre-wrap break-words">
                          {item.content}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </section>
        </>
      ) : (
        <section className={cardClass}>
          <p className="text-xs text-slate-400">
            先在上面搜索并选中一个用户，就能看到他的日记和聊天记录。
          </p>
        </section>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- 登录界面 */

function LoginView({ onSuccess, setError, setNotice }) {
  const [form, setForm] = useState({ username: "", password: "", code: "" });
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await api("/api/admin/session", { method: "POST", body: form });
      setNotice("登录成功");
      await onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-center mb-1">Solace 管理后台</h1>
        <p className="text-xs text-slate-500 text-center mb-6">账号密码 + 动态验证码（验证器 App）</p>

        <form onSubmit={submit} className={`${cardClass} space-y-3`}>
          <Field label="管理员账号">
            <input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              className={inputClass}
              autoComplete="username"
              required
            />
          </Field>
          <Field label="密码">
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className={inputClass}
              autoComplete="current-password"
              required
            />
          </Field>
          <Field label="动态验证码" hint="验证器 App 上 30 秒刷新一次的 6 位数字">
            <input
              inputMode="numeric"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.replace(/\D/g, "").slice(0, 6) })}
              className={`${inputClass} tracking-[0.4em] text-center font-mono`}
              required
            />
          </Field>
          <button type="submit" className={`${btnPrimary} w-full`} disabled={loading}>
            {loading ? "验证中..." : "登录"}
          </button>
        </form>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ 初始化界面 */

function SetupView({ setup, onSuccess, onDatabaseNeeded, setError }) {
  const [form, setForm] = useState({ username: "admin", password: "", confirm: "", code: "", setupKey: "" });
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    if (form.password !== form.confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setLoading(true);
    try {
      await api("/api/admin/setup", {
        method: "POST",
        body: {
          username: form.username,
          password: form.password,
          code: form.code,
          setupKey: form.setupKey,
        },
      });
      await onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-3xl">
        <h1 className="text-2xl font-bold mb-1">初始化管理后台</h1>
        <p className="text-xs text-slate-500 mb-6">
          这是第一次进入，需要绑定一个验证器 App（微软 Authenticator / Google Authenticator / 1Password 等）。
        </p>

        {setup?.setupKeyWarning ? (
          <Alert kind="info">
            安全提示：服务器还没有设置 ADMIN_SETUP_KEY。在完成初始化之前，知道这个网址的人都可能抢先注册管理员；
            建议先在 .env.local 里设置该口令，再回来初始化。
          </Alert>
        ) : null}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <section className={cardClass}>
            <h2 className="text-sm font-bold mb-3">第一步：扫码绑定验证器</h2>
            {setup?.qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={setup.qrDataUrl} alt="TOTP 二维码" className="w-52 h-52 mx-auto border border-[#eceeec] rounded-lg" />
            ) : (
              <p className="text-xs text-slate-400">二维码加载中...</p>
            )}
            <p className="text-xs text-slate-500 mt-3">无法扫码时手动输入密钥：</p>
            <p className="text-xs font-mono break-all bg-[#f7f7f4] border border-[#eceeec] rounded p-2 mt-1">
              {setup?.secret || "-"}
            </p>
            <button
              type="button"
              className={`${btnBase} w-full mt-3`}
              onClick={() => api("/api/admin/setup?refresh=1").then((data) => onDatabaseNeeded(data)).catch((err) => setError(err.message))}
            >
              重新生成密钥
            </button>
          </section>

          <form onSubmit={submit} className={cardClass}>
            <h2 className="text-sm font-bold mb-3">第二步：设置账号</h2>
            <Field label="管理员账号">
              <input
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                className={inputClass}
                required
              />
            </Field>
            <Field label="密码" hint="至少 8 位，同时包含字母和数字">
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                className={inputClass}
                autoComplete="new-password"
                required
              />
            </Field>
            <Field label="确认密码">
              <input
                type="password"
                value={form.confirm}
                onChange={(e) => setForm({ ...form, confirm: e.target.value })}
                className={inputClass}
                autoComplete="new-password"
                required
              />
            </Field>
            {setup?.setupKeyRequired ? (
              <Field label="初始化口令（ADMIN_SETUP_KEY）">
                <input
                  type="password"
                  value={form.setupKey}
                  onChange={(e) => setForm({ ...form, setupKey: e.target.value })}
                  className={inputClass}
                  required
                />
              </Field>
            ) : null}
            <Field label="验证器上的 6 位动态码" hint="提交后本页面会直接登录后台">
              <input
                inputMode="numeric"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.replace(/\D/g, "").slice(0, 6) })}
                className={`${inputClass} tracking-[0.4em] text-center font-mono`}
                required
              />
            </Field>
            <button type="submit" className={`${btnPrimary} w-full`} disabled={loading}>
              {loading ? "创建中..." : "创建管理员并进入后台"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ 主体组件 */

export default function AdminPage() {
  const [stage, setStage] = useState("loading");
  const [setup, setSetup] = useState(null);
  const [overview, setOverview] = useState(null);
  const [settings, setSettings] = useState(null);
  const [tab, setTab] = useState("overview");
  // 从「用户管理」点「查看数据」跳过来时要看哪个用户
  const [dataUserId, setDataUserId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ttsText, setTtsText] = useState("你好，我是 Solace，今天也愿意听你说说。");
  const [ttsBusy, setTtsBusy] = useState(false);
  const [mailTo, setMailTo] = useState("");
  const [mailBusy, setMailBusy] = useState(false);

  const loadAll = useCallback(async () => {
    const [overviewData, settingsData] = await Promise.all([
      api("/api/admin/overview"),
      api("/api/admin/settings"),
    ]);
    setOverview(overviewData);
    setSettings(settingsData.settings || {});
  }, []);

  const bootstrap = useCallback(async () => {
    setError("");
    try {
      const session = await api("/api/admin/session");
      if (!session.dbReady) {
        setStage("database");
        return;
      }
      if (session.needsSetup) {
        const setupData = await api("/api/admin/setup");
        if (!setupData.dbReady) {
          setStage("database");
          return;
        }
        setSetup(setupData);
        setStage("setup");
        return;
      }
      if (session.authenticated) {
        await loadAll();
        setStage("panel");
        return;
      }
      setStage("login");
    } catch (err) {
      setError(err.message);
      setStage("login");
    }
  }, [loadAll]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  async function handleLogout() {
    try {
      await api("/api/admin/session", { method: "DELETE" });
    } catch {
      /* 忽略 */
    }
    setOverview(null);
    setSettings(null);
    setStage("login");
  }

  async function previewTts() {
    setTtsBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await api("/api/admin/tts/test", { method: "POST", body: { text: ttsText } });
      const audio = new Audio(data.audio);
      await audio.play();
      setNotice(`语音试听成功（约 ${Math.round((data.bytes || 0) / 1024)} KB）`);
    } catch (err) {
      setError(err.message);
    } finally {
      setTtsBusy(false);
    }
  }

  async function sendTestMail() {
    setMailBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await api("/api/admin/mail/test", { method: "POST", body: { to: mailTo } });
      setNotice(data.message || "测试邮件已发送");
    } catch (err) {
      setError(err.message);
    } finally {
      setMailBusy(false);
    }
  }

  if (stage === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-sm text-slate-500">正在加载...</p>
      </div>
    );
  }

  if (stage === "database") {
    return (
      <div className="min-h-screen px-4 py-10">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-2xl font-bold mb-1">配置数据库连接</h1>
          <p className="text-xs text-slate-500 mb-6">
            后台的所有配置都存在 MySQL 里，所以先把数据库连上。数据库还没建的话，
            请先在宝塔面板创建数据库并导入 <code>db/schema.sql</code>。
          </p>
          {error ? <Alert kind="error">{error}</Alert> : null}
          {notice ? <Alert kind="success">{notice}</Alert> : null}
          <DatabasePanel
            bootstrap
            setError={setError}
            setNotice={setNotice}
            onChanged={async () => {
              await bootstrap();
            }}
          />
        </div>
      </div>
    );
  }

  if (stage === "setup") {
    return (
      <SetupView
        setup={setup}
        setError={setError}
        onSuccess={async () => {
          setNotice("初始化完成");
          await bootstrap();
        }}
        onDatabaseNeeded={(data) => setSetup(data)}
      />
    );
  }

  if (stage === "login") {
    return (
      <div className="min-h-screen px-4 py-6">
        {error ? (
          <div className="max-w-sm mx-auto">
            <Alert kind="error">{error}</Alert>
          </div>
        ) : null}
        <LoginView
          setError={setError}
          setNotice={setNotice}
          onSuccess={async () => {
            await bootstrap();
          }}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-[#e8eae7] bg-white">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <span className="font-bold text-slate-800">Solace 管理后台</span>
          <span className="text-xs text-slate-400">
            {overview?.admin?.username ? `已登录：${overview.admin.username}` : ""}
          </span>
          <button type="button" className={`${btnBase} ml-auto`} onClick={handleLogout}>
            退出登录
          </button>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-4">
        <div className="flex flex-wrap gap-2 mb-4">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setTab(item.id);
                setError("");
                setNotice("");
              }}
              className={
                tab === item.id
                  ? "px-3 py-1.5 text-sm rounded-lg bg-[#e3edf2] text-slate-900 font-bold"
                  : "px-3 py-1.5 text-sm rounded-lg text-slate-500 hover:bg-[#eef1f2]"
              }
            >
              {item.label}
            </button>
          ))}
        </div>

        {error ? <Alert kind="error">{error}</Alert> : null}
        {notice ? <Alert kind="success">{notice}</Alert> : null}

        {tab === "overview" ? (
          <OverviewPanel overview={overview} onReload={() => loadAll().catch((err) => setError(err.message))} />
        ) : null}

        {tab === "database" ? (
          <DatabasePanel
            setError={setError}
            setNotice={setNotice}
            onChanged={() => loadAll()}
          />
        ) : null}

        {tab === "ai" ? (
          <SettingsGroup
            group="ai"
            title="对话 AI"
            description="聊天接口使用这里配置的服务商。baseUrl 只写到版本目录，程序自动拼 /chat/completions。"
            settings={settings}
            setError={setError}
            setNotice={setNotice}
            onSaved={loadAll}
          />
        ) : null}

        {tab === "tts" ? (
          <SettingsGroup
            group="tts"
            title="语音 TTS"
            description="按 OpenAI 兼容格式请求 {baseUrl}/audio/speech，返回音频二进制。"
            settings={settings}
            setError={setError}
            setNotice={setNotice}
            onSaved={loadAll}
          >
            <div className="border-t border-[#eceeec] pt-3 mt-1">
              <p className="text-xs text-slate-500 mb-2">试听（使用上面保存后的配置）</p>
              <div className="flex gap-2">
                <input
                  value={ttsText}
                  onChange={(e) => setTtsText(e.target.value)}
                  className={inputClass}
                  placeholder="输入一段要合成的文字"
                />
                <button type="button" className={`${btnBase} shrink-0`} disabled={ttsBusy} onClick={previewTts}>
                  {ttsBusy ? "合成中..." : "试听"}
                </button>
              </div>
            </div>
          </SettingsGroup>
        ) : null}

        {tab === "mail" ? (
          <>
            <Alert kind="info">
              {"网易邮箱配置要点：登录 163/126 邮箱 → 设置 → POP3/SMTP/IMAP → 开启 SMTP 服务 → 获取「授权码」；\n" +
                "「SMTP 授权码」填授权码而不是登录密码；端口 465 勾选 SSL；发件人邮箱必须和发信邮箱一致。"}
            </Alert>
            <SettingsGroup
              group="smtp"
              title="发信邮箱（SMTP）"
              description="用于发送登录验证码邮件，本轮可先用它给管理员发测试邮件。"
              settings={settings}
              setError={setError}
              setNotice={setNotice}
              onSaved={loadAll}
            >
              <div className="border-t border-[#eceeec] pt-3 mt-1">
                <p className="text-xs text-slate-500 mb-2">发送测试邮件（需要先保存上面的配置）</p>
                <div className="flex gap-2">
                  <input
                    value={mailTo}
                    onChange={(e) => setMailTo(e.target.value)}
                    className={inputClass}
                    placeholder="收件邮箱，例如 you@example.com"
                  />
                  <button type="button" className={`${btnBase} shrink-0`} disabled={mailBusy} onClick={sendTestMail}>
                    {mailBusy ? "发送中..." : "发送测试邮件"}
                  </button>
                </div>
              </div>
            </SettingsGroup>

            <SettingsGroup
              group="login"
              title="邮箱验证码规则"
              description="下一轮用户端「邮箱验证码登录」会直接使用这里的规则。"
              settings={settings}
              setError={setError}
              setNotice={setNotice}
              onSaved={loadAll}
            />
          </>
        ) : null}

        {tab === "site" ? (
          <SettingsGroup
            group="site"
            title="站点信息"
            description="站点名称会出现在验证码邮件里。"
            settings={settings}
            setError={setError}
            setNotice={setNotice}
            onSaved={loadAll}
          />
        ) : null}

        {tab === "users" ? (
          <UsersPanel
            setError={setError}
            setNotice={setNotice}
            onViewData={(userId) => {
              setDataUserId(userId);
              setTab("userdata");
              setError("");
              setNotice("");
            }}
          />
        ) : null}

        {tab === "userdata" ? (
          <UserDataPanel
            initialUserId={dataUserId}
            setError={setError}
            setNotice={setNotice}
          />
        ) : null}

        {tab === "logs" ? <LogsPanel /> : null}
      </div>
    </div>
  );
}
