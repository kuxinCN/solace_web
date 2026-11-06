/**
 * 用户端对话接口（支持流式）。
 *
 *   * 需要登录（AI 额度是按服务器上的 Key 消耗的）
 *   * 两种返回方式：
 *       - 流式：请求体带 stream: true → 返回 SSE（data: {"delta":"..."} … data: [DONE]）
 *       - 一次性：返回 { reply, fallback?, error? }
 *   * diaryContext（读日记时用）：作为最后一条 system 消息紧贴用户消息，只发给 AI、不落库、不返回
 *   * 长期记忆（user_memories）：最近 20 条拼成一条 system 消息放在人格提示词之后，为空则不插
 *   * system 消息顺序：人格提示词 → 长期记忆 → 日记正文；GLM-4-flash 会弱化最前的 system 消息
 *   * 配置（接口地址 / Key / 模型）从后台数据库读，数据库没配好时回退 .env.local
 */
import { requestChat, chatCompletionsUrl, prewarmConnections } from "@/lib/ai";
import { SAFE_MODE_INSTRUCTION, checkUserContent, ensureHotline } from "@/lib/content-guard";
import { SUSPECT_INSTRUCTION, recordSuspected, takeRiskTag } from "@/lib/suspected-store";
import { execute } from "@/lib/db";
import { withTiming } from "@/lib/perf";
import { buildStyleBlock } from "@/lib/portrait";
import { extractMemoryMarkers, stripMemoryMarkers } from "@/lib/memory-marker";
import { buildTtsTagInstruction, isStyleTagsEnabled, stripTagsFromMessages, tagWordsFrom } from "@/lib/tts-tags";
import {
  buildMemoryMessage,
  loadMemoryCandidates,
  markMemoriesAccessed,
  saveMemory,
  selectMemoryRows,
} from "@/lib/memory-store";
import { getPortrait } from "@/lib/portrait-store";
import { recordInjection } from "@/lib/memory-metrics";
import { recordAiUsage } from "@/lib/usage";
import { rateLimit } from "@/lib/rate-limit";
import { getGroup, DEFAULTS } from "@/lib/settings";
import { buildFullSystemPrompt } from "@/lib/prompt-builder";
import { getCurrentUser } from "@/lib/user-auth";
import { decideSticker, stripStickerMarkers } from "@/lib/sticker-engine";
import { clientIp } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 按用户 + 按 IP 双层限流，防止被当成免费 AI 代理 */
const USER_RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 };
const IP_RATE_LIMIT = { limit: 120, windowMs: 60 * 1000 };

const MAX_MESSAGES = 60;
const MAX_CONTENT_CHARS = 8000;
const FALLBACK_REPLY = "我暂时无法回应，请稍后再试。";

/**
 * 长期记忆标记规则：让模型在回复末尾输出 `[MEMORY:一句话]`。
 *
 * ⚠️ 后台配置的 systemPrompt 会覆盖前端 SYSTEM_PROMPT，而默认提示词里没有这段，
 *    所以必须在服务端兜底追加（见下方 systemBlock 拼接处）。
 * ⚠️ 文案与前端 SYSTEM_PROMPT 保持一致，改一处记得同步另一处。
 */
const MEMORY_MARKER_RULE =
  "当用户说出长期稳定的个人信息、偏好、愿望或重要事实时，在回复末尾单独一行输出标记 [MEMORY:一句话事实]。务必完整保留关键专有名词、宠物名字、姓名、称呼与核心细节（例如用户提到'我养了只小猫叫TZW'必须输出[MEMORY:用户养了一只叫TZW的小猫]，绝对不可遗漏名字）。只记真实说过的，不编造；日常寒暄不需要记。";

/**
 * 日记上下文默认模板（后台 settings 的 diaryPrompt 可覆盖）。
 * {diary} 占位符会被替换成日记完整正文。
 * 必须强约束模型引用具体细节 —— 旧模板只说“理解情绪即可”，
 * GLM-4-flash 容易因此只回通用套话、反过来邀请用户分享。
 */
const DEFAULT_DIARY_TEMPLATE = [
  "以下是用户刚刚写的日记正文，作为背景知识。正文就在本消息中，你已经收到了，不需要再向用户索要：",
  "- 如果用户当前说的是和日记相关的话题，自然引用日记里的具体细节（人物、事件、场景、情绪）",
  "- 不要用“我感受到了你的情绪”这类通用套话；也不要说“你想分享吗”“愿意聊聊吗”“日记里写了什么”这类索要内容的话",
  "- 不要每次提“日记”这个词",
  "- 不要复述原文",
  "- 回复格式：每句话单独占一行，句与句之间用换行符分隔，共 2~4 行；不要把几句话挤在同一行",
  "日记正文：\n{diary}",
].join("\n");

