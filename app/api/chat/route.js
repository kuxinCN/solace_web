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
import { execute, query } from "@/lib/db";
import { withTiming } from "@/lib/perf";
import { buildStyleBlock } from "@/lib/portrait";
import { getPortrait } from "@/lib/portrait-store";
import { recordAiUsage } from "@/lib/usage";
import { rateLimit } from "@/lib/rate-limit";
import { getGroup } from "@/lib/settings";
import { getCurrentUser } from "@/lib/user-auth";
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

/** 长期记忆注入：最多取最近 20 条，拼成一条 system 消息，总长控制在 800 字以内 */
const MEMORY_LIMIT = 20;
const MEMORY_TOTAL_CHARS = 800;
const MEMORY_HEADER =
  "以下是用户之前提过的重要信息，作为背景参考，不要每次都主动提起，只在相关时自然引用：";

/**
 * 取该用户最近的记忆。
 * 表不存在 / 查询异常都静默返回空数组 —— 记忆是锦上添花，绝不能拖垮聊天。
 */
async function loadRecentMemories(userId) {
  try {
    const rows = await query(
      `SELECT content FROM user_memories WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ${MEMORY_LIMIT}`,
      [userId]
    );
    return rows;
  } catch {
    return [];
  }
}

/**
 * 给记忆查询加一道时间上限：万一表被锁或查询卡住，
 * 也只是这次不注入记忆，绝不拖着首字延迟。
 * 800ms 已覆盖远端库正常往返，异常情况下比旧版 1200ms 少等 400ms。
 */
function withMemoryTimeout(promise, ms = 800) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve([]), ms)),
  ]);
}

