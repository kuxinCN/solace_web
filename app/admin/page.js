"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ConfirmModal from "@/components/ConfirmModal";
import ContentReviewPanel from "@/components/ContentReviewPanel";
import DiaryTaskPanel from "@/components/DiaryTaskPanel";
import FloatingAlert from "@/components/FloatingAlert";
import KeywordManager from "@/components/KeywordManager";
import StickerPanel from "@/components/StickerPanel";
import PortraitPanel from "@/components/PortraitPanel";
import ScaleManagerPanel from "@/components/ScaleManagerPanel";
import StressDiagnosePanel from "@/components/StressDiagnosePanel";

/* ------------------------------------------------------------------ 样式 */

const inputClass =
  "w-full border border-[#ebe3dc] bg-white px-3.5 py-2 text-sm text-slate-800 placeholder-slate-400 rounded-xl transition-all duration-150 focus:outline-none focus:border-[#e2a68c] focus:ring-2 focus:ring-[#e2a68c]/20 shadow-2xs";

const btnBase =
  "border border-[#ebe3dc] bg-[#FAF8F5] text-slate-700 rounded-xl px-3.5 py-2 text-sm font-medium hover:bg-white hover:text-slate-900 hover:border-[#dfd6ce] active:bg-[#f3ebe4] active:scale-[0.98] transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed shadow-2xs cursor-pointer";

const btnPrimary =
  "border border-[#b85a3c] bg-gradient-to-r from-[#c06b50] to-[#b85a3c] text-white rounded-xl px-4 py-2 text-sm font-medium hover:from-[#b05f45] hover:to-[#a84f33] active:scale-[0.98] transition-all duration-150 shadow-sm shadow-[#b85a3c]/15 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer";

const cardClass = "bg-white border border-[#eee4dc] rounded-2xl p-5 shadow-xs transition-shadow duration-200 hover:shadow-sm";

/* -------------------------------------------------------------- API 封装 */

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const error = new Error(data?.error || `请求失败（HTTP ${res.status}）`);
    error.status = res.status;
    throw error;
  }
  return data || {};
}

/* ------------------------------------------------------------ 字段定义表 */