/**
 * 给记忆查询加一道时间上限：万一表被锁或查询卡住，
 * 也只是这次不注入记忆，绝不拖着首字延迟。
 * 800ms 已覆盖远端库正常往返，异常情况下比旧版 1200ms 少等 400ms。
 *
 * ⚠️ 记忆的去重写入（saveMemory）与相关性精选（selectMemoryRows / buildMemoryMessage）
 *    统一在 lib/memory-store.js，本文件只负责"并行发查询 + 超时兜底 + 拼进 systemBlock"。
 */
function withMemoryTimeout(promise, ms = 500) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ facts: [], daily: [] }), ms)),
  ]);
}

/** .env.local 里的智谱配置，作为数据库配置缺失时的兜底 */
function envFallbackConfig() {
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) return null;
  return {
    enabled: true,
    baseUrl: process.env.ZHIPU_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
    apiKey,
    model: process.env.ZHIPU_MODEL || "glm-4-flash",
    temperature: 0.7,
    maxTokens: 1024,
    timeoutSeconds: 60,
  };
}

/**
 * 根据后台配置（client / server）与客户端时钟构造时空背景 System 指令。
 */
function buildTimeContext({ config, clientTime }) {
  const timeSource = String(config?.timeSource || "client").toLowerCase();
  let dateObj = new Date();
  let sourceDesc = "服务器系统时间";

  if (timeSource === "client" && clientTime) {
    const ts = Number(clientTime.timestamp || clientTime.now);
    if (Number.isFinite(ts) && ts > 1577836800000 && ts < 2524608000000) {
      dateObj = new Date(ts);
      sourceDesc = "用户设备本地时间";
    }
  }

  let timeZone = "Asia/Shanghai";
  if (timeSource === "client" && typeof clientTime?.timeZone === "string" && clientTime.timeZone.trim()) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: clientTime.timeZone });
      timeZone = clientTime.timeZone;
    } catch {
      timeZone = "Asia/Shanghai";
    }
  }

  let dateStr = "";
  let timeStr = "";
  let weekdayStr = "";
  let hour = dateObj.getHours();

  try {
    const dtf = new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = dtf.formatToParts(dateObj);
    const p = {};
    for (const item of parts) {
      p[item.type] = item.value;
    }
    const mVal = String(p.month || "").replace(/月/g, "");
    dateStr = `${p.year}年${mVal}月${p.day}日`;
    timeStr = `${p.hour}:${p.minute}:${p.second}`;
    weekdayStr = p.weekday;
    hour = Number.parseInt(p.hour, 10) || hour;
  } catch {
    const y = dateObj.getFullYear();
    const m = dateObj.getMonth() + 1;
    const d = dateObj.getDate();
    const hh = String(dateObj.getHours()).padStart(2, "0");
    const mm = String(dateObj.getMinutes()).padStart(2, "0");
    const ss = String(dateObj.getSeconds()).padStart(2, "0");
    dateStr = `${y}年${m}月${d}日`;
    timeStr = `${hh}:${mm}:${ss}`;
    const days = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    weekdayStr = days[dateObj.getDay()];
  }

  let period = "白天";
  let greetingTip = "";
  if (hour >= 0 && hour < 5) {
    period = "深夜/凌晨";
    greetingTip = "夜深了，用户可能还在熬夜。如果用户提起作息或时间，自然提醒注意休息";
  } else if (hour >= 5 && hour < 9) {
    period = "清晨/早晨";
    greetingTip = "新的一天开始了，元气满满的早晨";
  } else if (hour >= 9 && hour < 12) {
    period = "上午";
    greetingTip = "学习或工作时间，注意适时休息和喝水";
  } else if (hour >= 12 && hour < 14) {
    period = "中午/午间";
    greetingTip = "午餐与小憩时间";
  } else if (hour >= 14 && hour < 18) {
    period = "下午";
    greetingTip = "下午时光，劳逸结合";
  } else if (hour >= 18 && hour < 20) {
    period = "傍晚/黄昏";
    greetingTip = "下班放学时段，晚餐与放松";
  } else {
    period = "夜晚";
    greetingTip = "夜晚的独处陪伴时光";
  }

  return `【当前现实时空背景】
- 当前时间：${dateStr} ${timeStr}
- 星期：${weekdayStr}
- 时段感知：${period}（${greetingTip}）
- 时钟基准：${sourceDesc}（时区：${timeZone}）
- 现实感知规则：你具备真实的现实时间与时区感知。当用户询问“现在几点”、“今天周几”、“今天几号”、“是不是很晚了”或聊起时间与作息时，必须基于上述准确时间作答与关怀，绝不要回答“不知道时间”或“没有准数”。在日常对话未被问及时间时，保持自然倾听与陪伴，无需刻意句句报时。`;
}

