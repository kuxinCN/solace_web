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
  createDailyDiaryTasks,
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
      `SELECT task_kind, status, COUNT(*) AS n
         FROM content_review_tasks
        GROUP BY task_kind, status`
    );

    // payload.stats 保持"全部任务"的口径（兼容老前端），
    // 另外按任务类型分开给一份 —— 后台「日记」页要单独看打标 / 生成的数量。
    const byKind = { review: {}, diary_mood: {}, diary_generate: {} };

    for (const row of statRows) {
      const kind = String(row.task_kind || "review");
      const status = String(row.status || "");
      const count = Number(row.n) || 0;

      if (Object.prototype.hasOwnProperty.call(payload.stats, status)) {
        payload.stats[status] += count;
      }
      if (byKind[kind] && Object.prototype.hasOwnProperty.call(byKind[kind], status)) {
        byKind[kind][status] = count;
      } else if (byKind[kind]) {
        byKind[kind][status] = count;
      }
    }

    // 保证每个类型都有完整的键（前端不用做 undefined 判断）
    for (const kind of Object.keys(byKind)) {
      for (const status of ["pending", "submitted", "pass", "reject", "failed", "manual"]) {
        if (!byKind[kind][status]) byKind[kind][status] = 0;
      }
    }

    payload.statsByKind = byKind;
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

  // 列表范围：默认只看**内容审核**的；后台「日记」页会带 `?scope=diary` 拿日记那两类。
  //
  // ⚠️ 分开是有原因的：混在一起会诱使管理员对一条**日记打标**任务点「驳回」——
  //    而打标根本没有"驳回"这个语义，那个误操作曾经把字符串 `reject`
  //    写进了用户的日记标签里（用户卡片上就出现了一个「reject」）。
  const scopeParam = String(new URL(request.url).searchParams.get("scope") || "review");
  const scopeWhere =
    scopeParam === "all"
      ? ""
      : scopeParam === "diary"
        ? "WHERE COALESCE(t.task_kind, 'review') IN ('diary_mood','diary_generate')"
        : "WHERE COALESCE(t.task_kind, 'review') = 'review'";

  try {
    // ⚠️ 列表里**不带 content**：图片是 base64，一次几十条会有好几 MB
    const tasks = await query(
      `SELECT t.id, t.user_id, t.task_kind, t.target_id, t.field, t.is_image, t.status, t.reason,
              t.provider, t.submitted_at, t.reviewed_at, t.created_at,
              u.username, u.email
         FROM content_review_tasks t
         LEFT JOIN users u ON u.id = t.user_id
        ${scopeWhere}
        ORDER BY t.id DESC
        LIMIT ${LIST_LIMIT}`
    );
    payload.tasks = tasks.map((row) => ({
      id: row.id,
      userId: row.user_id,
      // ⚠️ 后端「日记」页靠这个字段分流（review / diary_mood / diary_generate）
      taskKind: row.task_kind || "review",
      targetId: row.target_id || null,
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

  /* ---- 重试失败的任务 ---- */
  if (action === "retryFailed") {
    // ⚠️ 把 failed 的任务打回 pending，并**把重试计数清零**。
    //
    //    平时失败任务是自动重试的（最多 2 次，见 `lib/content-review.js` 的 takePending）——
    //    这个按钮的用途是"**换过提示词 / 换过模型之后，把之前失败的那批重新跑一遍**"。
    //    计数清零是有意的：手动点一次 = 重新给满自动重试的机会。
    const scope = String(body.scope || "review");
    const scopeWhere =
      scope === "diary"
        ? "AND COALESCE(task_kind, 'review') IN ('diary_mood','diary_generate')"
        : scope === "all"
          ? ""
          : "AND COALESCE(task_kind, 'review') = 'review'";

    try {
      const result = await query(
        `UPDATE content_review_tasks
            SET status = 'pending', retry_count = 0
          WHERE status = 'failed' ${scopeWhere}`
      );

      const affected = Number(result?.affectedRows || 0);

      await logAudit({
        adminId: admin.adminId,
        username: admin.username,
        action: "review_retry_failed",
        detail: `重试失败任务（范围 ${scope}）共 ${affected} 条`,
        ip: clientIp(request),
      });

      return json({
        ok: true,
        affected,
        message: affected
          ? `已把 ${affected} 条失败任务放回待处理队列 —— 点「立即提交」就会重跑`
          : "没有失败的任务",
      });
    } catch (err) {
      return jsonError(`重试失败：${err?.message || err}`, 500);
    }
  }

  /* ---- 手动触发：为昨天排「生成日记」任务 ---- */
  if (action === "generateDiaries") {
    // 平时是定时器每天自动跑一次；这里留个手动入口，方便调试或补跑
    const result = await createDailyDiaryTasks();
    await logAudit({
      adminId: admin.adminId,
      username: admin.username,
      action: "diary_generate",
      detail: result.message || `排入 ${result.created || 0} 篇`,
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

    /* ⓪ 先检查 Key 的类型 —— 这一条能省掉后面所有无效尝试 */
    //
    // 小米有两种 API Key：
    //   `sk-` 开头 → 按量计费（从现金余额扣费）✅ 批量能用
    //   `tp-` 开头 → Token Plan 套餐的 Key ⚠️ **批量不能用**
    //
    // 官方文档在批量那页明确写了「批量推理不支持 Token Plan 抵扣」。
    // 拿 tp- 的 Key 调批量接口，创建任务时会直接 500 internal_error，
    // 而且报错里完全看不出是这个原因 —— 所以这里提前拦一下。
    if (/^tp-/i.test(apiKey)) {
      return json({
        ok: false,
        verdict: "token-plan-key",
        hint:
          "❌ 你的 API Key 是 `tp-` 开头的，这是 **Token Plan 套餐的 Key**。\n\n" +
          "官方文档明确写了：**批量推理不支持 Token Plan 抵扣，只从现金余额扣费**。\n" +
          "所以用这个 Key 调批量接口，创建任务必然失败，而且上游只回一句 internal_error —— " +
          "这就是你一直看到 500 的原因。\n\n" +
          "**解决办法（二选一）**：\n" +
          "① 去小米控制台的「API Keys」页面，申请一个 **`sk-` 开头**的按量计费 Key，" +
          "填到上面的「API Key」里（注意按量计费要有余额，批量是从余额扣的）；\n" +
          "② 或者把「审核方式」改成「逐条调用」—— 那条路不受这个限制。",
      });
    }

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
      // ⚠️ 完全照**官方模板**写（只有 model + messages，不带 max_tokens / temperature）：
      //
      //   {"custom_id": "request-1", "method": "POST", "url": "/v1/chat/completions",
      //    "body": {"model": "mimo-v2.6-flash", "messages": [{"role": "user", "content": "Hello"}]}}
      //
      //   小米控制台的手动提交页写着「系统将逐条校验，校验通过的成员可继续发送；
      //   失败数据需修正后重新上传」—— 既然上游有校验环节，照模板写最保险。
      const line = JSON.stringify({
        custom_id: "solace-probe",
        method: "POST",
        url: "/v1/chat/completions",
        body: {
          model,
          messages: [{ role: "user", content: "Hello" }],
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
        // 把**发出去的 JSONL 原文**也带上：可以直接贴到小米控制台的
        // 「批量推理 → 手动提交」页面做校验 —— 那是官方给的验证途径，
        // 能直接看出是不是格式问题（页面上写着「系统将逐条校验」）。
        jsonl: line,
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

      /* ③ 创建批次：**试几种参数组合**，看哪种能过 */
      //
      // 为什么要试多种：上游失败时只回一句 internal_error，
      // 光看那句话分不清是"参数写法不对"还是"账号没权限"。
      // 把几种常见写法都试一遍，能过的就说明是写法问题，全不能过就基本是账号问题。
      const attempts = [
        {
          // ⚠️ 这个字段是从上游**真实返回**里发现的，官方文档的 curl 示例里没有它：
          //    控制台建的任务在批次列表里带着 "name":"test"（就是页面上的「任务描述」）。
          //    很可能它是必填的 —— 不传时上游直接 500 internal_error。
          name: "带 name 字段（对应控制台的「任务描述」）← 最可能的正确写法",
          body: {
            input_file_id: fileId,
            endpoint: "/v1/chat/completions",
            completion_window: "24h",
            name: "solace-probe",
          },
        },
        {
          name: "标准写法（双认证头 + endpoint 带 /v1 + window=24h）",
          body: {
            input_file_id: fileId,
            endpoint: "/v1/chat/completions",
            completion_window: "24h",
          },
        },
        {
          // ⚠️ 我们平时会**同时发** `api-key` 和 `Authorization` 两个头
          //    （因为小米的对话文档用前者、批量文档用后者）。
          //    文档里批量接口的示例只用了 Authorization ——
          //    有些网关对"多余的认证头"比较敏感，所以这里单独用 Bearer 试一次。
          name: "只发 Authorization 头（去掉 api-key）",
          body: {
            input_file_id: fileId,
            endpoint: "/v1/chat/completions",
            completion_window: "24h",
          },
          onlyBearer: true,
        },
        {
          name: "endpoint 不带 /v1",
          body: {
            input_file_id: fileId,
            endpoint: "chat/completions",
            completion_window: "24h",
          },
        },
        {
          name: "省略 completion_window（用上游默认值）",
          body: { input_file_id: fileId, endpoint: "/v1/chat/completions" },
        },
      ];

      let lastStatus = 0;
      let lastRaw = "";
      let success = null;

      for (const attempt of attempts) {
        // 「只发 Bearer」的组合要单独构造请求头
        const attemptHeaders = attempt.onlyBearer
          ? { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }
          : authHeaders(batchBase, apiKey);

        const bcRes = await fetch(endpoint(batchBase, "/batches"), {
          method: "POST",
          headers: attemptHeaders,
          body: JSON.stringify(attempt.body),
          signal: timeoutSignal(20000),
        });
        const bcText = await bcRes.text();
        lastStatus = bcRes.status;
        lastRaw = bcText;

        steps.push({
          step: `③ 创建批次 — ${attempt.name}`,
          status: bcRes.status,
          raw: bcText.slice(0, 300),
        });

        if (bcRes.ok) {
          success = attempt;
          break;
        }

        // 鉴权类错误再试别的写法也没用，直接停
        if (bcRes.status === 401 || bcRes.status === 403) break;
      }

      /* ④ 顺便探一下「列批次」接口 —— 判断批次服务对**这个账号**是否可用 */
      //
      // 这一步能把问题再分一层：
      //   列批次也 500     → 整个批次服务对你不工作（账号 / 开通问题）
      //   列批次正常返回    → 服务在工作，只是"创建"这一步有问题
      //   （这个接口文档没写，能返回就说明网关认它）
      try {
        const listRes = await fetch(endpoint(batchBase, "/batches"), {
          headers: authHeaders(batchBase, apiKey, false),
          signal: timeoutSignal(15000),
        });
        steps.push({
          step: "④ 列出已有批次（判断批次服务对本账号是否可用）",
          status: listRes.status,
          raw: (await listRes.text()).slice(0, 300),
        });
      } catch (err) {
        steps.push({ step: "④ 列出已有批次", error: err?.message || String(err) });
      }

      if (success) {
        return json({
          ok: true,
          verdict: "ok",
          steps,
          batchBaseUrl: batchBase,
          hint:
            `✅ 整条链路都通了 —— 能过的是这个写法：「${success.name}」。\n` +
            "请把这个结果告诉我，我把代码里的参数改成这一种；" +
            "在此之前正式提交可能会因为写法不一致而失败",
        });
      }

      return json({
        ok: false,
        verdict: "create",
        steps,
        batchBaseUrl: batchBase,
        hint:
          `四种参数组合都是 HTTP ${lastStatus} —— 这基本**排除了「参数写法」和「认证头」的问题**。\n` +
          `当前用的批量地址：${batchBase}\n` +
          `已上传的文件 id：${fileId}\n\n` +
          "剩下只有**账号在这个服务上的状态**了。请按顺序做这两件事：\n" +
          "**① 去控制台「批量推理」页面手动建一次任务**（最关键）：\n" +
          "   随便传个小文件 → 如果**它也建不了**，那就 100% 是账号 / 开通问题，" +
          "页面通常会有提示（比如要开通、要签协议、要充值）；\n" +
          "   如果**它建成功了** → 把那个页面显示的 Base URL 和提交参数发我，我照着改。\n" +
          "**② 顺手点一下上面第 ④ 步的结果**：\n" +
          "   列批次也 500 → 整个批次服务对你不工作；\n" +
          "   列批次正常 → 服务在工作，只有「创建」这一步不行。\n\n" +
          "⚠️ 在批量修好之前，建议先把「审核方式」切成「逐条调用」—— " +
          "探活和上传都通，说明 Key 和地址没问题，逐条那条路是能用的。",
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