const FIELDS = {
  ai: [
    { key: "enabled", label: "启用对话 AI", type: "boolean", hint: "关闭后 /api/chat 只会返回兜底文案" },
    {
      key: "baseUrl",
      label: "接口地址（OpenAI 协议）",
      type: "text",
      hint: "填到版本目录即可（如 https://api.xiaomimimo.com/v1），也支持直接粘官方文档给的完整地址（…/v1/chat/completions），程序会自动识别。例：智谱 https://open.bigmodel.cn/api/paas/v4 ｜ DeepSeek https://api.deepseek.com/v1 ｜ OpenAI https://api.openai.com/v1",
    },
    {
      key: "apiKey",
      label: "API Key（OpenAI 协议）",
      type: "secret",
      hint: "⚠️ 这里填的必须是「OpenAI 兼容协议」的 Key：智谱、DeepSeek、通义、Moonshot、OpenAI 官方等都支持。不是 OpenAI 协议的厂商（接口路径/请求体格式不同）直接填这里会报错",
    },
    {
      key: "model",
      label: "模型名",
      type: "datalist",
      optionsKey: "aiModels",
      hint: "可以点下方「拉取可用模型」自动获取后选择，也可以直接手动输入。例：deepseek-v4.1-flash-1017、deepseek-chat、glm-4-flash",
    },
    { key: "temperature", label: "温度（0-2）", type: "number", step: "0.1" },
    { key: "maxTokens", label: "最大回复长度", type: "number" },
    { key: "timeoutSeconds", label: "超时（秒）", type: "number" },
    {
      key: "timeSource",
      label: "时间感知基准",
      type: "select",
      options: [
        { value: "client", label: "用户设备本地时间（推荐，精准感知用户时区与作息）" },
        { value: "server", label: "服务器时间（以服务端当前系统时钟为准）" },
      ],
      hint: "向 AI 注入当前年月日、星期几、时间与时段（深夜/清晨/下午等）。选用户本地时间可避免跨时区偏差。",
    },
    { key: "provider", label: "服务商备注", type: "text", hint: "仅作记录，不影响调用" },
    {
      key: "systemPrompt",
      label: "AI 人设模块（默认中性）",
      type: "textarea",
      rows: 8,
      hint: "只需定义中性挚友的 Role、核心陪伴策略与口吻；公共底座（红线、微信气泡短句、禁思考链）会自动在后端拼接追加。留空使用内置出厂人设。",
    },
    {
      key: "systemPromptMale",
      label: "AI 人设模块（男性老友）",
      type: "textarea",
      rows: 8,
      hint: "用户选「他」时生效。只需定义沉稳老兄弟的定位与口吻风格，公共底座会自动拼接。留空回退默认人设。",
    },
    {
      key: "systemPromptFemale",
      label: "AI 人设模块（女性闺蜜）",
      type: "textarea",
      rows: 8,
      hint: "用户选「她」时生效。只需定义温柔知心闺蜜的定位与口吻风格，公共底座会自动拼接。留空回退默认人设。",
    },
    {
      key: "systemPromptBase",
      label: "公共规则底座（红线与气泡铁律）",
      type: "textarea",
      rows: 8,
      hint: "所有性别人格共用的底座模块（包含不诊断、不说教、微信气泡短句换行、禁思维链、记忆标记等）。留空则使用内置出厂标准底座。",
    },
    {
      key: "diaryPrompt",
      label: "读日记时的附加提示词",
      type: "textarea",
      rows: 4,
      hint: "用户写完日记后，这段文字会和日记正文一起发给 AI。用 {diary} 表示日记正文的位置。",
    },
  ],
  music: [
    { key: "enabled", label: "启用背景音乐", type: "boolean", hint: "关闭后用户端不显示播放器" },
    {
      key: "source",
      label: "当前音源",
      type: "select",
      options: [
        { value: "local", label: "本地歌单（本地上传 + 外链直链，支持自动播放与切歌）" },
        { value: "netease", label: "网易云收藏（官方外链播放器，不能自动播放/切歌）" },
      ],
      hint: "随时可在两者间切换；两种歌单可以同时维护，切过去即可生效",
    },
    {
      key: "autoPlay",
      label: "首次交互后自动播放",
      type: "boolean",
      hint: "浏览器禁止页面一加载就出声，所以实际行为是「用户第一次点击后」开始播",
    },
    { key: "defaultVolume", label: "默认音量（0-1）", type: "number", step: "0.1" },
    {
      key: "autoFallback",
      label: "网易云访问不了时自动降级到本地歌单",
      type: "boolean",
      hint: "音源选「网易云收藏」时，前端会先探测用户能否访问 music.163.com；访问不了就自动切回本地歌单，避免浮窗一片空白",
    },
  ],
  pet: [
    {
      key: "enabled",
      label: "启用桌宠（蓝蝴蝶）",
      type: "boolean",
      hint: "关闭后用户端不再显示蝴蝶。形象库、情绪选项、回复话术都会保留，重新打开即恢复",
    },
    {
      key: "size",
      label: "显示边长（px，40-160）",
      type: "number",
      hint: "⚠️ 这个数字同时参与蝴蝶的初始定位、拖动边界、气泡位置、飞行目标四处计算 —— 调大之后小屏手机上更容易贴边",
    },
    {
      key: "lineRepeatHours",
      label: "同一句回复多久内不重复（小时，0 = 不限制）",
      type: "number",
      hint: "点中一条情绪后，桌宠会从这条情绪的回复里随机挑一句；这个时间内说过的最近几句不会再出现（记录存在用户浏览器本地，不落库、不发请求）",
    },
    {
      type: "section",
      key: "_secPetContent",
      label: "形象 / 情绪 / 话术",
      hint: "下面的面板管这三样：形象库（多张可切换，含「当前用哪张」）、用户能点的情绪选项、每条情绪的回复话术",
    },
  ],
  sticker: [
    {
      key: "enabled",
      label: "启用表情包",
      type: "boolean",
      hint: "关闭后聊天不再自动发任何表情包（连情绪判定也不做）。分类与素材都会保留，重新打开即恢复",
    },
    {
      type: "section",
      key: "_secStickerContent",
      label: "分类与素材",
      hint: "下面的面板管两样：分类（= 情绪：关键词词表、优先级、深夜放宽、是否可主动发图）与每类的素材图片",
    },
  ],
  safety: [
    {
      type: "section",
      key: "_secContent",
      label: "① 内容安全过滤",
      hint: "拦截真正危险的内容（自伤 / 伤害他人 / 违法）—— 只拦这三类，不是敏感词过滤",
    },
    {
      key: "enabled",
      label: "启用内容安全过滤",
      type: "boolean",
      hint: "关闭后所有内容都会原样发给 AI（不建议关闭）",
    },
    /* ⚠️ 这里原本有三个「自定义追加词」文本框
       （extraSelfHarm / extraViolence / extraIllegal）——
       统一词表上线后**已撤掉**：同一个东西在两个地方编辑，
       改完一处还得记得改另一处，迟早会漏。

       现在词表的唯一编辑入口是下面的「统一词表」区（`components/KeywordManager.jsx`），
       那三个字段还保留着「启用内容安全过滤」开关，因为它是整层的总闸。

       ⚠️ 库里那三个字段的值**没有被删** —— 启动时会自动并进词表
       （见 `lib/lexicon-store.js` 的 `migrateLegacyExtraWords`），
       所以以前填过的词不会静默失效。 */

    /* ---------------- 压力评估 ---------------- */

    {
      type: "section",
      key: "_secStress",
      label: "② 压力评估与放松提醒",
      hint: "读用户的整体状态（聊天 + 日记双通道），压力偏高时在右上角温和地问一句「要不要放松」",
    },
    {
      key: "stressEnabled",
      label: "启用压力评估与放松提醒",
      type: "boolean",
      full: true,
      hint: "⚠️ 默认关闭。开启后：每 10 条消息（或命中关键词）做一次 AI 深度识别，压力连续偏高时弹出提醒卡。大部分判断由本地词表完成，Token 消耗很低",
    },
    {
      key: "stressThreshold",
      label: "提醒阈值（0-100）",
      type: "number",
      hint: "默认 70。用户自己还能在「压力设置」里再调；⚠️ 用户每次点「先不用」会自动 +5（最高 90）",
    },
    {
      key: "stressTimeoutSeconds",
      label: "深度识别超时（秒）",
      type: "number",
      hint: "默认 20。超时就放弃这次识别、继续用本地分数（不会阻塞用户）",
    },

    {
      type: "section",
      key: "_secLevels",
      label: "③ 压力值 → 情绪档位",
      hint: "⚠️ 这一段是**用户能看到的措辞**：提醒卡里会写「读到 78 分 · 压力很高」。语气要贴陪伴产品的调性，别写成诊断",
    },
    { key: "level1Max", label: "第 1 档 · 上限", type: "number", hint: "默认 40" },
    { key: "level1Label", label: "第 1 档 · 情绪名", type: "text", hint: "默认「很放松」" },
    { key: "level1Hint", label: "第 1 档 · 说明", type: "text", hint: "默认「读起来你现在挺稳的」" },
    { key: "level2Max", label: "第 2 档 · 上限", type: "number", hint: "默认 65" },
    { key: "level2Label", label: "第 2 档 · 情绪名", type: "text", hint: "默认「有点累」" },
    { key: "level2Hint", label: "第 2 档 · 说明", type: "text", hint: "默认「能感觉到一些疲惫」" },
    { key: "level3Max", label: "第 3 档 · 上限", type: "number", hint: "默认 85" },
    { key: "level3Label", label: "第 3 档 · 情绪名", type: "text", hint: "默认「压力偏高」" },
    { key: "level3Hint", label: "第 3 档 · 说明", type: "text", hint: "默认「这份沉有点压着你了」" },
    {
      key: "level4Label",
      label: "第 4 档 · 情绪名（最高档）",
      type: "text",
      hint: "默认「压力很高」。最高档不用填上限，它就是 100",
    },
    { key: "level4Hint", label: "第 4 档 · 说明", type: "text", hint: "默认「你现在背的东西很重」" },

    {
      type: "section",
      key: "_secRelax",
      label: "④ 提醒卡里提供哪些放松方式",
      hint: "⚠️ 只影响提醒卡。「治愈小屋」里两种方式永远都在，不受这里影响",
    },
    {
      key: "relaxOfferBreathing",
      label: "提供「呼吸放松」",
      type: "boolean",
      hint: "跟着圆圈做 4-2-4 呼吸，共 3 分钟",
    },
    {
      key: "relaxOfferButterfly",
      label: "提供「蝴蝶拍」",
      type: "boolean",
      hint: "双手交替轻拍，安抚自己",
    },

    {
      type: "section",
      key: "_secTrigger",
      label: "⑤ 触发与花费控制",
      hint: "绝大多数消息由本地词表处理（0 Token），只有这些条件命中时才真的调 AI",
    },
    {
      key: "stressPeriodicInterval",
      label: "每多少条消息做一次深度识别",
      type: "number",
      hint: "默认 10。这个值越大越省钱，但发现得也越晚",
    },
    {
      key: "stressKeywordCooldownMinutes",
      label: "关键词触发冷却（分钟）",
      type: "number",
      hint: "默认 2。避免同一段话里反复触发",
    },
    {
      key: "stressChatCooldownMinutes",
      label: "聊天提醒冷却（分钟）",
      type: "number",
      hint: "默认 15。两次提醒之间至少隔这么久",
    },
    {
      key: "stressDiaryCooldownMinutes",
      label: "日记提醒冷却（分钟）",
      type: "number",
      hint: "默认 30。日记场景更宽松，因为写完日记本来就需要缓一缓",
    },
    {
      key: "stressDailyLlmLimit",
      label: "每人每天最多调多少次 AI",
      type: "number",
      hint: "默认 60。防止长聊用户把额度跑飞",
    },

    {
      type: "section",
      key: "_secPrompt",
      label: "⑥ 深度识别提示词",
      hint: "⚠️ 接口地址 / API Key / 模型名都在「对话 AI」页配，这里只管提示词。要求模型只输出一行 JSON",
    },
    {
      key: "stressPromptChat",
      label: "聊天场景提示词",
      type: "textarea",
      rows: 8,
    },
    {
      key: "stressPromptDiary",
      label: "日记场景提示词",
      type: "textarea",
      rows: 8,
    },
  ],
  tts: [
    { key: "enabled", label: "启用语音合成", type: "boolean" },
    {
      key: "provider",
      label: "接口类型",
      type: "select",
      options: [
        { value: "openai-compatible", label: "OpenAI 兼容（POST /audio/speech，接口直接返回音频）" },
        { value: "mimo-chat", label: "小米 MiMo（POST /chat/completions，音频是 base64）" },
        { value: "dashscope-qwen", label: "阿里云百炼 DashScope / Qwen（qwen-audio-3.1-tts-flash，支持方言与声音事件）" },
      ],
      hint: "不同服务商的接口格式与能力不同，切换接口类型后，下方会自动切换匹配的配置项与推荐值",
    },
    {
      key: "baseUrl",
      label: "接口地址",
      type: "text",
      hint: ({ provider }) => {
        if (provider.includes("dashscope") || provider.includes("qwen")) {
          return "百炼可填 Base 地址 https://dashscope.aliyuncs.com/api/v1 或专有网关（程序会自动补齐 SpeechSynthesizer 路径；直接填完整端点亦可）";
        }
        if (provider.includes("mimo")) {
          return "小米 MiMo 填 https://api.xiaomimimo.com/v1（注意别填成控制台或文档网页地址）";
        }
        return "OpenAI 系填 https://api.openai.com/v1，或兼容转发网关地址";
      },
    },
    {
      key: "apiKey",
      label: "API Key",
      type: "secret",
      hint: ({ provider }) => {
        if (provider.includes("dashscope") || provider.includes("qwen")) {
          return "阿里云百炼 API Key（DashScope 控制台获取，形如 sk-xxx，请求时走 Bearer 头）";
        }
        if (provider.includes("mimo")) {
          return "小米 MiMo API Key（请求时走 api-key 头，程序自动处理）";
        }
        return "OpenAI API Key 或第三方中转 Key（走 Bearer 头）";
      },
    },
    {
      key: "model",
      label: "模型名",
      type: "text",
      hint: ({ provider }) => {
        if (provider.includes("dashscope") || provider.includes("qwen")) {
          return "百炼推荐填 qwen-audio-3.1-tts-flash（低延迟拟真流式合成）或 cosyvoice-v1";
        }
        if (provider.includes("mimo")) {
          return "小米 MiMo 填 mimo-v2.5-tts";
        }
        return "OpenAI 填 tts-1 或 tts-1-hd";
      },
    },
    {
      key: "voice",
      label: "默认音色",
      type: "text",
      hint: ({ provider }) => {
        if (provider.includes("dashscope") || provider.includes("qwen")) {
          return "用户未选人格时使用。百炼推荐：longanhuan_v3.1（支持多语种方言）或 Cherry 等";
        }
        if (provider.includes("mimo")) {
          return "用户未选人格时使用。小米 MiMo：mimo_default / 冰糖 / 茉莉 / 苏打 / 白桦";
        }
        return "默认音色，如 alloy / echo / fable / onyx / nova / shimmer";
      },
    },
    {
      key: "voiceFemale",
      label: "女性人格音色",
      type: "text",
      hint: ({ provider }) => {
        if (provider.includes("dashscope") || provider.includes("qwen")) {
          return "用户在「我的 → 设置」选了 AI 人格「她」之后使用。百炼推荐：longanhuan_v3.1 / Cherry";
        }
        if (provider.includes("mimo")) {
          return "用户选「她」时使用。小米 MiMo 常见女声：冰糖 / 茉莉 / Mia / Chloe";
        }
        return "女性人设朗读音色，留空则回退到默认音色";
      },
    },
    {
      key: "voiceMale",
      label: "男性人格音色",
      type: "text",
      hint: ({ provider }) => {
        if (provider.includes("dashscope") || provider.includes("qwen")) {
          return "用户选了 AI 人格「他」之后使用。百炼推荐：longxiaochun_v3.1 / longwan";
        }
        if (provider.includes("mimo")) {
          return "用户选「他」时使用。小米 MiMo 常见男声：苏打 / 白桦 / Milo / Dean";
        }
        return "男性人设朗读音色，留空则回退到默认音色";
      },
    },
    {
      key: "speed",
      label: "语速（0.5-2）",
      type: "number",
      step: "0.1",
      condition: ({ provider }) => !provider.includes("mimo"),
      hint: "OpenAI 与 阿里云百炼 原生支持语速调节；小米 MiMo 会忽略本项",
    },
    {
      key: "format",
      label: "音频格式",
      type: "text",
      hint: "常用 mp3 ；百炼支持 mp3 / wav / pcm / opus ；MiMo 支持 wav / mp3 / pcm",
    },
    {
      key: "stylePrompt",
      label: ({ provider }) =>
        provider.includes("dashscope") || provider.includes("qwen")
          ? "风格与方言指令（Instruction，支持方言）"
          : "朗读风格指令（仅小米 MiMo 生效）",
      type: "textarea",
      rows: 3,
      condition: ({ provider }) =>
        provider.includes("mimo") || provider.includes("dashscope") || provider.includes("qwen"),
      hint: ({ provider }) => {
        if (provider.includes("dashscope") || provider.includes("qwen")) {
          return "百炼原生指令控制：用自然语言描述情感、语气或方言口音，如：“用温柔、舒缓的语气朗读” 或 “请用地道的四川话/粤语朗读”。留空则按模型默认输出。";
        }
        return "用自然语言描述想要的语气，会作为 user 消息发给 MiMo（例如：用温柔、缓慢、轻声细语的语调朗读）。";
      },
    },
    {
      key: "styleTags",
      label: ({ provider }) =>
        provider.includes("dashscope") || provider.includes("qwen")
          ? "朗读标签与声音事件（支持情绪与叹气/笑声等事件）"
          : "朗读标签（情绪 / 声音事件，仅小米 MiMo 生效）",
      type: "boolean",
      condition: ({ provider }) =>
        provider.includes("mimo") || provider.includes("dashscope") || provider.includes("qwen"),
      hint: ({ provider }) => {
        if (provider.includes("dashscope") || provider.includes("qwen")) {
          return "开启后，AI 回复时会适度内嵌 [开心]、[叹气]、[笑] 等情绪或非言语事件标签，Qwen 合成时能精准呈现叹气、轻笑等细粒度情感；前端展示会自动剥离标签。";
        }
        return "开启后，AI 会在回复里自然带上 [温柔]、(叹气) 这类标签，MiMo 朗读时按标签控语气；前端展示会自动剥离标签。";
      },
    },
    {
      key: "styleTagWords",
      label: "语气 / 情绪标签词表",
      type: "textarea",
      rows: 5,
      condition: ({ provider, getValue }) =>
        (provider.includes("mimo") || provider.includes("dashscope") || provider.includes("qwen")) &&
        Boolean(getValue("styleTags")),
      hint: "一份词表两处用：① 提示词里告诉 AI 只能从这些词里选；② 用户端剥离标签的白名单。逗号分隔。清空 = 恢复默认值。",
    },
    {
      key: "eventTagWords",
      label: "声音事件词表（叹气 / 笑声 / 呼吸等）",
      type: "textarea",
      rows: 5,
      condition: ({ provider, getValue }) =>
        (provider.includes("mimo") || provider.includes("dashscope") || provider.includes("qwen")) &&
        Boolean(getValue("styleTags")),
      hint: "声音事件词表（吸气 / 深呼吸 / 叹气 / 轻笑 / laughing / sighing 等）。逗号分隔。清空 = 恢复默认值。",
    },
    { key: "timeoutSeconds", label: "超时（秒）", type: "number" },
  ],
  smtp: [
    { key: "enabled", label: "启用邮件发送", type: "boolean", hint: "开启后后台才能发测试邮件，下一轮用户端验证码也要靠它" },
    { key: "host", label: "SMTP 服务器", type: "text", hint: "网易：smtp.163.com 或 smtp.126.com" },
    { key: "port", label: "端口", type: "number", hint: "SSL 用 465，STARTTLS 用 587" },
    { key: "secure", label: "使用 SSL（465 端口选这个）", type: "boolean" },
    { key: "user", label: "发信邮箱", type: "text", hint: "例如 yourname@163.com" },
    { key: "password", label: "SMTP 授权码", type: "secret", hint: "网易邮箱要填授权码，不是登录密码" },
    { key: "fromName", label: "发件人显示名", type: "text" },
    { key: "fromEmail", label: "发件人邮箱", type: "text", hint: "网易邮箱要求与发信邮箱一致" },
  ],
  login: [
    { key: "codeLength", label: "验证码位数（4-8）", type: "number" },
    { key: "codeTtlSeconds", label: "有效期（秒）", type: "number", hint: "默认 300 秒" },
    { key: "sendCooldownSeconds", label: "发送冷却（秒）", type: "number", hint: "同一邮箱两次发送的最小间隔" },
    { key: "dailyLimitPerEmail", label: "单邮箱每日上限", type: "number" },
    { key: "emailSubject", label: "邮件标题", type: "text" },
    { key: "emailIntro", label: "邮件正文开头", type: "textarea", hint: "可用占位符 {code} {minutes} {siteName}" },
  ],
  site: [
    { key: "siteName", label: "站点名称", type: "text" },
    { key: "adminNotice", label: "后台公告", type: "textarea", hint: "显示在概览页，可留空" },
  ],
  review: [
    {
      key: "enabled",
      label: "启用数据审核",
      type: "boolean",
      hint: "关闭后不再自动审核用户上传的头像 / 背景 / 昵称 / 签名（已经攒下的待审内容会留在队列里）",
    },
    { key: "provider", label: "服务商备注", type: "text", hint: "仅作记录，不影响调用" },
    {
      key: "baseUrl",
      label: "接口地址（逐条 / 对话）",
      type: "text",
      hint: "小米 MiMo 填 https://api.xiaomimimo.com/v1。测试连接、拉取模型、逐条审核都走这个地址",
    },
    {
      key: "batchBaseUrl",
      label: "批量推理接口地址",
      type: "text",
      hint: "⚠️ 批量推理用独立域名，和上面那个不是一回事：形如 https://batch-api-{region}.xiaomimimo.com/v1，要去小米控制台的「批量推理」页面获取。留空则批量提交会失败并自动降级为逐条模式（功能正常，但拿不到五折价和闲时调度）",
    },
    {
      key: "apiKey",
      label: "API Key",
      type: "secret",
      hint: "要求和对话 AI 一样。程序会对小米域名同时发送 Authorization: Bearer 和 api-key 两个头（小米两处文档写法不同，两个都发最稳）",
    },
    {
      key: "model",
      label: "模型名",
      type: "datalist",
      optionsKey: "reviewModels",
      hint: "例如 mimo-v2.6-flash；点右侧箭头看候选，也可以直接手输",
    },
    {
      key: "mode",
      label: "审核方式",
      type: "select",
      options: [
        { value: "batch", label: "批量推理（一次提交一批，结果延迟返回，需要轮询领取）" },
        { value: "inline", label: "逐条调用（立刻出结果，一条一条来）" },
      ],
      hint: "选批量推理时，如果上游接口和 OpenAI Batch 协议不一致导致提交失败，会自动降级为逐条（可在下面关掉）",
    },
    {
      key: "completionWindow",
      label: "最长等待时间",
      type: "text",
      hint: "⚠️ 实测结论：**接口只认 24h**。填 168h（7 天）这类值，服务端会直接返回 HTTP 500 internal_error —— 文档里「控制台可设 1-14 天」那句只对控制台页面有效。程序会自动退回 24h 重试，所以填错也不会挂，但**建议就保持 24h**",
    },
    {
      key: "autoSubmit",
      label: "自动定时提交",
      type: "boolean",
      hint: "开着的话，应用会自己按下面的间隔「收结果 + 交新任务」—— 你完全不用点「立即提交」（手动点还要等它跑完，界面会卡一会儿）。保存即生效，不用重启",
    },
    {
      key: "submitIntervalMinutes",
      label: "自动提交间隔（分钟，1-1440）",
      type: "number",
      hint: "默认 10 分钟。批量推理本身就是延迟返回的，间隔太短没意义；太长又会让违规内容多挂一会儿",
    },
    {
      key: "autoFallback",
      label: "批量不可用时自动降级为逐条",
      type: "boolean",
      hint: "建议开着：否则批量接口一旦不兼容，审核就完全停住了",
    },
    {
      key: "reviewImages",
      label: "连图片一起送审",
      type: "boolean",
      hint: "关掉后头像 / 背景完全不送 AI，只进后台人工队列（昵称和签名始终会送审）",
    },
    {
      key: "imageHandling",
      label: "图片任务怎么处理",
      type: "select",
      options: [
        { value: "manual", label: "进后台人工队列（不花 AI 额度，推荐）" },
        { value: "inline", label: "用「逐条调用」单独审（会花钱，但能自动处理）" },
      ],
      hint: "⚠️ 图片**不能进批量推理** —— 多模态消息体会让整个批次在创建阶段就失败（HTTP 500），一条图片就能拖垮整批。所以批量模式下图片只能二选一：走人工，或用逐条单独审。⚠️ 如果「审核方式」选的是「逐条调用」，这个设置不起作用（那时图片跟文本一起走逐条）",
    },
    { key: "maxItemsPerBatch", label: "每次最多提交条数（1-100）", type: "number" },
    { key: "timeoutSeconds", label: "逐条模式超时（秒）", type: "number" },
    {
      key: "reviewMaxTokens",
      label: "单条输出上限（token）",
      type: "number",
      hint: "默认 200。审核只需要回一个极短的 JSON，200 足够；给多了纯属浪费。（生成日记那种长输出的额度在「日记」页调）",
    },
    {
      key: "keepDays",
      label: "审核记录保留天数",
      type: "number",
      hint: "超过这个天数的审核记录会被定时清理脚本删掉",
    },
    {
      key: "reviewPrompt",
      label: "审核提示词",
      type: "textarea",
      rows: 16,
      hint: '发给审核 AI 的系统提示词。必须要求它只输出 JSON：{"verdict":"pass|reject","reason":"理由"}。⚠️ AI 返回读不懂时会标成「失败·待人工」，不会自动放过',
    },
    // ⚠️ 日记打标 / 生成的配置**已经搬到后台「日记」页**了（这个页面只管内容审核）。
    //    这里不再放日记相关的字段，免得两处都能改、互相打架。
    {
      key: "customBlocklist",
      label: "自定义违禁词（本地预检）",
      type: "textarea",
      rows: 5,
      hint: "一行一个词，# 开头当注释。命中的内容**不走 AI、直接判违规并把资料改回默认值**。内置词表已经覆盖常见脏话的中文写法、谐音、拼音缩写（如草泥马 / tm / sb / 废物），这里只补充你遇到的漏网之词。⚠️ 只放没有歧义的词（像「滚」既可能骂人也可能是亲昵说法，别放）",
    },
    { key: "defaultNickname", label: "默认昵称", type: "text", hint: "昵称被判违规后改回这个" },
    { key: "defaultBio", label: "默认签名", type: "text", hint: "留空 = 违规后清空签名" },
    { key: "defaultAvatar", label: "默认头像", type: "image", hint: "留空则用前端自带的默认头像" },
    { key: "defaultAiAvatar", label: "默认 AI 头像", type: "image" },
    { key: "defaultChatBackground", label: "默认聊天背景", type: "image" },
    { key: "defaultDiaryBackground", label: "默认「我的」页背景", type: "image" },
  ],
  diary: [
    {
      type: "section",
      key: "_secMood",
      label: "① 情绪打标",
      hint: "给用户写的日记打情绪标签（不改动正文，只是多一个标签）",
    },
    {
      key: "moodEnabled",
      label: "启用日记情绪打标",
      type: "boolean",
      hint: "关掉后不再给日记打情绪标签（已有的标签会保留）",
    },
    {
      key: "moodPrompt",
      label: "打标提示词",
      type: "textarea",
      rows: 10,
      hint: "给日记打情绪标签用的系统提示词。要求它只输出一个词即可；代码会拿 8 个情绪词做白名单匹配，挑不出来就落到「默认标签」。⚠️ 打标和内容审核**共用同一套批量 AI 配置**（接口地址 / 批量地址 / Key / 模型名都在「数据审核」页配置）",
    },
    {
      key: "defaultMood",
      label: "默认情绪标签",
      type: "text",
      hint: "AI 打标失败、或它给不出有效词时用这个。默认「说不清」",
    },
    {
      type: "section",
      key: "_secGenerate",
      label: "② AI 自动生成日记",
      hint: "根据用户当天的聊天记录，替 ta 写一篇日记（会明确标注「AI 生成」）",
    },
    {
      key: "generateEnabled",
      label: "启用「AI 根据聊天记录自动生成日记」",
      type: "boolean",
      // ⚠️ full：这个开关是这一组的"总闸"，**必须独占一整行** ——
      //    和「默认情绪标签」挤在同一行的话，看起来像打标的一个子选项。
      full: true,
      hint: "⚠️ 默认关闭。开启后系统每天会在下面设定的时间，为「昨天」有聊天记录的用户生成一篇日记；生成结果会明确标注「AI 生成」，用户可以自己删",
    },
    {
      key: "generateHour",
      label: "每天几点生成（0-23）",
      type: "number",
      hint: "默认 23 点：等这一天聊完再写。生成的是**前一天**的日记",
    },
    {
      key: "minMessages",
      label: "少于多少条消息就不生成",
      type: "number",
      hint: "默认 4 条。聊得太少，硬凑出来的日记反而显得敷衍",
    },
    {
      key: "maxMessages",
      label: "最多取多少条聊天消息",
      type: "number",
      hint: "默认 60 条，取最近的那些。⚠️ 取太多会占掉输出的 token 额度",
    },
    {
      key: "maxChars",
      label: "聊天记录最长多少字",
      type: "number",
      hint: "默认 2500 字，超出会从**末尾**截（保留最近的，那儿的情绪最完整）。⚠️ **这个值直接决定 AI 还剩多少余地写日记** —— 出过的事：输入 4000+ 字把输出预算挤没了，日记写到一半就断",
    },
    {
      key: "diaryMinWords",
      label: "日记最少多少字",
      type: "number",
      hint: "默认 150。会替换提示词里的 `{minWords}` 占位符（不用去改提示词正文）",
    },
    {
      key: "diaryMaxWords",
      label: "日记最多多少字",
      type: "number",
      hint: "默认 250。会替换提示词里的 `{maxWords}` 占位符。⚠️ 别设太长：输出越长越容易被额度掐断，而且用户读日记不是读作文",
    },
    {
      key: "generateMaxTokens",
      label: "生成长度上限（token）",
      type: "number",
      hint: "默认 3000。⚠️ **日记被截断时第一个要调的就是这个** —— 一篇 250 字的日记约 400-600 token，输入越长越要留足。**保存即生效，不用重新部署**。被截断的结果不会保存（会标 failed 等重试），任务原因里会写清输入/输出各多少字",
    },
    {
      key: "moodMaxTokens",
      label: "打标输出上限（token）",
      type: "number",
      hint: "默认 30。打标只要输出一个情绪词，给多了纯属浪费",
    },
    {
      key: "generatePrompt",
      label: "生成日记提示词",
      type: "textarea",
      rows: 16,
      hint: "发给 AI 的生成指令。⚠️ 里面规定了输出格式（标签 / 标题 / 正文 三个行首标记），**改格式的话代码里的解析也要跟着改**（lib/content-review.js 的 parseDiaryDraft）",
    },
  ],
};

