/**
 * 定时跑「数据审核」：先把已提交批次的结果收回来，再把新的待审内容提交上去。
 *
 * 用法（在项目根目录执行）：
 *   node scripts/review-submit.mjs
 *
 * 配成计划任务（宝塔 → 计划任务 → Shell 脚本，建议每 10 分钟一次）：
 *   cd /www/wwwroot/solace && node scripts/review-submit.mjs >> logs/review.log 2>&1
 *
 * 为什么两件事放一起：
 *   批量推理是**延迟返回**的，一次提交可能几分钟到几小时才有结果。
 *   所以每次跑都先「收上一批的结果」，再「提交这一批新的」，
 *   一个计划任务就把闭环跑完了，不用配两条。
 *
 * 说明：
 *   * 没启用审核、或审核 AI 没配全时，脚本会自己退出，不会报错刷日志；
 *   * 单条失败不影响整批（会标成 failed，可以在后台人工判定）；
 *   * 审核失败**绝不影响**用户已经改好的资料。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
process.chdir(projectRoot);

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}`;
}

async function main() {
  // 走相对路径动态 import，避免 @/ 别名在纯 node 环境不可用（和 cleanup.mjs 一致）
  const review = await import(path.join(projectRoot, "lib", "content-review.js"));
  const { getGroup } = await import(path.join(projectRoot, "lib", "settings.js"));

  let config = null;
  try {
    config = await getGroup("review");
  } catch (err) {
    console.error(`[review] ${stamp()} ❌ 读取审核配置失败：${err?.message || err}`);
    process.exit(1);
  }

  if (!config?.enabled) {
    console.log(`[review] ${stamp()} 数据审核未启用，跳过`);
    process.exit(0);
  }
  if (!config.baseUrl || !config.apiKey || !config.model) {
    console.log(`[review] ${stamp()} 审核 AI 未配置完整（接口地址 / API Key / 模型名），跳过`);
    process.exit(0);
  }

  console.log(
    `[review] ${stamp()} 开始 · 模式 ${config.mode || "batch"} · 模型 ${config.model}`
  );

  // ① 先收结果：查一遍之前提交的批次
  try {
    const polled = await review.pollBatches();
    if (!polled.ok) {
      console.error(`[review] 轮询失败：${polled.error}`);
    } else {
      console.log(
        `[review] 轮询：检查 ${polled.checked} 个批次，完成 ${polled.completed} 个`
      );
      for (const item of polled.detail || []) {
        if (item.passCount !== undefined) {
          console.log(
            `          批次 ${item.batchId}：通过 ${item.passCount} / 违规 ${item.rejectCount} / 失败 ${item.failedCount}`
          );
        } else if (item.error) {
          console.log(`          批次 ${item.batchId}：${item.status}（${item.error}）`);
        } else {
          console.log(`          批次 ${item.batchId}：${item.status}`);
        }
      }
    }
  } catch (err) {
    console.error(`[review] 轮询异常：${err?.message || err}`);
  }

  // ② 再提交新的
  try {
    const submitted = await review.submitPendingTasks();

    if (!submitted.ok) {
      console.error(`[review] 提交失败：${submitted.error}`);
    } else if (!submitted.taskCount) {
      console.log("[review] 提交：没有待审核的内容");
    } else {
      const where = submitted.batchId ? `批次 ${submitted.batchId}` : submitted.provider;
      console.log(`[review] 提交：${submitted.taskCount} 条 · ${where}`);
      if (submitted.fallback) {
        console.log(`[review] 注意：批量推理不可用，已自动降级为逐条模式（原因：${submitted.batchError}）`);
      }
      if (submitted.rejectCount) {
        console.log(`[review] 本次判定违规 ${submitted.rejectCount} 条，已改回默认值`);
      }
      if (submitted.failedCount) {
        console.log(`[review] 本次有 ${submitted.failedCount} 条处理失败，可在后台人工判定`);
      }
    }
  } catch (err) {
    console.error(`[review] 提交异常：${err?.message || err}`);
  }

  console.log(`[review] ${stamp()} 结束`);
  // 数据库连接池是常驻的，脚本必须显式退出
  process.exit(0);
}

main().catch((err) => {
  console.error(`[review] ${stamp()} 异常退出：`, err);
  process.exit(1);
});
