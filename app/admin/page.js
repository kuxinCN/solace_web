"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ContentReviewPanel from "@/components/ContentReviewPanel";

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
    {
      key: "baseUrl",
      label: "接口地址（OpenAI 协议）",
      type: "text",
      hint: "填到版本目录即可（如 https://api.xiaomimimo.com/v1），也支持直接粘官方文档给的完整地址（…/v1/chat/completions），程序会自动识别。例：智谱 https://open.bigmodel.cn/api/paas/v4 ｜ DeepSeek https://api.deepseek.com/v1 ｜ OpenAI https://api.openai.com/v1",
    },
    {
      key: "apiKey",
      label: "API Key（OpenAI 协议）",
      type: "secret",
      hint: "⚠️ 这里填的必须是「OpenAI 兼容协议」的 Key：智谱、DeepSeek、通义、Moonshot、OpenAI 官方等都支持。不是 OpenAI 协议的厂商（接口路径/请求体格式不同）直接填这里会报错",
    },
    {
      key: "model",
      label: "模型名",
      type: "datalist",
      optionsKey: "aiModels",
      hint: "可以点下方「拉取可用模型」自动获取后选择，也可以直接手动输入。例：glm-4-flash、deepseek-chat、gpt-4o-mini",
    },
    { key: "temperature", label: "温度（0-2）", type: "number", step: "0.1" },
    { key: "maxTokens", label: "最大回复长度", type: "number" },
    { key: "timeoutSeconds", label: "超时（秒）", type: "number" },
    { key: "provider", label: "服务商备注", type: "text", hint: "仅作记录，不影响调用" },
    {
      key: "systemPrompt",
      label: "AI 提示词（默认人设）",
      type: "textarea",
      rows: 12,
      hint: "用户还没选择人格时用这一份。保存后立即生效，不用重启服务。留空则使用前端自带的提示词。",
    },
    {
      key: "systemPromptMale",
      label: "AI 提示词（男性人格）",
      type: "textarea",
      rows: 12,
      hint: "用户在「我的 → 设置」或聊天输入框旁选「他」时用这份。留空则回退到默认人设。",
    },
    {
      key: "systemPromptFemale",
      label: "AI 提示词（女性人格）",
      type: "textarea",
      rows: 12,
      hint: "用户选「她」时用这份。留空则回退到默认人设。",
    },
    {
      key: "diaryPrompt",
      label: "读日记时的附加提示词",
      type: "textarea",
      rows: 4,
      hint: "用户写完日记后，这段文字会和日记正文一起发给 AI。用 {diary} 表示日记正文的位置。",
    },
  ],
  music: [
    { key: "enabled", label: "启用背景音乐", type: "boolean", hint: "关闭后用户端不显示播放器" },
    {
      key: "source",
      label: "当前音源",
      type: "select",
      options: [
        { value: "local", label: "本地歌单（本地上传 + 外链直链，支持自动播放与切歌）" },
        { value: "netease", label: "网易云收藏（官方外链播放器，不能自动播放/切歌）" },
      ],
      hint: "随时可在两者间切换；两种歌单可以同时维护，切过去即可生效",
    },
    {
      key: "autoPlay",
      label: "首次交互后自动播放",
      type: "boolean",
      hint: "浏览器禁止页面一加载就出声，所以实际行为是「用户第一次点击后」开始播",
    },
    { key: "defaultVolume", label: "默认音量（0-1）", type: "number", step: "0.1" },
    {
      key: "autoFallback",
      label: "网易云访问不了时自动降级到本地歌单",
      type: "boolean",
      hint: "音源选「网易云收藏」时，前端会先探测用户能否访问 music.163.com；访问不了就自动切回本地歌单，避免浮窗一片空白",
    },
  ],
  safety: [
    {
      key: "enabled",
      label: "启用内容安全过滤",
      type: "boolean",
      hint: "关闭后所有内容都会原样发给 AI（不建议关闭）",
    },
    {
      key: "extraSelfHarm",
      label: "自伤倾向 · 自定义词",
      type: "textarea",
      rows: 5,
      hint: "一行一个词，命中后返回温和承接 + 心理援助热线。以 # 开头的行当注释忽略。内置规则始终生效，这里只做补充。",
    },
    {
      key: "extraViolence",
      label: "伤害他人 · 自定义词",
      type: "textarea",
      rows: 4,
      hint: "一行一个词。内置规则始终生效，这里只做补充。",
    },
    {
      key: "extraIllegal",
      label: "违法行为 · 自定义词",
      type: "textarea",
      rows: 4,
      hint: "一行一个词。内置规则始终生效，这里只做补充。",
    },
  ],
  tts: [
    { key: "enabled", label: "启用语音合成", type: "boolean" },
    {
      key: "provider",
      label: "接口类型",
      type: "select",
      options: [
        { value: "openai-compatible", label: "OpenAI 兼容（POST /audio/speech，接口直接返回音频）" },
        { value: "mimo-chat", label: "小米 MiMo（POST /chat/completions，音频是 base64）" },
      ],
      hint: "不同服务商的接口格式不一样，选错了会报 400 / Invalid request",
    },
    {
      key: "baseUrl",
      label: "接口地址",
      type: "text",
      hint: "两种填法都行：只填 https://api.xiaomimimo.com/v1 ，或直接粘官方文档里的完整地址 https://api.xiaomimimo.com/v1/chat/completions 。注意别填成文档网页地址（mimo.mi.com/docs/...）。OpenAI 系填 https://api.openai.com/v1",
    },
    { key: "apiKey", label: "API Key", type: "secret", hint: "小米 MiMo 走 api-key 请求头、其他走 Bearer，程序会按接口类型自动处理" },
    { key: "model", label: "模型名", type: "text", hint: "小米 MiMo 填 mimo-v2.5-tts ；OpenAI 系填 tts-1 之类" },
    {
      key: "voice",
      label: "默认音色",
      type: "text",
      hint: "小米 MiMo：mimo_default / 冰糖 / 茉莉 / 苏打 / 白桦 / Mia / Chloe / Milo / Dean ；OpenAI：alloy 等",
    },
    { key: "speed", label: "语速（0.5-2）", type: "number", step: "0.1", hint: "仅 OpenAI 兼容接口支持，小米 MiMo 接口会忽略它" },
    { key: "format", label: "音频格式", type: "text", hint: "常用 mp3 ；小米 MiMo 支持 wav / mp3 / pcm" },
    {
      key: "stylePrompt",
      label: "朗读风格指令（仅小米 MiMo 生效）",
      type: "textarea",
      rows: 3,
      hint: "用自然语言描述想要的语气，会作为 user 消息发给 MiMo（例如：用温柔、缓慢、轻声细语的语调朗读）。留空则不发送；OpenAI 兼容协议会忽略这项。",
    },
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
  review: [
    {
      key: "enabled",
      label: "启用数据审核",
      type: "boolean",
      hint: "关闭后不再自动审核用户上传的头像 / 背景 / 昵称 / 签名（已经攒下的待审内容会留在队列里）",
    },
    { key: "provider", label: "服务商备注", type: "text", hint: "仅作记录，不影响调用" },
    {
      key: "baseUrl",
      label: "接口地址（逐条 / 对话）",
      type: "text",
      hint: "小米 MiMo 填 https://api.xiaomimimo.com/v1。测试连接、拉取模型、逐条审核都走这个地址",
    },
    {
      key: "batchBaseUrl",
      label: "批量推理接口地址",
      type: "text",
      hint: "⚠️ 批量推理用独立域名，和上面那个不是一回事：形如 https://batch-api-{region}.xiaomimimo.com/v1，要去小米控制台的「批量推理」页面获取。留空则批量提交会失败并自动降级为逐条模式（功能正常，但拿不到五折价和闲时调度）",
    },
    {
      key: "apiKey",
      label: "API Key",
      type: "secret",
      hint: "要求和对话 AI 一样。程序会对小米域名同时发送 Authorization: Bearer 和 api-key 两个头（小米两处文档写法不同，两个都发最稳）",
    },
    {
      key: "model",
      label: "模型名",
      type: "datalist",
      optionsKey: "reviewModels",
      hint: "例如 mimo-v2.6-flash；点右侧箭头看候选，也可以直接手输",
    },
    {
      key: "mode",
      label: "审核方式",
      type: "select",
      options: [
        { value: "batch", label: "批量推理（一次提交一批，结果延迟返回，需要轮询领取）" },
        { value: "inline", label: "逐条调用（立刻出结果，一条一条来）" },
      ],
      hint: "选批量推理时，如果上游接口和 OpenAI Batch 协议不一致导致提交失败，会自动降级为逐条（可在下面关掉）",
    },
    {
      key: "completionWindow",
      label: "最长等待时间",
      type: "text",
      hint: "⚠️ 实测结论：**接口只认 24h**。填 168h（7 天）这类值，服务端会直接返回 HTTP 500 internal_error —— 文档里「控制台可设 1-14 天」那句只对控制台页面有效。程序会自动退回 24h 重试，所以填错也不会挂，但**建议就保持 24h**",
    },
    {
      key: "autoSubmit",
      label: "自动定时提交",
      type: "boolean",
      hint: "开着的话，应用会自己按下面的间隔「收结果 + 交新任务」—— 你完全不用点「立即提交」（手动点还要等它跑完，界面会卡一会儿）。保存即生效，不用重启",
    },
    {
      key: "submitIntervalMinutes",
      label: "自动提交间隔（分钟，1-1440）",
      type: "number",
      hint: "默认 10 分钟。批量推理本身就是延迟返回的，间隔太短没意义；太长又会让违规内容多挂一会儿",
    },
    {
      key: "autoFallback",
      label: "批量不可用时自动降级为逐条",
      type: "boolean",
      hint: "建议开着：否则批量接口一旦不兼容，审核就完全停住了",
    },
    {
      key: "reviewImages",
      label: "连图片一起送审",
      type: "boolean",
      hint: "关掉后头像 / 背景完全不送 AI，只进后台人工队列（昵称和签名始终会送审）",
    },
    {
      key: "imageHandling",
      label: "图片任务怎么处理",
      type: "select",
      options: [
        { value: "manual", label: "进后台人工队列（不花 AI 额度，推荐）" },
        { value: "inline", label: "用「逐条调用」单独审（会花钱，但能自动处理）" },
      ],
      hint: "⚠️ 图片**不能进批量推理** —— 多模态消息体会让整个批次在创建阶段就失败（HTTP 500），一条图片就能拖垮整批。所以批量模式下图片只能二选一：走人工，或用逐条单独审。⚠️ 如果「审核方式」选的是「逐条调用」，这个设置不起作用（那时图片跟文本一起走逐条）",
    },
    { key: "maxItemsPerBatch", label: "每次最多提交条数（1-100）", type: "number" },
    { key: "timeoutSeconds", label: "逐条模式超时（秒）", type: "number" },
    {
      key: "keepDays",
      label: "审核记录保留天数",
      type: "number",
      hint: "超过这个天数的审核记录会被定时清理脚本删掉",
    },
    {
      key: "reviewPrompt",
      label: "审核提示词",
      type: "textarea",
      rows: 16,
      hint: '发给审核 AI 的系统提示词。必须要求它只输出 JSON：{"verdict":"pass|reject","reason":"理由"}。⚠️ AI 返回读不懂时会标成「失败·待人工」，不会自动放过',
    },
    {
      key: "customBlocklist",
      label: "自定义违禁词（本地预检）",
      type: "textarea",
      rows: 5,
      hint: "一行一个词，# 开头当注释。命中的内容**不走 AI、直接判违规并把资料改回默认值**。内置词表已经覆盖常见脏话的中文写法、谐音、拼音缩写（如草泥马 / tm / sb / 废物），这里只补充你遇到的漏网之词。⚠️ 只放没有歧义的词（像「滚」既可能骂人也可能是亲昵说法，别放）",
    },
    { key: "defaultNickname", label: "默认昵称", type: "text", hint: "昵称被判违规后改回这个" },
    { key: "defaultBio", label: "默认签名", type: "text", hint: "留空 = 违规后清空签名" },
    { key: "defaultAvatar", label: "默认头像", type: "image", hint: "留空则用前端自带的默认头像" },
    { key: "defaultAiAvatar", label: "默认 AI 头像", type: "image" },
    { key: "defaultChatBackground", label: "默认聊天背景", type: "image" },
    { key: "defaultDiaryBackground", label: "默认「我的」页背景", type: "image" },
  ],
};

