"use client";

import { useEffect, useState } from "react";
import FirstAid from "@/components/FirstAid";

/* ================= 题库 ================= */

// 性格倾向探索：24 题，4 个维度各 6 题（基于荣格类型学自拟，非 MBTI 官方题目）
// dim: 0=I/E  1=N/S  2=T/F  3=J/P；a 选项对应维度第一个字母
const P_QUESTIONS = [
  { dim: 0, q: "忙碌了一周的周末，你更想把时间：", a: "留给自己，一个人安静地待着", b: "约上朋友，出门热闹一下" },
  { dim: 0, q: "在一场聚会上，你通常会：", a: "和一两个人聊得比较深入", b: "和很多人都能聊得开心" },
  { dim: 0, q: "需要消化情绪的时候，你倾向于：", a: "自己一个人静静整理", b: "找个人说出来才舒服" },
  { dim: 0, q: "长时间待在热闹的人群里，你会感觉：", a: "有点累，需要独处恢复精力", b: "越待越有精神" },
  { dim: 0, q: "遇到开心的事，你的第一反应是：", a: "自己先细细品味一会儿", b: "马上分享给身边的人" },
  { dim: 0, q: "来到一个新环境，你更常是：", a: "先在旁边观察，慢慢融入", b: "很快就能和大家打成一片" },
  { dim: 1, q: "听别人讲一件事，你更容易注意到：", a: "背后的含义和可能性", b: "具体的细节和事实" },
  { dim: 1, q: "你的白日梦更多是关于：", a: "对未来的想象和种种可能", b: "现实中具体的人和事" },
  { dim: 1, q: "学新东西时，你更喜欢：", a: "先弄懂整体框架和原理", b: "一步一步按部就班地练" },
  { dim: 1, q: "你希望别人夸你：", a: "想法独特、有创意", b: "靠谱踏实、把事做得漂亮" },
  { dim: 1, q: "看到一段文字，你的大脑会：", a: "自动联想到画面和隐喻", b: "记住关键信息本身" },
  { dim: 1, q: "你更愿意相信：", a: "直觉带给你的感觉", b: "被亲身经验验证过的事" },
  { dim: 2, q: "朋友向你倾诉烦恼，你的第一反应是：", a: "帮他分析问题出在哪里", b: "先安慰他的感受" },
  { dim: 2, q: "做决定时，你更看重：", a: "逻辑上是否站得住脚", b: "大家的感受是否舒服" },
  { dim: 2, q: "看电影最打动你的时刻，往往是：", a: "情节或设定设计得巧妙", b: "人物情感带来的共鸣" },
  { dim: 2, q: "被批评的时候，你会先想：", a: "对方说得有没有道理", b: "对方是不是对我有意见" },
  { dim: 2, q: "小组讨论起了争执，你更倾向：", a: "把事实和道理捋清楚", b: "先照顾气氛，让大家舒服" },
  { dim: 2, q: "你觉得更让人为难的是：", a: "明知不对却什么也不说", b: "话说得太直，伤了人" },
  { dim: 3, q: "出门旅行，你更喜欢：", a: "提前做好攻略和计划", b: "随性走走，看到哪算哪" },
  { dim: 3, q: "你的待办清单通常是：", a: "列得清清楚楚，逐项打勾", b: "大概有个想法，看心情来" },
  { dim: 3, q: "计划突然被打乱，你会：", a: "有点不安，想尽快重新安排", b: "还好，反正总会有办法" },
  { dim: 3, q: "面对任务截止日期，你倾向：", a: "提前完成，心里才踏实", b: "在期限前冲刺，灵感反而更多" },
  { dim: 3, q: "你的桌面或房间更接近：", a: "各归其位，整齐有序", b: "乱中有序，反正我知道东西在哪" },
  { dim: 3, q: "面对需要做选择的事，你更喜欢：", a: "尽早定下来，不再纠结", b: "保持开放，再多看看" },
];

