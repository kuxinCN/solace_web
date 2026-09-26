/**
 * 关键词回归测试 —— **在服务器上跑**（本机不用装 node）。
 *
 * 用法：
 *   cd /www/wwwroot/solace && node scripts/test-keywords.mjs
 *
 * 退出码：0 = 全过，1 = 有失败（可以直接串进部署脚本里当门禁）
 *
 * ⚠️ 这份测试是**必须过**的，别把它当"参考"：
 *    「笑死了」「累死了」误报一次，等于把正常用户的日常表达当成自杀倾向 ——
 *    那比漏判更伤体验（用户会觉得"这破 AI 有病"）。
 *    反过来「我想死」漏一次，是安全事故。
 *    两个方向都不能错，所以每次改词表都要跑。
 *
 * ⚠️ 它**不连数据库** —— `getLexicons()` 在没有库的时候会用内置默认词表兜底，
 *    所以哪台机器上都能跑。想测**库里那份**（管理员改过的词表），
 *    先 `await refreshLexicons()`（那步要连库）。
 */
import {
  ensureHotline,
  checkUserContent,
} from "../lib/content-guard.js";
import { matchCrisis, matchStress, needsSafeMode } from "../lib/lexicon-store.js";

let pass = 0;
let fail = 0;

function check(ok, label, extra = "") {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}${extra ? `  ← ${extra}` : ""}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

/* ============================================================ 误报：必须不命中 */

section("误报回归（日常表达，一个都不许命中）");

const MUST_NOT_HIT = [
  "笑死了",
  "累死了",
  "热死了",
  "困死了",
  "死党",
  "死宅",
  "死心",
  "我的焦虑消失了",
  "这份工作让我累死",
  "气死我了",
  "烦死了",
  "好想睡觉",
  "这题难死了",
  // ⚠️ 下面这几条是「死 X」构词的情况 —— 「死」是词头，不是危机信号。
  //    它们曾经全部误报（前缀「想」「要」+ 后缀「死」距离 0 就命中）。
  //    用户实际报的就是「我想死磕这对 cp」这一条。
  "我想死磕这对cp",
  "我要死磕到底",
  "要死线了",
  "他要死记硬背",
  "这项目要死机了",
  "想死守这个位置",
];

for (const text of MUST_NOT_HIT) {
  const crisis = matchCrisis(text);
  check(!crisis.hit, `「${text}」不判危机`, crisis.hit ? `匹配到了「${crisis.label}」` : "");
}

/* ============================================================ 漏报：必须命中 */

section("漏报回归（真的要拦住）");

const MUST_HIT = [
  ["想死了", false],
  ["我想死", false],
  // ⚠️ 下面这两条和「我想死磕这对 cp」**只差一个字，必须命中** ——
  //    它们是"构词排除"那张表不能做宽的边界：多排除一个字就会漏掉真危机。
  ["我想死了", false],
  ["我想死，真的", false],
  ["不想活了", false],
  ["活着没意思", false],
  ["我准备跳楼", false],
  ["打算烧炭", false],
  ["买了安眠药", false],
  ["我写了遗书", true],
  ["不想活了，今晚就走", true],
];

for (const [text, urgentWanted] of MUST_HIT) {
  const crisis = matchCrisis(text);
  check(crisis.hit, `「${text}」判危机`);
  if (crisis.hit) {
    check(
      crisis.urgent === urgentWanted,
      `「${text}」紧迫性 = ${urgentWanted ? "紧迫（截断）" : "非紧迫（安全模式）"}`,
      `实际 urgent=${crisis.urgent}`
    );
  }
}

/* ============================================================ 三层优先级 */

section("统一检测层优先级");

{
  const onlyStress = await checkUserContent("最近工作压力好大，天天加班");
  check(!onlyStress.blocked && !onlyStress.safeMode, "只有压力词 → 不进安全模式，不截断");

  const safe = await checkUserContent("我想死");
  check(safe.safeMode && !safe.blocked, "非紧迫危机 → 安全模式（不截断）");

  const urgent = await checkUserContent("我今晚就准备跳楼");
  check(urgent.blocked && !urgent.safeMode, "紧迫危机 → 截断");

  const daily = await checkUserContent("今天好累，笑死了");
  check(!daily.safeMode && !daily.blocked, "日常表达 → 什么都不是");
}

/* ============================================================ 压力词分层 */

section("压力词三档（只影响压力值，不影响安全判定）");

{
  const mild = matchStress("有点焦虑");
  check(mild.delta > 0, "轻度词能加到分", `delta=${mild.delta}`);

  // ⚠️ 压力词**不该**让消息进安全模式
  const s = needsSafeMode("压力好大，焦虑到睡不着");
  check(!s.safeMode, "压力词不会触发安全模式");
}

/* ============================================================ 热线兜底 */

section("输出侧兜底（热线是底线）");

{
  const without = ensureHotline("我理解你的感受，我们慢慢说。");
  check(without.includes("400-161-9995"), "没提到热线 → 自动追加");

  const withDash = ensureHotline("可以打 400-161-9995。");
  check(withDash === "可以打 400-161-9995。", "已提到（带横线）→ 不重复追加");

  const withPlain = ensureHotline("可以打 4001619995。");
  check(withPlain === "可以打 4001619995。", "已提到（不带横线）→ 不重复追加");

  check(ensureHotline("") === "", "空回复不追加");
}

/* ============================================================ 总结 */

console.log("\n" + "═".repeat(52));
console.log(`  通过 ${pass} ／ 失败 ${fail}`);
console.log(fail === 0 ? "  ✅ 全部通过" : "  ❌ 有失败项，别部署");
console.log("═".repeat(52) + "\n");

process.exit(fail === 0 ? 0 : 1);
