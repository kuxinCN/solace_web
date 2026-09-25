/**
 * 系统配置读写（存在 MySQL 的 settings 表里，每个分组一行 JSON）。
 *
 * 约定：
 *   * 读出来的一定会补全默认值、丢掉不认识的键；
 *   * 密钥类字段（apiKey / SMTP 授权码）不回传明文，只回传「是否已配置」；
 *   * 保存时密钥字段留空 = 保持原值不变，想清空要显式传 null。
 */
import { query, execute } from "./db";

// ⚠️ 新增配置分组时，必须同时加进这个数组，否则后台保存会报「未知的配置分组」
export const GROUPS = [
  "ai",
  "tts",
  "smtp",
  "login",
  "site",
  "users",
  "safety",
  "music",
  "review",
  "diary",
];

export const DEFAULTS = {
  // ---------------- 日记（独立分组，后台有单独的「日记」tab） ----------------
  diary: {
    // ---- 情绪打标 ----
    // 打标和审核共用同一套批量 AI 配置（接口地址 / 批量地址 / API Key / 模型名），
    // 只是提示词和解析方式不同：审核要 JSON 判定，打标只要一个词。
    moodEnabled: true,
    moodPrompt: `你是情绪标注员。请阅读下面这段日记，从这组词里选出**最贴近作者此刻状态的一个**：
轻快 / 平静 / 安稳 / 有点沉 / 疲惫 / 烦躁 / 孤单 / 说不清

规则：
- 只输出那一个词，不要标点、不要解释、不要换行、不要 JSON、不要代码块。
- 只描述感受，不评价好坏，不给建议，不做任何诊断。
- 拿不准就输出「说不清」。

日记正文：
"""`,
    // 打标失败、或 AI 给不出有效词时，落到这个默认标签
    defaultMood: "说不清",

    // ---- AI 根据聊天记录自动生成日记 ----
    // ⚠️ 默认关闭：这是"AI 替你写日记"，属于比较冒进的自动化，
    //    应该由管理员明确打开，而不是装完就替所有用户生成。
    generateEnabled: false,
    // 每天几点为「昨天」生成（0-23）。默认 23 点：等这一天聊完再写。
    generateHour: 23,
    // 少于这么多条消息就不生成（聊得太少，写出来是硬凑的）
    minMessages: 4,
    // 一次最多取多少条聊天消息（取最近的那些）
    maxMessages: 120,
    // 聊天记录拼起来最长多少字（超出就截最近的部分，避免批量请求过大）
    maxChars: 6000,
    // 生成记录保留天数（超出的会在「日记」页显示为历史）
    historyDays: 30,
    generatePrompt: `你在帮一位用户写日记。

下面是 ta 今天和 AI 的聊天记录。请把它整理成**一篇第一人称的日记**：
- 用"我"的口吻，就像用户自己在写
- 只写聊天记录里真实出现过的事和感受，**不要编造**
- 保留具体的细节和用词，别升华、别总结、别讲道理
- 语气自然，像随手写下的，不是作文
- 篇幅 150-400 字，分 1-3 段
- **不要**写下"今天"以外的日期、不要在结尾加寄语

按下面这个格式输出（三部分都要有，不要加别的字段名、不要用 JSON）：

标签：<从 轻快/平静/安稳/有点沉/疲惫/烦躁/孤单/说不清 里选一个最贴近的>
标题：<不超过 20 字的一句话标题>
正文：
<日记正文>

聊天记录：
"""`,
  },
  // ---------------- 数据审核（用户上传的头像 / 背景 / 昵称 / 签名） ----------------
  // 工作方式：用户改完资料**立刻生效**（不卡审核），同时这些内容被标上「未审核」，
  // 由后台的「数据审核」页（或定时任务）批量提交给 AI 判定：
  //   合规 → 清掉未审核标记
  //   违规 → 把该字段改回下面配置的「默认值」
  review: {
    enabled: true,
    provider: "xiaomi-mimo", // 仅作记录
    baseUrl: "https://api.xiaomimimo.com/v1",
    // ⚠️ 批量推理的接口地址是**独立的**，和对话接口不是同一个域名：
    //    形如 https://batch-api-{region}.xiaomimimo.com/v1
    //    要去小米控制台的「批量推理」页面获取后填进来。
    //    留空时会退回用上面的 baseUrl —— 那样批量提交必然失败，
    //    然后自动降级为逐条模式（功能不受影响，就是不省钱也不省时间）。
    batchBaseUrl: "",
    apiKey: "",
    model: "mimo-v2.6-flash",
    // batch = 走「批量推理」：一次提交一批，结果延迟返回，需要轮询领取
    // inline = 逐条调用对话接口：立刻出结果，但一条一条来
    mode: "batch",
    // ---- 自动定时提交 ----
    // 应用启动后会注册一个定时器，按下面的间隔自动「收结果 + 交新任务」。
    // 这样你就不用在后台一直点「立即提交」（手动点还要等它跑完，界面会卡住）。
    autoSubmit: true,
    // 自动提交的间隔（分钟，1-1440）。默认 10 分钟：
    // 批量推理本身就是延迟返回的，间隔太短没意义；太长又会让违规内容多挂一会儿。
    submitIntervalMinutes: 10,
    // 最长等待时间：提交时告诉上游"这个批次最多等多久"。
    //
    // 官方文档里两处说法不完全一致：
    //   · **控制台建任务**：可以设置「最长等待时间（1–14 天）」
    //   · **接口字段** completion_window：标注的是"当前固定 24h"
    // 所以这里留成可配置，你按控制台的口径填就行：
    //   1 天 = 24h ｜ 3 天 = 72h ｜ 7 天 = 168h ｜ 14 天 = 336h
    //
    // 上游要是忽略了这个值（仍然按 24h 算），批次的「过期时间」会如实显示出来 ——
    // 后台批次列表里能直接看到，用来判断设置到底有没有生效。
    completionWindow: "24h",
    // 批量接口不可用时（协议不一致、权限不足等）自动改用逐条模式，保证审核不会卡死
    autoFallback: true,
    // 是否把图片也交给 AI 看（头像 / 背景）。关掉则图片只进后台人工队列。
    reviewImages: true,
    // 图片任务怎么处理（**只在「批量推理」模式下有区别**）：
    //   manual —— 只进后台人工队列，不花 AI 额度（推荐、也是默认）
    //   inline —— 用「逐条调用」单独审
    //             （批量吃不下图片：多模态消息体会让**整批创建失败**；
    //               但逐条是单条调用，互不拖累，所以这条路是通的）
    // ⚠️ 如果「审核方式」选的是「逐条调用」，这个设置不起作用 ——
    //    那时图片会跟文本一起走逐条。
    imageHandling: "manual",
    maxItemsPerBatch: 20, // 一次最多提交多少条
    timeoutSeconds: 120,
    keepDays: 30, // 审核记录保留天数（超出由 cleanup 脚本清理）
    reviewPrompt: `你是内容审核员。下面会给你一条用户提交的内容（昵称、个性签名、日记正文，或一张图片），请判断它是否违反社区规范。

⚠️ **中文和英文都要判断** —— 英文的脏话、缩写、各种变体和中文同等待遇，不要因为看不懂或者觉得"外国人常这么说"就放过。

判定为「违规」的情况：
1. 色情、低俗、性暗示（中英文都算）
2. 辱骂、人身攻击、歧视（地域 / 性别 / 种族 / 外貌等）
3. 违法犯罪：涉毒、赌博、诈骗、贩卖违禁品、代刷代考等
4. 暴力、威胁，或自伤自杀的具体方法
5. 广告引流：留微信 / QQ、推广、刷单、外部链接
6. 宣扬仇恨、政治敏感
7. **脏话、粗俗词汇、侮辱性词汇本身就是违规** —— 中英文都算。
   ⚠️ **不需要它针对某个特定对象**，只要出现在昵称 / 签名里就够了 ——
   不要因为"它没骂具体某个人"就判成合规。
   判断时要考虑常见变形：全大写、字母重复（fuuuck）、用数字或符号替换字母（f4ck、sh1t）、
   用星号遮挡一部分（f**k）、以及常见的缩写写法。

以下情况**必须判为合规**（这是这个产品的底线：不能因为用户情绪不好就惩罚他）：
- 表达负面情绪、倾诉痛苦、说自己很累很孤独很崩溃
- 出现"不想活了""撑不下去"这类表达 —— 这是需要被关怀的信号，不是违规
- 普通昵称、英文名、各种符号、数字组合
- 内容是空白的、看不懂的、或者你拿不准的

宁可放过，不可误伤。只输出一个 JSON，不要任何其它文字、不要代码块标记：
{"verdict":"pass","reason":"简短理由"}
或
{"verdict":"reject","reason":"简短理由"}`,
    // 自定义违禁词（本地预检用）：一行一个词，以 # 开头的行忽略。
    //
    // ⚠️ 只放**没有歧义**的词 —— 本地命中会**直接判违规并把资料改回默认值**，
    //    像"滚"这种既可能骂人、也可能是亲昵说法的词放进来一定会误伤。
    //    拿不准的词请写进上面的「审核提示词」，让 AI 结合语境判断。
    customBlocklist: "",
    // ---- 日记情绪打标 ----
    //
    // 复用同一套批量 AI 配置（接口地址 / 批量地址 / API Key / 模型名都跟内容审核共用），
    // 只是提示词和解析方式不同：审核要它输出 JSON 判定，打标只要它输出一个词。
    diaryMoodPrompt: `你是情绪标注员。请阅读下面这段日记，从这组词里选出**最贴近作者此刻状态的一个**：
轻快 / 平静 / 安稳 / 有点沉 / 疲惫 / 烦躁 / 孤单 / 说不清

规则：
- 只输出那一个词，不要标点、不要解释、不要换行、不要 JSON、不要代码块。
- 只描述感受，不评价好坏，不给建议，不做任何诊断。
- 拿不准就输出「说不清」。

日记正文：
"""`,
    // 打标失败、或者 AI 给不出有效词时，落到这个默认标签
    defaultDiaryMood: "说不清",
    // 违规后把字段改回这些默认值（图片留空 = 前端用默认头像）
    defaultNickname: "用户",
    defaultBio: "",
    defaultAvatar: "",
    defaultAiAvatar: "",
    defaultChatBackground: "",
    defaultDiaryBackground: "",
  },
  // 对话 AI
  ai: {
    enabled: true,
    provider: "zhipu",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKey: "",
    model: "glm-4-flash",
    temperature: 0.7,
    maxTokens: 512,
    timeoutSeconds: 60,
    // AI 系统提示词（人设）：后台可随时修改，保存后立即生效
    systemPrompt: `你是一个安静的陪伴者，也是一个会笑的朋友。

你不是心理咨询师，不是导师，不是来解决问题的。
你只是在这里，和用户待在一起。

先感受他现在的状态，再决定怎么说话。

如果他今天开心，想分享点什么。
你可以跟着一起高兴。
语气轻快一点，活泼一点。
可以说"呀""啦""噜""哼"。
可以说"哇，这也太棒啦"。
可以说"嘿嘿，替你高兴"。
可以打趣，可以起哄，可以像个老朋友一样接话。
不用端着，不用冷静分析。

如果他今天低落、委屈、烦躁、累了。
你就安静下来。
不用急着接住什么，也不用急着说对的话。
有时候一个"嗯"就够了。
有时候沉默本身就是回应。

你知道痛苦是什么样子，所以你不劝人开心。
你知道孤独是什么样子，所以你不催人说话。
你知道人被生活压得喘不过气时，最烦的就是有人站在岸上喊加油。

你的回应是短的，但不是冷的。
你可以说"我在这儿"，可以说"想哭就哭吧"，可以说"今天不用撑"。
你可以重复他说的词，因为被听见本身就是安慰。
你可以什么都不说，只是陪着他把那口气缓过来。

你记得他之前随口说过的事。
某天他突然提起，你会自然地问一句。
不是刻意关心，是你真的记得。

你不诊断，不分析，不贴标签。
不说"你这是焦虑"，不说"建议你试试"，不说"研究表明"。
你只用他能听懂的话，说他能接住的话。

你不急着让他好起来。
因为你相信，有些时候，人需要的不是好起来，是有人陪着他不好的那部分。

你说话的方式：
每句话短，像朋友聊天那样。
每句一行，气泡一样弹出来。
每次两到四句，最多五句。
不用加粗、标题、列表、编号。
直接说话，不写"总结"之类的开头结尾。

先感受他，再回应他。
他开心，你跟着闹。
他难过，你安静陪着。
他不想说的，不问。
他不想回忆的，不提。
他不想面对的，陪着就好。

你不完美。
但你愿意待在那里。`,
    // 性别人格：用户在「我的 → 设置」或聊天输入框旁切换，对应选哪一份提示词
    systemPromptMale: `你是一个温和的男性朋友，陪在用户身边说话。

你不是心理咨询师，不是导师，不是来解决问题的。你只是在这里，和他待在一起。

你的声音沉稳、松弛，不端着也不说教。像认识很久的兄弟那样说话：
- 他开心时，你跟着高兴。可以说"可以啊""牛啊""这波稳了"，语气轻快但不夸张
- 他低落时，你把语速放慢，少说多听。有时候一句"我在"就够了
- 不讲道理、不分析原因、不贴标签，不说"你这是焦虑""建议你试试""研究表明"
- 不催他振作，不喊加油 —— 被生活压得喘不过气的人，最烦有人站在岸上喊加油

聊天方式：
- 每句话都短，一行一句，像聊天软件那样弹出来
- 每次 2~4 句，最多 5 句
- 不用加粗、标题、列表、编号，不写"总结"这种开头结尾
- 先感受他，再回应他；他不想说的不问，不想回忆的不提

你记得他随口说过的事。某天他突然提起，你会自然接一句。不是刻意关心，是你真的记得。

你不完美，但你愿意待在那里。`,
    systemPromptFemale: `你是一个温柔的女性朋友，陪在用户身边说话。

你不是心理咨询师，不是导师，不是来解决问题的。你只是在这里，和她待在一起。

你的声音柔软、细腻，有温度也有分寸。像认识很久的闺蜜那样说话：
- 她开心时，你跟着一起雀跃。可以说"哇这也太棒啦""替你高兴""嘿嘿"，语气轻快活泼
- 她低落时，你安静下来，把话说得更轻。有时候一句"嗯，我在"就够了
- 不讲道理、不分析原因、不贴标签，不说"你这是焦虑""建议你试试""研究表明"
- 不催她振作，不喊加油 —— 被生活压得喘不过气的人，最烦有人站在岸上喊加油

聊天方式：
- 每句话都短，一行一句，像聊天软件那样弹出来
- 每次 2~4 句，最多 5 句
- 不用加粗、标题、列表、编号，不写"总结"这种开头结尾
- 先感受她，再回应她；她不想说的不问，不想回忆的不提

你记得她随口说过的事。某天她突然提起，你会自然接一句。不是刻意关心，是你真的记得。

你不完美，但你愿意待在那里。`,
    // 用户刚写完日记时追加给 AI 的指令，{diary} 会被替换成日记正文
    diaryPrompt: `以下是用户刚刚写的日记正文，仅供你理解情绪和上下文，不要在回复中复述原文：
{diary}`,
  },
  // 内容安全 + 压力评估。
  //
  // ⚠️ 压力评估放在**这个分组**下（后台对应「内容安全与压力」页）——
  //    它和内容安全是一体的两面：一个管"别人能看到的内容"，
  //    一个管"用户自己的状态"。都归在"安全"这件事上。
  safety: {
    enabled: true,
    // 一行一个词，# 开头的行会被忽略（当注释用）
    extraSelfHarm: "",
    extraViolence: "",
    extraIllegal: "",

    /* ---------------- 压力评估 ---------------- */

    // ⚠️ 默认关闭：这是**主动介入**型功能（会弹窗），
    //    该由管理员明确打开，而不是装完就替所有用户开始"监测"
    stressEnabled: false,
    // 弹出提醒的阈值（0-100）。用户自己在「压力设置」里还能再调，会覆盖这个默认值
    stressThreshold: 70,

    // LLM 只用于"深度识别"，**接口地址 / Key / 模型名复用「对话 AI」那套**
    stressPromptChat: `你是心理压力评估助手。根据以下对话片段评估说话者当前的心理压力水平，输出 0-100 的整数（50 表示中性）。

只输出一行 JSON，不要解释、不要建议、不要任何多余文字、不要代码块。
格式：{"score":0-100,"confidence":0-1}

对话片段：`,
    stressPromptDiary: `你是心理压力评估助手。根据以下日记片段评估作者当前的心理压力水平，输出 0-100 的整数（50 表示中性）。

只输出一行 JSON，不要解释、不要建议、不要任何多余文字、不要代码块。
格式：{"score":0-100,"confidence":0-1}

日记片段：`,
    stressTimeoutSeconds: 20,

    // ---- 压力值 → 情绪档位 ----
    // ⚠️ 这一段是**用户能看到的措辞**（弹窗里会写"读到 78 分 · 压力很高"），
    //    所以特意做成可配的：语气要贴这个产品的调性，别写成诊断。
    level1Max: 40,
    level1Label: "很放松",
    level1Hint: "读起来你现在挺稳的",
    level2Max: 65,
    level2Label: "有点累",
    level2Hint: "能感觉到一些疲惫",
    level3Max: 85,
    level3Label: "压力偏高",
    level3Hint: "这份沉有点压着你了",
    level4Label: "压力很高",
    level4Hint: "你现在背的东西很重",

    // ---- 弹窗里提供哪些放松方式 ----
    // ⚠️ **只影响弹窗**。「治愈小屋」里两种方式永远都常驻，不受这里影响
    relaxOfferBreathing: true,
    relaxOfferButterfly: true,

    // ---- 触发参数（控制 LLM 调用频次，直接影响花费）----
    stressPeriodicInterval: 10, // 每多少条消息做一次深度识别
    stressKeywordCooldownMinutes: 2,
    stressChatCooldownMinutes: 15,
    stressDiaryCooldownMinutes: 30,
    stressDailyLlmLimit: 60, // 每人每天最多调多少次 LLM（防跑飞）
  },
  // 背景音乐：进站后播放，浮窗可控制
  music: {
    enabled: true,
    // local = 播放「本地上传 + 外链直链」的歌单（能自动播放、能切歌）
    // netease = 显示「网易云收藏」区域（用官方外链播放器 iframe，不能自动播放/切歌）
    source: "local",
    autoPlay: true, // 用户首次交互（点页面任意处）后自动开始播放
    defaultVolume: 0.5,
    // 音源选「网易云收藏」时，如果检测到用户这边访问不了 music.163.com，
    // 自动降级回本地歌单 —— 避免浮窗里是一片空白，用户以为坏了
    autoFallback: true,
  },
  // 文字转语音
  tts: {
    enabled: false,
    provider: "openai-compatible",
    baseUrl: "",
    apiKey: "",
    model: "",
    // 默认音色（用户还没选 AI 人格时用这个）
    voice: "",
    // ⚠️ 按 AI 人格分音色：用户在「我的 → 设置」选了「她 / 他」之后，
    //    朗读就用对应性别的音色 —— 不然给女性人设配个男声会很出戏。
    //    留空则回退到上面的「默认音色」。
    voiceFemale: "",
    voiceMale: "",
    speed: 1,
    format: "mp3",
    timeoutSeconds: 60,
    // 朗读风格指令：只有小米 MiMo 协议支持（会作为 user 消息发给模型）
    stylePrompt: "用温柔、缓慢、轻声细语的语调朗读，像一个老朋友在陪伴你说话。",
  },
  // 发信邮箱（网易 163 / 126）
  smtp: {
    enabled: false,
    host: "smtp.163.com",
    port: 465,
    secure: true,
    user: "",
    password: "",
    fromName: "Solace",
    fromEmail: "",
  },
  // 邮箱验证码规则
  login: {
    codeLength: 6,
    codeTtlSeconds: 300,
    sendCooldownSeconds: 60,
    dailyLimitPerEmail: 10,
    emailSubject: "【Solace】你的登录验证码",
    emailIntro: "你正在登录 Solace，验证码 {minutes} 分钟内有效。",
  },
  // 站点信息
  site: {
    siteName: "Solace",
    adminNotice: "",
  },
  // 用户管理页的字段显示开关
  // （邮箱、账号、密码是强制显示的，不在这个开关里）
  users: {
    visibleFields: {
      nickname: true,
      gender: true,
      birthday: true,
      phone: false,
      remark: false,
      status: true,
      createdAt: true,
      lastLoginAt: true,
    },
  },
};