const P_DIM_LETTERS = [
  ["I", "E"],
  ["N", "S"],
  ["T", "F"],
  ["J", "P"],
];

// 16 型：类型 → [名称, 描述（80 字内）]
const TYPE_INFO = {
  INFP: ["调停者", "你心里有一片柔软的世界，重视真实的感受与意义，安静却有力量。愿你也常常被自己温柔以待。"],
  INFJ: ["提倡者", "你敏锐而体贴，总能察觉别人没说出口的情绪。也请记得，你的感受同样值得被认真对待。"],
  INTP: ["逻辑学家", "你喜欢想清楚再行动，脑子里总有无数问题在发芽。偶尔放下逻辑，纯然感受当下也很好。"],
  INTJ: ["建筑师", "你目标清晰、思维独立，习惯把世界拆解成系统。允许计划之外的小意外，也是一种自由。"],
  ISFP: ["探险家", "你安静地感受世界的美，用行动而非语言表达在意。你的温柔，是很多人心里的一束光。"],
  ISFJ: ["守卫者", "你细心可靠，总在默默照顾身边的人。这一次，也请把自己放进被照顾的名单里。"],
  ISTP: ["鉴赏家", "你冷静务实，动手能力强，遇事不慌。留一点时间给感受，它们同样值得被看见。"],
  ISTJ: ["物流师", "你踏实守诺，是大家信赖的定心丸。偶尔松开日程表，让生活透进一点意外的风。"],
  ENFP: ["竞选者", "你的热情有感染力，好奇心带你奔赴各种可能。也请留一些安静时刻，给自己回回血。"],
  ENFJ: ["主人公", "你天生会照顾人，愿意托住身边的情绪。记得先接住自己，再去接住别人。"],
  ENTP: ["辩论家", "你脑子转得快，喜欢新鲜的观点与挑战。偶尔不争对错，只是感受，也会很舒服。"],
  ENTJ: ["指挥官", "你目标感强，天生带着行动力。偶尔慢下来，不设目标地度过一天，也是很好的休息。"],
  ESFP: ["表演者", "你把快乐带给身边所有人，活在鲜活的当下。情绪低落时，也允许自己安静一会儿。"],
  ESFJ: ["执政官", "你热心周到，总把大家安排得妥妥当当。你的辛苦，值得被看见和感谢。"],
  ESTP: ["企业家", "你行动果敢，越有挑战越有精神。停下来喘口气不丢人，那是必要的充电。"],
  ESTJ: ["总经理", "你可靠高效，擅长把混乱变成秩序。允许自己偶尔不做决定，只去感受。"],
};

// PHQ-9（9 题）+ GAD-7（7 题）：近两周情绪自评
const PHQ9_QUESTIONS = [
  "做事时提不起劲或没有兴趣",
  "感到心情低落、沮丧或绝望",
  "入睡困难、睡不安稳或睡眠过多",
  "感觉疲倦或没有活力",
  "食欲不振或吃得太多",
  "觉得自己很糟，或觉得自己很失败",
  "对事物难以集中注意力，例如阅读时",
  "动作或说话变慢到别人能察觉，或相反——烦躁、坐立不安",
  "有「不如消失」或伤害自己的念头",
];
const GAD7_QUESTIONS = [
  "感觉紧张、焦虑或急切",
  "不能停止或控制担忧",
  "对各种各样的事情担忧过多",
  "很难放松下来",
  "由于不安而无法静静坐着",
  "变得容易烦恼或急躁",
  "感到似乎将有可怕的事情发生而害怕",
];
const MOOD_OPTIONS = [
  { label: "完全没有", score: 0 },
  { label: "有几天", score: 1 },
  { label: "一半以上时间", score: 2 },
  { label: "几乎每天", score: 3 },
];