const TABS = [
  { id: "overview", label: "概览" },
  { id: "database", label: "数据库" },
  { id: "ai", label: "对话 AI" },
  { id: "tts", label: "语音 TTS" },
  { id: "safety", label: "内容安全" },
  { id: "review", label: "数据审核" },
  { id: "music", label: "背景音乐" },
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

/** 默认值图片预览：只接受真正的位图 data URL（挡掉 svg 这类可能带脚本的类型） */
function safeImagePreview(value) {
  const text = String(value || "");
  return /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(text) ? text : "";
}

/**
 * 把选的图片读成 data URL，并先缩到 maxSize 以内。
 *
 * 为什么必须缩：默认值会整段存进 settings 表，原图几 MB 会把它撑爆；
 * 缩到 512px 之后 base64 一般只有几十 KB，和用户端上传的头像同一个量级。
 */
function readImageAsDataUrl(file, maxSize = 512) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("这不是有效的图片文件"));
      img.onload = () => {
        try {
          const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
          const width = Math.max(1, Math.round(img.width * scale));
          const height = Math.max(1, Math.round(img.height * scale));

          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, width, height);

          // 优先 WebP（同画质体积小约 30%），浏览器不支持时退回 JPEG
          let out = canvas.toDataURL("image/webp", 0.85);
          if (!out.startsWith("data:image/webp")) out = canvas.toDataURL("image/jpeg", 0.85);
          resolve(out);
        } catch (err) {
          reject(new Error(err?.message || "处理图片失败"));
        }
      };
      img.src = String(reader.result || "");
    };
    reader.readAsDataURL(file);
  });
}