const TABS = [
  { id: "overview", label: "系统概览", icon: "📊", group: "data", desc: "运行状态与聚合指标" },
  { id: "users", label: "用户管理", icon: "👥", group: "data", desc: "账号列表与状态管理" },
  { id: "logs", label: "操作日志", icon: "📜", group: "data", desc: "敏感操作安全审计" },

  { id: "ai", label: "对话 AI", icon: "💬", group: "ai", desc: "主模型与提示词人设" },
  { id: "tts", label: "语音 TTS", icon: "🎙️", group: "ai", desc: "MiMo 语音与音效标签" },
  { id: "review", label: "数据审核", icon: "🛡️", group: "ai", desc: "内容异步审核与处置" },
  { id: "diary", label: "日记任务", icon: "📖", group: "ai", desc: "零点暖言小记生成调度" },

  { id: "safety", label: "内容安全与压力", icon: "🔒", group: "content", desc: "违规词过滤与压力规则" },
  { id: "scales", label: "量表题库", icon: "📋", group: "content", desc: "标准化测评题目与方案" },
  { id: "music", label: "背景音乐", icon: "🎵", group: "content", desc: "本地歌单与网易云外链" },
  { id: "sticker", label: "表情包库", icon: "🏷️", group: "content", desc: "分类素材与情绪自动配图" },

  { id: "database", label: "数据库运维", icon: "🗄️", group: "system", desc: "连接池、数据备份与升级" },
  { id: "mail", label: "邮箱 / SMTP", icon: "✉️", group: "system", desc: "验证码与通知发信通道" },
  { id: "site", label: "站点信息", icon: "🌐", group: "system", desc: "基础配置与前端展示项" },
];

const TAB_GROUPS = [
  { id: "data", label: "数据与概览", icon: "📊" },
  { id: "ai", label: "核心 AI 引擎", icon: "🧠" },
  { id: "content", label: "交互与内容", icon: "✨" },
  { id: "system", label: "系统与设置", icon: "⚙️" },
];

/* ------------------------------------------------------------ 基础 UI 块 */

function Field({ label, hint, className = "", children }) {
  return (
    <label className={`block mb-3 ${className}`}>
      <span className="block text-xs font-medium text-slate-600 mb-1">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-slate-400 mt-1">{hint}</span> : null}
    </label>
  );
}

function Alert({ kind = "error", children }) {
  if (!children) return null;
  const tone =
    kind === "error"
      ? "border-red-200 bg-red-50 text-red-700"
      : kind === "success"
        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
        : "border-[#cfdde5] bg-[#f2f7fa] text-slate-600";
  return (
    <div className={`border rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words mb-3 ${tone}`}>
      {children}
    </div>
  );
}

function StatusDot({ ok }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full mr-2 ${ok ? "bg-emerald-500" : "bg-slate-300"}`}
    />
  );
}

/* -------------------------------------------------------- 通用配置表单块 */

/** 默认值图片预览：只接受真正的位图 data URL（挡掉 svg 这类可能带脚本的类型） */
function safeImagePreview(value) {
  const text = String(value || "");
  return /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(text) ? text : "";
}

/**
 * 把选的图片读成 data URL，并先缩到 maxSize 以内。
 *
 * 为什么必须缩：默认值会整段存进 settings 表，原图几 MB 会把它撑爆；
 * 缩到 512px 之后 base64 一般只有几十 KB，和用户端上传的头像同一个量级。
 */
function readImageAsDataUrl(file, maxSize = 512) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("这不是有效的图片文件"));
      img.onload = () => {
        try {
          const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
          const width = Math.max(1, Math.round(img.width * scale));
          const height = Math.max(1, Math.round(img.height * scale));

          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, width, height);

          // 优先 WebP（同画质体积小约 30%），浏览器不支持时退回 JPEG
          let out = canvas.toDataURL("image/webp", 0.85);
          if (!out.startsWith("data:image/webp")) out = canvas.toDataURL("image/jpeg", 0.85);
          resolve(out);
        } catch (err) {
          reject(new Error(err?.message || "处理图片失败"));
        }
      };
      img.src = String(reader.result || "");
    };
    reader.readAsDataURL(file);
  });
}

/**
 * 可输入 + 可下拉选择的输入框（用来替代原生 datalist）
 *
 * ⚠️ 为什么不用 `<input list>`：
 *   原生 datalist 有个硬伤 —— **输入框里已经有内容时，点箭头只会拿当前值去筛选**，
 *   匹配不到就是一片空白，用户会以为"没有可用模型"。
 *   这里自己实现：点箭头**永远列出全部候选**，输入时才按关键字过滤。
 *
 * 右侧两个控件（只在模型名字段出现）：
 *   [拉取模型] [▼]
 *   箭头在拉取按钮的右边，用细线 SVG 画，不用原生那种粗糙的下拉箭头。
 */
function ComboField({
  value,
  onChange,
  placeholder,
  inputClass,
  options = [],
  onFetch,
  fetching = false,
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  // 点空白处收起
  useEffect(() => {
    if (!open) return;
    const away = (event) => {
      if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  // 点箭头时列全部；输入之后按关键字过滤（大小写不敏感，匹配子串）
  const keyword = String(value || "").trim().toLowerCase();
  const list = keyword
    ? options.filter((item) => String(item).toLowerCase().includes(keyword))
    : options;

  return (
    <div className="relative" ref={boxRef}>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value);
          if (!open && options.length) setOpen(true);
        }}
        onFocus={() => {
          if (options.length) setOpen(true);
        }}
        className={`${inputClass} ${onFetch ? "pr-[124px]" : "pr-9"}`}
      />

      <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
        {onFetch ? (
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              onFetch();
            }}
            disabled={fetching}
            className="rounded-md border border-[#d5d9d7] bg-white px-2 py-0.5 text-[11px] text-slate-600 transition-colors hover:bg-[#f2f5f4] disabled:opacity-50"
            title="从接口拉取可用模型列表"
          >
            {fetching ? "拉取中…" : "拉取模型"}
          </button>
        ) : null}

        <button
          type="button"
          tabIndex={-1}
          onClick={() => setOpen((prev) => !prev)}
          disabled={!options.length}
          className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-[#f2f5f4] hover:text-slate-600 disabled:opacity-40"
          title={options.length ? "展开候选列表" : "还没有候选，先点「拉取模型」"}
        >
          <svg
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
          >
            <path d="M3 4.5L6 7.5L9 4.5" />
          </svg>
        </button>
      </div>

      {open && list.length ? (
        <ul className="absolute left-0 right-0 z-30 mt-1 max-h-56 overflow-y-auto rounded-lg border border-[#e6e8e6] bg-white py-1 shadow-xl">
          {list.slice(0, 200).map((item) => (
            <li key={item}>
              <button
                type="button"
                onClick={() => {
                  onChange(item);
                  setOpen(false);
                }}
                className={`block w-full truncate px-3 py-1.5 text-left text-xs transition-colors hover:bg-[#f2f5f4] ${
                  String(item) === String(value) ? "bg-[#e8eff2] text-slate-800" : "text-slate-600"
                }`}
              >
                {item}
              </button>
            </li>
          ))}
          {list.length < options.length ? (
            <li className="px-3 py-1.5 text-[11px] text-slate-400">
              共 {options.length} 个，已按输入过滤；清空输入可看全部
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function SettingsGroup({
  group,
  title,
  description,
  settings,
  onSaved,
  setError,
  setNotice,
  // 动态候选项：形如 { aiModels: ["glm-4-flash", ...] }，给 type: "datalist" 的字段用
  fieldOptions = {},
  // 「拉取可用模型」按钮：只有模型名字段用得到，按钮内嵌在输入框右侧
  onFetchModels,
  modelsBusy = false,
  children,
}) {
  const fields = FIELDS[group] || [];
  const source = (settings && settings[group]) || {};
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft({});
  }, [settings]);

  const rawValue = (key) =>
    Object.prototype.hasOwnProperty.call(draft, key) ? draft[key] : source[key];
  const textValue = (key) => {
    const value = rawValue(key);
    return value === undefined || value === null ? "" : String(value);
  };
  const boolValue = (key) => Boolean(rawValue(key));
  const touched = (key) => Object.prototype.hasOwnProperty.call(draft, key);

  function setValue(key, value) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function applyTtsPresets(nextProvider) {
    const p = String(nextProvider || "").toLowerCase();
    setDraft((prev) => {
      const updated = { ...prev, provider: nextProvider };
      if (p.includes("dashscope") || p.includes("qwen")) {
        if (!prev.baseUrl || prev.baseUrl.includes("xiaomimimo") || prev.baseUrl.includes("openai")) {
          updated.baseUrl = "https://dashscope.aliyuncs.com/api/v1";
        }
        if (!prev.model || prev.model.includes("mimo") || prev.model.includes("tts-1")) {
          updated.model = "qwen-audio-3.1-tts-flash";
        }
        if (!prev.voice || prev.voice.includes("mimo") || prev.voice === "alloy") {
          updated.voice = "longanhuan_v3.1";
        }
        if (!prev.voiceFemale || prev.voiceFemale.includes("冰糖") || prev.voiceFemale.includes("茉莉")) {
          updated.voiceFemale = "longanhuan_v3.1";
        }
        if (!prev.voiceMale || prev.voiceMale.includes("苏打") || prev.voiceMale.includes("白桦")) {
          updated.voiceMale = "longxiaochun_v3.1";
        }
        if (!prev.stylePrompt || prev.stylePrompt.includes("老朋友")) {
          updated.stylePrompt = "用温柔、舒缓的语气朗读，像朋友在身旁陪伴一样。";
        }
      } else if (p.includes("mimo")) {
        if (!prev.baseUrl || prev.baseUrl.includes("dashscope") || prev.baseUrl.includes("openai")) {
          updated.baseUrl = "https://api.xiaomimimo.com/v1";
        }
        if (!prev.model || prev.model.includes("qwen") || prev.model.includes("tts-1")) {
          updated.model = "mimo-v2.5-tts";
        }
        if (!prev.voice || prev.voice.includes("long") || prev.voice === "alloy") {
          updated.voice = "mimo_default";
        }
        if (!prev.voiceFemale || prev.voiceFemale.includes("long")) {
          updated.voiceFemale = "冰糖";
        }
        if (!prev.voiceMale || prev.voiceMale.includes("long")) {
          updated.voiceMale = "苏打";
        }
        if (!prev.stylePrompt || prev.stylePrompt.includes("身旁陪伴")) {
          updated.stylePrompt = "用温柔、缓慢、轻声细语的语调朗读，像一个老朋友在陪伴你说话。";
        }
      } else if (p.includes("openai")) {
        if (!prev.baseUrl || prev.baseUrl.includes("dashscope") || prev.baseUrl.includes("xiaomimimo")) {
          updated.baseUrl = "https://api.openai.com/v1";
        }
        if (!prev.model || prev.model.includes("qwen") || prev.model.includes("mimo")) {
          updated.model = "tts-1";
        }
        if (!prev.voice || prev.voice.includes("long") || prev.voice.includes("mimo")) {
          updated.voice = "alloy";
        }
      }
      return updated;
    });
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const values = {};
      for (const field of fields) {
        if (!touched(field.key)) continue;
        const value = draft[field.key];

        if (field.type === "boolean") {
          values[field.key] = Boolean(value);
          continue;
        }
        // 密钥与数字字段留空 = 不修改；普通文本留空 = 真正清空该字段
        if (
          typeof value === "string" &&
          value.trim() === "" &&
          (field.type === "secret" || field.type === "number")
        ) {
          continue;
        }
        values[field.key] = value;
      }

      if (!Object.keys(values).length) {
        setNotice(`${title}：没有需要保存的修改`);
        return;
      }

      await api("/api/admin/settings", {
        method: "PUT",
        body: { group, values },
      });
      setNotice(`${title} 已保存`);
      if (onSaved) await onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={`${cardClass} mb-4`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <h2 className="text-sm font-bold text-slate-800">{title}</h2>
          {description ? <p className="text-xs text-slate-500 mt-1">{description}</p> : null}
        </div>
        <button type="button" onClick={handleSave} disabled={saving} className={btnPrimary}>
          {saving ? "保存中..." : "保存"}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
        {fields.map((field) => {
          const ctx = {
            values: draft,
            source,
            getValue: (key) => (touched(key) ? draft[key] : source[key]),
            provider: String(
              touched("provider") ? draft.provider : source.provider || ""
            ).toLowerCase(),
            textValue,
            boolValue,
          };

          if (typeof field.condition === "function" && !field.condition(ctx)) {
            return null;
          }

          const fieldLabel = typeof field.label === "function" ? field.label(ctx) : field.label;
          const fieldHint = typeof field.hint === "function" ? field.hint(ctx) : field.hint;

          // ⚠️ field.full = 这一项**独占一整行**。
          //    默认是两列并排，但"总开关"和它下面的参数挤在同一行会让层级看不出来 ——
          //    该占整行的就标 full。典型例子：「AI 根据聊天记录自动生成日记」。
          const spanCls = field.full ? "md:col-span-2" : "";

          // 分节标题：把同一个 tab 里的几组配置**分框**
          if (field.type === "section") {
            return (
              <div
                key={field.key}
                className="md:col-span-2 mt-2 border-t border-[#eceeec] pt-3 first:mt-0 first:border-t-0 first:pt-0"
              >
                <p className="text-sm font-semibold text-slate-700">{fieldLabel}</p>
                {fieldHint ? (
                  <p className="mt-0.5 text-xs text-slate-400">{fieldHint}</p>
                ) : null}
              </div>
            );
          }

          if (field.type === "boolean") {
            return (
              <Field key={field.key} label={fieldLabel} hint={fieldHint} className={spanCls}>
                <span className="inline-flex items-center gap-2 h-[34px]">
                  <input
                    type="checkbox"
                    checked={boolValue(field.key)}
                    onChange={(e) => setValue(field.key, e.target.checked)}
                    className="w-4 h-4 accent-[#7fa3b8]"
                  />
                  <span className="text-xs text-slate-500">
                    {boolValue(field.key) ? "已开启" : "已关闭"}
                  </span>
                </span>
              </Field>
            );
          }

          // 默认值里的图片（头像 / 背景）：选一张 → 在浏览器里缩到 512px 并转成 data URL 存进配置。
          // 为什么存 data URL 而不是上传成文件：默认值是「用户违规后回填」用的，
          // 存成和用户上传完全相同的格式，处置时直接写库即可，少一次文件读写和清理。
          if (field.type === "image") {
            const preview = safeImagePreview(textValue(field.key));
            return (
              <Field key={field.key} label={fieldLabel} hint={fieldHint}>
                <div className="flex items-center gap-2">
                  <label className="inline-flex h-[34px] cursor-pointer items-center rounded-lg border border-[#d5d9d7] bg-white px-3 text-xs text-slate-600 transition-colors hover:bg-[#f2f5f4]">
                    选择图片
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      className="hidden"
                      onChange={async (event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (!file) return;
                        setError("");
                        try {
                          const dataUrl = await readImageAsDataUrl(file, 512);
                          setValue(field.key, dataUrl);
                        } catch (err) {
                          setError(`读取图片失败：${err.message}`);
                        }
                      }}
                    />
                  </label>

                  {preview ? (
                    <>
                      <img
                        src={preview}
                        alt=""
                        className="h-[34px] w-[34px] rounded-md border border-[#e8eae7] object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => setValue(field.key, "")}
                        className="text-xs text-red-500 transition-colors hover:text-red-700"
                      >
                        清除
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-slate-400">未设置（用前端自带的默认）</span>
                  )}
                </div>
              </Field>
            );
          }

          if (field.type === "select") {
            return (
              <Field key={field.key} label={fieldLabel} hint={fieldHint} className={spanCls}>
                <select
                  value={textValue(field.key)}
                  onChange={(e) => {
                    const nextVal = e.target.value;
                    setValue(field.key, nextVal);
                    if (group === "tts" && field.key === "provider") {
                      applyTtsPresets(nextVal);
                    }
                  }}
                  className={inputClass}
                >
                  {(field.options || []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
            );
          }

          // 可输入 + 可下拉：点箭头**永远列出全部候选**
          // （原生 datalist 在输入框有内容时只会筛选，匹配不到就是空列表，用户会以为"没有模型"）
          if (field.type === "datalist") {
            const options = fieldOptions[field.optionsKey] || [];
            const isModelField = field.key === "model" && typeof onFetchModels === "function";
            return (
              <Field key={field.key} label={fieldLabel} hint={fieldHint} className={spanCls}>
                <ComboField
                  value={textValue(field.key)}
                  onChange={(next) => setValue(field.key, next)}
                  placeholder={fieldHint || ""}
                  inputClass={inputClass}
                  options={options}
                  onFetch={
                    isModelField
                      ? () =>
                          onFetchModels({
                            baseUrl: textValue("baseUrl"),
                            apiKey: textValue("apiKey"),
                          })
                      : undefined
                  }
                  fetching={isModelField ? modelsBusy : false}
                />
                {options.length ? (
                  <span className="block text-xs text-slate-400 mt-1">
                    已拉取 {options.length} 个候选：点右侧箭头看全部，也可以直接手输
                  </span>
                ) : null}
              </Field>
            );
          }

          if (field.type === "textarea") {
            return (
              <div key={field.key} className="md:col-span-2">
                <Field label={fieldLabel} hint={fieldHint}>
                  <textarea
                    rows={field.rows || 3}
                    value={textValue(field.key)}
                    onChange={(e) => setValue(field.key, e.target.value)}
                    className={`${inputClass} resize-none`}
                  />
                </Field>
              </div>
            );
          }

          const isSecret = field.type === "secret";
          const configured = Boolean(source[`${field.key}Configured`]);
          const placeholder = isSecret
            ? configured
              ? "已配置，留空表示不修改"
              : "尚未配置"
            : fieldHint || "";

          return (
            <Field key={field.key} label={fieldLabel} hint={fieldHint} className={spanCls}>
              <input
                type={isSecret ? "password" : field.type === "number" ? "number" : "text"}
                step={field.step}
                value={textValue(field.key)}
                placeholder={placeholder}
                onChange={(e) => setValue(field.key, e.target.value)}
                className={inputClass}
              />
            </Field>
          );
        })}
      </div>

      {children}
    </section>
  );
}

/* ------------------------------------------------------------ 数据库表单 */

function DatabasePanel({ onChanged, setError, setNotice, bootstrap = false }) {
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState("");
  const [localError, setLocalError] = useState("");
  const [setupKeyRequired, setSetupKeyRequired] = useState(false);
  const [setupKey, setSetupKey] = useState("");

  const load = useCallback(async () => {
    setLocalError("");
    try {
      const data = await api("/api/admin/database");
      setConfig(data.config);
      setStatus(data.status);
      setSetupKeyRequired(Boolean(data.setupKeyRequired));
      setForm({
        host: data.config.host,
        port: String(data.config.port),
        user: data.config.user,
        password: "",
        database: data.config.database,
        connectionLimit: String(data.config.connectionLimit),
      });
    } catch (err) {
      setLocalError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function update(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(action) {
    if (!form) return;
    setBusy(action);
    setLocalError("");
    setNotice("");
    try {
      const data = await api("/api/admin/database", {
        method: "POST",
        body: {
          action,
          keepPassword: true,
          setupKey,
          config: {
            host: form.host,
            port: form.port === "" ? undefined : Number(form.port),
            user: form.user,
            password: form.password,
            database: form.database,
            connectionLimit: form.connectionLimit === "" ? undefined : Number(form.connectionLimit),
          },
        },
      });
      setStatus(data.status || null);
      if (action === "save") {
        setNotice(data.message || "数据库配置已保存");
        await load();
        if (onChanged) await onChanged();
      } else {
        setNotice("连接测试成功");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  if (!form) {
    return (
      <section className={cardClass}>
        <Alert kind="error">{localError || "正在读取数据库配置..."}</Alert>
      </section>
    );
  }

  return (
    <section className={cardClass}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <h2 className="text-sm font-bold text-slate-800">数据库连接</h2>
          <p className="text-xs text-slate-500 mt-1">
            保存在服务器文件 <code className="text-slate-600">{config?.configFilePath || "config/db.json"}</code>
            （不写进数据库，也不提交到仓库）。保存前会真实测试连接，连接不通不会改动现有配置。
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button type="button" className={btnBase} disabled={busy !== ""} onClick={() => submit("test")}>
            {busy === "test" ? "测试中..." : "测试连接"}
          </button>
          <button type="button" className={btnPrimary} disabled={busy !== ""} onClick={() => submit("save")}>
            {busy === "save" ? "保存中..." : "保存并生效"}
          </button>
        </div>
      </div>

      {localError ? <Alert kind="error">{localError}</Alert> : null}

      <Alert kind={status?.connected ? "success" : "error"}>
        {status?.connected
          ? `当前连接正常，MySQL 版本 ${status.version}`
          : status?.error
            ? `当前连接失败：${status.error}`
            : "尚未检测连接状态"}
      </Alert>

      {setupKeyRequired && bootstrap ? (
        <Field label="初始化口令（ADMIN_SETUP_KEY）" hint="未登录状态下操作数据库配置时需要">
          <input
            type="password"
            value={setupKey}
            onChange={(e) => setSetupKey(e.target.value)}
            className={inputClass}
          />
        </Field>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
        <Field label="主机">
          <input value={form.host} onChange={(e) => update("host", e.target.value)} className={inputClass} />
        </Field>
        <Field label="端口">
          <input value={form.port} onChange={(e) => update("port", e.target.value)} className={inputClass} />
        </Field>
        <Field label="用户名">
          <input value={form.user} onChange={(e) => update("user", e.target.value)} className={inputClass} />
        </Field>
        <Field label="密码" hint={config?.hasPassword ? "已配置，留空表示不修改" : "尚未配置"}>
          <input
            type="password"
            value={form.password}
            placeholder={config?.hasPassword ? "留空表示不修改" : "请输入数据库密码"}
            onChange={(e) => update("password", e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="数据库名">
          <input
            value={form.database}
            onChange={(e) => update("database", e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="连接池大小" hint="宝塔小内存服务器建议 5 左右">
          <input
            value={form.connectionLimit}
            onChange={(e) => update("connectionLimit", e.target.value)}
            className={inputClass}
          />
        </Field>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- 概览面板 */

/* ------------------------------------------------------------ 数据看板 */

/** 极简柱状图：不引入图表库，用 div 高度实现，够用且零依赖 */
function MiniBarChart({ title, series, unit = "" }) {
  const max = Math.max(1, ...series.map((item) => item.count));
  const first = series[0]?.date?.slice(5) || "";
  const last = series[series.length - 1]?.date?.slice(5) || "";

  return (
    <div>
      <div className="flex items-end justify-between mb-2">
        <h3 className="text-xs font-bold text-slate-700">{title}</h3>
        <span className="text-xs text-slate-400">峰值 {max}{unit}</span>
      </div>
      <div className="flex items-end gap-1 h-24">
        {series.map((item) => {
          const height = Math.max(2, Math.round((item.count / max) * 100));
          return (
            <div
              key={item.date}
              className="flex-1 h-full flex flex-col items-center justify-end"
              title={`${item.date}：${item.count}${unit}`}
            >
              <div
                className="w-full bg-[#8fb3c7] rounded-t transition-all"
                style={{ height: `${height}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-xs text-slate-400 mt-1">
        <span>{first}</span>
        <span>{last}</span>
      </div>
    </div>
  );
}