function normalizeMessages(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((item) => item && typeof item.content === "string" && item.content.trim())
    .slice(-MAX_MESSAGES)
    .map((item) => ({
      role: ["system", "user", "assistant"].includes(item.role) ? item.role : "user",
      content: String(item.content).slice(0, MAX_CONTENT_CHARS),
    }));
}

export async function POST(request) {
  // 接口耗时按路径统计（见 lib/perf.js），后台「运行指标」里能看到哪个接口最慢
  return withTiming("/api/chat", () => handleChat(request));
}

async function handleChat(request) {
  const user = await getCurrentUser(request);
  if (!user) {
    return Response.json({ reply: FALLBACK_REPLY, error: "请先登录后再聊天" }, { status: 401 });
  }

  const ipQuota = rateLimit(`chat:ip:${clientIp(request) || "direct"}`, IP_RATE_LIMIT);
  const userQuota = rateLimit(`chat:user:${user.id}`, USER_RATE_LIMIT);
  const quota = ipQuota.ok ? userQuota : ipQuota;
  if (!quota.ok) {
    return Response.json(
      { reply: FALLBACK_REPLY, error: `请求过于频繁，请 ${quota.retryAfterSeconds} 秒后再试` },
      { status: 429 }
    );
  }

  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return Response.json({ reply: FALLBACK_REPLY, error: "请求体不是合法 JSON" });
  }

  const wantStream = payload?.stream === true;

  // 入参归一化是纯本地操作（过滤 + 截断），提到最前面：
  // 内容安全检测只依赖"本轮用户原话"，提前发出去就能和记忆 / 画像 / 配置**并行**跑，
  // 不必串在"记忆读完 → 安全检测 → 开流"这条链上（白搭一次往返）。
  const incoming = normalizeMessages(payload?.messages);
  const rawLastUser = [...incoming].reverse().find((item) => item.role === "user");
  // 纯正则匹配 + 一次 safety 配置读取（getGroup 自带 30 秒缓存），与下面几个查询并行
  const safetyPromise = checkUserContent(rawLastUser?.content || "");

  // 长期记忆候选（事实池 200 条 + 日报 2 条）与 AI 配置互不依赖，并行发出：
  // 两者各需一次远端查询，串行会给首字延迟叠加一次往返（实测单次 0.5~1.5 秒）。
  // 本轮用户消息要等 normalize 之后才有，所以这里只发"查询"，
  // 相关性精选（纯 JS）放到拼 systemBlock 时做，不把查询拖成串行。
  const memoryCandidatesPromise = loadMemoryCandidates(user.id);
  // 心理画像也是纯 DB 查询 + 本地映射：和记忆、配置一起**并行**发出去，
  // 不再串在"配置读完 → 画像 → 朗读标签 → 记忆"这条链上（每次多 0.5~1.5 秒）。
  const portraitPromise = getPortrait(user.id).catch((err) => {
    console.warn("[portrait] 读画像失败，本次只用全局人格提示词：", err?.message || err);
    return null;
  });

  let config = null;
  // 朗读标签要不要注入取决于 TTS 分组的两个字段（接口类型 + 开关），
  // 与 AI 配置互相不依赖 —— 并行读，不给首字延迟再加一次串行往返。
  let ttsConfig = null;
  try {
    [config, ttsConfig] = await Promise.all([
      getGroup("ai"),
      getGroup("tts").catch(() => null),
    ]);
  } catch {
    config = null;
  }
  if (!config || !config.apiKey) config = envFallbackConfig();

  if (!config) {
    return Response.json({
      reply: FALLBACK_REPLY,
      error: "对话 AI 尚未配置：请到后台「对话 AI」页面填写接口地址、API Key 和模型",
    });
  }

  // 连接预热：首次请求时建好到上游 AI 的 TCP+TLS 连接，后续请求复用连接池
  prewarmConnections({ ai: true });

  // 组装最终发给 AI 的消息：
  //   * 系统提示词优先用后台配置的（后台改完保存就生效，不用重启）；后台没配才用前端传来的
  //   * 读日记时，把日记正文按后台配置的模板拼进去（模板里的 {diary} 会被替换成正文）
  const frontEndSystem = incoming.filter((item) => item.role === "system");
  // ⚠️ 回喂给模型的历史要先剥掉朗读标签：
  //    模型看到自己上一轮的 `[温柔]` 会越贴越多，而且标签对"读上下文"没有信息量。
  //    只动 assistant 的消息 —— 用户自己打的括号是内容（见 lib/tts-tags.js）。
  //    不生效时（没开 / 不是 MiMo）不碰任何东西，行为与加这个功能之前一致。
  const historyTagWords = isStyleTagsEnabled(ttsConfig) ? tagWordsFrom(ttsConfig) : null;
  const dialogue = stripTagsFromMessages(
    incoming.filter((item) => item.role !== "system"),
    historyTagWords
  );

  // 按用户选择的 AI 人格组装提示词：采用「性别人设模块 + 公共底座规则」模块化拼接
  const persona = String(user.aiPersona || "").trim().toLowerCase();
  const configuredSystem = buildFullSystemPrompt({ config, persona });

  // system 消息统一收集，最后再与对话拼接。顺序至关重要：
  //   人格提示词 → 长期记忆 → 日记正文（紧贴用户消息）
  // GLM-4-flash 在多条 system 消息并存时会弱化最前面的内容，
  // 若把日记 unshift 到最前，模型会读不到正文、反过来邀请用户分享。
  const systemBlock = [];
  if (configuredSystem) {
    systemBlock.push({ role: "system", content: configuredSystem });
  } else {
    systemBlock.push(...frontEndSystem);
  }

  // ---- 现实时空背景与时间感知 ----
  const timeContextBlock = buildTimeContext({ config, clientTime: payload?.clientTime });
  if (timeContextBlock) {
    systemBlock.push({ role: "system", content: timeContextBlock });
  }

  // ---- 长期记忆标记规则（[MEMORY:]）----
  //
  // ⚠️ 必须在这里补：后台配置的 systemPrompt **优先于**前端传来的 SYSTEM_PROMPT，
  //    而默认提示词（lib/settings.js）里并没有 [MEMORY:] 规则 ——
  //    只靠前端那份的话，线上永远输出不了标记，通道②等于死锁。
  // ⚠️ 用 includes 判重：前端 SYSTEM_PROMPT 已含这段时不再重复追加，
  //    避免同一条指令在 system 里出现两次（模型会过度标记）。
  if (systemBlock[0] && !String(systemBlock[0].content || "").includes("[MEMORY:")) {
    systemBlock[0] = {
      role: "system",
      content: `${systemBlock[0].content}\n\n${MEMORY_MARKER_RULE}`,
    };
  }

  // ---- 心理画像 → 聊天风格指令 ----
  //
  // ⚠️ **纯本地字符串映射，不调用任何 AI**（规则见 lib/portrait.js）。
  // ⚠️ 位置：**人格提示词之后、长期记忆之前** ——
  //    它是"针对这个用户的微调"，不替换全局人设；
  //    而长期记忆和日记正文要更贴近用户消息（见上面的顺序说明）。
  // ⚠️ 取不到画像（新用户没做任何测评）时**一条都不加**，不报错、不降级：
  //    行为和加这个功能之前完全一样。
  try {
    const stored = await portraitPromise;
    const styleBlock = buildStyleBlock(stored?.portrait);
    if (styleBlock) systemBlock.push({ role: "system", content: styleBlock });
  } catch (err) {
    console.warn("[portrait] 读画像失败，本次只用全局人格提示词：", err?.message || err);
  }

  // ---- 朗读标签（情绪 / 声音事件）----
  //
  // 让 AI 在回复里内嵌 `[温柔]`、`(叹气)` 这类标签，小米 MiMo 朗读时按标签控语气。
  // 存库存的是**带标签的原文**，用户看到的气泡由前端剥掉（见 lib/tts-tags.js）。
  //
  // ⚠️ **只在请求时拼接，绝不写进后台的人格提示词**：
  //    人格提示词存在数据库里、所有部署共用一份 —— 一旦写进去，
  //    "OpenAI 兼容 TTS"的部署也会让 AI 输出标签，然后被一字一顿念出来。
  // ⚠️ 位置与心理画像一致：人格之后、长期记忆之前（同属"该怎么说话"的指令，
  //    不是"回忆内容"），不占用紧贴用户消息那个注意力最高的位置。
  // ⚠️ 不生效时**什么都不加**：行为和上这个功能之前完全一样。
  const ttsTagBlock = buildTtsTagInstruction(ttsConfig);
  if (ttsTagBlock) systemBlock.push({ role: "system", content: ttsTagBlock });

  // 长期记忆：放在人格提示词之后，为空则不插入。
  // 候选池（事实 200 + 日报 2）已并行取回，这里按"最近 3 条用户消息"做 bigram
  // 相关性精选 + 分层（daily ≤2 / 相关事实 ≤14 / 无关时只留 6 条最近）+ 关系/偏好常驻 ≤4，
  // 最相关的行排在记忆块最后（紧贴用户消息，GLM 对靠前 system 注意力弱）。
  // 500 字总上限（lib/memory-store.js 的 MEMORY_TOTAL_CHARS）
  // 和 500ms 查询超时两条硬兜底保持不变。
  // 跨对话检索：只用"最后一条消息"时，像"今天又加班到十点"这种没带关键实体的话
  // 往往匹配不到任何记忆；把最近 3 条用户消息拼起来做相关性打分，命中率明显更高。
  // ⚠️ 只取用户的话：AI 的回复会复述记忆内容，拼进去等于让记忆"自己证明自己相关"。
  const memoryQueryText = dialogue
    .filter((item) => item.role === "user")
    .slice(-3)
    .map((item) => String(item.content || ""))
    .join("\n");
  const memoryCandidates = await withMemoryTimeout(memoryCandidatesPromise);
  const memoryRows = selectMemoryRows(memoryCandidates, memoryQueryText);
  const memoryMessage = buildMemoryMessage(memoryRows);
  if (memoryMessage) systemBlock.push(memoryMessage);

  // 唤醒：被选中的记忆这轮真正进了提示词 → 强度立刻恢复 100、时间刷新到现在。
  // ⚠️ **不 await**：它只是一条 UPDATE，压在主链路上等于白等一次数据库往返。
  // ⚠️ 用选中的行（而不是"库里的全部"）：只有真被想起来的记忆才该续命。
  if (memoryRows.length) {
    void markMemoriesAccessed(
      user.id,
      memoryRows.map((row) => row.id)
    ).catch((err) => console.warn("[chat] 记忆唤醒失败：", err?.message || err));
  }
  // 观测指标：异步累加（按用户 × 天），失败静默，绝不拖慢首字
  try {
    recordInjection(user.id, memoryRows.length, memoryMessage?.content?.length || 0);
  } catch {
    /* 统计失败不影响聊天 */
  }

  // 日记正文：作为最后一条 system 消息，与本轮用户消息直接相邻，确保模型一定读到
  if (typeof payload?.diaryContext === "string" && payload.diaryContext.trim()) {
    const diary = payload.diaryContext.slice(0, MAX_CONTENT_CHARS);
    const template = String(config.diaryPrompt || "").trim() || DEFAULT_DIARY_TEMPLATE;
    const content = template.includes("{diary}")
      ? template.replace(/\{diary\}/g, diary)
      : `${template}\n${diary}`;
    systemBlock.push({ role: "system", content });
  }

  if (dialogue.length === 0) {
    return Response.json({ reply: FALLBACK_REPLY, error: "没有可发送的内容" });
  }

  // ---- 内容安全：三层判定（危机 → 安全词 → 压力词），见 lib/content-guard.js ----
  //
  // ⚠️ **这一段必须在 `const messages = [...]` 之前做完** ——
  //    "安全模式"要往 systemBlock 里追加指令，而 messages 一旦拼好就加不进去了。
  // ⚠️ 命中只记录"类别 + 规则名"，**不把用户原话写进数据库或日志**。
  const lastUserMessage = [...dialogue].reverse().find((item) => item.role === "user");
  // 检测在请求一进来就发起（与记忆 / 画像 / 配置并行），这里只是取结果
  const safety = await safetyPromise;



  /* ---- ① 紧迫危机：截断，不给 AI 自由发挥的余地 ---- */
  if (safety.blocked) {
    try {
      await execute(
        "INSERT INTO safety_flags (user_id, category, matched, source) VALUES (?, ?, ?, ?)",
        [user.id, safety.category, safety.name, "chat"]
      );
    } catch {
      /* 记录失败不影响拦截本身 */
    }

    if (!wantStream) {
      return Response.json({ reply: safety.reply, safety: safety.category });
    }

    // 流式模式下也用同样的 SSE 格式返回，前端不需要额外分支
    const guardStream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ delta: safety.reply })}\n\n`)
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(guardStream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  /* ---- ② 安全模式：**不截断**，正常调 AI + 附加安全指令 ---- */
  //
  // ⚠️ 这是本次改造的重点。命中自伤/伤人/违法的表达时，
  //    与其甩一句固定话术（那是"关门"），不如**让 AI 接着聊**（这是"扶着"）——
  //    固定话术会让正在倾诉的人立刻感到被推开，而那段话恰恰是他最需要被接住的时候。
  // ⚠️ 只有**紧迫危机**（有计划、有时间、已经做准备）才截断 —— 见上面那一段。
  /* ---- ② 安全模式：**不截断**，正常调 AI + 附加安全指令 ---- */
  //
  // ⚠️ 这是本次改造的重点。命中自伤/伤人/违法的表达时，
  //    与其甩一句固定话术（那是"关门"），不如**让 AI 接着聊**（这是"扶着"）——
  //    固定话术会让正在倾诉的人立刻感到被推开，而那段话恰恰是他最需要被接住的时候。
  // ⚠️ 只有**紧迫危机**（有计划、有时间、已经做准备）才截断 —— 见上面那一段。
  const safeMode = Boolean(safety.safeMode);
  // ⚠️ **疑似命中**（"前缀+后缀"组合出来的，比如"想"+"死"）——
  //    只有这种才给 AI 判语义的机会；`high`（完整短语命中，如"遗书"）不给。
  const isSuspect = safeMode && safety.confidence === "suspect";

  if (safeMode) {
    // ⚠️ **一定要打这条日志**：出问题时（"为什么没有热线？"）第一步就是看这里 ——
    //    有这条 = 检测层认出来了，问题在输出侧；没这条 = 检测层根本没命中。
    //    不记原文，只记类别。
    console.log(
      `[chat] 安全模式：命中「${safety.name}」${isSuspect ? `（疑似「${safety.matched}」，交给 AI 判）` : ""}，已附加安全指令（user=${user.id}）`
    );

    // ⚠️ **不 await** —— 这条 INSERT 就在响应链路上，而安全模式下每次聊天都要走一遍。
    //    它只是留档（给后台看"哪些消息触发了风险判定"），失败也无所谓，
    //    **不该让用户等它写完再开始收 AI 的回复**。
    void execute(
      "INSERT INTO safety_flags (user_id, category, matched, source) VALUES (?, ?, ?, ?)",
      [user.id, safety.category, safety.name, "chat"]
    ).catch(() => {});

    // 追加在人格提示词和画像指令之后、长期记忆之前 —— 风险场景下这条优先级最高
    systemBlock.push({ role: "system", content: SAFE_MODE_INSTRUCTION });

    // ⚠️ 疑似的额外给一条判定指令。**只有它明确写 `[RISK:no]` 才会撤掉热线**；
    //    不写、写错、写一半 —— 一律按有风险处理（见 suspected-store.js 的文件头说明）。
    if (isSuspect) {
      systemBlock.push({ role: "system", content: SUSPECT_INSTRUCTION });

      // ⚠️ **攒疑似词**（fire-and-forget，不 await）——
      //    后台能看出"这个词被判过 N 次日常用法"，将来决定要不要加进例外表。
      //    只记命中的片段 + 一小段上下文，**不记完整原话**。
      void recordSuspected(
        safety.matched,
        safety.category,
        "unknown",
        lastUserMessage?.content || ""
      ).catch(() => {});
    }
  }

  const messages = [...systemBlock, ...dialogue];

  // 诊断：System Prompt 体积分块打点。首字变慢最常见的元凶就是它悄悄膨胀 ——
  // 记一条日志（只有长度，不含内容），排查时一眼能看出是哪块在涨。
  try {
    const systemChars = systemBlock.reduce((n, item) => n + String(item.content || "").length, 0);
    const historyChars = dialogue.reduce((n, item) => n + String(item.content || "").length, 0);
    const blocks = systemBlock.map((item) => String(item.content || "").length).join("/");
    console.log(
      `[chat] prompt: total=${systemChars + historyChars} system=${systemChars} (blocks=${blocks}) history=${historyChars} messages=${messages.length}`
    );
  } catch {
    /* 日志失败不影响聊天 */
  }

  // ---- 压力评估（本地规则，几毫秒）----
  //
  // ⚠️ **故意不 await**：这一段要查几次库，触发时还会异步调一次 LLM，
  //    压在用户消息的响应链路上会白白多等几百毫秒 —— 而它本来就不影响回复内容。
  //    算出来的分数和"要不要弹窗"由前端调 `/api/stress/state` 取（那里有 pendingPopup）。
  // ⚠️ 用**动态 import**：这样没开这个功能时，聊天热路径完全不加载这套模块。
  void (async () => {
    try {
      const [trigger, settings] = await Promise.all([
        import("@/lib/stress-trigger"),
        import("@/lib/settings"),
      ]);

      const stressConfig = await settings.getGroup("safety");
      if (!stressConfig?.stressEnabled) return;

      await trigger.onUserMessage(user.id, lastUserMessage?.content || "");
    } catch (err) {
      // 压力评估出任何问题都不该影响聊天
      console.warn("[stress] 聊天压力分析失败：", err?.message || err);
    }
  })();

  // ---------------- 表情包：情绪判定与主对话流**并行** ----------------
  //
  // 关键词命中是毫秒级；判不出才并行调一次轻量 AI（引擎内部 2.5s 超时即放弃）。
  // 这里只"发起"不 await —— 与上游 AI 的文字流式同时跑，流末才取结果，
  // 无论判定走不走 AI，都不会拖慢首字。"重新生成"是重放旧消息而非新发言，不计数。
  //
  // ⚠️ 分类 spec（词表 / 优先级 / 深夜放宽 / 哪些分类可触发）是**后台配的、存在库里**的，
  //    所以这里要先读一次（`lib/sticker-store.js` 里带 30 秒缓存，不是每句话都查库）。
  //    读不到就用引擎的出厂默认分类 —— 读配置失败不该让贴纸功能整个消失。
  const stickerDecisionPromise =
    payload?.regenerate === true
      ? Promise.resolve(null)
      : (async () => {
          try {
            // 表情包总开关：关掉就连计数都不做，省掉一次情绪判定
            if ((await getGroup("sticker"))?.enabled === false) return null;

            let spec = null;
            try {
              const { readStickerSpec } = await import("@/lib/sticker-store");
              spec = await readStickerSpec();
            } catch (err) {
              console.warn(
                "[sticker] 读取表情包分类配置失败，改用出厂默认分类：",
                err?.message || err
              );
            }

            return await decideSticker({
              userId: user.id,
              conversationId: payload?.conversationId,
              // 日记场景前端显式传入"标题+正文"作为情绪判断文本；普通聊天用最后一条用户消息
              text: payload?.emotionText || lastUserMessage?.content || "",
              config,
              spec,
            });
          } catch (err) {
            console.warn("[sticker] 表情包判定失败：", err?.message || err);
            return null;
          }
        })();

  // ---------------- 非流式：直接返回完整回复 ----------------
  if (!wantStream) {
    const startedAt = Date.now();
    const result = await requestChat({ messages, config });
    const latencyMs = Date.now() - startedAt;
    await recordAiUsage({
      userId: user.id,
      kind: "chat",
      model: config.model,
      usage: result.usage,
      latencyMs,
      ok: result.ok,
    });
    if (!result.ok) {
      // ⚠️ **AI 挂了也必须有热线** —— 这条路径以前直接返回兜底文案，
      //    把安全模式的兜底整个绕过去了。风险场景下"AI 不可用"不是少给热线的理由。
      return Response.json({
        reply: safeMode ? ensureHotline(FALLBACK_REPLY) : FALLBACK_REPLY,
        fallback: true,
        error: result.error,
      });
    }

    // ⚠️ **输出侧兜底**（安全模式下）：`SAFE_MODE_INSTRUCTION` 只是"要求"，
    //    模型可能不照做 —— 回复短的时候尤其容易把"引导专业帮助"漏掉。
    //    风险场景下不该赌模型的自觉。**热线是底线，这段不能删。**
    //
    // ⚠️ 疑似的先看 AI 有没有"翻案"：**只有它明确写了 `[RISK:no]`** 才算
    //    "这只是日常表达"，那就把标记摘掉、也不补热线。
    //    **其他一切情况（没写 / 写错 / 写一半）都按有风险处理** —— 见 suspected-store.js。
    const verdict = isSuspect ? takeRiskTag(result.reply) : { text: result.reply, noRisk: false };
    let reply = safeMode && !verdict.noRisk ? ensureHotline(verdict.text) : verdict.text;

    // 模型自主记忆（[MEMORY:xxx]）：从展示文本里剥标记，fire-and-forget 写库
    const markers = extractMemoryMarkers(result.reply);
    if (markers.length) {
      reply = stripMemoryMarkers(reply);
      const marker = markers[markers.length - 1];
      void (async () => {
        try {
          // 走统一写入口：与关键词通道近似去重，重复提及只强化不新增
          await saveMemory(user.id, marker, "self");
        } catch (err) {
          console.warn("[chat] 自主记忆写入失败：", err?.message || err);
        }
      })();
    }

    // 模型自主写的贴纸标记一律剥掉：贴纸只能来自情绪节流引擎的决策
    reply = stripStickerMarkers(reply);

    const sticker = await stickerDecisionPromise;
    return Response.json({ reply, fallback: false, sticker: sticker?.category || null });
  }

  // ---------------- 流式：把上游 SSE 逐段转发给前端 ----------------
  const baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
  const timeoutMs = Math.max(5, Number(config.timeoutSeconds) || 60) * 1000;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      // ⚠️ 立即向前端写入首个 SSE 注释行：
      //    1. 让前端立即收到 HTTP 200 响应头与首字节，彻底打破 Nginx 反代 60 秒的连接空闲超时；
      //    2. 配合 X-Accel-Buffering: no 穿透反向代理缓冲。
      try {
        controller.enqueue(encoder.encode(": solace-stream-init\n\n"));
      } catch {
        /* 忽略客户端早期断开 */
      }

      // 心跳保活定时器：模型思考或等待排队期间，每 5 秒推一次注释行保活
      const keepAliveTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          clearInterval(keepAliveTimer);
        }
      }, 5000);

      // ⚠️ 累积这一轮 AI 的完整回复 —— 流结束后要用它做**输出侧兜底**
      //    （安全模式下没提到热线就补一句，见下面 `sendDone()` 之前那段）
      let fullText = "";
      let headFlushed = false;

      const send = (obj) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* 客户端可能已经断开 */
        }
      };
      const sendDone = () => {
        clearInterval(keepAliveTimer);
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch {
          /* 忽略 */
        }
      };

      try {
        let upstream = null;
        let upstreamFailed = false;
        let failDetail = "";

        try {
          upstream = await fetch(chatCompletionsUrl(baseUrl), {
            method: "POST",
            signal:
              typeof AbortSignal?.timeout === "function"
                ? AbortSignal.timeout(timeoutMs)
                : undefined,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
              model: config.model,
              messages,
              temperature: Number(config.temperature) || 0.7,
              max_tokens: Number(config.maxTokens) || 1024,
              stream: true,
            }),
          });

          if (!upstream.ok || !upstream.body) {
            upstreamFailed = true;
            try {
              failDetail = await upstream.text();
            } catch {
              failDetail = "(读取响应体失败)";
            }
            console.warn(
              `[chat] 上游流式请求返回 ${upstream.status}，尝试自动降级为非流式重试：`,
              String(failDetail).slice(0, 300)
            );
          }
        } catch (streamFetchErr) {
          upstreamFailed = true;
          console.warn("[chat] 上游流式连接失败，尝试自动降级为非流式重试：", streamFetchErr?.message || streamFetchErr);
        }

        // ================= 智能降级双保险（Fallback to Non-Stream） =================
        // 如果上游模型不支持 stream: true（部分第三方聚合平台限制）或流式握手失败，
        // 自动用非流式 requestChat 重试，再转为 SSE 下发，100% 避免前台报网络波动。
        if (upstreamFailed) {
          const fallbackRes = await requestChat({ messages, config });
          if (fallbackRes.ok && fallbackRes.reply) {
            fullText = fallbackRes.reply;
            const cleanText = takeRiskTag(fullText).text;
            send({ delta: cleanText });
          } else {
            console.error(`[chat] 非流式降级重试依然失败：`, fallbackRes.error || failDetail);
            send({ error: safeMode ? ensureHotline(FALLBACK_REPLY) : FALLBACK_REPLY });
            sendDone();
            return;
          }
        } else {
          // 正常的上游流式读取
          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done: finished, value } = await reader.read();
            if (finished) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || ""; // 保留最后一段不完整的行

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;

              const data = trimmed.slice(5).trim();
              if (!data || data === "[DONE]") continue;

              try {
                const parsed = JSON.parse(data);
                // ⚠️ 严格只读取正式回复 content，坚决忽略模型的内部思维链（reasoning_content / thinking）
                const delta = parsed?.choices?.[0]?.delta?.content;
                if (delta) {
                  fullText += delta;

                  if (safeMode && !headFlushed) {
                    if (fullText.length < 40) continue;
                    headFlushed = true;
                    const head = takeRiskTag(fullText);
                    send({ delta: head.found ? head.text : fullText });
                    continue;
                  }

                  // 过滤可能内嵌在 content 里的 <think> 标签碎片
                  if (!fullText.includes('<think>')) {
                    send({ delta });
                  }
                }
              } catch {
                /* 忽略单行解析错误 */
              }
            }
          }
        }

        // ⚠️ 彻底剥离任何可能出现在正文里的 <think>...</think> 思考链标签
        if (fullText.includes('<think>')) {
          fullText = fullText.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*/gi, '').trimStart();
          send({ replace: fullText });
        }

        // ⚠️ **输出侧兜底** —— 只在安全模式下生效。
        if (safeMode) {
          const verdict = isSuspect ? takeRiskTag(fullText) : { text: fullText, noRisk: false };
          if (verdict.found) {
            send({ replace: verdict.text });
          }

          if (!verdict.noRisk) {
            const fixed = ensureHotline(verdict.text);
            if (fixed.length > verdict.text.length) {
              send({ delta: fixed.slice(verdict.text.length) });
            }
          }
        }

        // ---------------- 模型自主决策记忆（[MEMORY:xxx]） ----------------
        const memoryMarkers = extractMemoryMarkers(fullText);
        const hasStickerMark = /\[sticker:[a-z0-9]+\]/i.test(fullText);
        if (memoryMarkers.length || hasStickerMark) {
          const cleanBase = takeRiskTag(fullText).text;
          let clean = stripMemoryMarkers(cleanBase);
          clean = stripStickerMarkers(clean);
          if (safeMode) clean = ensureHotline(clean);
          send({ replace: clean });

          if (memoryMarkers.length) {
            const marker = memoryMarkers[memoryMarkers.length - 1];
            void (async () => {
              try {
                await saveMemory(user.id, marker, "self");
              } catch (err) {
                console.warn("[chat] 自主记忆写入失败：", err?.message || err);
              }
            })();
          }
        }

        // ---------------- 情绪贴纸（节流引擎） ----------------
        const sticker = await Promise.race([
          stickerDecisionPromise,
          new Promise((resolve) => setTimeout(() => resolve(null), 400)),
        ]);
        if (sticker?.category) {
          send({ sticker: sticker.category });
        }

        sendDone();
      } catch (err) {
        clearInterval(keepAliveTimer);
        console.error("[chat] 调用上游失败：", err?.message || err);
        send({ error: safeMode ? ensureHotline(FALLBACK_REPLY) : FALLBACK_REPLY });
        sendDone();
      } finally {
        clearInterval(keepAliveTimer);
        try {
          controller.close();
        } catch {
          /* 忽略 */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
