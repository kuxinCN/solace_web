/**
 * 后台「数据审核」统一接口：GET 看状态，POST 执行动作。
 *
 * 为什么不拆成好几个路由：
 *   它们共用同一套鉴权、同一份配置、同一个「一次提交 / 一次轮询」的心智，
 *   放一个文件里更好维护，前端也只需要记一个地址。
 *
 * GET  → 审核总览：统计 + 最近的批次 + 待处理列表（**不含正文**，避免一次传几 MB 的图片）
 * POST → body.action：
 *        submit  立即把待审内容提交给 AI（后台的「立即提交」按钮）
 *        poll    查一遍进行中的批次，把已完成的拉回来并执行处置
 *        detail  看某一条的正文 / 图片
 *        manual  人工判定 { taskId, approve }
 *        test    测试审核 AI 连通性
 *        models  拉取可用模型列表
 */
import { getAdminFromRequest, logAudit } from "@/lib/admin-auth";
import {
  applyManualVerdict,
  pollBatches,
  scanExistingContent,
  submitPendingTasks,
} from "@/lib/content-review";
import { query } from "@/lib/db";
import { ensureUserColumnsOnce } from "@/lib/schema";
import { getGroup } from "@/lib/settings";
import { cleanString, clientIp, json, jsonError, readJsonBody } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEST_TIMEOUT_MS = 20000;
const LIST_LIMIT = 60;

/** 把后台填的地址补成某个端点（允许直接粘完整地址） */
function endpoint(baseUrl, suffix) {
  const base = String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/files$/i, "")
    .replace(/\/batches$/i, "")
    .replace(/\/models$/i, "");
  if (!base) return "";
  return `${base}${suffix}`;
}