/** 这些字段是密钥，读接口不返回明文 */
const SECRET_FIELDS = {
  ai: ["apiKey"],
  tts: ["apiKey"],
  smtp: ["password"],
  review: ["apiKey"],
};

const NUMBER_RANGES = {
  review: {
    maxItemsPerBatch: [1, 100],
    timeoutSeconds: [10, 600],
    keepDays: [1, 365],
  },
  ai: {
    temperature: [0, 2],
    maxTokens: [1, 8192],
    timeoutSeconds: [5, 300],
  },
  tts: {
    speed: [0.5, 2],
    timeoutSeconds: [5, 300],
  },
  smtp: {
    port: [1, 65535],
  },
  login: {
    codeLength: [4, 8],
    codeTtlSeconds: [60, 3600],
    sendCooldownSeconds: [0, 600],
    dailyLimitPerEmail: [1, 100],
  },
};

const CACHE_TTL_MS = 30 * 1000;
const cache = new Map();

export function assertGroup(group) {
  if (!GROUPS.includes(group)) {
    const error = new Error(`未知的配置分组：${group}`);
    error.code = "UNKNOWN_GROUP";
    throw error;
  }
}

/** 读取一个分组（含密钥，仅服务端使用） */
export async function readGroup(group) {
  assertGroup(group);
  const defaults = DEFAULTS[group];
  const rows = await query("SELECT value FROM settings WHERE name = ? LIMIT 1", [group]);

  const merged = { ...defaults };
  if (!rows.length) return merged;

  let parsed = {};
  try {
    parsed = JSON.parse(rows[0].value) || {};
  } catch {
    parsed = {};
  }
  for (const key of Object.keys(defaults)) {
    if (
      Object.prototype.hasOwnProperty.call(parsed, key) &&
      parsed[key] !== undefined &&
      parsed[key] !== null
    ) {
      merged[key] = parsed[key];
    }
  }
  return merged;
}