/**
 * 可输入 + 可下拉选择的输入框（用来替代原生 datalist）
 *
 * ⚠️ 为什么不用 `<input list>`：
 *   原生 datalist 有个硬伤 —— **输入框里已经有内容时，点箭头只会拿当前值去筛选**，
 *   匹配不到就是一片空白，用户会以为"没有可用模型"。
 *   这里自己实现：点箭头**永远列出全部候选**，输入时才按关键字过滤。
 *
 * 右侧两个控件（只在模型名字段出现）：
 *   [拉取模型] [▼]
 *   箭头在拉取按钮的右边，用细线 SVG 画，不用原生那种粗糙的下拉箭头。
 */
function ComboField({
  value,
  onChange,
  placeholder,
  inputClass,
  options = [],
  onFetch,
  fetching = false,
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  // 点空白处收起
  useEffect(() => {
    if (!open) return;
    const away = (event) => {
      if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  // 点箭头时列全部；输入之后按关键字过滤（大小写不敏感，匹配子串）
  const keyword = String(value || "").trim().toLowerCase();
  const list = keyword
    ? options.filter((item) => String(item).toLowerCase().includes(keyword))
    : options;

  return (
    <div className="relative" ref={boxRef}>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value);
          if (!open && options.length) setOpen(true);
        }}
        onFocus={() => {
          if (options.length) setOpen(true);
        }}
        className={`${inputClass} ${onFetch ? "pr-[124px]" : "pr-9"}`}
      />

      <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
        {onFetch ? (
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              onFetch();
            }}
            disabled={fetching}
            className="rounded-md border border-[#d5d9d7] bg-white px-2 py-0.5 text-[11px] text-slate-600 transition-colors hover:bg-[#f2f5f4] disabled:opacity-50"
            title="从接口拉取可用模型列表"
          >
            {fetching ? "拉取中…" : "拉取模型"}
          </button>
        ) : null}

        <button
          type="button"
          tabIndex={-1}
          onClick={() => setOpen((prev) => !prev)}
          disabled={!options.length}
          className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-[#f2f5f4] hover:text-slate-600 disabled:opacity-40"
          title={options.length ? "展开候选列表" : "还没有候选，先点「拉取模型」"}
        >
          <svg
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
          >
            <path d="M3 4.5L6 7.5L9 4.5" />
          </svg>
        </button>
      </div>

      {open && list.length ? (
        <ul className="absolute left-0 right-0 z-30 mt-1 max-h-56 overflow-y-auto rounded-lg border border-[#e6e8e6] bg-white py-1 shadow-xl">
          {list.slice(0, 200).map((item) => (
            <li key={item}>
              <button
                type="button"
                onClick={() => {
                  onChange(item);
                  setOpen(false);
                }}
                className={`block w-full truncate px-3 py-1.5 text-left text-xs transition-colors hover:bg-[#f2f5f4] ${
                  String(item) === String(value) ? "bg-[#e8eff2] text-slate-800" : "text-slate-600"
                }`}
              >
                {item}
              </button>
            </li>
          ))}
          {list.length < options.length ? (
            <li className="px-3 py-1.5 text-[11px] text-slate-400">
              共 {options.length} 个，已按输入过滤；清空输入可看全部
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function SettingsGroup({
  group,
  title,
  description,
  settings,
  onSaved,
  setError,
  setNotice,
  // 动态候选项：形如 { aiModels: ["glm-4-flash", ...] }，给 type: "datalist" 的字段用
  fieldOptions = {},
  // 「拉取可用模型」按钮：只有模型名字段用得到，按钮内嵌在输入框右侧
  onFetchModels,
  modelsBusy = false,
  children,
}) {
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

          // 默认值里的图片（头像 / 背景）：选一张 → 在浏览器里缩到 512px 并转成 data URL 存进配置。
          // 为什么存 data URL 而不是上传成文件：默认值是「用户违规后回填」用的，
          // 存成和用户上传完全相同的格式，处置时直接写库即可，少一次文件读写和清理。
          if (field.type === "image") {
            const preview = safeImagePreview(textValue(field.key));
            return (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <div className="flex items-center gap-2">
                  <label className="inline-flex h-[34px] cursor-pointer items-center rounded-lg border border-[#d5d9d7] bg-white px-3 text-xs text-slate-600 transition-colors hover:bg-[#f2f5f4]">
                    选择图片
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      className="hidden"
                      onChange={async (event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (!file) return;
                        setError("");
                        try {
                          const dataUrl = await readImageAsDataUrl(file, 512);
                          setValue(field.key, dataUrl);
                        } catch (err) {
                          setError(`读取图片失败：${err.message}`);
                        }
                      }}
                    />
                  </label>

                  {preview ? (
                    <>
                      <img
                        src={preview}
                        alt=""
                        className="h-[34px] w-[34px] rounded-md border border-[#e8eae7] object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => setValue(field.key, "")}
                        className="text-xs text-red-500 transition-colors hover:text-red-700"
                      >
                        清除
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-slate-400">未设置（用前端自带的默认）</span>
                  )}
                </div>
              </Field>
            );
          }

          if (field.type === "select") {
            return (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <select
                  value={textValue(field.key)}
                  onChange={(e) => setValue(field.key, e.target.value)}
                  className={inputClass}
                >
                  {(field.options || []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
            );
          }

          // 可输入 + 可下拉：点箭头**永远列出全部候选**
          // （原生 datalist 在输入框有内容时只会筛选，匹配不到就是空列表，用户会以为"没有模型"）
          if (field.type === "datalist") {
            const options = fieldOptions[field.optionsKey] || [];
            const isModelField = field.key === "model" && typeof onFetchModels === "function";
            return (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <ComboField
                  value={textValue(field.key)}
                  onChange={(next) => setValue(field.key, next)}
                  placeholder={field.hint || ""}
                  inputClass={inputClass}
                  options={options}
                  onFetch={isModelField ? onFetchModels : undefined}
                  fetching={isModelField ? modelsBusy : false}
                />
                {options.length ? (
                  <span className="block text-xs text-slate-400 mt-1">
                    已拉取 {options.length} 个候选：点右侧箭头看全部，也可以直接手输
                  </span>
                ) : null}
              </Field>
            );
          }

          if (field.type === "textarea") {
            return (
              <div key={field.key} className="md:col-span-2">
                <Field label={field.label} hint={field.hint}>
                  <textarea
                    rows={field.rows || 3}
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

/* ------------------------------------------------------------ 数据看板 */

/** 极简柱状图：不引入图表库，用 div 高度实现，够用且零依赖 */
function MiniBarChart({ title, series, unit = "" }) {
  const max = Math.max(1, ...series.map((item) => item.count));
  const first = series[0]?.date?.slice(5) || "";
  const last = series[series.length - 1]?.date?.slice(5) || "";

  return (
    <div>
      <div className="flex items-end justify-between mb-2">
        <h3 className="text-xs font-bold text-slate-700">{title}</h3>
        <span className="text-xs text-slate-400">峰值 {max}{unit}</span>
      </div>
      <div className="flex items-end gap-1 h-24">
        {series.map((item) => {
          const height = Math.max(2, Math.round((item.count / max) * 100));
          return (
            <div
              key={item.date}
              className="flex-1 h-full flex flex-col items-center justify-end"
              title={`${item.date}：${item.count}${unit}`}
            >
              <div
                className="w-full bg-[#8fb3c7] rounded-t transition-all"
                style={{ height: `${height}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-xs text-slate-400 mt-1">
        <span>{first}</span>
        <span>{last}</span>
      </div>
    </div>
  );
}

const DASHBOARD_DAYS = [7, 14, 30];

function DashboardPanel() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setError("");
      const result = await api(`/api/admin/dashboard?days=${days}`);
      setData(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <section className={cardClass}>
        <p className="text-sm text-red-600">统计数据读取失败：{error}</p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className={cardClass}>
        <Alert kind="info">正在统计数据...</Alert>
      </section>
    );
  }

  const cards = [
    {
      label: "用户总数",
      value: data.totals.users,
      sub: `今日新增 +${data.today.newUsers}`,
    },
    {
      label: "对话总数",
      value: data.totals.conversations,
      sub: `近 ${data.days} 天活跃 ${data.activeUsers} 人`,
    },
    {
      label: "消息总数",
      value: data.totals.messages,
      sub: `今日新增 +${data.today.newMessages}`,
    },
    {
      label: "日记总数",
      value: data.totals.diaries,
      sub: `今日新增 +${data.today.newDiaries}`,
    },
  ];

  const moodTotal = data.moodDistribution.reduce((sum, item) => sum + item.count, 0);

  return (
    <section className={cardClass}>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 className="text-sm font-bold text-slate-800">数据看板</h2>
        <div className="flex items-center gap-2">
          {DASHBOARD_DAYS.map((item) => (
            <button
              key={item}
              type="button"
              className={`px-2 py-1 text-xs rounded border transition-colors ${
                days === item
                  ? "border-[#8fb3c7] bg-[#e8eff2] text-slate-800 font-medium"
                  : "border-[#d5d9d7] text-slate-500 hover:bg-[#f2f5f4]"
              }`}
              onClick={() => setDays(item)}
            >
              近 {item} 天
            </button>
          ))}
          <button type="button" className={btnBase} onClick={load} disabled={loading}>
            {loading ? "刷新中" : "刷新"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {cards.map((card) => (
          <div key={card.label} className="border border-[#e6e8e6] rounded-lg p-3">
            <div className="text-xs text-slate-500">{card.label}</div>
            <div className="text-2xl font-bold text-slate-800 my-1">{card.value}</div>
            <div className="text-xs text-slate-400">{card.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div className="border border-[#e6e8e6] rounded-lg p-3">
          <MiniBarChart title="消息量趋势" series={data.messageTrend} unit=" 条" />
        </div>
        <div className="border border-[#e6e8e6] rounded-lg p-3">
          <MiniBarChart title="新增用户趋势" series={data.userTrend} unit=" 人" />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="border border-[#e6e8e6] rounded-lg p-3">
          <h3 className="text-xs font-bold text-slate-700 mb-2">
            日记情绪分布（近 {data.days} 天）
          </h3>
          {moodTotal === 0 ? (
            <p className="text-xs text-slate-400">这段时间还没有带标签的日记</p>
          ) : (
            <ul className="space-y-2">
              {data.moodDistribution.map((item) => (
                <li key={item.mood} className="text-xs">
                  <div className="flex justify-between text-slate-600 mb-1">
                    <span>{item.mood}</span>
                    <span className="text-slate-400">{item.count} 篇</span>
                  </div>
                  <div className="h-2 bg-[#eef1ef] rounded overflow-hidden">
                    <div
                      className="h-full bg-[#a8c4d4]"
                      style={{ width: `${Math.round((item.count / moodTotal) * 100)}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-slate-400 mt-2">
            仅作整体观察用，不做个体评判
          </p>
        </div>

        <div className="border border-[#e6e8e6] rounded-lg p-3">
          <h3 className="text-xs font-bold text-slate-700 mb-2">
            活跃用户 Top 5（近 {data.days} 天，邮箱已掩码）
          </h3>
          {data.topUsers.length === 0 ? (
            <p className="text-xs text-slate-400">这段时间还没有活跃用户</p>
          ) : (
            <ol className="space-y-2 text-xs text-slate-600">
              {data.topUsers.map((item, index) => (
                <li key={item.id} className="flex justify-between gap-2">
                  <span className="truncate">
                    <span className="text-slate-400 mr-1">{index + 1}.</span>
                    {item.username || item.email}
                  </span>
                  <span className="text-slate-400 shrink-0">{item.messageCount} 条</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      {/* 运行指标：接口耗时 + AI 用量 + 内容安全命中 */}
      <MetricsBlock />
    </section>
  );
}

/** 后台歌单管理：本地上传 / 外链直链 / 网易云 */
function MusicTracksPanel({ setError, setNotice }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState("");
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [source, setSource] = useState("url");
  const [url, setUrl] = useState("");
  const [neteaseId, setNeteaseId] = useState("");
  const [neteaseType, setNeteaseType] = useState("2");
  // 管理员备注：只在后台显示，用户端拿不到
  const [adminNote, setAdminNote] = useState("");
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await api("/api/admin/music");
      setData(res);
    } catch (err) {
      setError(err.message);
    }
  }, [setError]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 「取名称」：请求网易云**公开网页**读取歌名 / 歌单名，自动填进输入框。
   * 网易云官方没有开放"按 ID 取名称"的接口，所以这里只读网页标题；
   * 拿不到就让管理员手填 —— 不重试、不伪造。
   */
  async function fetchNeteaseName() {
    setBusy("fetchName");
    setError("");
    setNotice("");
    try {
      const result = await api(
        `/api/admin/music/netease-info?id=${encodeURIComponent(neteaseId)}&type=${neteaseType}`
      );
      if (!result?.ok) throw new Error(result?.error || "取不到名称");
      if (result.title) setTitle(result.title);
      if (result.artist) setArtist(result.artist);
      setNotice(`已读取到：${result.raw || result.title}`);
    } catch (err) {
      setError("取名称失败：" + err.message + "（可以手动填写）");
    } finally {
      setBusy("");
    }
  }

  /** 导入音乐包：选一个 JSON 文件，上传后新增歌单与音频 */
  async function handleImport(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!window.confirm("导入会新增歌单与音频文件。继续？")) {
      event.target.value = "";
      return;
    }
    setBusy("import");
    setError("");
    setNotice("");
    try {
      const text = await file.text();
      const pack = JSON.parse(text);
      const res = await fetch("/api/admin/music/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pack),
      });
      const result = await res.json().catch(() => null);
      if (!res.ok) throw new Error(result?.error || `导入失败（HTTP ${res.status}）`);
      setNotice(
        `导入完成：新增歌曲 ${result.addedTracks} 首、音频 ${result.addedFiles} 个` +
          (result.skippedTracks ? `，跳过 ${result.skippedTracks} 条` : "")
      );
      await load();
    } catch (err) {
      setError("导入失败：" + err.message);
    } finally {
      setBusy("");
      event.target.value = "";
    }
  }

  async function handleUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy("upload");
    setError("");
    setNotice("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("title", title || file.name.replace(/\.[^.]+$/, ""));
      fd.append("artist", artist || "");
      const res = await fetch("/api/admin/music/upload", { method: "POST", body: fd });
      const result = await res.json().catch(() => null);
      if (!res.ok) throw new Error(result?.error || `上传失败（HTTP ${res.status}）`);
      setNotice(`已上传：${result.title}（${Math.round((result.bytes || 0) / 1024)}KB）`);
      setTitle("");
      setArtist("");
      await load();
    } catch (err) {
      setError("上传失败：" + err.message);
    } finally {
      setBusy("");
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleAdd() {
    setBusy("add");
    setError("");
    setNotice("");
    try {
      await api("/api/admin/music", {
        method: "POST",
        body: { source, title, artist, url, neteaseId, neteaseType, adminNote },
      });
      setNotice(source === "netease" ? "已添加网易云歌曲" : "已添加外链歌曲");
      setTitle("");
      setArtist("");
      setUrl("");
      setNeteaseId("");
      setAdminNote("");
      await load();
    } catch (err) {
      setError("添加失败：" + err.message);
    } finally {
      setBusy("");
    }
  }

  async function handleRemove(track) {
    if (!window.confirm(`删除「${track.title}」？${track.source === "local" ? "本地文件也会一起删掉。" : ""}`)) {
      return;
    }
    setBusy(`del-${track.id}`);
    try {
      await api(`/api/admin/music?id=${encodeURIComponent(track.id)}`, { method: "DELETE" });
      setNotice("已删除");
      await load();
    } catch (err) {
      setError("删除失败：" + err.message);
    } finally {
      setBusy("");
    }
  }

  async function handleToggle(track) {
    setBusy(`toggle-${track.id}`);
    try {
      await api("/api/admin/music", {
        method: "PATCH",
        body: { id: track.id, enabled: Number(track.enabled) !== 1 },
      });
      await load();
    } catch (err) {
      setError("操作失败：" + err.message);
    } finally {
      setBusy("");
    }
  }

  async function handleMove(track, delta) {
    const next = Number(track.sort_order || 0) + delta;
    setBusy(`move-${track.id}`);
    try {
      await api("/api/admin/music", { method: "PATCH", body: { id: track.id, sortOrder: next } });
      await load();
    } catch (err) {
      setError("调整顺序失败：" + err.message);
    } finally {
      setBusy("");
    }
  }

  const tracks = data?.tracks || [];
  const disk = data?.disk || { count: 0, mb: 0 };
  const isNetease = source === "netease";

  return (
    <section className={`${cardClass} mb-4`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <h2 className="text-sm font-bold text-slate-800">歌单管理</h2>
          <p className="text-xs text-slate-500 mt-1">
            本地文件存在 public/music/，共 {disk.count} 个文件 · 约 {disk.mb} MB
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnBase} onClick={load}>
            刷新
          </button>
          <button
            type="button"
            className={btnBase}
            onClick={() => window.open("/api/admin/music/export", "_blank")}
            title="把歌单与全部音频导出成一个 JSON 文件（换服务器/备份用）"
          >
            导出音乐包
          </button>
          <label className={`${btnBase} px-3 py-1.5 text-xs cursor-pointer`}>
            导入音乐包
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={handleImport}
            />
          </label>
        </div>
      </div>

      {/* 添加区 */}
      <div className="border border-[#e6e8e6] rounded-lg p-3 mb-3 space-y-2">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <Field label={source === "netease" ? "名称（可点右侧「取名称」自动填）" : "歌名"}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={inputClass}
              placeholder={
                source === "netease" ? "留空会自动取，也可以手填" : "留空则用文件名"
              }
            />
          </Field>
          <Field label="歌手（可空）">
            <input value={artist} onChange={(e) => setArtist(e.target.value)} className={inputClass} />
          </Field>
        </div>

        {/* 本地上传 */}
        <div className="pt-2 border-t border-[#f0f2f0]">
          <p className="text-xs text-slate-600 mb-1.5">
            ① 上传本地音频（mp3 / m4a / wav / ogg，单个不超过 20MB）
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".mp3,.m4a,.wav,.ogg,audio/*"
            onChange={handleUpload}
            disabled={busy === "upload"}
            className="text-xs text-slate-600"
          />
          {busy === "upload" ? <span className="text-xs text-slate-400 ml-2">上传中...</span> : null}
        </div>

        {/* 外链 / 网易云 */}
        <div className="pt-2 border-t border-[#f0f2f0] space-y-2">
          <p className="text-xs text-slate-600">② 或添加链接</p>
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setSource("url")}
              className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                !isNetease
                  ? "border-[#8fb3c7] bg-[#e8eff2] text-slate-800"
                  : "border-[#d5d9d7] text-slate-500 hover:bg-[#f2f5f4]"
              }`}
            >
              外链直链
            </button>
            <button
              type="button"
              onClick={() => setSource("netease")}
              className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                isNetease
                  ? "border-[#8fb3c7] bg-[#e8eff2] text-slate-800"
                  : "border-[#d5d9d7] text-slate-500 hover:bg-[#f2f5f4]"
              }`}
            >
              网易云收藏
            </button>
          </div>

          {isNetease ? (
            <>
              <Field label="内容类型">
                <select
                  value={neteaseType}
                  onChange={(e) => setNeteaseType(e.target.value)}
                  className={inputClass}
                >
                  <option value="2">单曲（type=2）</option>
                  <option value="0">歌单（type=0，会显示完整歌曲列表）</option>
                </select>
              </Field>
              <Field label={neteaseType === "0" ? "网易云歌单 ID" : "网易云歌曲 ID"}>
                <div className="flex gap-2">
                  <input
                    value={neteaseId}
                    onChange={(e) => setNeteaseId(e.target.value)}
                    className={inputClass}
                    placeholder="例如 1901371647，或粘贴含 id= 的链接"
                  />
                  <button
                    type="button"
                    disabled={busy === "fetchName" || !neteaseId.trim()}
                    onClick={fetchNeteaseName}
                    className={`${btnBase} shrink-0`}
                    title="请求网易云公开网页读取名称，自动填到上面的输入框"
                  >
                    {busy === "fetchName" ? "读取中…" : "取名称"}
                  </button>
                </div>
              </Field>

              <Field label="管理员备注（只有后台能看到）">
                <textarea
                  value={adminNote}
                  onChange={(e) => setAdminNote(e.target.value)}
                  rows={2}
                  className={inputClass}
                  placeholder="例如：热歌榜 / 比赛用 / 备用 —— 用户端不会显示这一栏"
                />
              </Field>
              <p className="text-xs text-slate-400 leading-relaxed">
                ⚠️ 只填 ID，不做任何解析 —— 网易云官方没有开放播放地址接口。
                用户端会用**官方外链播放器**嵌入，**用户可以点播放器里的按钮播放/暂停/切歌**；
                但我们（代码）控制不了它，也进不了自动播放队列（跨域限制）。
              </p>
            </>
          ) : (
            <Field label="音频直链">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className={inputClass}
                placeholder="https://你的域名/xxx.mp3"
              />
            </Field>
          )}

          <button
            type="button"
            className={btnPrimary}
            disabled={busy === "add"}
            onClick={handleAdd}
          >
            {busy === "add" ? "添加中..." : "添加"}
          </button>
        </div>
      </div>

      {/* 列表 */}
      {!tracks.length ? (
        <p className="text-xs text-slate-400 py-4 text-center">还没有歌曲</p>
      ) : (
        <ul className="space-y-2">
          {tracks.map((track) => (
            <li
              key={track.id}
              className="border border-[#e6e8e6] rounded-lg px-3 py-2 flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <p className="text-sm text-slate-700 truncate">
                  {track.title}
                  {track.artist ? <span className="text-slate-400"> · {track.artist}</span> : null}
                </p>
                <p className="text-xs text-slate-400 truncate mt-0.5">
                  来源：
                  {track.source === "local" ? "本地上传" : track.source === "netease" ? "网易云" : "外链"}
                  {track.source === "netease" && String(track.netease_type) === "0" ? "歌单" : ""}
                  {Number(track.enabled) === 1 ? " · 启用中" : " · 已停用"}
                  {track.url ? ` · ${track.url}` : ""}
                </p>
                {track.admin_note ? (
                  <p className="text-xs text-amber-600 truncate mt-0.5" title="只有后台能看到这一栏">
                    备注：{track.admin_note}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button type="button" className={`${btnBase} px-2 py-1 text-xs`} disabled={busy === `move-${track.id}`} onClick={() => handleMove(track, -1)} title="上移">
                  ↑
                </button>
                <button type="button" className={`${btnBase} px-2 py-1 text-xs`} disabled={busy === `move-${track.id}`} onClick={() => handleMove(track, 1)} title="下移">
                  ↓
                </button>
                <button type="button" className={`${btnBase} px-2 py-1 text-xs`} disabled={busy === `toggle-${track.id}`} onClick={() => handleToggle(track)}>
                  {Number(track.enabled) === 1 ? "停用" : "启用"}
                </button>
                <button
                  type="button"
                  disabled={busy === `del-${track.id}`}
                  onClick={() => handleRemove(track)}
                  className="border border-[#e5c9c9] bg-[#fdf6f6] text-red-500 rounded-lg px-2 py-1 text-xs hover:bg-[#fbecec] transition-colors"
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 运行指标：接口耗时、AI 用量、内容安全命中（数据来自 /api/admin/metrics） */
function MetricsBlock() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      const res = await api("/api/admin/metrics?days=7");
      setData(res);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return <p className="text-xs text-red-500 mt-3">运行指标读取失败：{error}</p>;
  }
  if (!data) return null;

  const db = data.database || {};
  const usage = data.usage || {};
  const apiPaths = (data.api?.paths || []).slice(0, 6);
  const safety = data.safety || [];
  const daily = data.daily || [];
  const days = usage.days || 7;

  return (
    <div className="border border-[#e6e8e6] rounded-lg p-3 mt-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold text-slate-700">运行指标</h3>
        <button type="button" className={btnBase} onClick={load}>
          刷新
        </button>
      </div>

      <div>
        <p className="text-xs text-slate-600 mb-1.5">
          接口耗时（本次启动以来 · 平均最慢的几个）
        </p>
        {apiPaths.length === 0 ? (
          <p className="text-xs text-slate-400">还没有记录</p>
        ) : (
          <ul className="space-y-1">
            {apiPaths.map((item) => (
              <li key={item.path} className="flex justify-between text-xs gap-2">
                <span className="text-slate-600 truncate">{item.path}</span>
                <span className="text-slate-400 shrink-0">
                  平均 {item.avgMs}ms · 最慢 {item.maxMs}ms · {item.count} 次
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-slate-400 mt-1">
          数据库查询 {db.totalQueries || 0} 次 · 平均 {db.avgMs || 0}ms · 最慢 {db.maxMs || 0}ms
          · 慢查询（≥{db.slowThresholdMs || 300}ms）{db.slowQueries || 0} 次
        </p>
      </div>

      <div>
        <p className="text-xs text-slate-600 mb-1.5">AI 用量（近 {days} 天）</p>
        {(usage.calls || 0) === 0 ? (
          <p className="text-xs text-slate-400">这段时间还没有调用记录</p>
        ) : (
          <>
            <p className="text-xs text-slate-500">
              共 {usage.calls} 次 · 消耗 {usage.totalTokens} tokens · 平均 {usage.avgMs}ms
              {usage.failures ? ` · 失败 ${usage.failures} 次` : ""}
            </p>
            <ul className="space-y-1 mt-1">
              {(usage.byKind || []).map((item) => (
                <li key={item.kind} className="flex justify-between text-xs">
                  <span className="text-slate-600">{item.kind}</span>
                  <span className="text-slate-400">
                    {item.calls} 次 · {item.tokens} tokens · 平均 {item.avgMs}ms
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {daily.length ? (
          <p className="text-xs text-slate-400 mt-1">
            另有 {daily.length} 条按天汇总的历史记录（明细清理后仍保留）
          </p>
        ) : null}
      </div>

      <div>
        <p className="text-xs text-slate-600 mb-1.5">内容安全命中（近 {days} 天）</p>
        {safety.length === 0 ? (
          <p className="text-xs text-slate-400">这段时间没有命中记录</p>
        ) : (
          <ul className="space-y-1">
            {safety.map((item) => (
              <li key={item.category} className="flex justify-between text-xs">
                <span className="text-slate-600">{item.category}</span>
                <span className="text-slate-400">{item.count} 次</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-slate-400 mt-1">只记录命中的类别，不保存用户原话</p>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 概览页 */

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

      <DashboardPanel />

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

  // 对话 AI：拉取到的可用模型列表 + 「测试连接」的结果
  const [aiModels, setAiModels] = useState([]);
  const [aiModelsBusy, setAiModelsBusy] = useState(false);

  // 数据审核的模型列表 / 测试连接状态（和对话 AI 那套完全独立）
  const [reviewModels, setReviewModels] = useState([]);
  const [reviewModelsBusy, setReviewModelsBusy] = useState(false);
  const [reviewTestBusy, setReviewTestBusy] = useState(false);
  const [reviewTestResult, setReviewTestResult] = useState(null);

  /**
   * 拉取审核 AI 的可用模型。
   * ⚠️ 这里只填「下拉候选」，不会自动改模型名字段 —— 用户点了候选才生效。
   */
  async function fetchReviewModels() {
    setReviewModelsBusy(true);
    setError("");
    try {
      const data = await api("/api/admin/review", {
        method: "POST",
        body: { action: "models" },
      });
      const list = Array.isArray(data?.models) ? data.models : [];
      setReviewModels(list);

      if (!data?.ok) {
        setNotice(
          `没能自动获取模型列表（${data?.error || "未知原因"}），直接手动输入模型名即可`
        );
      } else if (list.length) {
        setNotice(`已获取 ${list.length} 个模型，点模型名输入框右侧的箭头选择`);
      } else {
        setNotice("上游返回了空列表，请手动输入模型名");
      }
    } catch (err) {
      setError("拉取模型失败：" + err.message);
    } finally {
      setReviewModelsBusy(false);
    }
  }

  /** 测一次审核 AI 连通性（用已保存的配置，改了配置要先保存） */
  async function testReviewConnection() {
    setReviewTestBusy(true);
    setReviewTestResult(null);
    setError("");
    try {
      const result = await api("/api/admin/review", {
        method: "POST",
        body: { action: "test" },
      });
      setReviewTestResult(result);
    } catch (err) {
      setReviewTestResult({ ok: false, error: err.message, hint: "" });
    } finally {
      setReviewTestBusy(false);
    }
  }
  const [aiTestBusy, setAiTestBusy] = useState(false);
  const [aiTestResult, setAiTestResult] = useState(null);
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

  /**
   * 拉取上游可用的模型列表（OpenAI 协议的标准 GET /models 接口）。
   * 用的是**已保存的配置** —— 所以改了 Key/地址之后要先点保存，再点这个按钮。
   */
  async function fetchAiModels() {
    setAiModelsBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await api("/api/admin/ai/models");
      setAiModels(data.models || []);
      if (data.ok && (data.models || []).length) {
        setNotice(`拉取到 ${data.models.length} 个可用模型，点「模型名」输入框即可选择`);
      } else if (data.ok) {
        setNotice(data.hint || "上游没有返回模型列表，请手动输入模型名");
      } else {
        setError(
          `拉取失败：${data.error || "未知原因"}${data.hint ? `（${data.hint}）` : ""}`
        );
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setAiModelsBusy(false);
    }
  }

  /** 用已保存的配置发一句「你好」，验证接口地址 / Key / 模型名是否都正确 */
  async function testAiConnection() {
    setAiTestBusy(true);
    setAiTestResult(null);
    setError("");
    setNotice("");
    try {
      const data = await api("/api/admin/ai/test", { method: "POST", body: {} });
      setAiTestResult(data);
    } catch (err) {
      setAiTestResult({ ok: false, error: err.message });
    } finally {
      setAiTestBusy(false);
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
            description="聊天接口使用这里配置的服务商。baseUrl 只写到版本目录，程序自动拼 /chat/completions。下面的两个工具都用「已保存的配置」，改了配置请先点右上角保存。"
            settings={settings}
            setError={setError}
            setNotice={setNotice}
            onSaved={loadAll}
            fieldOptions={{ aiModels }}
            onFetchModels={fetchAiModels}
            modelsBusy={aiModelsBusy}
          >
            <div className="border-t border-[#eceeec] pt-3 mt-1 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                {/* 「拉取可用模型」已挪到上面的模型名输入框里（右侧、下箭头左边） */}
                <button
                  type="button"
                  className={btnBase}
                  disabled={aiTestBusy}
                  onClick={testAiConnection}
                >
                  {aiTestBusy ? "测试中..." : "测试连接"}
                </button>
                {aiModels.length ? (
                  <span className="text-xs text-slate-400">已获取 {aiModels.length} 个模型</span>
                ) : null}
              </div>

              {aiTestResult ? (
                <div
                  className={`text-xs rounded-lg border px-3 py-2 leading-relaxed ${
                    aiTestResult.ok
                      ? "border-[#c8e0cc] bg-[#f2f9f3] text-slate-700"
                      : "border-[#e8cccc] bg-[#fdf4f4] text-slate-700"
                  }`}
                >
                  {aiTestResult.ok ? (
                    <>
                      <p className="font-medium text-slate-800">
                        ✅ 连接成功（{aiTestResult.latencyMs} ms）
                      </p>
                      <p className="mt-0.5">模型：{aiTestResult.model}</p>
                      <p className="mt-0.5 break-words">回复：{aiTestResult.reply || "（空）"}</p>
                    </>
                  ) : (
                    <>
                      <p className="font-medium text-slate-800">❌ 连接失败</p>
                      <p className="mt-0.5 break-words">{aiTestResult.error}</p>
                      {aiTestResult.hint ? (
                        <p className="mt-1 text-slate-500">建议：{aiTestResult.hint}</p>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </div>
          </SettingsGroup>
        ) : null}

        {tab === "music" ? (
          <>
            <SettingsGroup
              group="music"
              title="背景音乐设置"
              description="音源可随时切换：本地歌单支持自动播放与切歌；网易云收藏使用官方外链播放器（受官方限制，不能自动播放/切歌）。两种歌单可以同时维护。"
              settings={settings}
              setError={setError}
              setNotice={setNotice}
              onSaved={loadAll}
            />
            <MusicTracksPanel setError={setError} setNotice={setNotice} />
          </>
        ) : null}

        {tab === "safety" ? (
          <SettingsGroup
            group="safety"
            title="内容安全"
            description="在把用户消息发给 AI 之前先过一遍规则。只拦「自伤倾向 / 伤害他人 / 明显违法」三类；命中后不调用 AI，而是返回一句温和的承接话术 + 心理援助热线。词表改完保存立即生效，不用重启。"
            settings={settings}
            setError={setError}
            setNotice={setNotice}
            onSaved={loadAll}
          />
        ) : null}

        {tab === "review" ? (
          <>
            <SettingsGroup
              group="review"
              title="数据审核 · 审核 AI 与默认值"
              description="用户改头像、背景、昵称、签名后会立刻生效，同时被打上「未审核」标记，之后由 AI 批量判定：合规清标记，违规改回下面配置的默认值。改完请先点右上角保存 —— 下面的「立即提交」用的是已保存的配置。"
              settings={settings}
              setError={setError}
              setNotice={setNotice}
              onSaved={loadAll}
              fieldOptions={{ reviewModels }}
              onFetchModels={fetchReviewModels}
              modelsBusy={reviewModelsBusy}
            >
              <div className="border-t border-[#eceeec] pt-3 mt-1 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={btnBase}
                    disabled={reviewTestBusy}
                    onClick={testReviewConnection}
                    title="用已保存的配置发一次真实请求，验证地址 / Key / 模型名"
                  >
                    {reviewTestBusy ? "测试中..." : "测试连接"}
                  </button>
                  <span className="text-xs text-slate-400">
                    测试的是「逐条调用」的对话接口；批量推理能否用，看提交后的批次结果
                  </span>
                </div>

                {reviewTestResult ? (
                  <div
                    className={`text-xs rounded-lg border px-3 py-2 leading-relaxed ${
                      reviewTestResult.ok
                        ? "border-[#c8e0cc] bg-[#f2f9f3] text-slate-700"
                        : "border-[#e8cccc] bg-[#fdf4f4] text-slate-700"
                    }`}
                  >
                    {reviewTestResult.ok ? (
                      <>
                        <p className="font-medium text-slate-800">
                          ✅ 连接成功（{reviewTestResult.latencyMs} ms）
                        </p>
                        <p className="mt-0.5">模型：{reviewTestResult.model}</p>
                        <p className="mt-0.5 break-words">
                          回复：{reviewTestResult.reply || "（空）"}
                        </p>
                        {reviewTestResult.hint ? (
                          <p className="mt-1 text-slate-500">{reviewTestResult.hint}</p>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <p className="font-medium text-slate-800">❌ 连接失败</p>
                        <p className="mt-0.5 break-words">{reviewTestResult.error}</p>
                        {reviewTestResult.hint ? (
                          <p className="mt-1 text-slate-500">建议：{reviewTestResult.hint}</p>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            </SettingsGroup>

            <ContentReviewPanel api={api} setError={setError} setNotice={setNotice} />
          </>
        ) : null}

        {tab === "tts" ? (
          <SettingsGroup
            group="tts"
            title="语音 TTS"
            description="支持两种协议，按你的服务商选对应的「接口类型」：① OpenAI 兼容（智谱、OpenAI、多数厂商）→ POST {接口地址}/audio/speech，接口直接返回音频文件；② 小米 MiMo → POST {接口地址}/chat/completions，音频以 base64 形式放在 JSON 里返回。选错类型会报 400 / Invalid request。"
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
