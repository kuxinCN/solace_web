/**
 * 数据审核的自动定时器。
 *
 * 每隔一段时间跑一次「收结果 + 交新任务」：
 *   ① 把已提交批次的结果收回来，判违规的改回默认值
 *   ② 把攒着的待审内容提交上去（先跑本地词表，命中的不浪费 AI）
 *
 * 为什么要有它：
 *   手动点「立即提交」时，代码要等整批跑完才返回 —— 批量上传要几秒，
 *   一旦降级成逐条，20 条要一条条调 AI，可能要一两分钟，界面就一直在转。
 *   有了自动定时器，你根本不用点，它自己按间隔跑。
 *
 * ⚠️ **它是怎么启动的（重要，别改成 instrumentation.js）**：
 *    不在应用启动时注册，而是**懒启动** —— 第一个访问 `/api/health`
 *    或后台审核页的请求会调用 startReviewScheduler()（幂等，重复调用无副作用）。
 *    第一次访问之后它就一直在跑了。
 *
 *    为什么不放在根目录的 instrumentation.js：
 *    Next 会给 server 和 edge **两套环境各编译一次** instrumentation，
 *    webpack 顺着 scheduler → settings → db 一路静态解析到 `node:path`，
 *    而 edge 环境没有这个模块 → **整个 npm run build 直接失败**。
 *    这个坑已经踩过一次，不要再试。
 *
 * ⚠️ 其他几个关键设计：
 *   * **间隔从后台配置读** —— 后台改完保存就生效，不用重启；
 *   * 定时器每分钟"看一次表"，只有距上次执行够久才真的干活；
 *   * 同一时刻只允许一个实例在跑（running 标志），避免叠加把上游打爆；
 *   * 每次执行都包 try/catch —— 审核系统出任何问题都不影响聊天等主功能。
 */
let timer = null;
let running = false;
let lastRunAt = 0;
let started = false;
// 上次为「昨天」排「生成日记」任务的时间槽（形如 2026-09-22#23）
// 用它保证"每天只排一次"，不用再另起一个定时器
let lastDiaryGenSlot = "";

// 上次跑「画像例行重算」的日期（形如 2026-09-24）
// 同样是为了"每天一次" —— 画像本身是纯本地计算，但要扫一遍用户表，没必要频繁跑
let lastPortraitSlot = "";

/** 每分钟"看一次表"，够间隔了才真的跑 */
const CHECK_INTERVAL_MS = 60 * 1000;

/** 启动后先等一会儿再跑第一次，避免和应用初始化抢资源 */
const FIRST_RUN_DELAY_MS = 30 * 1000;

export function startReviewScheduler() {
  if (started) return;
  started = true;

  timer = setInterval(() => {
    tick().catch(() => {});
  }, CHECK_INTERVAL_MS);

  // 不阻止进程退出（PM2 停服务时能干净退出）
  if (typeof timer.unref === "function") timer.unref();

  console.log("[scheduler] 数据审核自动提交已注册（每分钟检查一次，按后台设置的间隔执行）");

  const first = setTimeout(() => {
    tick().catch(() => {});
  }, FIRST_RUN_DELAY_MS);
  if (typeof first.unref === "function") first.unref();
}