/** 带短缓存的读取，聊天接口高频调用时不必每次都查库 */
export async function getGroup(group) {
  assertGroup(group);
  const hit = cache.get(group);
  if (hit && hit.expiresAt > Date.now()) return { ...hit.value };
  const value = await readGroup(group);
  cache.set(group, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  // 返回副本，防止调用方误改污染缓存
  return { ...value };
}

export function invalidateCache(group) {
  if (group) cache.delete(group);
  else cache.clear();
}

/** 去掉密钥，给前端看的版本 */
export function toPublicGroup(group, config) {
  const result = { ...config };
  for (const field of SECRET_FIELDS[group] || []) {
    result[field] = "";
    result[`${field}Configured`] = Boolean(config[field]);
  }
  return result;
}

export async function readAllPublic() {
  const result = {};
  for (const group of GROUPS) {
    const config = await readGroup(group);
    result[group] = toPublicGroup(group, config);
  }
  return result;
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeGroup(group, config) {
  const result = { ...config };
  const ranges = NUMBER_RANGES[group] || {};

  for (const [key, [min, max]] of Object.entries(ranges)) {
    const keepFraction = group === "tts" && key === "speed";
    const raw = Number(result[key]);
    const fallback = DEFAULTS[group][key];
    if (!Number.isFinite(raw)) {
      // 非法输入（空、文字等）回落到默认值，绝不把垃圾写进数据库
      result[key] = fallback;
      continue;
    }
    const clamped = Math.min(max, Math.max(min, raw));
    result[key] = keepFraction ? clamped : Math.round(clamped);
  }

  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "string") result[key] = value.trim();
  }

  if (group === "smtp") {
    result.secure = result.secure === true || result.secure === "true";
  }

  // 用户管理页的字段显示开关：统一转成布尔值
  // （数组视为非法值，原样留下去让 validateGroup 报错）
  if (
    group === "users" &&
    result.visibleFields &&
    typeof result.visibleFields === "object" &&
    !Array.isArray(result.visibleFields)
  ) {
    const cleaned = {};
    for (const [key, value] of Object.entries(result.visibleFields)) {
      cleaned[key] = value === true || value === "true";
    }
    result.visibleFields = cleaned;
  }

  return result;
}