function phqFeedback(score) {
  if (score <= 4) return "最近情绪比较平稳。";
  if (score <= 9) return "最近可能有些低落，给自己多一点空间。";
  if (score <= 14) return "这段时间你承受了不少，愿意的话找人聊聊。";
  return "你现在的感受很重要，请务必联系信任的人或拨打 400-161-9995。";
}
function gadFeedback(score) {
  if (score <= 4) return "焦虑感不明显。";
  if (score <= 9) return "有些紧张，试着做几次深呼吸。";
  if (score <= 14) return "焦虑感比较明显，试着和信任的人聊聊。";
  return "建议寻求专业支持，拨打 400-161-9995。";
}

/* ================= 本地存储 ================= */

function loadHistory() {
  const read = (key) => {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : null;
    } catch (e) {
      return null;
    }
  };
  return {
    personality: read("solace_personality_result"),
    phq9: read("solace_phq9_result"),
    gad7: read("solace_gad7_result"),
  };
}

const todayCN = () => new Date().toLocaleDateString("zh-CN");

/* ================= 组件 ================= */

export default function HealingCottage() {
  // mode: null=小屋首页 | "personality" | "mood"
  const [mode, setMode] = useState(null);

  // 性格倾向探索
  const [pStep, setPStep] = useState(0);
  const [pAnswers, setPAnswers] = useState([]);
  const [pResult, setPResult] = useState(null);

  // 情绪状态自评（0-8 为 PHQ-9，9-15 为 GAD-7）
  const [mStep, setMStep] = useState(0);
  const [mAnswers, setMAnswers] = useState([]);
  const [mResult, setMResult] = useState(null);

  // 历史结果
  const [history, setHistory] = useState({
    personality: null,
    phq9: null,
    gad7: null,
  });

  // 进入页面时读取历史结果
  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  /* ---------- 性格倾向探索 ---------- */

  function startPersonality() {
    setPStep(0);
    setPAnswers([]);
    setPResult(null);
    setMode("personality");
  }

  function answerPersonality(choice) {
    const next = [...pAnswers];
    next[pStep] = choice;
    setPAnswers(next);
    if (pStep === P_QUESTIONS.length - 1) {
      // 计算 4 维度倾向：每维度 6 题，A 计数 >= 4 取 A 字母
      const letters = P_DIM_LETTERS.map((pair, di) => {
        let countA = 0;
        for (let i = 0; i < 6; i++) {
          if (next[di * 6 + i] === "A") countA++;
        }
        return countA >= 4 ? pair[0] : pair[1];
      });
      const type = letters.join("");
      const [name, desc] =
        TYPE_INFO[type] || ["探索者", "每个人都有独特的性格组合，这是一次认识自己的小小旅行。"];
      const result = { date: todayCN(), type, name, desc };
      try {
        localStorage.setItem("solace_personality_result", JSON.stringify(result));
      } catch (e) {}
      setPResult(result);
      setHistory((h) => ({ ...h, personality: result }));
    } else {
      setTimeout(() => setPStep(pStep + 1), 180);
    }
  }

  function backPersonality() {
    if (pStep > 0) setPStep(pStep - 1);
    else setMode(null);
  }

  /* ---------- 情绪状态自评 ---------- */

  function startMood() {
    setMStep(0);
    setMAnswers([]);
    setMResult(null);
    setMode("mood");
  }

  function answerMood(score) {
    const next = [...mAnswers];
    next[mStep] = score;
    setMAnswers(next);
    if (mStep === 15) {
      const phq = next.slice(0, 9).reduce((a, b) => a + (b || 0), 0);
      const gad = next.slice(9).reduce((a, b) => a + (b || 0), 0);
      const date = todayCN();
      const pRes = { date, score: phq };
      const gRes = { date, score: gad };
      try {
        localStorage.setItem("solace_phq9_result", JSON.stringify(pRes));
        localStorage.setItem("solace_gad7_result", JSON.stringify(gRes));
      } catch (e) {}
      setMResult({ phq: pRes, gad: gRes });
      setHistory((h) => ({ ...h, phq9: pRes, gad7: gRes }));
    } else {
      setTimeout(() => setMStep(mStep + 1), 180);
    }
  }

  function backMood() {
    if (mStep > 0) setMStep(mStep - 1);
    else setMode(null);
  }

  /* ---------- 渲染 ---------- */

  const cardBase =
    "bg-white rounded-2xl shadow-sm border border-[#e8eae7]";
  const optBase =
    "w-full text-left border rounded-xl px-4 py-3 text-sm text-slate-700 transition-all duration-150 border-[#e8eae7] bg-white hover:bg-[#eef4f6] hover:border-[#a9c6da] active:scale-[0.99] flex items-center gap-3";
  const badgeBase =
    "w-7 h-7 shrink-0 rounded-lg bg-[#eef4f6] text-[#5b8aa6] flex items-center justify-center text-xs font-bold";

  // 进度条
  function Progress({ current, total }) {
    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-slate-400">
            第 {current + 1} / {total} 题
          </p>
          <p className="text-xs text-slate-400">
            {Math.round(((current + 1) / total) * 100)}%
          </p>
        </div>
        <div className="h-1.5 rounded-full bg-[#eef1f2] overflow-hidden">
          <div
            className="h-full bg-[#7fa8c4] rounded-full transition-all duration-300"
            style={{ width: `${((current + 1) / total) * 100}%` }}
          />
        </div>
      </div>
    );
  }

  /* ---------- 测评视图 ---------- */

  if (mode === "personality") {
    return (
      <div className={cardBase + " p-5 md:p-6"}>
        <style>{`@keyframes hcFade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}.hc-fade{animation:hcFade .25s ease}`}</style>
        {pResult ? (
          /* 性格测试结果页 */
          <div className="hc-fade text-center py-2">
            <p className="text-xs text-slate-400 mb-3">你的性格倾向</p>
            <p className="text-4xl font-bold text-[#5b8aa6] tracking-wide">
              {pResult.type}
            </p>
            <p className="text-lg text-slate-700 mt-1">{pResult.name}</p>
            <p className="text-sm text-slate-600 leading-7 mt-4 max-w-md mx-auto">
              {pResult.desc}
            </p>
            <p className="text-xs text-slate-400 mt-4">
              测评日期：{pResult.date}
            </p>
            <div className="flex gap-2 justify-center mt-5">
              <button
                onClick={startPersonality}
                className="border border-[#7fa8c4] bg-[#7fa8c4] text-white rounded-lg px-4 py-2 text-sm hover:bg-[#6b98b4] active:scale-[0.98] transition-all duration-150"
              >
                重新测试
              </button>
              <button
                onClick={() => setMode(null)}
                className="border border-[#d5d9d7] bg-[#fdfdfc] text-slate-500 rounded-lg px-4 py-2 text-sm hover:bg-[#eef1f2] active:scale-[0.98] transition-all duration-150"
              >
                返回小屋
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-5 border-t border-[#e8eae7] pt-3">
              本测试基于荣格类型学理论，供自我探索参考，非 MBTI 官方测试。
            </p>
          </div>
        ) : (
          /* 性格测试答题页 */
          <div>
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm font-bold text-slate-800">性格倾向探索</p>
              <button
                onClick={() => setMode(null)}
                className="text-xs text-slate-400 hover:text-slate-600 transition-colors duration-150"
              >
                退出
              </button>
            </div>
            <Progress current={pStep} total={P_QUESTIONS.length} />
            <div key={pStep} className="hc-fade mt-5">
              <p className="text-base text-slate-800 leading-7 mb-4">
                {P_QUESTIONS[pStep].q}
              </p>
              <div className="space-y-2.5">
                <button onClick={() => answerPersonality("A")} className={optBase}>
                  <span className={badgeBase}>A</span>
                  {P_QUESTIONS[pStep].a}
                </button>
                <button onClick={() => answerPersonality("B")} className={optBase}>
                  <span className={badgeBase}>B</span>
                  {P_QUESTIONS[pStep].b}
                </button>
              </div>
            </div>
            <button
              onClick={backPersonality}
              className="mt-5 text-xs text-slate-400 hover:text-slate-600 transition-colors duration-150"
            >
              {pStep > 0 ? "← 返回上一题" : "← 返回小屋"}
            </button>
          </div>
        )}
      </div>
    );
  }

  if (mode === "mood") {
    const inPhq = mStep < 9;
    return (
      <div className={cardBase + " p-5 md:p-6"}>
        <style>{`@keyframes hcFade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}.hc-fade{animation:hcFade .25s ease}`}</style>
        {mResult ? (
          /* 情绪自评结果页 */
          <div className="hc-fade">
            <p className="text-center text-xs text-slate-400 mb-4">
              你的情绪自评结果
            </p>
            <div
              className={`rounded-xl border p-4 mb-3 ${
                mResult.phq.score >= 15
                  ? "border-[#f0c8a8] bg-[#fdf6ef]"
                  : "border-[#e8eae7] bg-[#fafcfb]"
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <p className="text-sm font-bold text-slate-700">
                  情绪低落自评（PHQ-9）
                </p>
                <p className="text-xl font-bold text-[#5b8aa6]">
                  {mResult.phq.score}
                  <span className="text-xs text-slate-400 font-normal"> 分</span>
                </p>
              </div>
              <p className="text-sm text-slate-600 leading-6">
                {phqFeedback(mResult.phq.score)}
              </p>
            </div>
            <div
              className={`rounded-xl border p-4 mb-4 ${
                mResult.gad.score >= 15
                  ? "border-[#f0c8a8] bg-[#fdf6ef]"
                  : "border-[#e8eae7] bg-[#fafcfb]"
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <p className="text-sm font-bold text-slate-700">
                  焦虑自评（GAD-7）
                </p>
                <p className="text-xl font-bold text-[#5b8aa6]">
                  {mResult.gad.score}
                  <span className="text-xs text-slate-400 font-normal"> 分</span>
                </p>
              </div>
              <p className="text-sm text-slate-600 leading-6">
                {gadFeedback(mResult.gad.score)}
              </p>
            </div>
            <p className="text-xs text-slate-400 text-center">
              测评日期：{mResult.phq.date}
            </p>
            <div className="flex gap-2 justify-center mt-4">
              <button
                onClick={startMood}
                className="border border-[#7fa8c4] bg-[#7fa8c4] text-white rounded-lg px-4 py-2 text-sm hover:bg-[#6b98b4] active:scale-[0.98] transition-all duration-150"
              >
                重新测试
              </button>
              <button
                onClick={() => setMode(null)}
                className="border border-[#d5d9d7] bg-[#fdfdfc] text-slate-500 rounded-lg px-4 py-2 text-sm hover:bg-[#eef1f2] active:scale-[0.98] transition-all duration-150"
              >
                返回小屋
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-5 text-center border-t border-[#e8eae7] pt-3">
              本自评仅用于情绪觉察，不构成医学诊断。如有持续困扰，请寻求专业帮助。
            </p>
          </div>
        ) : (
          /* 情绪自评答题页 */
          <div>
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm font-bold text-slate-800">情绪状态自评</p>
              <button
                onClick={() => setMode(null)}
                className="text-xs text-slate-400 hover:text-slate-600 transition-colors duration-150"
              >
                退出
              </button>
            </div>
            <Progress current={mStep} total={16} />
            <p className="text-xs text-[#5b8aa6] mt-4 mb-2">
              {inPhq
                ? "情绪低落自评（PHQ-9）"
                : "焦虑自评（GAD-7）"}
              {" · 过去两周里，你被以下问题困扰的频率是？"}
            </p>
            <div key={mStep} className="hc-fade">
              <p className="text-base text-slate-800 leading-7 mb-4">
                {inPhq ? PHQ9_QUESTIONS[mStep] : GAD7_QUESTIONS[mStep - 9]}
              </p>
              <div className="space-y-2.5">
                {MOOD_OPTIONS.map((o) => (
                  <button
                    key={o.score}
                    onClick={() => answerMood(o.score)}
                    className={optBase}
                  >
                    <span className={badgeBase}>{o.score}</span>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={backMood}
              className="mt-5 text-xs text-slate-400 hover:text-slate-600 transition-colors duration-150"
            >
              {mStep > 0 ? "← 返回上一题" : "← 返回小屋"}
            </button>
          </div>
        )}
      </div>
    );
  }

  /* ---------- 小屋首页 ---------- */

  return (
    <div className="space-y-4">
      {/* 标题区 */}
      <div className="text-center py-2">
        <h1 className="text-2xl font-bold text-slate-800">
          🏠 治愈小屋
        </h1>
        <p className="text-sm text-slate-400 mt-1">慢下来，陪自己一会儿。</p>
      </div>

      {/* 原有功能：呼吸放松 / 蝴蝶拍 / 安全提示 */}
      <FirstAid />

      {/* 测评区 */}
      <p className="text-sm font-bold text-slate-700 px-1 pt-1">小测评</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 性格倾向探索 */}
        <div className={cardBase + " p-4 flex flex-col"}>
          <p className="text-sm font-bold text-slate-800 mb-1">
            性格倾向探索
          </p>
          <p className="text-xs text-slate-400 mb-3">
            24 道小题，认识一下自己的性格组合
          </p>
          <div className="flex-1 rounded-xl bg-[#fafcfb] border border-[#eef1f2] px-3 py-2.5 mb-3">
            {history.personality ? (
              <>
                <p className="text-sm text-slate-700">
                  最近一次：
                  <span className="font-bold text-[#5b8aa6]">
                    {history.personality.type}
                  </span>{" "}
                  {history.personality.name}
                </p>
                <p className="text-xs text-slate-400 mt-0.5">
                  {history.personality.date}
                </p>
              </>
            ) : (
              <p className="text-xs text-slate-400 leading-5">
                还没有测过，从一道道小问题开始认识自己吧。
              </p>
            )}
          </div>
          <button
            onClick={startPersonality}
            className="w-full border border-[#7fa8c4] bg-[#7fa8c4] text-white rounded-lg py-2 text-sm font-medium hover:bg-[#6b98b4] active:scale-[0.99] transition-all duration-150"
          >
            {history.personality ? "重新测试" : "开始测试"}
          </button>
        </div>

        {/* 情绪状态自评 */}
        <div className={cardBase + " p-4 flex flex-col"}>
          <p className="text-sm font-bold text-slate-800 mb-1">
            情绪状态自评
          </p>
          <p className="text-xs text-slate-400 mb-3">
            PHQ-9 + GAD-7 共 16 题，觉察近两周的情绪
          </p>
          <div className="flex-1 rounded-xl bg-[#fafcfb] border border-[#eef1f2] px-3 py-2.5 mb-3 space-y-1">
            {history.phq9 ? (
              <p className="text-xs text-slate-600">
                PHQ-9：
                <span className="font-bold text-[#5b8aa6]">
                  {history.phq9.score} 分
                </span>
                <span className="text-slate-400 ml-1">
                  {history.phq9.date}
                </span>
              </p>
            ) : (
              <p className="text-xs text-slate-400">PHQ-9：未测</p>
            )}
            {history.gad7 ? (
              <p className="text-xs text-slate-600">
                GAD-7：
                <span className="font-bold text-[#5b8aa6]">
                  {history.gad7.score} 分
                </span>
                <span className="text-slate-400 ml-1">{history.gad7.date}</span>
              </p>
            ) : (
              <p className="text-xs text-slate-400">GAD-7：未测</p>
            )}
          </div>
          <button
            onClick={startMood}
            className="w-full border border-[#7fa8c4] bg-[#7fa8c4] text-white rounded-lg py-2 text-sm font-medium hover:bg-[#6b98b4] active:scale-[0.99] transition-all duration-150"
          >
            {history.phq9 || history.gad7 ? "重新测试" : "开始测试"}
          </button>
        </div>
      </div>
    </div>
  );
}