/** 到点了才真正干活 */
async function tick() {
  if (running) return;
  running = true;

  try {
    const { getGroup } = await import("./settings.js");
    const config = await getGroup("review");

    // 没启用、或关了自动提交 → 什么都不做
    if (!config?.enabled) return;
    if (config?.autoSubmit === false) return;

    // 没配齐也别白跑（省得每分钟打一条日志）
    if (!config.baseUrl || !config.apiKey || !config.model) return;

    const intervalMinutes = Math.min(
      Math.max(Number(config.submitIntervalMinutes) || 10, 1),
      1440
    );
    if (Date.now() < lastRunAt + intervalMinutes * 60 * 1000) return;

    lastRunAt = Date.now();

    const review = await import("./content-review.js");

    // ⓪ 到点了就为「昨天」排一批「生成日记」的任务
    //
    // ⚠️ 它和"提交 / 拉取"是两回事，但**共用同一个批量队列** ——
    //    所以放在这里最顺：排完紧接着就提交上去，一轮搞定。
    try {
      const diaryConfig = await getGroup("diary");
      if (diaryConfig?.generateEnabled) {
        const hour = Math.min(Math.max(Number(diaryConfig.generateHour) || 23, 0), 23);
        const nowDate = new Date();
        // 时间槽 = 日期 + 当前小时：跨天或换小时会自动变成新的，
        // 所以"每天只排一次"不需要额外的持久化
        const slot = `${nowDate.toISOString().slice(0, 10)}#${nowDate.getHours()}`;

        if (nowDate.getHours() >= hour && slot !== lastDiaryGenSlot) {
          lastDiaryGenSlot = slot;
          const generated = await review.createDailyDiaryTasks();
          console.log(
            `[scheduler] AI 日记：${generated.message || `排入 ${generated.created || 0} 篇`}`
          );
        }
      }
    } catch (err) {
      console.error("[scheduler] 生成日记任务失败：", err?.message || err);
    }

    // ⓪.5 每天跑一次「心理画像例行重算」
    //
    // ⚠️ 三个条件缺一不可（判断在 `refreshStalePortraits` 内部）：
    //    ① 距上次画像更新超过 7 天；② 用户**有新测评数据**；③ 画像从没算过。
    //    第 ② 条尤其不能省 —— 否则每 7 天给一个从不测评的用户重算一次，
    //    算出来的东西一模一样，纯属白跑。
    //
    // ⚠️ 画像本身是纯本地计算（不调 AI），但它要扫一遍用户表，
    //    所以也是"每天一次"就够，不必更频繁。
    try {
      const today = new Date().toISOString().slice(0, 10);

      if (today !== lastPortraitSlot) {
        lastPortraitSlot = today;
        const { refreshStalePortraits } = await import("./portrait-store.js");
        const refreshed = await refreshStalePortraits();

        if (refreshed?.updated) {
          console.log(
            `[scheduler] 心理画像：重算了 ${refreshed.updated} 位（扫描 ${refreshed.scanned}，按条件跳过 ${refreshed.skipped}）`
          );
        }
      }
    } catch (err) {
      console.error("[scheduler] 画像例行重算失败：", err?.message || err);
    }

    // ① 先收结果：把已完成的批次拿回来，违规的改回默认值
    try {
      const polled = await review.pollBatches();
      if (polled?.checked) {
        console.log(
          `[scheduler] 轮询：检查 ${polled.checked} 个批次，完成 ${polled.completed} 个`
        );
      }
    } catch (err) {
      console.error("[scheduler] 轮询失败：", err?.message || err);
    }

    // ② 再交新任务
    try {
      const submitted = await review.submitPendingTasks();
      if (submitted?.taskCount) {
        const bits = [`提交 ${submitted.taskCount} 条`, submitted.provider || "-"];
        if (submitted.batchId) bits.push(submitted.batchId);
        if (submitted.localRejected) bits.push(`本地判违规 ${submitted.localRejected} 条`);
        if (submitted.fallback) bits.push("批量不可用，已降级为逐条");
        if (submitted.error) bits.push(`失败：${submitted.error}`);
        console.log(`[scheduler] ${bits.join(" · ")}`);
      }
    } catch (err) {
      console.error("[scheduler] 提交失败：", err?.message || err);
    }
  } catch (err) {
    console.error("[scheduler] 执行异常：", err?.message || err);
  } finally {
    running = false;
  }
}

/** 给测试/排查用：立刻跑一次（不管间隔） */
export async function runOnceNow() {
  lastRunAt = 0;
  await tick();
}