/** 把记忆拼成一条 system 消息；没有可用内容时返回 null（不插入） */
function buildMemoryMessage(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const lines = [];
  let used = MEMORY_HEADER.length;
  for (const row of rows) {
    const text = String(row?.content ?? "").trim();
    if (!text) continue;
    const line = `- ${text}`;
    if (used + line.length + 1 > MEMORY_TOTAL_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return null;
  return { role: "system", content: `${MEMORY_HEADER}\n${lines.join("\n")}` };
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

  // 长期记忆与 AI 配置互不依赖，并行发出：两者各需一次远端查询，
  // 串行会给首字延迟叠加一次往返（实测单次 0.5~1.5 秒）。
  const memoriesPromise = loadRecentMemories(user.id);

  let config = null;
  try {
    config = await getGroup("ai");
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
  const incoming = normalizeMessages(payload?.messages);
  const frontEndSystem = incoming.filter((item) => item.role === "system");
  const dialogue = incoming.filter((item) => item.role !== "system");

  // 按用户选择的 AI 人格取提示词：male / female 各一份，都没选就用默认那份。
  // persona 来自会话查询（lib/user-auth.js 里一并取出），不用再单独查一次数据库。
  const persona = String(user.aiPersona || "").trim().toLowerCase();

  const personaPrompt =
    persona === "male"
      ? String(config.systemPromptMale || "").trim()
      : persona === "female"
        ? String(config.systemPromptFemale || "").trim()
        : "";

  const configuredSystem = personaPrompt || String(config.systemPrompt || "").trim();

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

  // ---- 心理画像 → 聊天风格指令 ----
  //
  // ⚠️ **纯本地字符串映射，不调用任何 AI**（规则见 lib/portrait.js）。
  // ⚠️ 位置：**人格提示词之后、长期记忆之前** ——
  //    它是"针对这个用户的微调"，不替换全局人设；
  //    而长期记忆和日记正文要更贴近用户消息（见上面的顺序说明）。
  // ⚠️ 取不到画像（新用户没做任何测评）时**一条都不加**，不报错、不降级：
  //    行为和加这个功能之前完全一样。
  try {
    const stored = await getPortrait(user.id);
    const styleBlock = buildStyleBlock(stored?.portrait);
    if (styleBlock) systemBlock.push({ role: "system", content: styleBlock });
  } catch (err) {
    console.warn("[portrait] 读画像失败，本次只用全局人格提示词：", err?.message || err);
  }

  // 长期记忆：放在人格提示词之后（最多 20 条 / 总长 800 字以内），为空则不插入
  const memoryMessage = buildMemoryMessage(await withMemoryTimeout(memoriesPromise));
  if (memoryMessage) systemBlock.push(memoryMessage);

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
  const safety = await checkUserContent(lastUserMessage?.content || "");

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
    const reply = safeMode && !verdict.noRisk ? ensureHotline(verdict.text) : verdict.text;

    return Response.json({ reply, fallback: false });
  }

  // ---------------- 流式：把上游 SSE 逐段转发给前端 ----------------
  const baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
  const timeoutMs = Math.max(5, Number(config.timeoutSeconds) || 60) * 1000;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      // ⚠️ 累积这一轮 AI 的完整回复 —— 流结束后要用它做**输出侧兜底**
      //    （安全模式下没提到热线就补一句，见下面 `sendDone()` 之前那段）
      let fullText = "";

      // ⚠️ **开头的字先攒着不发**：模型有时把 `[RISK:*]` 写在**开头**（指令要求写最后，
      //    但它不一定照做）。一旦发出去流式就收不回来了，标记会一直挂在气泡里 ——
      //    用户实际踩过这个。所以前 40 个字先扣住，攒够了再决定发什么。
      let headFlushed = false;

      const send = (obj) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* 客户端可能已经断开 */
        }
      };
      const sendDone = () => {
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch {
          /* 忽略 */
        }
      };

      try {
        const upstream = await fetch(chatCompletionsUrl(baseUrl), {
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
          // ⚠️ 上游失败的原因必须写进服务端日志：前端只看到兜底文案，排查全靠这里
          let detail = "";
          try {
            detail = await upstream.text();
          } catch {
            detail = "(读取上游响应体失败)";
          }
          console.error(
            `[chat] 上游返回 ${upstream.status} ${upstream.statusText || ""}：`,
            String(detail).slice(0, 500)
          );
          // ⚠️ **AI 挂了也必须有热线** —— 同非流式那条路径的道理：
          //    上游 503 不该成为"风险场景下不给热线"的理由。
          send({ error: safeMode ? ensureHotline(FALLBACK_REPLY) : FALLBACK_REPLY });
          sendDone();
          return;
        }

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
              const delta = parsed?.choices?.[0]?.delta?.content;
              if (delta) {
                fullText += delta;

                // ⚠️ **安全模式下，前 40 个字先扣着不发** ——
                //    模型有时把 `[RISK:*]` 写在**开头**（指令要求写最后，但它不一定照做），
                //    而流式一旦发出去就收不回来了，标记会一直挂在气泡里（用户实际踩过）。
                //    攒够 40 字再决定：有标记就摘掉，没有就原样发。
                // ⚠️ 只有安全模式才走这条 —— 正常聊天不该让用户等那 40 个字。
                if (safeMode && !headFlushed) {
                  if (fullText.length < 40) continue;
                  headFlushed = true;
                  const head = takeRiskTag(fullText);
                  send({ delta: head.found ? head.text : fullText });
                  continue;
                }

                send({ delta });
              }
            } catch {
              /* 忽略单行解析错误 */
            }
          }
        }

        // ⚠️ **输出侧兜底** —— 只在安全模式下生效。**热线是底线，这段不能删。**
        //
        //    为什么要放在这里：`SAFE_MODE_INSTRUCTION` 只是"要求"，模型可能不照做
        //    （回复短的时候尤其容易把"引导专业帮助"那半句吞掉）。
        //    风险场景下不该赌模型的自觉。
        //
        //    ⚠️ 补的时候把"多出来的那段"当普通 delta 发出去 ——
        //       前端那边就是继续往气泡里追加，不需要任何新逻辑。
        if (safeMode) {
          // ⚠️ 疑似的先看 AI 有没有"翻案"：**只有它明确写了 `[RISK:no]`** 才算日常表达
          const verdict = isSuspect ? takeRiskTag(fullText) : { text: fullText, noRisk: false };

          // ⚠️ 流式下 `[RISK:*]` 已经一个字一个字发出去了，这里**没法"收回"** ——
          //    所以额外发一条 `replace`：前端如果认得，就把气泡内容整体换成干净版（标记就消失了）；
          //    不认得也不要紧，只是末尾多一行标记 —— **关键的判定逻辑不受影响**。
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

        sendDone();
      } catch (err) {
        console.error("[chat] 调用上游失败：", err?.message || err);
        // ⚠️ 走到这里说明连流都没建立起来 —— 同样不能漏掉热线
        send({ error: safeMode ? ensureHotline(FALLBACK_REPLY) : FALLBACK_REPLY });
        sendDone();
      } finally {
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
    },
  });
}
