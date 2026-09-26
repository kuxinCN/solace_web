/**
 * 后台「统一词表」接口（安全词 + 压力词）。
 *
 * ⚠️ 这个接口是给**现有的「内容安全」页面**用的 —— 词表管理就该和
 *    自伤/伤人/违法那三张表待在一起，不另开一个页面：
 *    管理员要改"什么话会被拦"，眼里应该只有一个地方。
 *
 * ⚠️ 安全词的三张表（selfHarm / harmOthers / illegal）**不允许被清空** ——
 *    空表意味着这类风险完全不再识别，那是比"误判"严重得多的事故。
 *
 * ⚠️ 改完必须调 `refreshLexicons()` —— 词表是**预编译在内存里的**，
 *    不重编译的话改动不会生效（缓存不会自己失效）。
 */
import { NextResponse } from "next/server";
import { getAdminFromRequest } from "@/lib/admin-auth";
import {
  DEFAULT_GROUPS,
  SAFETY_GROUP_IDS,
  getGroup,
  listGroups,
  refreshLexicons,
  upsertGroup,
  validateContent,
  needsSafeMode,
  matchStress,
} from "@/lib/lexicon-store.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 词数组的清洗：去空、去重、去首尾空格 */
function cleanList(content) {
  const seen = new Set();
  const out = [];
  for (const raw of content || []) {
    const word = String(raw || "").trim();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

/** 短语对数组的清洗：前缀/后缀各自去空去重；空组丢掉 */
function cleanPairs(content) {
  const out = [];
  for (const item of content || []) {
    if (Array.isArray(item?.phrase)) {
      const phrase = cleanList(item.phrase);
      if (phrase.length) out.push({ phrase });
      continue;
    }
    const prefix = cleanList(item?.prefix || []);
    const suffix = cleanList(item?.suffix || []);
    if (!prefix.length || !suffix.length) continue;
    out.push({ prefix, suffix });
  }
  return out;
}

/* ------------------------------------------------------------------ GET */

export async function GET(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: "请先登录后台" }, { status: 401 });

  const groups = await listGroups();

  // 附上"这是不是安全词表" —— 前端据此决定要不要做二次确认
  const shaped = groups.map((group) => ({
    ...group,
    safety: SAFETY_GROUP_IDS.includes(group.id),
    // ⚠️ 空的上下文短语对在界面里没法表达，提示一下管理员
    empty: !Array.isArray(group.content) || group.content.length === 0,
  }));

  // ⚠️ 疑似词列表一起返回 —— 它就挂在词表下面，不该再多发一个请求。
  //    动态 import：词表页是低频操作，不值得为它把 suspected-store 拖进主依赖链。
  let suspected = [];
  try {
    const mod = await import("@/lib/suspected-store.js");
    suspected = await mod.listSuspected({ limit: 200 });
  } catch {
    suspected = [];
  }

  return NextResponse.json({
    ok: true,
    groups: shaped,
    suspected,
    safetyIds: SAFETY_GROUP_IDS,
    formatHint:
      "安全词（自伤倾向）编辑的是「上下文短语对」：前缀词和后缀词要在 6 个字以内同时出现才算命中。" +
      "⚠️ 单个字（如「死」）不能作为独立词条，否则会误伤「笑死了」「累死了」—— 放在前后缀对里是安全的。",
  });
}

/* ----------------------------------------------------------------- POST */

export async function POST(request) {
  const admin = await getAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: "请先登录后台" }, { status: 401 });

  let body = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const action = String(body?.action || "save");

  /* ---------------- 试一句：改完词表想知道会命中什么 ---------------- */
  if (action === "test") {
    const text = String(body?.text || "").slice(0, 500);
    if (!text.trim()) return NextResponse.json({ ok: false, error: "请输入要测试的句子" }, { status: 400 });

    const safety = needsSafeMode(text);
    const stress = matchStress(text);

    return NextResponse.json({
      ok: true,
      text,
      // ⚠️ 结果分三种：紧迫截断 / 安全模式 / 只算压力 / 什么都不是 —— 和线上逻辑一致
      result: safety.urgent
        ? { kind: "urgent", label: "紧迫危机（会被截断，返回干预话术 + 热线）" }
        : safety.safeMode
          ? { kind: "safeMode", label: `安全模式（正常回复 + 安全指令）· ${safety.crisis?.label || safety.safety?.label || ""}` }
          : stress.delta > 0
            ? { kind: "stress", label: `只算压力：+${stress.delta}（${stress.words.join("、")}）` }
            : { kind: "none", label: "没有任何命中" },
      stress,
    });
  }

  /* ---------------- 启用 / 停用 ---------------- */
  if (action === "toggle") {
    const group = await getGroup(body?.id);
    if (!group) return NextResponse.json({ ok: false, error: "找不到这个词表" }, { status: 404 });

    await upsertGroup({ ...group, enabled: body?.enabled !== false });
    await refreshLexicons();

    return NextResponse.json({ ok: true, id: group.id, enabled: body?.enabled !== false });
  }

  /* ---------------- 恢复内置默认 ---------------- */
  if (action === "reset") {
    const preset = DEFAULT_GROUPS.find((item) => item.id === String(body?.id || ""));
    if (!preset) return NextResponse.json({ ok: false, error: "这个词表没有内置默认值" }, { status: 404 });

    const current = await getGroup(preset.id);
    await upsertGroup({ ...preset, enabled: current?.enabled !== false, builtin: true });
    await refreshLexicons();

    return NextResponse.json({ ok: true, id: preset.id, content: preset.content });
  }

  /* ---------------- 保存词表内容 ---------------- */
  const id = String(body?.id || "").trim();
  if (!id) return NextResponse.json({ ok: false, error: "缺少词表 id" }, { status: 400 });

  const group = await getGroup(id);
  if (!group) return NextResponse.json({ ok: false, error: `没有叫「${id}」的词表` }, { status: 404 });

  const isSafety = SAFETY_GROUP_IDS.includes(id);
  const raw = Array.isArray(body?.content) ? body.content : [];
  const content = group.type === "contextPairs" ? cleanPairs(raw) : cleanList(raw);

  /* ⚠️ **安全词表不能被清空** —— 这是硬约束。
     空的危机词表 = 自伤表达完全不再被识别，比误判严重得多。
     如果确实想临时关掉，用「停用」而不是清空（停用是可逆的、后台看得见状态）。 */
  if (isSafety && !content.length) {
    return NextResponse.json(
      {
        ok: false,
        error: `「${group.label}」是安全词表，**不能清空**（那等于这类风险不再识别）。如果确实要临时关闭，请用「停用」。`,
      },
      { status: 400 }
    );
  }

  const valid = validateContent(group, content);
  if (!valid.ok) return NextResponse.json({ ok: false, error: valid.error }, { status: 400 });

  await upsertGroup({ ...group, content, enabled: group.enabled !== false });

  // ⚠️ 改完立刻重编译 —— 不然改动要等下次重启才生效
  await refreshLexicons();

  return NextResponse.json({
    ok: true,
    id,
    content,
    // 让前端能提示"从 N 条变成 M 条"
    count: content.length,
  });
}