/** 小米 MiMo 走 api-key 头，其余走 Bearer（和 lib/content-review.js 一致） */
function authHeaders(baseUrl, apiKey, withJson = true) {
  const headers = {};
  if (withJson) headers["Content-Type"] = "application/json";
  if (String(baseUrl || "").toLowerCase().includes("xiaomimimo.com")) {
    headers["api-key"] = apiKey;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function timeoutSignal(ms) {
  return typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

/** 按上游状态码给一句人话提示（和对话 AI 的测试保持同样的口径） */
function hintForStatus(status) {
  if (status === 401 || status === 403) return "Key 不对或没有权限：确认 Key 完整、前后没有多余空格";
  if (status === 404) return "地址不对：只填到版本目录（如 https://api.xiaomimimo.com/v1）";
  if (status === 429) return "触发限流或额度用尽：去服务商控制台看余额与限额";
  if (status === 400) return "参数有误：最常见的是模型名不存在，换个模型名试试";
  if (status >= 500) return "上游服务异常：稍后重试";
  return "把上面的报错原文发出来，或去服务商控制台核对配置";
}

/* ------------------------------------------------------------------ GET */

export async function GET(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  // 老部署升级：确保审核相关的表和 users 的新列都在。
  // 幂等 + 进程内只跑一次；补表失败不影响下面的读取（会体现在 warn 里）。
  try {
    await ensureUserColumnsOnce();
  } catch (err) {
    console.error("[review] 补表失败：", err?.code || err?.message || err);
  }

  // 自动定时提交的「懒启动」：管理员一打开这个页面，定时器就注册起来。
  // ⚠️ 为什么不用 instrumentation.js 在启动时注册：
  //    Next 会给 server / edge 两套环境各编译一次 instrumentation，
  //    webpack 顺着 scheduler → settings → db 会解析到 node:path，
  //    edge 没有这个模块 → 整个 build 失败（已经踩过一次，不要再试）。
  //    懒启动没有任何构建期风险，第一次访问后就会一直跑。
  try {
    const { startReviewScheduler } = await import("@/lib/scheduler");
    startReviewScheduler();
  } catch (err) {
    console.error("[review] 定时器启动失败（不影响本页）：", err?.message || err);
  }

  const payload = {
    ok: true,
    stats: { pending: 0, submitted: 0, pass: 0, reject: 0, failed: 0, manual: 0 },
    batches: [],
    tasks: [],
    warn: "",
  };

  try {
    const config = await getGroup("review");
    payload.config = {
      enabled: config?.enabled !== false,
      mode: String(config?.mode || "batch"),
      model: String(config?.model || ""),
      baseUrl: String(config?.baseUrl || ""),
      batchBaseUrl: String(config?.batchBaseUrl || ""),
      apiKeyConfigured: Boolean(config?.apiKey),
      reviewImages: config?.reviewImages !== false,
      imageHandling: String(config?.imageHandling || "manual"),
      autoFallback: config?.autoFallback !== false,
      maxItemsPerBatch: Number(config?.maxItemsPerBatch) || 20,
      keepDays: Number(config?.keepDays) || 30,
      autoSubmit: config?.autoSubmit !== false,
      submitIntervalMinutes: Number(config?.submitIntervalMinutes) || 10,
    };
  } catch (err) {
    payload.config = null;
    payload.warn = `读取审核配置失败：${err?.message || err}`;
  }

  try {
    const statRows = await query(
      `SELECT status, COUNT(*) AS n FROM content_review_tasks GROUP BY status`
    );
    for (const row of statRows) {
      const key = String(row.status || "");
      if (Object.prototype.hasOwnProperty.call(payload.stats, key)) {
        payload.stats[key] = Number(row.n) || 0;
      }
    }
    // 「待人工」= 审核失败 + 还没被 AI 处理的图片（关了审图时）
    payload.stats.manual = Number(payload.stats.failed) || 0;
  } catch (err) {
    payload.warn = `${payload.warn} ${err?.code || err?.message || err}`.trim();
  }

  try {
    // expires_at 是后加的列（老库可能还没补上），失败就降级查一次不带它的
    let batches = [];
    try {
      batches = await query(
        `SELECT id, remote_id, provider, status, task_count, pass_count, reject_count,
                failed_count, error, submitted_at, completed_at, expires_at
           FROM content_review_batches
          ORDER BY id DESC
          LIMIT 10`
      );
    } catch {
      batches = await query(
        `SELECT id, remote_id, provider, status, task_count, pass_count, reject_count,
                failed_count, error, submitted_at, completed_at
           FROM content_review_batches
          ORDER BY id DESC
          LIMIT 10`
      );
    }

    payload.batches = batches.map((row) => ({
      id: row.id,
      remoteId: row.remote_id || "",
      provider: row.provider || "",
      status: row.status || "",
      taskCount: Number(row.task_count) || 0,
      passCount: Number(row.pass_count) || 0,
      rejectCount: Number(row.reject_count) || 0,
      failedCount: Number(row.failed_count) || 0,
      error: row.error || "",
      submittedAt: row.submitted_at || null,
      completedAt: row.completed_at || null,
      // 上游给的过期时间：设了「最长等待时间」之后，看这个能判断到底生效没有
      expiresAt: row.expires_at || null,
    }));
  } catch (err) {
    payload.warn = `${payload.warn} ${err?.code || err?.message || err}`.trim();
  }

  try {
    // ⚠️ 列表里**不带 content**：图片是 base64，一次几十条会有好几 MB
    const tasks = await query(
      `SELECT t.id, t.user_id, t.field, t.is_image, t.status, t.reason,
              t.provider, t.submitted_at, t.reviewed_at, t.created_at,
              u.username, u.email
         FROM content_review_tasks t
         LEFT JOIN users u ON u.id = t.user_id
        ORDER BY t.id DESC
        LIMIT ${LIST_LIMIT}`
    );
    payload.tasks = tasks.map((row) => ({
      id: row.id,
      userId: row.user_id,
      field: row.field || "",
      isImage: Number(row.is_image) === 1,
      status: row.status || "",
      reason: row.reason || "",
      provider: row.provider || "",
      username: row.username || "",
      email: row.email || "",
      submittedAt: row.submitted_at || null,
      reviewedAt: row.reviewed_at || null,
      createdAt: row.created_at || null,
    }));
  } catch (err) {
    payload.warn = `${payload.warn} ${err?.code || err?.message || err}`.trim();
  }

  return json(payload);
}

/* ----------------------------------------------------------------- POST */

export async function POST(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return jsonError("请先登录后台", 401);

  const body = await readJsonBody(request);
  const action = cleanString(body.action, 32);

  /* ---- 立即提交 ---- */
  if (action === "submit") {
    const limit = Number(body.limit) || undefined;

    // ⚠️ 这里**不等它跑完**。
    //
    //   之前是 await，结果：批量要上传文件、降级后还要一条条调 AI，
    //   20 条可能要一两分钟 —— 前端一直显示"提交中"，Nginx 还可能把请求掐掉。
    //
    //   现在改成「点完立刻回一句，活交给后台干」；
    //   想看结果就点「刷新」，或者干脆别管 —— 自动定时器会收。
    submitPendingTasks({ limit })
      .then((result) => {
        console.log(
          `[review] 手动提交完成：${result.taskCount || 0} 条 · ${result.provider || "-"}${
            result.ok ? "" : ` · 失败：${result.error || ""}`
          }${result.localRejected ? ` · 本地判违规 ${result.localRejected} 条` : ""}`
        );
      })
      .catch((err) => {
        console.error("[review] 手动提交异常：", err?.message || err);
      });

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "review_submit",
      detail: "手动触发提交（后台异步执行）",
      ip: clientIp(request),
    });

    return json({
      ok: true,
      started: true,
      message: "已开始提交，正在后台跑（几秒到一分钟）。稍后点「刷新」看结果",
    });
  }

  /* ---- 扫描存量数据（给老用户补 tag）---- */
  if (action === "scan") {
    // 审核是后加的功能，老用户的昵称 / 头像从没进过队列 ——
    // 这个动作把它们补上，后台的「待提交」才会真实反映情况。
    const limit = Number(body.limit) || 100;
    const result = await scanExistingContent({ limit });
    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "review_scan",
      detail: result.message || `扫描完成，新入队 ${result.queued || 0} 条`,
      ip: clientIp(request),
    });
    return json(result);
  }

  /* ---- 拉取结果 ---- */
  if (action === "poll") {
    const result = await pollBatches();
    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "review_poll",
      detail: `检查 ${result.checked || 0} 个批次，完成 ${result.completed || 0} 个`,
      ip: clientIp(request),
    });
    return json(result);
  }

  /* ---- 看某一条的正文 / 图片 ---- */
  if (action === "detail") {
    const taskId = Number.parseInt(String(body.taskId ?? ""), 10);
    if (!Number.isInteger(taskId) || taskId <= 0) return jsonError("缺少任务 id", 400);

    const rows = await query(
      `SELECT t.id, t.user_id, t.field, t.content, t.is_image, t.status, t.reason,
              t.created_at, t.reviewed_at, u.username, u.email
         FROM content_review_tasks t
         LEFT JOIN users u ON u.id = t.user_id
        WHERE t.id = ? LIMIT 1`,
      [taskId]
    );
    if (!rows.length) return jsonError("记录不存在", 404);

    const row = rows[0];
    return json({
      ok: true,
      task: {
        id: row.id,
        userId: row.user_id,
        field: row.field || "",
        content: row.content || "",
        isImage: Number(row.is_image) === 1,
        status: row.status || "",
        reason: row.reason || "",
        username: row.username || "",
        email: row.email || "",
        createdAt: row.created_at || null,
        reviewedAt: row.reviewed_at || null,
      },
    });
  }

  /* ---- 人工判定 ---- */
  if (action === "manual") {
    const taskId = Number.parseInt(String(body.taskId ?? ""), 10);
    if (!Number.isInteger(taskId) || taskId <= 0) return jsonError("缺少任务 id", 400);

    const result = await applyManualVerdict({
      taskId,
      approve: body.approve !== false,
      adminName: admin.username,
    });

    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "review_manual",
      detail: `任务 #${taskId}｜${body.approve === false ? "驳回（已改回默认值）" : "通过"}${
        result.ok ? "" : `｜失败：${result.error}`
      }`,
      ip: clientIp(request),
    });

    if (!result.ok) return jsonError(result.error || "操作失败", 400);
    return json(result);
  }

  /* ---- 测试连接 ---- */
  if (action === "test") {
    let saved = null;
    try {
      saved = await getGroup("review");
    } catch {
      saved = null;
    }

    const baseUrl = cleanString(body.baseUrl, 500) || String(saved?.baseUrl || "").trim();
    const apiKey = cleanString(body.apiKey, 500) || String(saved?.apiKey || "").trim();
    const model = cleanString(body.model, 120) || String(saved?.model || "").trim();

    if (!baseUrl) return jsonError("请先填「接口地址」", 400);
    if (!apiKey) return jsonError("请先填「API Key」", 400);
    if (!model) return jsonError("请先填「模型名」", 400);

    const url = endpoint(baseUrl, "/chat/completions");
    const startedAt = Date.now();

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: authHeaders(baseUrl, apiKey),
        signal: timeoutSignal(TEST_TIMEOUT_MS),
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: '只输出一个 JSON：{"verdict":"pass","reason":"ok"}' },
            { role: "user", content: "测试" },
          ],
          max_tokens: 64,
          temperature: 0,
        }),
      });

      const latencyMs = Date.now() - startedAt;
      const raw = await res.text();

      let data = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        data = null;
      }

      if (!res.ok) {
        const upstreamMessage =
          data?.error?.message || data?.error?.code || String(raw || "").slice(0, 250) || "(上游无内容)";
        return json({
          ok: false,
          latencyMs,
          status: res.status,
          url,
          error: `上游返回 ${res.status}：${upstreamMessage}`,
          hint: hintForStatus(res.status),
        });
      }

      const reply = data?.choices?.[0]?.message?.content || "";
      return json({
        ok: true,
        latencyMs,
        model,
        url,
        reply: String(reply).slice(0, 200),
        usage: data?.usage || null,
        hint: "能通。注意：这里测的是「逐条模式」的对话接口；批量推理接口是否可用，要看下面「模式」的选择和提交结果。",
      });
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const message =
        err?.name === "TimeoutError"
          ? `请求超时（${TEST_TIMEOUT_MS / 1000} 秒没有响应）`
          : err?.message || String(err);
      return json({
        ok: false,
        latencyMs,
        url,
        error: message,
        hint: "连不上上游：检查服务器出网是否被防火墙限制，或确认域名能解析",
      });
    }
  }

  /* ---- 测试批量推理接口 ---- */
  if (action === "testBatch") {
    // 这个诊断分两步，**真的把链路跑一遍**，而不是只探个活：
    //   浅探测：查一个不存在的批次 → 验证地址和 Key
    //   深探测：上传一条极简请求 + 创建批次 → 验证"上传 → 创建"这条主链路
    //
    // 为什么必须真的跑：上游失败时只回一句 internal_error，
    // 光看那句话根本分不清是地址、Key、参数还是内容的问题。
    let saved = null;
    try {
      saved = await getGroup("review");
    } catch {
      saved = null;
    }

    const batchBase = String(saved?.batchBaseUrl || "").trim();
    const apiKey = String(saved?.apiKey || "").trim();
    const model = String(saved?.model || "").trim() || "mimo-v2.6-flash";

    if (!batchBase) {
      return json({
        ok: false,
        verdict: "missing",
        hint:
          "还没填「批量推理接口地址」—— 这就是批量提交一直失败、被自动降级成逐条的原因。" +
          "去小米控制台的「批量推理」页面拿到 Base URL（形如 https://batch-api-xxx.xiaomimimo.com/v1）填进来",
      });
    }
    if (!apiKey) return jsonError("请先填「API Key」", 400);

    const steps = [];

    /* ① 浅探测：查一个不存在的批次 */
    const probeUrl = endpoint(batchBase, "/batches/solace-probe-does-not-exist");
    const startedAt = Date.now();
    let shallow = { ok: false, status: 0, raw: "" };

    try {
      const res = await fetch(probeUrl, {
        headers: authHeaders(batchBase, apiKey, false),
        signal: timeoutSignal(15000),
      });
      shallow = { ok: res.ok, status: res.status, raw: (await res.text()).slice(0, 300) };
    } catch (err) {
      return json({
        ok: false,
        verdict: "unreachable",
        url: probeUrl,
        error:
          err?.name === "TimeoutError" ? "请求超时（15 秒没响应）" : err?.message || String(err),
        hint:
          "连不上这个地址：① 确认 Base URL 抄对了（尤其 region 那一段）；" +
          "② 确认服务器能出网；③ 有些服务商要求先完成实名认证才会开通批量接口",
      });
    }

    steps.push({
      step: "① 探活（查不存在的批次）",
      status: shallow.status,
      latencyMs: Date.now() - startedAt,
      raw: shallow.raw,
    });

    /* ② 深探测：上传一条极简请求，然后创建批次 */
    try {
      const line = JSON.stringify({
        custom_id: "solace-probe",
        method: "POST",
        url: "/v1/chat/completions",
        body: {
          model,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 8,
        },
      });

      const form = new FormData();
      form.append("purpose", "batch");
      form.append("file", new Blob([line], { type: "application/jsonl" }), "solace-probe.jsonl");

      const uploadHeaders = authHeaders(batchBase, apiKey);
      delete uploadHeaders["Content-Type"];

      const upRes = await fetch(endpoint(batchBase, "/files"), {
        method: "POST",
        headers: uploadHeaders,
        body: form,
        signal: timeoutSignal(20000),
      });
      const upText = await upRes.text();
      steps.push({
        step: "② 上传测试文件",
        status: upRes.status,
        raw: upText.slice(0, 300),
      });

      if (!upRes.ok) {
        return json({
          ok: false,
          verdict: "upload",
          steps,
          hint: "上传这一步就失败了 —— 先看上面的原文",
        });
      }

      let fileId = "";
      try {
        const parsed = JSON.parse(upText);
        fileId = parsed?.id || parsed?.file_id || "";
      } catch {
        /* 下面统一处理 */
      }

      if (!fileId) {
        return json({
          ok: false,
          verdict: "upload",
          steps,
          hint: "上传返回里没有文件 id，说明这个接口的返回格式和预期不一致，把原文发出来",
        });
      }

      const bcRes = await fetch(endpoint(batchBase, "/batches"), {
        method: "POST",
        headers: authHeaders(batchBase, apiKey),
        body: JSON.stringify({
          input_file_id: fileId,
          endpoint: "/v1/chat/completions",
          completion_window: "24h",
        }),
        signal: timeoutSignal(20000),
      });
      const bcText = await bcRes.text();
      steps.push({
        step: "③ 创建测试批次（1 条纯文本请求）",
        status: bcRes.status,
        raw: bcText.slice(0, 400),
      });

      if (bcRes.ok) {
        return json({
          ok: true,
          verdict: "ok",
          steps,
          hint:
            "✅ 整条链路都通了（上传 + 创建批次）。" +
            "如果正式提交还是失败，那就不是接口的问题，而是**批次内容**的问题 —— " +
            "最常见的是批次里混了图片（多模态消息体），程序现在已经自动把图片排除在批量之外了",
        });
      }

      return json({
        ok: false,
        verdict: "create",
        steps,
        hint:
          "创建批次失败（上游只回了一句 internal_error，看不出细节）。" +
          "请把上面的原文发出来。" +
          "如果上传那步是 200，说明地址和 Key 都对，问题出在创建参数或账号权限上",
      });
    } catch (err) {
      steps.push({ step: "②/③ 异常", error: err?.message || String(err) });
      return json({
        ok: false,
        verdict: "error",
        steps,
        hint: "探测过程中抛异常了，看上面的 error",
      });
    }
  }

  /* ---- 拉取模型列表 ---- */
  if (action === "models") {
    let saved = null;
    try {
      saved = await getGroup("review");
    } catch {
      saved = null;
    }

    const baseUrl = cleanString(body.baseUrl, 500) || String(saved?.baseUrl || "").trim();
    const apiKey = cleanString(body.apiKey, 500) || String(saved?.apiKey || "").trim();

    if (!baseUrl) return jsonError("请先填「接口地址」", 400);
    if (!apiKey) return jsonError("请先填「API Key」", 400);

    const url = endpoint(baseUrl, "/models");
    const startedAt = Date.now();

    try {
      const res = await fetch(url, {
        headers: authHeaders(baseUrl, apiKey, false),
        signal: timeoutSignal(15000),
      });
      const latencyMs = Date.now() - startedAt;
      const raw = await res.text();

      let data = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        data = null;
      }

      if (!res.ok) {
        return json({
          ok: false,
          models: [],
          latencyMs,
          url,
          error: `上游返回 ${res.status}：${
            data?.error?.message || String(raw || "").slice(0, 200) || "(无内容)"
          }`,
          hint: "该服务商可能不支持自动获取模型列表，直接手动输入模型名即可",
        });
      }

      const list = Array.isArray(data)
        ? data
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.models)
            ? data.models
            : [];

      const models = [
        ...new Set(
          list
            .map((item) => (typeof item === "string" ? item : item?.id || item?.name || ""))
            .filter((id) => typeof id === "string" && id.trim())
            .map((id) => id.trim())
        ),
      ].sort();

      return json({
        ok: true,
        models,
        count: models.length,
        latencyMs,
        url,
        hint: models.length ? "" : "上游返回了空列表，请手动输入模型名",
      });
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const message =
        err?.name === "TimeoutError" ? "请求超时（15 秒没有响应）" : err?.message || String(err);
      return json({
        ok: false,
        models: [],
        latencyMs,
        url,
        error: message,
        hint: "连不上上游：检查服务器出网是否被防火墙限制；也可以直接手动输入模型名",
      });
    }
  }

  return jsonError(`不认识的操作：${action || "(空)"}`, 400);
}
