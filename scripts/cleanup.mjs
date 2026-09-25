/**
 * 定时清理脚本：删掉过期的验证码、登录会话、回收站条目。
 *
 * 用法（在项目根目录执行）：
 *   node scripts/cleanup.mjs
 *
 * 配成计划任务（宝塔 → 计划任务 → Shell 脚本，每天 04:00）：
 *   cd /www/wwwroot/solace && node scripts/cleanup.mjs >> logs/cleanup.log 2>&1
 *
 * 说明：
 *   * 用的都是 CREATE/DELETE 的幂等操作，重复跑没有副作用；
 *   * 任何一步失败都不影响其他步骤，最后会打印一份汇总；
 *   * 之所以写成独立脚本而不是接口：清理不需要人工触发，
 *     而且脚本方式不占用 Web 进程、不受登录态影响。
 */

// 从项目根目录解析模块路径，保证在任意工作目录下执行都能找到
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
process.chdir(projectRoot);

const require = createRequire(import.meta.url);

async function main() {
  // 动态 import 项目里的 lib（走相对路径，避免 @/ 别名在纯 node 环境不可用）
  const { query, execute, describeDbError, getDatabaseConfig } = await import(
    path.join(projectRoot, "lib", "db.js")
  );

  const { toMysqlDateTime } = await import(path.join(projectRoot, "lib", "util.js"));

  const now = toMysqlDateTime(new Date());
  const dayAgo = toMysqlDateTime(new Date(Date.now() - 24 * 3600 * 1000));
  const results = [];

  const step = async (name, fn) => {
    try {
      const value = await fn();
      results.push(`  ✅ ${name}：${value}`);
    } catch (err) {
      // 表不存在之类的错误不算致命，记一行就够了
      results.push(`  ⚠️  ${name}：跳过（${err?.code || err?.message || err}）`);
    }
  };

  // 确认数据库能连上（顺便打印版本，方便排查）
  try {
    const rows = await query("SELECT VERSION() AS v, DATABASE() AS db");
    console.log(
      `[cleanup] 开始 · ${now} · 库 ${rows[0]?.db} · MySQL ${rows[0]?.v} · 连接 ${getDatabaseConfig().host}`
    );
  } catch (err) {
    console.error(`[cleanup] ❌ 数据库连不上：${describeDbError(err)}`);
    process.exit(1);
  }

  await step("过期邮箱验证码", async () => {
    const r = await execute("DELETE FROM email_codes WHERE expires_at < ?", [dayAgo]);
    return `删除 ${r.affectedRows || 0} 条`;
  });

  await step("过期用户会话", async () => {
    const r = await execute("DELETE FROM user_sessions WHERE expires_at < ?", [now]);
    return `删除 ${r.affectedRows || 0} 条`;
  });

  await step("过期管理员会话", async () => {
    const r = await execute("DELETE FROM admin_sessions WHERE expires_at < ?", [now]);
    return `删除 ${r.affectedRows || 0} 条`;
  });

  await step("回收站到期条目", async () => {
    const r = await execute("DELETE FROM trash WHERE expire_at < ?", [now]);
    return `删除 ${r.affectedRows || 0} 条`;
  });

  await step("90 天前的 AI 用量明细（先汇总再删）", async () => {
    const cutoff = toMysqlDateTime(new Date(Date.now() - 90 * 24 * 3600 * 1000));

    // ① 先按「天 + 功能」汇总进 ai_usage_daily，这样删掉明细也不会丢掉长期趋势。
    //    ON DUPLICATE KEY UPDATE 保证脚本重复执行也安全（幂等累加）
    let aggregated = 0;
    try {
      const agg = await execute(
        `INSERT INTO ai_usage_daily
           (day, kind, calls, prompt_tokens, completion_tokens, total_latency_ms, failures)
         SELECT DATE(created_at) AS day,
                kind,
                COUNT(*) AS calls,
                COALESCE(SUM(prompt_tokens), 0),
                COALESCE(SUM(completion_tokens), 0),
                COALESCE(SUM(latency_ms), 0),
                COALESCE(SUM(ok = 0), 0)
           FROM ai_usage
          WHERE created_at < ?
          GROUP BY DATE(created_at), kind
         ON DUPLICATE KEY UPDATE
           calls             = calls + VALUES(calls),
           prompt_tokens     = prompt_tokens + VALUES(prompt_tokens),
           completion_tokens = completion_tokens + VALUES(completion_tokens),
           total_latency_ms  = total_latency_ms + VALUES(total_latency_ms),
           failures          = failures + VALUES(failures)`,
        [cutoff]
      );
      aggregated = agg.affectedRows || 0;
    } catch (err) {
      // 汇总失败就保留明细，宁可不删也别丢数据
      return `汇总失败，已跳过删除（${err?.code || err?.message}）`;
    }

    // ② 汇总成功后才删明细
    const r = await execute("DELETE FROM ai_usage WHERE created_at < ?", [cutoff]);
    return `汇总 ${aggregated} 行，删除明细 ${r.affectedRows || 0} 条`;
  });

  await step("过期的内容审核记录（保留天数取后台配置）", async () => {
    const { getGroup } = await import(path.join(projectRoot, "lib", "settings.js"));
    const config = await getGroup("review");
    const keepDays = Math.min(Math.max(Number(config?.keepDays) || 30, 1), 365);
    const cutoff = toMysqlDateTime(new Date(Date.now() - keepDays * 24 * 3600 * 1000));

    // ① 审核批次：只删已经结束的，进行中的还要用来轮询
    const batches = await execute(
      "DELETE FROM content_review_batches WHERE submitted_at < ? AND status <> 'submitted'",
      [cutoff]
    );

    // ② 审核任务：**只删已判定的**（pass / reject）。
    //    ⚠️ pending / submitted / failed 还得留着 —— 删了审核链路就断了。
    const tasks = await execute(
      "DELETE FROM content_review_tasks WHERE created_at < ? AND status IN ('pass', 'reject')",
      [cutoff]
    );

    return `批次 ${batches.affectedRows || 0} 条，审核记录 ${tasks.affectedRows || 0} 条（保留 ${keepDays} 天）`;
  });

  await step("回收站容量提醒", async () => {
    // 不是清理，只是把当前占用打出来，方便判断要不要调保留天数
    const rows = await query(
      "SELECT COUNT(*) AS n, COALESCE(SUM(CHAR_LENGTH(payload)), 0) AS bytes FROM trash"
    );
    const n = Number(rows[0]?.n) || 0;
    const mb = Math.round(((Number(rows[0]?.bytes) || 0) / 1024 / 1024) * 10) / 10;
    return `${n} 条，约 ${mb} MB`;
  });

  console.log("[cleanup] 清理结果：");
  console.log(results.join("\n"));
  console.log(`[cleanup] 完成 · ${toMysqlDateTime(new Date())}`);
}

main().catch((err) => {
  console.error("[cleanup] ❌ 未预期的错误：", err);
  process.exit(1);
});