const DASHBOARD_DAYS = [7, 14, 30];

function DashboardPanel() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState(null);
  const [memStats, setMemStats] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setError("");
      // 记忆观测指标与主看板并行拉取；它挂了不影响主看板
      const [result, mem] = await Promise.all([
        api(`/api/admin/dashboard?days=${days}`),
        api(`/api/admin/memories/stats?days=${days}`).catch(() => null),
      ]);
      setData(result);
      setMemStats(mem);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <section className={cardClass}>
        <p className="text-sm text-red-600">统计数据读取失败：{error}</p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className={cardClass}>
        <Alert kind="info">正在统计数据...</Alert>
      </section>
    );
  }

  const cards = [
    {
      label: "用户总数",
      value: data.totals.users,
      sub: `今日新增 +${data.today.newUsers}`,
    },
    {
      label: "对话总数",
      value: data.totals.conversations,
      sub: `近 ${data.days} 天活跃 ${data.activeUsers} 人`,
    },
    {
      label: "消息总数",
      value: data.totals.messages,
      sub: `今日新增 +${data.today.newMessages}`,
    },
    {
      label: "日记总数",
      value: data.totals.diaries,
      sub: `今日新增 +${data.today.newDiaries}`,
    },
  ];

  const moodTotal = data.moodDistribution.reduce((sum, item) => sum + item.count, 0);

  return (
    <section className={cardClass}>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 className="text-sm font-bold text-slate-800">数据看板</h2>
        <div className="flex items-center gap-2">
          {DASHBOARD_DAYS.map((item) => (
            <button
              key={item}
              type="button"
              className={`px-2 py-1 text-xs rounded border transition-colors ${
                days === item
                  ? "border-[#8fb3c7] bg-[#e8eff2] text-slate-800 font-medium"
                  : "border-[#d5d9d7] text-slate-500 hover:bg-[#f2f5f4]"
              }`}
              onClick={() => setDays(item)}
            >
              近 {item} 天
            </button>
          ))}
          <button type="button" className={btnBase} onClick={load} disabled={loading}>
            {loading ? "刷新中" : "刷新"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {cards.map((card) => (
          <div key={card.label} className="border border-[#e6e8e6] rounded-lg p-3">
            <div className="text-xs text-slate-500">{card.label}</div>
            <div className="text-2xl font-bold text-slate-800 my-1">{card.value}</div>
            <div className="text-xs text-slate-400">{card.sub}</div>
          </div>
        ))}
      </div>

      {memStats?.ok && (
        <div className="border border-[#e6e8e6] rounded-lg p-3 mb-4">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-1">
            <h3 className="text-xs font-bold text-slate-700">
              长期记忆（近 {memStats.days} 天）
            </h3>
            <span className="text-xs text-slate-400">
              注入 {memStats.totals.requests} 次 · 平均 {memStats.totals.avgFacts} 条/次
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <div className="text-xs text-slate-500">注入次数</div>
              <div className="text-xl font-bold text-slate-800">{memStats.totals.requests}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">累计注入条数</div>
              <div className="text-xl font-bold text-slate-800">{memStats.totals.facts}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">压缩次数</div>
              <div className="text-xl font-bold text-slate-800">{memStats.totals.compactRuns}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">压缩条数</div>
              <div className="text-xl font-bold text-slate-800">{memStats.totals.compactedRows}</div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div className="border border-[#e6e8e6] rounded-lg p-3">
          <MiniBarChart title="消息量趋势" series={data.messageTrend} unit=" 条" />
        </div>
        <div className="border border-[#e6e8e6] rounded-lg p-3">
          <MiniBarChart title="新增用户趋势" series={data.userTrend} unit=" 人" />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="border border-[#e6e8e6] rounded-lg p-3">
          <h3 className="text-xs font-bold text-slate-700 mb-2">
            日记情绪分布（近 {data.days} 天）
          </h3>
          {moodTotal === 0 ? (
            <p className="text-xs text-slate-400">这段时间还没有带标签的日记</p>
          ) : (
            <ul className="space-y-2">
              {data.moodDistribution.map((item) => (
                <li key={item.mood} className="text-xs">
                  <div className="flex justify-between text-slate-600 mb-1">
                    <span>{item.mood}</span>
                    <span className="text-slate-400">{item.count} 篇</span>
                  </div>
                  <div className="h-2 bg-[#eef1ef] rounded overflow-hidden">
                    <div
                      className="h-full bg-[#a8c4d4]"
                      style={{ width: `${Math.round((item.count / moodTotal) * 100)}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-slate-400 mt-2">
            仅作整体观察用，不做个体评判
          </p>
        </div>

        <div className="border border-[#e6e8e6] rounded-lg p-3">
          <h3 className="text-xs font-bold text-slate-700 mb-2">
            活跃用户 Top 5（近 {data.days} 天，邮箱已掩码）
          </h3>
          {data.topUsers.length === 0 ? (
            <p className="text-xs text-slate-400">这段时间还没有活跃用户</p>
          ) : (
            <ol className="space-y-2 text-xs text-slate-600">
              {data.topUsers.map((item, index) => (
                <li key={item.id} className="flex justify-between gap-2">
                  <span className="truncate">
                    <span className="text-slate-400 mr-1">{index + 1}.</span>
                    {item.username || item.email}
                  </span>
                  <span className="text-slate-400 shrink-0">{item.messageCount} 条</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      {/* 运行指标：接口耗时 + AI 用量 + 内容安全命中 */}
      <MetricsBlock />
    </section>
  );
}

/** 后台歌单管理：本地上传 / 外链直链 / 网易云 */
function MusicTracksPanel({ setError, setNotice }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState("");
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [source, setSource] = useState("url");
  const [url, setUrl] = useState("");
  const [neteaseId, setNeteaseId] = useState("");
  const [neteaseType, setNeteaseType] = useState("2");
  // 管理员备注：只在后台显示，用户端拿不到
  const [adminNote, setAdminNote] = useState("");
  // 自定义确认弹窗（替代 window.confirm）：{ message, confirmText, onConfirm }
  const [confirmBox, setConfirmBox] = useState(null);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await api("/api/admin/music");
      setData(res);
    } catch (err) {
      setError(err.message);
    }
  }, [setError]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 「取名称」：请求网易云**公开网页**读取歌名 / 歌单名，自动填进输入框。
   * 网易云官方没有开放"按 ID 取名称"的接口，所以这里只读网页标题；
   * 拿不到就让管理员手填 —— 不重试、不伪造。
   */
  async function fetchNeteaseName() {
    setBusy("fetchName");
    setError("");
    setNotice("");
    try {
      const result = await api(
        `/api/admin/music/netease-info?id=${encodeURIComponent(neteaseId)}&type=${neteaseType}`
      );
      if (!result?.ok) throw new Error(result?.error || "取不到名称");
      if (result.title) setTitle(result.title);
      if (result.artist) setArtist(result.artist);
      setNotice(`已读取到：${result.raw || result.title}`);
    } catch (err) {
      setError("取名称失败：" + err.message + "（可以手动填写）");
    } finally {
      setBusy("");
    }
  }

  /** 导入音乐包：选一个 JSON 文件，上传后新增歌单与音频 */
  async function handleImport(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    // 弹窗是异步的，先把文件存到 ref，确认后还能取到
    fileRef.current = file;
    setConfirmBox({
      message: "导入会新增歌单与音频文件。继续？",
      confirmText: "继续导入",
      onConfirm: () => doImport(),
    });
  }

  async function doImport() {
    setConfirmBox(null);
    const file = fileRef.current;
    fileRef.current = null;
    if (!file) return;
    setBusy("import");
    setError("");
    setNotice("");
    try {
      const text = await file.text();
      const pack = JSON.parse(text);
      const res = await fetch("/api/admin/music/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pack),
      });
      const result = await res.json().catch(() => null);
      if (!res.ok) throw new Error(result?.error || `导入失败（HTTP ${res.status}）`);
      setNotice(
        `导入完成：新增歌曲 ${result.addedTracks} 首、音频 ${result.addedFiles} 个` +
          (result.skippedTracks ? `，跳过 ${result.skippedTracks} 条` : "")
      );
      await load();
    } catch (err) {
      setError("导入失败：" + err.message);
    } finally {
      setBusy("");
    }
  }

  async function handleUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy("upload");
    setError("");
    setNotice("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("title", title || file.name.replace(/\.[^.]+$/, ""));
      fd.append("artist", artist || "");
      const res = await fetch("/api/admin/music/upload", { method: "POST", body: fd });
      const result = await res.json().catch(() => null);
      if (!res.ok) throw new Error(result?.error || `上传失败（HTTP ${res.status}）`);
      setNotice(`已上传：${result.title}（${Math.round((result.bytes || 0) / 1024)}KB）`);
      setTitle("");
      setArtist("");
      await load();
    } catch (err) {
      setError("上传失败：" + err.message);
    } finally {
      setBusy("");
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleAdd() {
    setBusy("add");
    setError("");
    setNotice("");
    try {
      await api("/api/admin/music", {
        method: "POST",
        body: { source, title, artist, url, neteaseId, neteaseType, adminNote },
      });
      setNotice(source === "netease" ? "已添加网易云歌曲" : "已添加外链歌曲");
      setTitle("");
      setArtist("");
      setUrl("");
      setNeteaseId("");
      setAdminNote("");
      await load();
    } catch (err) {
      setError("添加失败：" + err.message);
    } finally {
      setBusy("");
    }
  }

  function handleRemove(track) {
    setConfirmBox({
      message: `删除「${track.title}」？${track.source === "local" ? "本地文件也会一起删掉。" : ""}`,
      confirmText: "删除",
      onConfirm: () => doRemove(track),
    });
  }

  async function doRemove(track) {
    setConfirmBox(null);
    setBusy(`del-${track.id}`);
    try {
      await api(`/api/admin/music?id=${encodeURIComponent(track.id)}`, { method: "DELETE" });
      setNotice("已删除");
      await load();
    } catch (err) {
      setError("删除失败：" + err.message);
    } finally {
      setBusy("");
    }
  }

  async function handleToggle(track) {
    setBusy(`toggle-${track.id}`);
    try {
      await api("/api/admin/music", {
        method: "PATCH",
        body: { id: track.id, enabled: Number(track.enabled) !== 1 },
      });
      await load();
    } catch (err) {
      setError("操作失败：" + err.message);
    } finally {
      setBusy("");
    }
  }

  async function handleMove(track, delta) {
    const next = Number(track.sort_order || 0) + delta;
    setBusy(`move-${track.id}`);
    try {
      await api("/api/admin/music", { method: "PATCH", body: { id: track.id, sortOrder: next } });
      await load();
    } catch (err) {
      setError("调整顺序失败：" + err.message);
    } finally {
      setBusy("");
    }
  }

  const tracks = data?.tracks || [];
  const disk = data?.disk || { count: 0, mb: 0 };
  const isNetease = source === "netease";

  return (
    <section className={`${cardClass} mb-4`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <h2 className="text-sm font-bold text-slate-800">歌单管理</h2>
          <p className="text-xs text-slate-500 mt-1">
            本地文件存在 public/music/，共 {disk.count} 个文件 · 约 {disk.mb} MB
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnBase} onClick={load}>
            刷新
          </button>
          <button
            type="button"
            className={btnBase}
            onClick={() => window.open("/api/admin/music/export", "_blank")}
            title="把歌单与全部音频导出成一个 JSON 文件（换服务器/备份用）"
          >
            导出音乐包
          </button>
          <label className={`${btnBase} px-3 py-1.5 text-xs cursor-pointer`}>
            导入音乐包
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={handleImport}
            />
          </label>
        </div>
      </div>

      {/* 添加区 */}
      <div className="border border-[#e6e8e6] rounded-lg p-3 mb-3 space-y-2">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <Field label={source === "netease" ? "名称（可点右侧「取名称」自动填）" : "歌名"}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={inputClass}
              placeholder={
                source === "netease" ? "留空会自动取，也可以手填" : "留空则用文件名"
              }
            />
          </Field>
          <Field label="歌手（可空）">
            <input value={artist} onChange={(e) => setArtist(e.target.value)} className={inputClass} />
          </Field>
        </div>

        {/* 本地上传 */}
        <div className="pt-2 border-t border-[#f0f2f0]">
          <p className="text-xs text-slate-600 mb-1.5">
            ① 上传本地音频（mp3 / m4a / wav / ogg，单个不超过 20MB）
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".mp3,.m4a,.wav,.ogg,audio/*"
            onChange={handleUpload}
            disabled={busy === "upload"}
            className="text-xs text-slate-600"
          />
          {busy === "upload" ? <span className="text-xs text-slate-400 ml-2">上传中...</span> : null}
        </div>

        {/* 外链 / 网易云 */}
        <div className="pt-2 border-t border-[#f0f2f0] space-y-2">
          <p className="text-xs text-slate-600">② 或添加链接</p>
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setSource("url")}
              className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                !isNetease
                  ? "border-[#8fb3c7] bg-[#e8eff2] text-slate-800"
                  : "border-[#d5d9d7] text-slate-500 hover:bg-[#f2f5f4]"
              }`}
            >
              外链直链
            </button>
            <button
              type="button"
              onClick={() => setSource("netease")}
              className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                isNetease
                  ? "border-[#8fb3c7] bg-[#e8eff2] text-slate-800"
                  : "border-[#d5d9d7] text-slate-500 hover:bg-[#f2f5f4]"
              }`}
            >
              网易云收藏
            </button>
          </div>

          {isNetease ? (
            <>
              <Field label="内容类型">
                <select
                  value={neteaseType}
                  onChange={(e) => setNeteaseType(e.target.value)}
                  className={inputClass}
                >
                  <option value="2">单曲（type=2）</option>
                  <option value="0">歌单（type=0，会显示完整歌曲列表）</option>
                </select>
              </Field>
              <Field label={neteaseType === "0" ? "网易云歌单 ID" : "网易云歌曲 ID"}>
                <div className="flex gap-2">
                  <input
                    value={neteaseId}
                    onChange={(e) => setNeteaseId(e.target.value)}
                    className={inputClass}
                    placeholder="例如 1901371647，或粘贴含 id= 的链接"
                  />
                  <button
                    type="button"
                    disabled={busy === "fetchName" || !neteaseId.trim()}
                    onClick={fetchNeteaseName}
                    className={`${btnBase} shrink-0`}
                    title="请求网易云公开网页读取名称，自动填到上面的输入框"
                  >
                    {busy === "fetchName" ? "读取中…" : "取名称"}
                  </button>
                </div>
              </Field>

              <Field label="管理员备注（只有后台能看到）">
                <textarea
                  value={adminNote}
                  onChange={(e) => setAdminNote(e.target.value)}
                  rows={2}
                  className={inputClass}
                  placeholder="例如：热歌榜 / 比赛用 / 备用 —— 用户端不会显示这一栏"
                />
              </Field>
              <p className="text-xs text-slate-400 leading-relaxed">
                ⚠️ 只填 ID，不做任何解析 —— 网易云官方没有开放播放地址接口。
                用户端会用**官方外链播放器**嵌入，**用户可以点播放器里的按钮播放/暂停/切歌**；
                但我们（代码）控制不了它，也进不了自动播放队列（跨域限制）。
              </p>
            </>
          ) : (
            <Field label="音频直链">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className={inputClass}
                placeholder="https://你的域名/xxx.mp3"
              />
            </Field>
          )}

          <button
            type="button"
            className={btnPrimary}
            disabled={busy === "add"}
            onClick={handleAdd}
          >
            {busy === "add" ? "添加中..." : "添加"}
          </button>
        </div>
      </div>

      {/* 列表 */}
      {!tracks.length ? (
        <p className="text-xs text-slate-400 py-4 text-center">还没有歌曲</p>
      ) : (
        <ul className="space-y-2">
          {tracks.map((track) => (
            <li
              key={track.id}
              className="border border-[#e6e8e6] rounded-lg px-3 py-2 flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <p className="text-sm text-slate-700 truncate">
                  {track.title}
                  {track.artist ? <span className="text-slate-400"> · {track.artist}</span> : null}
                </p>
                <p className="text-xs text-slate-400 truncate mt-0.5">
                  来源：
                  {track.source === "local" ? "本地上传" : track.source === "netease" ? "网易云" : "外链"}
                  {track.source === "netease" && String(track.netease_type) === "0" ? "歌单" : ""}
                  {Number(track.enabled) === 1 ? " · 启用中" : " · 已停用"}
                  {track.url ? ` · ${track.url}` : ""}
                </p>
                {track.admin_note ? (
                  <p className="text-xs text-amber-600 truncate mt-0.5" title="只有后台能看到这一栏">
                    备注：{track.admin_note}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button type="button" className={`${btnBase} px-2 py-1 text-xs`} disabled={busy === `move-${track.id}`} onClick={() => handleMove(track, -1)} title="上移">
                  ↑
                </button>
                <button type="button" className={`${btnBase} px-2 py-1 text-xs`} disabled={busy === `move-${track.id}`} onClick={() => handleMove(track, 1)} title="下移">
                  ↓
                </button>
                <button type="button" className={`${btnBase} px-2 py-1 text-xs`} disabled={busy === `toggle-${track.id}`} onClick={() => handleToggle(track)}>
                  {Number(track.enabled) === 1 ? "停用" : "启用"}
                </button>
                <button
                  type="button"
                  disabled={busy === `del-${track.id}`}
                  onClick={() => handleRemove(track)}
                  className="border border-[#e5c9c9] bg-[#fdf6f6] text-red-500 rounded-lg px-2 py-1 text-xs hover:bg-[#fbecec] transition-colors"
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 自定义确认弹窗（替代 window.confirm） */}
      <ConfirmModal
        open={!!confirmBox}
        message={confirmBox?.message || ""}
        confirmText={confirmBox?.confirmText || "确认删除"}
        onConfirm={confirmBox?.onConfirm || (() => {})}
        onClose={() => setConfirmBox(null)}
      />
    </section>
  );
}

/** 运行指标：接口耗时、AI 用量、内容安全命中（数据来自 /api/admin/metrics） */
function MetricsBlock() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      const res = await api("/api/admin/metrics?days=7");
      setData(res);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return <p className="text-xs text-red-500 mt-3">运行指标读取失败：{error}</p>;
  }
  if (!data) return null;

  const db = data.database || {};
  const usage = data.usage || {};
  const apiPaths = (data.api?.paths || []).slice(0, 6);
  const safety = data.safety || [];
  const daily = data.daily || [];
  const days = usage.days || 7;

  return (
    <div className="border border-[#e6e8e6] rounded-lg p-3 mt-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold text-slate-700">运行指标</h3>
        <button type="button" className={btnBase} onClick={load}>
          刷新
        </button>
      </div>

      <div>
        <p className="text-xs text-slate-600 mb-1.5">
          接口耗时（本次启动以来 · 平均最慢的几个）
        </p>
        {apiPaths.length === 0 ? (
          <p className="text-xs text-slate-400">还没有记录</p>
        ) : (
          <ul className="space-y-1">
            {apiPaths.map((item) => (
              <li key={item.path} className="flex justify-between text-xs gap-2">
                <span className="text-slate-600 truncate">{item.path}</span>
                <span className="text-slate-400 shrink-0">
                  平均 {item.avgMs}ms · 最慢 {item.maxMs}ms · {item.count} 次
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-slate-400 mt-1">
          数据库查询 {db.totalQueries || 0} 次 · 平均 {db.avgMs || 0}ms · 最慢 {db.maxMs || 0}ms
          · 慢查询（≥{db.slowThresholdMs || 300}ms）{db.slowQueries || 0} 次
        </p>
      </div>

      <div>
        <p className="text-xs text-slate-600 mb-1.5">AI 用量（近 {days} 天）</p>
        {(usage.calls || 0) === 0 ? (
          <p className="text-xs text-slate-400">这段时间还没有调用记录</p>
        ) : (
          <>
            <p className="text-xs text-slate-500">
              共 {usage.calls} 次 · 消耗 {usage.totalTokens} tokens · 平均 {usage.avgMs}ms
              {usage.failures ? ` · 失败 ${usage.failures} 次` : ""}
            </p>
            <ul className="space-y-1 mt-1">
              {(usage.byKind || []).map((item) => (
                <li key={item.kind} className="flex justify-between text-xs">
                  <span className="text-slate-600">{item.kind}</span>
                  <span className="text-slate-400">
                    {item.calls} 次 · {item.tokens} tokens · 平均 {item.avgMs}ms
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {daily.length ? (
          <p className="text-xs text-slate-400 mt-1">
            另有 {daily.length} 条按天汇总的历史记录（明细清理后仍保留）
          </p>
        ) : null}
      </div>

      <div>
        <p className="text-xs text-slate-600 mb-1.5">内容安全命中（近 {days} 天）</p>
        {safety.length === 0 ? (
          <p className="text-xs text-slate-400">这段时间没有命中记录</p>
        ) : (
          <ul className="space-y-1">
            {safety.map((item) => (
              <li key={item.category} className="flex justify-between text-xs">
                <span className="text-slate-600">{item.category}</span>
                <span className="text-slate-400">{item.count} 次</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-slate-400 mt-1">只记录命中的类别，不保存用户原话</p>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 概览页 */

function OverviewPanel({ overview, onReload }) {
  if (!overview) {
    return (
      <section className={cardClass}>
        <Alert kind="info">正在读取运行状态...</Alert>
      </section>
    );
  }

  const { env, database, admin, readiness } = overview;

  const rows = [
    {
      label: "数据库",
      ok: database.connected,
      detail: database.connected
        ? `${database.user}@${database.host}:${database.port}/${database.database}（MySQL ${database.version}）`
        : database.error,
    },
    {
      label: "对话 AI",
      ok: Boolean(readiness.ai?.enabled && readiness.ai?.configured),
      detail: readiness.ai
        ? `模型 ${readiness.ai.model || "未填"}｜${readiness.ai.configured ? "配置完整" : "配置不完整（缺 Key / 地址 / 模型）"}｜${readiness.ai.enabled ? "已启用" : "已关闭"}`
        : "读取失败",
    },
    {
      label: "语音 TTS",
      ok: Boolean(readiness.tts?.enabled && readiness.tts?.configured),
      detail: readiness.tts
        ? `模型 ${readiness.tts.model || "未填"}｜音色 ${readiness.tts.voice || "未填"}｜${readiness.tts.configured ? "配置完整" : "配置不完整（缺 Key / 地址 / 模型 / 音色）"}｜${readiness.tts.enabled ? "已启用" : "已关闭"}`
        : "读取失败",
    },
    {
      label: "邮件 SMTP",
      ok: Boolean(readiness.smtp?.enabled && readiness.smtp?.configured),
      detail: readiness.smtp
        ? `${readiness.smtp.host}:${readiness.smtp.port}｜账号 ${readiness.smtp.user || "未填"}｜${readiness.smtp.configured ? "配置完整" : "配置不完整（缺服务器 / 账号 / 授权码）"}｜${readiness.smtp.enabled ? "已启用" : "已关闭"}`
        : "读取失败",
    },
  ];

  return (
    <div className="space-y-4">
      {readiness.site?.adminNotice ? (
        <Alert kind="info">{readiness.site.adminNotice}</Alert>
      ) : null}

      <DashboardPanel />

      <section className={cardClass}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-slate-800">模块状态</h2>
          <button type="button" className={btnBase} onClick={onReload}>
            刷新
          </button>
        </div>
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.label} className="text-sm">
              <div className="font-medium text-slate-700">
                <StatusDot ok={row.ok} />
                {row.label}
              </div>
              <div className="text-xs text-slate-500 pl-4 break-words">{row.detail || "-"}</div>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section className={cardClass}>
          <h2 className="text-sm font-bold text-slate-800 mb-3">服务器环境</h2>
          <dl className="text-xs text-slate-600 space-y-2">
            <div className="flex justify-between gap-3">
              <dt>Node 版本</dt>
              <dd className="font-mono">{env.nodeVersion}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>运行平台</dt>
              <dd className="font-mono">{env.platform}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>NODE_ENV</dt>
              <dd className="font-mono">{env.nextEnv}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>已运行</dt>
              <dd className="font-mono">{Math.floor(env.uptimeSeconds / 60)} 分钟</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>服务器时间</dt>
              <dd className="font-mono">{new Date(env.serverTime).toLocaleString()}</dd>
            </div>
          </dl>
        </section>

        <section className={cardClass}>
          <h2 className="text-sm font-bold text-slate-800 mb-3">账号</h2>
          <dl className="text-xs text-slate-600 space-y-2">
            <div className="flex justify-between gap-3">
              <dt>当前登录</dt>
              <dd className="font-mono">{admin.username}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>管理员数量</dt>
              <dd className="font-mono">{admin.adminCount}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>上次登录</dt>
              <dd className="font-mono">{admin.lastLoginAt ? String(admin.lastLoginAt) : "-"}</dd>
            </div>
          </dl>
        </section>
      </div>

      <LogsPanel logs={overview.logs} compact />
    </div>
  );
}

/* ---------------------------------------------------------------- 日志表 */

function LogsPanel({ logs, compact = false }) {
  const [rows, setRows] = useState(logs || null);

  useEffect(() => {
    if (logs) setRows(logs);
  }, [logs]);

  useEffect(() => {
    if (compact) return;
    api("/api/admin/logs?limit=100")
      .then((data) => setRows(data.logs || []))
      .catch(() => setRows([]));
  }, [compact]);

  if (!rows) return null;

  return (
    <section className={cardClass}>
      <h2 className="text-sm font-bold text-slate-800 mb-3">
        {compact ? "最近操作" : "操作日志（最近 100 条）"}
      </h2>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-400">暂无记录</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 border-b border-[#eceeec]">
                <th className="text-left py-2 pr-3 font-medium">时间</th>
                <th className="text-left py-2 pr-3 font-medium">账号</th>
                <th className="text-left py-2 pr-3 font-medium">操作</th>
                <th className="text-left py-2 pr-3 font-medium">详情</th>
                <th className="text-left py-2 font-medium">IP</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-[#f2f3f1] text-slate-600">
                  <td className="py-1.5 pr-3 whitespace-nowrap font-mono">{String(row.created_at)}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{row.username || "-"}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{row.action}</td>
                  <td className="py-1.5 pr-3">{row.detail || "-"}</td>
                  <td className="py-1.5 whitespace-nowrap font-mono">{row.ip || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------ 用户管理 */

const GENDER_OPTIONS = ["", "男", "女", "其他", "保密"];

// 可开关的字段（邮箱、账号、密码是强制显示的，不在这里）
const FIELD_LABELS = [
  { key: "nickname", label: "昵称" },
  { key: "gender", label: "性别" },
  { key: "birthday", label: "出生年月" },
  { key: "phone", label: "手机号" },
  { key: "remark", label: "备注" },
  { key: "status", label: "账号状态" },
  { key: "createdAt", label: "注册时间" },
  { key: "lastLoginAt", label: "最后登录" },
];

const EMPTY_USER_FORM = {
  id: null,
  email: "",
  account: "",
  password: "",
  username: "",
  gender: "",
  birthday: "",
  phone: "",
  remark: "",
  status: 1,
};

// 模块级用户管理快照缓存：切换 Tab 时 0 毫秒瞬间呈现，后台静默拉取更新（SWR 机制）
let globalUsersCache = null;

function UsersPanel({ setError, setNotice }) {
  const [data, setData] = useState(() => globalUsersCache);
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [reveal, setReveal] = useState(false);
  const [fields, setFields] = useState(() => globalUsersCache?.visibleFields || null); // 已保存的开关
  const [draftFields, setDraftFields] = useState(null); // 正在编辑、还没保存的开关
  const [loading, setLoading] = useState(() => !globalUsersCache);
  const [savingFields, setSavingFields] = useState(false);
  const [form, setForm] = useState(null); // null 表示弹窗关闭
  const [busy, setBusy] = useState(false);
  // 自定义确认弹窗（替代 window.confirm）
  const [confirmBox, setConfirmBox] = useState(null);
  const pageSize = 20;

  async function load(overrides = {}) {
    const nextPage = overrides.page ?? page;
    const nextKeyword = overrides.keyword ?? keyword;
    const nextReveal = overrides.reveal ?? reveal;

    setLoading(true);
    try {
      const query = new URLSearchParams({
        keyword: nextKeyword,
        page: String(nextPage),
        pageSize: String(pageSize),
        revealPassword: nextReveal ? "1" : "0",
      });
      const result = await api(`/api/admin/users?${query.toString()}`);
      globalUsersCache = result;
      setData(result);
      setPage(result.page || nextPage);
      setKeyword(nextKeyword);
      setReveal(Boolean(result.revealPassword));
      setFields(result.visibleFields || {});
      setDraftFields((prev) => prev || result.visibleFields || {});
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // 只在挂载时拉一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = fields || data?.visibleFields || {};
  // 复选框编辑 draft，保存后才影响列表的显示
  const editing = draftFields || visible;
  const users = data?.users || [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  async function saveFields() {
    if (!editing) return;

    setSavingFields(true);
    setError("");
    setNotice("");
    try {
      await api("/api/admin/settings", {
        method: "PUT",
        body: { group: "users", values: { visibleFields: editing } },
      });
      setNotice("字段显示开关已保存");
      setDraftFields(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingFields(false);
    }
  }

  async function submitForm(event) {
    event.preventDefault();
    if (!form) return;

    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (form.id) {
        const body = {
          id: form.id,
          email: form.email,
          account: form.account,
          username: form.username,
          gender: form.gender,
          birthday: form.birthday,
          phone: form.phone,
          remark: form.remark,
          status: form.status,
        };
        if (form.password) body.password = form.password;
        await api("/api/admin/users", { method: "PATCH", body });
      } else {
        await api("/api/admin/users", {
          method: "POST",
          body: {
            email: form.email,
            account: form.account,
            password: form.password,
            username: form.username,
            gender: form.gender,
            birthday: form.birthday,
            phone: form.phone,
            remark: form.remark,
            status: form.status,
          },
        });
      }
      setNotice(form.id ? "用户已更新" : "用户已添加");
      setForm(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function removeUser(user) {
    setConfirmBox({
      message: `确定删除用户「${user.email}」吗？\n他的聊天记录和日记也会一起删除，且不可恢复。`,
      confirmText: "删除用户",
      onConfirm: () => doRemoveUser(user),
    });
  }

  async function doRemoveUser(user) {
    setConfirmBox(null);
    setError("");
    setNotice("");
    try {
      await api(`/api/admin/users?id=${encodeURIComponent(user.id)}`, { method: "DELETE" });
      setNotice("用户已删除");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleStatus(user) {
    setError("");
    setNotice("");
    try {
      await api("/api/admin/users", {
        method: "PATCH",
        body: { id: user.id, status: user.status === 1 ? 0 : 1 },
      });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function clearPassword(user) {
    setConfirmBox({
      message: "确定清空该用户的密码吗？之后他只能用邮箱验证码登录。",
      confirmText: "清空密码",
      onConfirm: () => doClearPassword(user),
    });
  }

  async function doClearPassword(user) {
    setConfirmBox(null);
    setError("");
    setNotice("");
    try {
      await api("/api/admin/users", {
        method: "PATCH",
        body: { id: user.id, clearPassword: true },
      });
      setNotice("密码已清空");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <section className={cardClass}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h2 className="text-sm font-bold text-slate-800">信息显示开关</h2>
            <p className="text-xs text-slate-500 mt-1">
              邮箱、账号、密码是<strong>强制显示</strong>的，不受这里控制；下面这些字段可以选择性显示。
            </p>
          </div>
          <button
            type="button"
            className={btnPrimary}
            onClick={saveFields}
            disabled={savingFields}
          >
            {savingFields ? "保存中..." : "保存开关"}
          </button>
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {FIELD_LABELS.map((item) => (
            <label
              key={item.key}
              className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer"
            >
              <input
                type="checkbox"
                className="w-4 h-4 accent-[#7fa3b8]"
                checked={editing[item.key] !== false}
                onChange={(e) =>
                  setDraftFields((prev) => ({
                    ...(prev || visible),
                    [item.key]: e.target.checked,
                  }))
                }
              />
              {item.label}
            </label>
          ))}
        </div>

        {data?.keyIsDefault ? (
          <p className="text-xs text-amber-700 mt-3">
            提示：当前使用的是默认加密密钥。建议在 <code>.env.local</code> 里设置{" "}
            <code>USER_PASSWORD_KEY</code>（或 <code>CODE_SECRET</code>）来提高强度；
            注意设置后要先重启服务，已经存过的密码需要用新密钥重新保存一次才能解开。
          </p>
        ) : null}
      </section>

      <section className={cardClass}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="flex items-center gap-2 mr-auto">
            <h2 className="text-sm font-bold text-slate-800">
              用户列表（共 {data?.total ?? 0} 人）
            </h2>
            {loading && data ? (
              <span className="text-[10px] text-[#b85a3c] bg-[#FFF5EF] px-2 py-0.5 rounded-full border border-[#f0ded4] animate-pulse">
                同步中…
              </span>
            ) : null}
          </div>
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") load({ page: 1 });
            }}
            placeholder="搜索邮箱 / 账号 / 昵称 / 手机号"
            className={`${inputClass} w-56`}
          />
          <button type="button" className={btnBase} onClick={() => load({ page: 1 })}>
            搜索
          </button>
          <button
            type="button"
            className={btnBase}
            onClick={() => load({ reveal: !reveal })}
          >
            {reveal ? "隐藏密码" : "显示密码"}
          </button>
          <button
            type="button"
            className={btnPrimary}
            onClick={() => setForm({ ...EMPTY_USER_FORM })}
          >
            + 添加用户
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 border-b border-[#eceeec]">
                <th className="text-left py-2 pr-3 font-medium">ID</th>
                <th className="text-left py-2 pr-3 font-medium">邮箱</th>
                <th className="text-left py-2 pr-3 font-medium">账号</th>
                <th className="text-left py-2 pr-3 font-medium">密码</th>
                {visible.gender ? <th className="text-left py-2 pr-3 font-medium">性别</th> : null}
                {visible.birthday ? (
                  <th className="text-left py-2 pr-3 font-medium">出生年月</th>
                ) : null}
                {visible.nickname ? (
                  <th className="text-left py-2 pr-3 font-medium">昵称</th>
                ) : null}
                {visible.phone ? <th className="text-left py-2 pr-3 font-medium">手机号</th> : null}
                {visible.remark ? <th className="text-left py-2 pr-3 font-medium">备注</th> : null}
                {visible.status ? <th className="text-left py-2 pr-3 font-medium">状态</th> : null}
                {visible.createdAt ? (
                  <th className="text-left py-2 pr-3 font-medium">注册时间</th>
                ) : null}
                {visible.lastLoginAt ? (
                  <th className="text-left py-2 pr-3 font-medium">最后登录</th>
                ) : null}
                <th className="text-left py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr>
                  <td colSpan={13} className="py-4 text-slate-400">
                    {data ? "暂无用户" : "加载中..."}
                  </td>
                </tr>
              ) : null}

              {users.map((user) => (
                <tr key={user.id} className="border-b border-[#f2f3f1] text-slate-600 align-top">
                  <td className="py-2 pr-3 font-mono">{user.id}</td>
                  <td className="py-2 pr-3 break-all">{user.email}</td>
                  <td className="py-2 pr-3 font-mono">{user.account || "-"}</td>
                  <td className="py-2 pr-3 font-mono break-all">
                    {!user.hasPassword ? (
                      <span className="text-slate-400">未设置</span>
                    ) : reveal ? (
                      user.passwordReadable ? (
                        user.password
                      ) : (
                        <span className="text-amber-700">解密失败（密钥变过）</span>
                      )
                    ) : (
                      "••••••"
                    )}
                  </td>
                  {visible.gender ? <td className="py-2 pr-3">{user.gender || "-"}</td> : null}
                  {visible.birthday ? <td className="py-2 pr-3">{user.birthday || "-"}</td> : null}
                  {visible.nickname ? (
                    <td className="py-2 pr-3">{user.username || "-"}</td>
                  ) : null}
                  {visible.phone ? <td className="py-2 pr-3">{user.phone || "-"}</td> : null}
                  {visible.remark ? <td className="py-2 pr-3">{user.remark || "-"}</td> : null}
                  {visible.status ? (
                    <td className="py-2 pr-3">
                      {user.status === 1 ? (
                        <span className="text-emerald-600">正常</span>
                      ) : (
                        <span className="text-red-600">已禁用</span>
                      )}
                    </td>
                  ) : null}
                  {visible.createdAt ? (
                    <td className="py-2 pr-3 font-mono whitespace-nowrap">
                      {user.created_at || "-"}
                    </td>
                  ) : null}
                  {visible.lastLoginAt ? (
                    <td className="py-2 pr-3 font-mono whitespace-nowrap">
                      {user.last_login_at || "-"}
                    </td>
                  ) : null}
                  <td className="py-2 whitespace-nowrap">

                    <button
                      type="button"
                      className="text-[#5b8aa6] hover:underline mr-2"
                      onClick={() =>
                        setForm({
                          id: user.id,
                          email: user.email || "",
                          account: user.account || "",
                          password: "",
                          username: user.username || "",
                          gender: user.gender || "",
                          birthday: user.birthday || "",
                          phone: user.phone || "",
                          remark: user.remark || "",
                          status: user.status === 1 ? 1 : 0,
                        })
                      }
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="text-[#5b8aa6] hover:underline mr-2"
                      onClick={() => toggleStatus(user)}
                    >
                      {user.status === 1 ? "禁用" : "启用"}
                    </button>
                    <button
                      type="button"
                      className="text-[#5b8aa6] hover:underline mr-2"
                      onClick={() => clearPassword(user)}
                    >
                      清空密码
                    </button>
                    <button
                      type="button"
                      className="text-red-500 hover:underline"
                      onClick={() => removeUser(user)}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {totalPages > 1 ? (
          <div className="flex items-center gap-2 mt-3 text-xs text-slate-500">
            <button
              type="button"
              className={btnBase}
              disabled={page <= 1}
              onClick={() => load({ page: page - 1 })}
            >
              上一页
            </button>
            <span>
              第 {page} / {totalPages} 页
            </span>
            <button
              type="button"
              className={btnBase}
              disabled={page >= totalPages}
              onClick={() => load({ page: page + 1 })}
            >
              下一页
            </button>
          </div>
        ) : null}
      </section>

      {form ? (
        <div
          className="fixed inset-0 bg-black/20 flex items-center justify-center z-50"
          onClick={() => setForm(null)}
        >
          <form
            onSubmit={submitForm}
            className="bg-white rounded-xl p-4 w-[460px] max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-bold text-slate-800 mb-3">
              {form.id ? `编辑用户 #${form.id}` : "添加用户"}
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
              <Field label="邮箱（必填）" hint="用于邮箱验证码登录">
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className={inputClass}
                  required
                />
              </Field>
              <Field label="登录账号" hint="3-32 位字母数字，可留空">
                <input
                  value={form.account}
                  onChange={(e) => setForm({ ...form, account: e.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field
                label={form.id ? "重置密码（留空 = 不修改）" : "登录密码"}
                hint="至少 6 位；留空表示该用户只能用邮箱验证码登录"
              >
                <input
                  type="text"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  className={inputClass}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="昵称 / 显示名">
                <input
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field label="性别">
                <select
                  value={form.gender}
                  onChange={(e) => setForm({ ...form, gender: e.target.value })}
                  className={inputClass}
                >
                  {GENDER_OPTIONS.map((item) => (
                    <option key={item || "empty"} value={item}>
                      {item || "未填写"}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="出生年月" hint="例如 2003-05 或 2003-05-20">
                <input
                  value={form.birthday}
                  onChange={(e) => setForm({ ...form, birthday: e.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field label="手机号">
                <input
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field label="账号状态">
                <select
                  value={String(form.status)}
                  onChange={(e) => setForm({ ...form, status: Number(e.target.value) })}
                  className={inputClass}
                >
                  <option value="1">正常（可登录）</option>
                  <option value="0">禁用（不能登录）</option>
                </select>
              </Field>
              <div className="md:col-span-2">
                <Field label="备注">
                  <textarea
                    rows={2}
                    value={form.remark}
                    onChange={(e) => setForm({ ...form, remark: e.target.value })}
                    className={`${inputClass} resize-none`}
                  />
                </Field>
              </div>
            </div>

            <div className="flex items-center gap-2 mt-2">
              <button type="submit" className={btnPrimary} disabled={busy}>
                {busy ? "保存中..." : "保存"}
              </button>
              <button type="button" className={btnBase} onClick={() => setForm(null)}>
                取消
              </button>
            </div>

            <p className="text-xs text-slate-400 mt-3">
              密码在数据库里是加密存储的，后台点「显示密码」可以看到明文（加密密钥在服务器的 .env.local 里）。
            </p>
          </form>
        </div>
      ) : null}

      {/* 自定义确认弹窗（替代 window.confirm） */}
      <ConfirmModal
        open={!!confirmBox}
        message={confirmBox?.message || ""}
        confirmText={confirmBox?.confirmText || "确认删除"}
        onConfirm={confirmBox?.onConfirm || (() => {})}
        onClose={() => setConfirmBox(null)}
      />
    </div>
  );
}

/* -------------------------------------------------------------- 登录界面 */

function LoginView({ onSuccess, setError, setNotice }) {
  const [form, setForm] = useState({ username: "", password: "", code: "" });
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await api("/api/admin/session", { method: "POST", body: form });
      setNotice("登录成功");
      await onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-gradient-to-br from-[#FFF8F5] via-[#FCF8F6] to-[#F0F4F8] text-slate-800 flex items-center justify-center px-4">
      {/* 柔光光晕装饰：与用户登录页风格完全一致 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-24 -top-32 h-[420px] w-[420px] rounded-full bg-[#FBE4DA]/60 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-40 -right-24 h-[460px] w-[460px] rounded-full bg-[#CFE0F5]/60 blur-3xl"
      />

      {/* 左上角返回首页 */}
      <a
        href="/"
        className="absolute left-6 top-6 z-20 flex items-center gap-1.5 rounded-full bg-white/60 px-3.5 py-1.5 text-xs text-slate-600 backdrop-blur-sm transition-colors duration-150 hover:bg-white/90 hover:text-slate-800 shadow-2xs"
      >
        <span>←</span>
        <span>返回首页</span>
      </a>

      <div className="relative z-10 w-full max-w-[400px] rounded-[24px] border border-white/80 bg-white/85 p-7 backdrop-blur-md shadow-xl shadow-[#b88576]/15">
        <div className="flex flex-col items-center mb-6 text-center">
          <img src="/logo.png" alt="Solace Logo" className="w-12 h-12 object-contain drop-shadow-xs mb-1.5" />
          <div className="flex items-center gap-1.5 justify-center mb-1">
            <img
              src="/solace-wordmark.png"
              alt="Solace"
              className="h-6 w-auto object-contain"
              style={{ height: "24px", width: "auto" }}
            />
            <span className="font-serif text-xl font-bold tracking-tight text-slate-800">管理后台</span>
          </div>
          <p className="text-xs text-slate-400 mt-1">账号密码 + 动态验证码（TOTP 双因素认证）</p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">管理员账号</label>
            <input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              className="w-full rounded-xl border border-transparent bg-[#f6f3f1] px-4 py-2.5 text-sm text-gray-800 placeholder-slate-400 transition-all duration-150 focus:outline-none focus:bg-white focus:border-[#e2a68c] focus:ring-2 focus:ring-[#e2a68c]/20"
              autoComplete="username"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">登录密码</label>
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="w-full rounded-xl border border-transparent bg-[#f6f3f1] px-4 py-2.5 text-sm text-gray-800 placeholder-slate-400 transition-all duration-150 focus:outline-none focus:bg-white focus:border-[#e2a68c] focus:ring-2 focus:ring-[#e2a68c]/20"
              autoComplete="current-password"
              required
            />
          </div>
          <div>
            <div className="flex justify-between items-center mb-1.5">
              <label className="text-xs font-medium text-slate-600">动态验证码</label>
              <span className="text-[11px] text-slate-400">验证器 App 6 位数字</span>
            </div>
            <input
              inputMode="numeric"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.replace(/\D/g, "").slice(0, 6) })}
              className="w-full rounded-xl border border-transparent bg-[#f6f3f1] px-4 py-2.5 text-base text-gray-800 tracking-[0.4em] text-center font-mono transition-all duration-150 focus:outline-none focus:bg-white focus:border-[#e2a68c] focus:ring-2 focus:ring-[#e2a68c]/20"
              placeholder="000000"
              required
            />
          </div>
          <button
            type="submit"
            className="w-full rounded-xl border border-[#b85a3c] bg-[#b85a3c] py-2.5 text-sm font-medium text-white shadow-md shadow-[#b85a3c]/20 transition-all duration-150 hover:bg-[#a34f33] active:scale-[0.98] disabled:opacity-50"
            disabled={loading}
          >
            {loading ? "安全验证中..." : "登录后台"}
          </button>
        </form>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ 初始化界面 */

function SetupView({ setup, onSuccess, onDatabaseNeeded, setError }) {
  const [form, setForm] = useState({ username: "admin", password: "", confirm: "", code: "", setupKey: "" });
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    if (form.password !== form.confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setLoading(true);
    try {
      await api("/api/admin/setup", {
        method: "POST",
        body: {
          username: form.username,
          password: form.password,
          code: form.code,
          setupKey: form.setupKey,
        },
      });
      await onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-3xl">
        <h1 className="text-2xl font-bold mb-1">初始化管理后台</h1>
        <p className="text-xs text-slate-500 mb-6">
          这是第一次进入，需要绑定一个验证器 App（微软 Authenticator / Google Authenticator / 1Password 等）。
        </p>

        {setup?.setupKeyWarning ? (
          <Alert kind="info">
            安全提示：服务器还没有设置 ADMIN_SETUP_KEY。在完成初始化之前，知道这个网址的人都可能抢先注册管理员；
            建议先在 .env.local 里设置该口令，再回来初始化。
          </Alert>
        ) : null}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <section className={cardClass}>
            <h2 className="text-sm font-bold mb-3">第一步：扫码绑定验证器</h2>
            {setup?.qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={setup.qrDataUrl} alt="TOTP 二维码" className="w-52 h-52 mx-auto border border-[#eceeec] rounded-lg" />
            ) : (
              <p className="text-xs text-slate-400">二维码加载中...</p>
            )}
            <p className="text-xs text-slate-500 mt-3">无法扫码时手动输入密钥：</p>
            <p className="text-xs font-mono break-all bg-[#f7f7f4] border border-[#eceeec] rounded p-2 mt-1">
              {setup?.secret || "-"}
            </p>
            <button
              type="button"
              className={`${btnBase} w-full mt-3`}
              onClick={() => api("/api/admin/setup?refresh=1").then((data) => onDatabaseNeeded(data)).catch((err) => setError(err.message))}
            >
              重新生成密钥
            </button>
          </section>

          <form onSubmit={submit} className={cardClass}>
            <h2 className="text-sm font-bold mb-3">第二步：设置账号</h2>
            <Field label="管理员账号">
              <input
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                className={inputClass}
                required
              />
            </Field>
            <Field label="密码" hint="至少 8 位，同时包含字母和数字">
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                className={inputClass}
                autoComplete="new-password"
                required
              />
            </Field>
            <Field label="确认密码">
              <input
                type="password"
                value={form.confirm}
                onChange={(e) => setForm({ ...form, confirm: e.target.value })}
                className={inputClass}
                autoComplete="new-password"
                required
              />
            </Field>
            {setup?.setupKeyRequired ? (
              <Field label="初始化口令（ADMIN_SETUP_KEY）">
                <input
                  type="password"
                  value={form.setupKey}
                  onChange={(e) => setForm({ ...form, setupKey: e.target.value })}
                  className={inputClass}
                  required
                />
              </Field>
            ) : null}
            <Field label="验证器上的 6 位动态码" hint="提交后本页面会直接登录后台">
              <input
                inputMode="numeric"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.replace(/\D/g, "").slice(0, 6) })}
                className={`${inputClass} tracking-[0.4em] text-center font-mono`}
                required
              />
            </Field>
            <button type="submit" className={`${btnPrimary} w-full`} disabled={loading}>
              {loading ? "创建中..." : "创建管理员并进入后台"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ 主体组件 */

export default function AdminPage() {
  const [stage, setStage] = useState("loading");
  const [setup, setSetup] = useState(null);
  const [overview, setOverview] = useState(null);
  const [settings, setSettings] = useState(null);
  const [tab, setTab] = useState("overview");
  const [activeGroup, setActiveGroup] = useState(() => {
    return TABS.find((t) => t.id === "overview")?.group || "data";
  });
  const [tabSearch, setTabSearch] = useState("");

  // 确保外部切换 tab 时，对应的主分类分组自动高亮
  useEffect(() => {
    const found = TABS.find((t) => t.id === tab);
    if (found && found.group !== activeGroup) {
      setActiveGroup(found.group);
    }
  }, [tab]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ttsText, setTtsText] = useState("你好，我是 Solace，今天也愿意听你说说。");
  const [ttsBusy, setTtsBusy] = useState(false);

  // 对话 AI：拉取到的可用模型列表 + 「测试连接」的结果
  const [aiModels, setAiModels] = useState([]);
  const [aiModelsBusy, setAiModelsBusy] = useState(false);

  // 数据审核的模型列表 / 测试连接状态（和对话 AI 那套完全独立）
  const [reviewModels, setReviewModels] = useState([]);
  const [reviewModelsBusy, setReviewModelsBusy] = useState(false);
  const [reviewTestBusy, setReviewTestBusy] = useState(false);
  const [reviewTestResult, setReviewTestResult] = useState(null);
  // 「日记」页：手动排「生成今日日记任务」时的忙碌态
  const [diaryGenBusy, setDiaryGenBusy] = useState(false);

  /**
   * 拉取审核 AI 的可用模型。
   * ⚠️ 这里只填「下拉候选」，不会自动改模型名字段 —— 用户点了候选才生效。
   */
  async function fetchReviewModels(overrideConfig = {}) {
    setReviewModelsBusy(true);
    setError("");
    try {
      const payload = { action: "models" };
      if (overrideConfig?.baseUrl) payload.baseUrl = overrideConfig.baseUrl;
      if (overrideConfig?.apiKey) payload.apiKey = overrideConfig.apiKey;

      const data = await api("/api/admin/review", {
        method: "POST",
        body: payload,
      });
      const list = Array.isArray(data?.models) ? data.models : [];
      setReviewModels(list);

      if (!data?.ok) {
        setNotice(
          `没能自动获取模型列表（${data?.error || "未知原因"}），直接手动输入模型名即可`
        );
      } else if (list.length) {
        setNotice(`已获取 ${list.length} 个模型，点模型名输入框右侧的箭头选择`);
      } else {
        setNotice("上游返回了空列表，请手动输入模型名");
      }
    } catch (err) {
      setError("拉取模型失败：" + err.message);
    } finally {
      setReviewModelsBusy(false);
    }
  }

  /** 测一次审核 AI 连通性（用已保存的配置，改了配置要先保存） */
  async function testReviewConnection() {
    setReviewTestBusy(true);
    setReviewTestResult(null);
    setError("");
    try {
      const result = await api("/api/admin/review", {
        method: "POST",
        body: { action: "test" },
      });
      setReviewTestResult(result);
    } catch (err) {
      setReviewTestResult({ ok: false, error: err.message, hint: "" });
    } finally {
      setReviewTestBusy(false);
    }
  }
  const [aiTestBusy, setAiTestBusy] = useState(false);
  const [aiTestResult, setAiTestResult] = useState(null);
  const [mailTo, setMailTo] = useState("");
  const [mailBusy, setMailBusy] = useState(false);

  const loadAll = useCallback(async () => {
    const [overviewData, settingsData] = await Promise.all([
      api("/api/admin/overview"),
      api("/api/admin/settings"),
    ]);
    setOverview(overviewData);
    setSettings(settingsData.settings || {});
  }, []);

  const bootstrap = useCallback(async () => {
    setError("");
    try {
      const session = await api("/api/admin/session");
      if (!session.dbReady) {
        setStage("database");
        return;
      }
      if (session.needsSetup) {
        const setupData = await api("/api/admin/setup");
        if (!setupData.dbReady) {
          setStage("database");
          return;
        }
        setSetup(setupData);
        setStage("setup");
        return;
      }
      if (session.authenticated) {
        await loadAll();
        setStage("panel");
        return;
      }
      setStage("login");
    } catch (err) {
      setError(err.message);
      setStage("login");
    }
  }, [loadAll]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  async function handleLogout() {
    try {
      await api("/api/admin/session", { method: "DELETE" });
    } catch {
      /* 忽略 */
    }
    setOverview(null);
    setSettings(null);
    setStage("login");
  }

  async function previewTts() {
    setTtsBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await api("/api/admin/tts/test", { method: "POST", body: { text: ttsText } });
      const audio = new Audio(data.audio);
      await audio.play();
      setNotice(`语音试听成功（约 ${Math.round((data.bytes || 0) / 1024)} KB）`);
    } catch (err) {
      setError(err.message);
    } finally {
      setTtsBusy(false);
    }
  }

  /**
   * 拉取上游可用的模型列表（OpenAI 协议的标准 GET /models 接口）。
   * 优先使用当前输入框中的 baseUrl 和 apiKey，未传时回退到已保存的配置。
   * 用户修改完接口地址或 Key 后无需先点保存，点击即可直接拉取最新模型列表。
   */
  async function fetchAiModels(overrideConfig = {}) {
    setAiModelsBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = {};
      if (overrideConfig?.baseUrl) payload.baseUrl = overrideConfig.baseUrl;
      if (overrideConfig?.apiKey) payload.apiKey = overrideConfig.apiKey;

      const data = await api("/api/admin/ai/models", {
        method: "POST",
        body: payload,
      });
      setAiModels(data.models || []);
      if (data.ok && (data.models || []).length) {
        setNotice(`拉取到 ${data.models.length} 个可用模型，点「模型名」输入框即可选择`);
      } else if (data.ok) {
        setNotice(data.hint || "上游没有返回模型列表，请手动输入模型名");
      } else {
        setError(
          `拉取失败：${data.error || "未知原因"}${data.hint ? `（${data.hint}）` : ""}`
        );
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setAiModelsBusy(false);
    }
  }

  /** 用已保存的配置发一句「你好」，验证接口地址 / Key / 模型名是否都正确 */
  async function testAiConnection() {
    setAiTestBusy(true);
    setAiTestResult(null);
    setError("");
    setNotice("");
    try {
      const data = await api("/api/admin/ai/test", { method: "POST", body: {} });
      setAiTestResult(data);
    } catch (err) {
      setAiTestResult({ ok: false, error: err.message });
    } finally {
      setAiTestBusy(false);
    }
  }

  async function sendTestMail() {
    setMailBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await api("/api/admin/mail/test", { method: "POST", body: { to: mailTo } });
      setNotice(data.message || "测试邮件已发送");
    } catch (err) {
      setError(err.message);
    } finally {
      setMailBusy(false);
    }
  }

  if (stage === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-sm text-slate-500">正在加载...</p>
      </div>
    );
  }

  if (stage === "database") {
    return (
      <div className="min-h-screen px-4 py-10">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-2xl font-bold mb-1">配置数据库连接</h1>
          <p className="text-xs text-slate-500 mb-6">
            后台的所有配置都存在 MySQL 里，所以先把数据库连上。数据库还没建的话，
            请先在宝塔面板创建数据库并导入 <code>db/schema.sql</code>。
          </p>
          <FloatingAlert error={error} notice={notice} setError={setError} setNotice={setNotice} />
          
          <DatabasePanel
            bootstrap
            setError={setError}
            setNotice={setNotice}
            onChanged={async () => {
              await bootstrap();
            }}
          />
        </div>
      </div>
    );
  }

  if (stage === "setup") {
    return (
      <SetupView
        setup={setup}
        setError={setError}
        onSuccess={async () => {
          setNotice("初始化完成");
          await bootstrap();
        }}
        onDatabaseNeeded={(data) => setSetup(data)}
      />
    );
  }

  if (stage === "login") {
    return (
      <div className="min-h-screen px-4 py-6">
        {error ? (
          <div className="max-w-sm mx-auto">
            <FloatingAlert error={error} notice={notice} setError={setError} setNotice={setNotice} />
          </div>
        ) : null}
        <LoginView
          setError={setError}
          setNotice={setNotice}
          onSuccess={async () => {
            await bootstrap();
          }}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FAF7F4] text-slate-800">
      <header className="sticky top-0 z-40 border-b border-[#eee4dc] bg-[#FFF9F6]/95 backdrop-blur-md transition-all shadow-2xs">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="Solace Logo" className="w-8 h-8 object-contain drop-shadow-xs" />
            <img
              src="/solace-wordmark.png"
              alt="Solace"
              className="h-5 w-auto object-contain mt-0.5"
              style={{ height: "20px", width: "auto" }}
            />
            <span className="font-serif text-sm font-semibold tracking-wide text-slate-700 hidden sm:inline border-l border-[#ecdcd3] pl-2.5">管理控制台</span>
          </div>

          {/* 快捷功能搜索框 */}
          <div className="relative flex-1 max-w-xs hidden md:block">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="20" y1="20" x2="16.2" y2="16.2" />
            </svg>
            <input
              type="text"
              value={tabSearch}
              onChange={(e) => setTabSearch(e.target.value)}
              placeholder="搜索后台配置与功能..."
              className="w-full pl-8 pr-7 py-1.5 text-xs rounded-full border border-[#ebe3dc] bg-white/90 focus:bg-white focus:outline-none focus:border-[#e2a68c] focus:ring-1 focus:ring-[#e2a68c]/30 transition-all placeholder-slate-400"
            />
            {tabSearch && (
              <button
                type="button"
                onClick={() => setTabSearch("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
              >
                ✕
              </button>
            )}
          </div>

          <div className="flex items-center gap-3">
            {overview?.admin?.username ? (
              <div className="flex items-center gap-1.5 text-xs text-slate-600 bg-[#fdf5ef] px-3 py-1 rounded-full border border-[#f2ded4]">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="font-medium">{overview.admin.username}</span>
              </div>
            ) : null}
            <button
              type="button"
              className="border border-[#ebe3dc] bg-white/90 text-slate-600 rounded-xl px-3 py-1.5 text-xs font-medium hover:bg-[#FAF7F4] hover:text-red-600 hover:border-red-200 active:scale-[0.98] transition-all cursor-pointer shadow-2xs"
              onClick={handleLogout}
            >
              退出登录
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5">
        {/* 分类标签导航栏 */}
        <div className="bg-white/90 rounded-2xl border border-[#eee4dc] p-3 mb-5 shadow-xs">
          {tabSearch ? (
            /* 搜索模式：直接平铺匹配项 */
            <div>
              <div className="flex items-center justify-between px-2 pb-2 mb-2 border-b border-[#f3ebe4]">
                <span className="text-xs text-slate-500">
                  搜索 “<span className="text-[#b85a3c] font-medium">{tabSearch}</span>” 的功能匹配项：
                </span>
                <button
                  type="button"
                  onClick={() => setTabSearch("")}
                  className="text-xs text-[#b85a3c] hover:underline cursor-pointer"
                >
                  清除搜索
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {TABS.filter(
                  (item) =>
                    item.label.toLowerCase().includes(tabSearch.toLowerCase()) ||
                    item.desc.toLowerCase().includes(tabSearch.toLowerCase()) ||
                    item.id.toLowerCase().includes(tabSearch.toLowerCase())
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setTab(item.id);
                      setActiveGroup(item.group);
                      setError("");
                      setNotice("");
                    }}
                    className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium transition-all cursor-pointer ${
                      tab === item.id
                        ? "bg-gradient-to-r from-[#c06b50] to-[#b85a3c] text-white shadow-xs"
                        : "bg-[#FAF8F5] text-slate-700 hover:bg-[#faede5] hover:text-[#b85a3c]"
                    }`}
                  >
                    <span>{item.icon}</span>
                    <span>{item.label}</span>
                    <span className="text-[10px] opacity-70">({item.desc})</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            /* 标准分类模式：上层4个主类胶囊，下层具体二级功能按钮 */
            <div className="space-y-2.5">
              {/* 一级分类 */}
              <div className="flex flex-wrap items-center gap-1.5 pb-2.5 border-b border-[#f3ebe4]">
                {TAB_GROUPS.map((grp) => {
                  const isCurrentGrp = activeGroup === grp.id;
                  return (
                    <button
                      key={grp.id}
                      type="button"
                      onClick={() => {
                        setActiveGroup(grp.id);
                        // 自动切到该分类下的第一个 tab（如果当前 tab 不在该分类内）
                        const grpTabs = TABS.filter((t) => t.group === grp.id);
                        if (!grpTabs.some((t) => t.id === tab)) {
                          setTab(grpTabs[0]?.id || "overview");
                          setError("");
                          setNotice("");
                        }
                      }}
                      className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-medium transition-all cursor-pointer ${
                        isCurrentGrp
                          ? "bg-[#FFF5EF] text-[#b85a3c] font-semibold border border-[#f0ded4] shadow-xs"
                          : "text-slate-600 hover:text-slate-900 hover:bg-[#FAF8F5]"
                      }`}
                    >
                      <span className="text-sm">{grp.icon}</span>
                      <span>{grp.label}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-black/[0.04]">
                        {TABS.filter((t) => t.group === grp.id).length}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* 二级功能按键 */}
              <div className="flex flex-wrap gap-2 pt-0.5">
                {TABS.filter((t) => t.group === activeGroup).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setTab(item.id);
                      setError("");
                      setNotice("");
                    }}
                    className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium transition-all duration-150 cursor-pointer ${
                      tab === item.id
                        ? "bg-gradient-to-r from-[#c06b50] to-[#b85a3c] text-white shadow-sm shadow-[#b85a3c]/20 scale-[1.02]"
                        : "bg-[#FAF8F5] text-slate-700 hover:bg-[#faede5] hover:text-[#b85a3c] border border-transparent hover:border-[#f0ded4]"
                    }`}
                  >
                    <span>{item.icon}</span>
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <FloatingAlert error={error} notice={notice} setError={setError} setNotice={setNotice} />
        

        {tab === "overview" ? (
          <OverviewPanel overview={overview} onReload={() => loadAll().catch((err) => setError(err.message))} />
        ) : null}

        {tab === "database" ? (
          <DatabasePanel
            setError={setError}
            setNotice={setNotice}
            onChanged={() => loadAll()}
          />
        ) : null}

        {tab === "ai" ? (
          <SettingsGroup
            group="ai"
            title="对话 AI"
            description="聊天接口使用这里配置的服务商。baseUrl 只写到版本目录，程序自动拼 /chat/completions。下面的两个工具都用「已保存的配置」，改了配置请先点右上角保存。"
            settings={settings}
            setError={setError}
            setNotice={setNotice}
            onSaved={loadAll}
            fieldOptions={{ aiModels }}
            onFetchModels={fetchAiModels}
            modelsBusy={aiModelsBusy}
          >
            <div className="border-t border-[#eceeec] pt-3 mt-1 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                {/* 「拉取可用模型」已挪到上面的模型名输入框里（右侧、下箭头左边） */}
                <button
                  type="button"
                  className={btnBase}
                  disabled={aiTestBusy}
                  onClick={testAiConnection}
                >
                  {aiTestBusy ? "测试中..." : "测试连接"}
                </button>
                {aiModels.length ? (
                  <span className="text-xs text-slate-400">已获取 {aiModels.length} 个模型</span>
                ) : null}
              </div>

              {aiTestResult ? (
                <div
                  className={`text-xs rounded-lg border px-3 py-2 leading-relaxed ${
                    aiTestResult.ok
                      ? "border-[#c8e0cc] bg-[#f2f9f3] text-slate-700"
                      : "border-[#e8cccc] bg-[#fdf4f4] text-slate-700"
                  }`}
                >
                  {aiTestResult.ok ? (
                    <>
                      <p className="font-medium text-slate-800">
                        ✅ 连接成功（{aiTestResult.latencyMs} ms）
                      </p>
                      <p className="mt-0.5">模型：{aiTestResult.model}</p>
                      <p className="mt-0.5 break-words">回复：{aiTestResult.reply || "（空）"}</p>
                    </>
                  ) : (
                    <>
                      <p className="font-medium text-slate-800">❌ 连接失败</p>
                      <p className="mt-0.5 break-words">{aiTestResult.error}</p>
                      {aiTestResult.hint ? (
                        <p className="mt-1 text-slate-500">建议：{aiTestResult.hint}</p>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </div>
          </SettingsGroup>
        ) : null}

        {tab === "music" ? (
          <>
            <SettingsGroup
              group="music"
              title="背景音乐设置"
              description="音源可随时切换：本地歌单支持自动播放与切歌；网易云收藏使用官方外链播放器（受官方限制，不能自动播放/切歌）。两种歌单可以同时维护。"
              settings={settings}
              setError={setError}
              setNotice={setNotice}
              onSaved={loadAll}
            />
            <MusicTracksPanel setError={setError} setNotice={setNotice} />
          </>
        ) : null}

        {tab === "sticker" ? (
          <>
            <SettingsGroup
              group="sticker"
              title="表情包设置"
              description="聊天时按用户这句话的情绪自动配一张表情包：先扫关键词（毫秒级、零成本），判不出才交给 AI 判一次；然后按「第 1 句 0%、第 2 句 40%、第 3 句 100% 保底」的节奏随机发出，同一种情绪发出后冷却 15 分钟、两张之间至少隔 5 轮。这里管总开关；分类（有哪些情绪、靠哪些词判定、优先级、深夜是否放宽）与素材图片在下面的面板里增删改。"
              settings={settings}
              setError={setError}
              setNotice={setNotice}
              onSaved={loadAll}
            />
            <StickerPanel api={api} setError={setError} setNotice={setNotice} onSaved={loadAll} />
          </>
        ) : null}

        {tab === "safety" ? (
          <>
            <SettingsGroup
              group="safety"
              title="内容安全与压力"
              description="① 内容安全：用户消息发给 AI 之前先过一遍规则，只拦「自伤倾向 / 伤害他人 / 明显违法」三类。命中后分两种走法 —— 带明确计划或时间表达的（紧迫）**直接截断**，返回干预话术 + 400-161-9995；其余走**安全模式**（正常调 AI，附加安全指令要求先共情再引导，回复里没提到热线会自动补一句）。② 压力评估：读「聊天 + 日记」两条通道，压力连续偏高时在右上角温和地问一句要不要放松。③ 词表：安全词和压力词都在下面统一管理，改完保存立即生效，不用重启。"
              settings={settings}
              setError={setError}
              setNotice={setNotice}
              onSaved={loadAll}
            >
              <div className="border-t border-[#eceeec] pt-3 mt-1">
                {/* ⚠️ 诊断面板放在这里：改完配置能**立刻看到效果好不好** ——
                    它会把"最近 24 小时有没有记录、超阈值几次、实际提醒几次、
                    有没有卡住的会话"全摆出来，并用人话说明为什么不弹。 */}
                <StressDiagnosePanel api={api} setError={setError} setNotice={setNotice} />
              </div>

              <div className="border-t border-[#eceeec] pt-3 mt-1">
                {/* ⚠️ **统一词表就放在这一页**（和上面的安全配置同一处）——
                    管理员要回答的问题只有一个：「什么话会被拦、什么话会算成压力」。
                    拆成两个页面，改完一边还得去另一边确认，反而容易漏。

                    ⚠️ 这里也是词表的**唯一**编辑入口 —— 早期那三个「自定义追加词」
                    文本框已经撤掉了，以前填过的词会在启动时自动并进下面的表里。 */}
                <p className="mb-2 text-xs font-semibold text-slate-600">
                  统一词表（安全词 + 压力词）
                </p>
                <KeywordManager api={api} setError={setError} setNotice={setNotice} />
              </div>
            </SettingsGroup>
          </>
        ) : null}

        {tab === "review" ? (
          <>
            <SettingsGroup
              group="review"
              title="数据审核 · 审核 AI 与默认值"
              description="用户改头像、背景、昵称、签名后会立刻生效，同时被打上「未审核」标记，之后由 AI 批量判定：合规清标记，违规改回下面配置的默认值。改完请先点右上角保存 —— 下面的「立即提交」用的是已保存的配置。"
              settings={settings}
              setError={setError}
              setNotice={setNotice}
              onSaved={loadAll}
              fieldOptions={{ reviewModels }}
              onFetchModels={fetchReviewModels}
              modelsBusy={reviewModelsBusy}
            >
              <div className="border-t border-[#eceeec] pt-3 mt-1 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={btnBase}
                    disabled={reviewTestBusy}
                    onClick={testReviewConnection}
                    title="用已保存的配置发一次真实请求，验证地址 / Key / 模型名"
                  >
                    {reviewTestBusy ? "测试中..." : "测试连接"}
                  </button>
                  <span className="text-xs text-slate-400">
                    测试的是「逐条调用」的对话接口；批量推理能否用，看提交后的批次结果
                  </span>
                </div>

                {reviewTestResult ? (
                  <div
                    className={`text-xs rounded-lg border px-3 py-2 leading-relaxed ${
                      reviewTestResult.ok
                        ? "border-[#c8e0cc] bg-[#f2f9f3] text-slate-700"
                        : "border-[#e8cccc] bg-[#fdf4f4] text-slate-700"
                    }`}
                  >
                    {reviewTestResult.ok ? (
                      <>
                        <p className="font-medium text-slate-800">
                          ✅ 连接成功（{reviewTestResult.latencyMs} ms）
                        </p>
                        <p className="mt-0.5">模型：{reviewTestResult.model}</p>
                        <p className="mt-0.5 break-words">
                          回复：{reviewTestResult.reply || "（空）"}
                        </p>
                        {reviewTestResult.hint ? (
                          <p className="mt-1 text-slate-500">{reviewTestResult.hint}</p>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <p className="font-medium text-slate-800">❌ 连接失败</p>
                        <p className="mt-0.5 break-words">{reviewTestResult.error}</p>
                        {reviewTestResult.hint ? (
                          <p className="mt-1 text-slate-500">建议：{reviewTestResult.hint}</p>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            </SettingsGroup>

            <ContentReviewPanel api={api} setError={setError} setNotice={setNotice} />
          </>
        ) : null}

        {tab === "diary" ? (
          <>
            <SettingsGroup
              group="diary"
              title="日记 · 情绪打标与 AI 生成"
              description="打标和「数据审核」共用同一套批量 AI 配置（接口地址 / 批量地址 / Key / 模型名都在「数据审核」页配），这里只管日记自己的提示词和开关。改完记得先点右上角「保存」。"
              settings={settings}
              setError={setError}
              setNotice={setNotice}
              onSaved={loadAll}
            >
              <div className="border-t border-[#eceeec] pt-3 mt-1">
                {/* ⚠️ 这里只放"手动排任务"这一个按钮 ——
                    其余动作（提交 / 拉取 / 看原文）都在下面的任务面板里 */}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={btnBase}
                    disabled={diaryGenBusy}
                    onClick={async () => {
                      setDiaryGenBusy(true);
                      setError("");
                      setNotice("");
                      try {
                        const result = await api("/api/admin/review", {
                          method: "POST",
                          body: { action: "generateDiaries" },
                        });
                        setNotice(
                          result?.message ||
                            `已为昨天排入 ${result?.created || 0} 篇待生成的日记`
                        );
                      } catch (err) {
                        setError("生成任务失败：" + err.message);
                      } finally {
                        setDiaryGenBusy(false);
                      }
                    }}
                    title="不用等定时器，立刻为「昨天」排一批生成任务；排完在下面点「立即提交」就能送出去"
                  >
                    {diaryGenBusy ? "处理中…" : "① 立刻为昨天排生成任务"}
                  </button>
                  <span className="text-xs text-slate-400">
                    平时由定时器每天自动跑，这里用于调试 / 补跑
                  </span>
                </div>
              </div>

              {/* ---- 任务列表：打标和生成**分开列** ---- */}
              <div className="border-t border-[#eceeec] pt-3 mt-1">
                <DiaryTaskPanel api={api} setError={setError} setNotice={setNotice} />
              </div>
            </SettingsGroup>
          </>
        ) : null}

        {tab === "tts" ? (
          <SettingsGroup
            group="tts"
            title="语音 TTS"
            description="支持三种主流协议，切换「接口类型」后下方输入项会自动切换与联动预填：① OpenAI 兼容（POST /audio/speech，直接返回音频）；② 小米 MiMo（POST /chat/completions，音频为 base64，支持圆括号风格+方括号事件）；③ 阿里云百炼 DashScope（qwen-audio-3.1-tts-flash，支持指令 Instruction 控制方言口音与副语言事件）。"
            settings={settings}
            setError={setError}
            setNotice={setNotice}
            onSaved={loadAll}
          >
            <div className="border-t border-[#eceeec] pt-3 mt-1">
              <p className="text-xs text-slate-500 mb-2">试听（使用上面保存后的配置）</p>
              <div className="flex gap-2">
                <input
                  value={ttsText}
                  onChange={(e) => setTtsText(e.target.value)}
                  className={inputClass}
                  placeholder="输入一段要合成的文字"
                />
                <button type="button" className={`${btnBase} shrink-0`} disabled={ttsBusy} onClick={previewTts}>
                  {ttsBusy ? "合成中..." : "试听"}
                </button>
              </div>
            </div>
          </SettingsGroup>
        ) : null}

        {tab === "mail" ? (
          <>
            <Alert kind="info">
              {"网易邮箱配置要点：登录 163/126 邮箱 → 设置 → POP3/SMTP/IMAP → 开启 SMTP 服务 → 获取「授权码」；\n" +
                "「SMTP 授权码」填授权码而不是登录密码；端口 465 勾选 SSL；发件人邮箱必须和发信邮箱一致。"}
            </Alert>
            <SettingsGroup
              group="smtp"
              title="发信邮箱（SMTP）"
              description="用于发送登录验证码邮件，本轮可先用它给管理员发测试邮件。"
              settings={settings}
              setError={setError}
              setNotice={setNotice}
              onSaved={loadAll}
            >
              <div className="border-t border-[#eceeec] pt-3 mt-1">
                <p className="text-xs text-slate-500 mb-2">发送测试邮件（需要先保存上面的配置）</p>
                <div className="flex gap-2">
                  <input
                    value={mailTo}
                    onChange={(e) => setMailTo(e.target.value)}
                    className={inputClass}
                    placeholder="收件邮箱，例如 you@example.com"
                  />
                  <button type="button" className={`${btnBase} shrink-0`} disabled={mailBusy} onClick={sendTestMail}>
                    {mailBusy ? "发送中..." : "发送测试邮件"}
                  </button>
                </div>
              </div>
            </SettingsGroup>

            <SettingsGroup
              group="login"
              title="邮箱验证码规则"
              description="下一轮用户端「邮箱验证码登录」会直接使用这里的规则。"
              settings={settings}
              setError={setError}
              setNotice={setNotice}
              onSaved={loadAll}
            />
          </>
        ) : null}

        {tab === "site" ? (
          <SettingsGroup
            group="site"
            title="站点信息"
            description="站点名称会出现在验证码邮件里。"
            settings={settings}
            setError={setError}
            setNotice={setNotice}
            onSaved={loadAll}
          />
        ) : null}

        {tab === "users" ? (
          <UsersPanel
            setError={setError}
            setNotice={setNotice}
          />
        ) : null}

        {tab === "scales" ? (
          <ScaleManagerPanel api={api} setError={setError} setNotice={setNotice} />
        ) : null}

        {tab === "logs" ? <LogsPanel /> : null}
      </div>
    </div>
  );
}