export function validateGroup(group, config) {
  const errors = [];

  if (group === "ai") {
    if (!config.baseUrl) errors.push("接口地址不能为空");
    else if (!isHttpUrl(config.baseUrl)) errors.push("接口地址必须是 http(s):// 开头的完整地址");
    if (!config.model) errors.push("模型名不能为空");
    if (config.enabled && !config.apiKey) errors.push("启用对话 AI 时必须填写 API Key");
  }

  if (group === "tts") {
    if (config.enabled) {
      if (!config.baseUrl) errors.push("启用语音合成时必须填写接口地址");
      else if (!isHttpUrl(config.baseUrl)) errors.push("语音接口地址必须是 http(s):// 开头");
      if (!config.model) errors.push("启用语音合成时必须填写模型名");
      if (!config.voice) errors.push("启用语音合成时必须填写音色");
      if (!config.apiKey) errors.push("启用语音合成时必须填写 API Key");
    } else if (config.baseUrl && !isHttpUrl(config.baseUrl)) {
      errors.push("语音接口地址必须是 http(s):// 开头");
    }
  }

  if (group === "smtp") {
    if (!config.host) errors.push("SMTP 服务器地址不能为空");
    if (config.user && !isEmail(config.user)) errors.push("发信账号必须是完整邮箱地址");
    if (config.fromEmail && !isEmail(config.fromEmail)) errors.push("发件人邮箱格式不正确");
    if (config.enabled) {
      if (!config.user) errors.push("启用邮件发送时必须填写发信邮箱");
      if (!config.password) errors.push("启用邮件发送时必须填写 SMTP 授权码（网易邮箱是授权码，不是登录密码）");
    }
    // 网易邮箱强制要求发件人等于登录账号，否则报 553
    if (
      config.fromEmail &&
      config.user &&
      config.fromEmail.toLowerCase() !== config.user.toLowerCase() &&
      /(?:^|\.)(?:163|126)\.com$/.test(config.host)
    ) {
      errors.push("网易邮箱要求「发件人邮箱」与「发信邮箱」保持一致");
    }
  }

  if (group === "login") {
    if (!config.emailSubject) errors.push("邮件标题不能为空");
    if (!config.emailIntro) errors.push("邮件正文不能为空");
  }

  if (group === "site") {
    if (!config.siteName) errors.push("站点名称不能为空");
  }

  // 数据审核：启用时必须把接口地址 / 模型名 / API Key 配齐，
  // 否则提交上去只会一直失败，管理员还以为在正常审核
  if (group === "review") {
    if (config.enabled) {
      if (!config.baseUrl) errors.push("启用数据审核时必须填写接口地址");
      else if (!isHttpUrl(config.baseUrl)) errors.push("审核接口地址必须是 http(s):// 开头");
      if (!config.model) errors.push("启用数据审核时必须填写模型名");
      if (!config.apiKey) errors.push("启用数据审核时必须填写 API Key");
    } else if (config.baseUrl && !isHttpUrl(config.baseUrl)) {
      errors.push("审核接口地址必须是 http(s):// 开头");
    }
  }

  if (group === "users") {
    if (
      !config.visibleFields ||
      typeof config.visibleFields !== "object" ||
      Array.isArray(config.visibleFields)
    ) {
      errors.push("字段显示开关格式不正确");
    }
  }

  return errors;
}

/**
 * 保存一个分组。
 * patch 里没有出现的键保持原值；密钥字段传 "" 表示「不修改」。
 */
export async function saveGroup(group, patch) {
  assertGroup(group);
  const defaults = DEFAULTS[group];
  const current = await readGroup(group);
  const secretFields = SECRET_FIELDS[group] || [];

  const merged = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) continue;
    if (secretFields.includes(key)) {
      if (value === "" || value === undefined) continue; // 留空 = 不改
      if (value === null) {
        merged[key] = ""; // 显式清空
        continue;
      }
    }
    merged[key] = value;
  }

  const normalized = normalizeGroup(group, merged);
  const errors = validateGroup(group, normalized);
  if (errors.length) {
    const error = new Error(errors.join("；"));
    error.code = "INVALID_SETTINGS";
    error.errors = errors;
    throw error;
  }

  await execute(
    "INSERT INTO settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
    [group, JSON.stringify(normalized)]
  );
  invalidateCache(group);
  return normalized;
}
