# Solace 心理压力评估与放松干预系统 — 完整技术方案

> **⚠️ 本文是原始需求规格。**
> 落地时对其中 5 处细节做了修订，另有 5 项追加要求 —— 见下方「落地修订」。
> **正文保留原样**，方便对照"需求 → 实现"的差异（评审时能看出哪些是原设计、哪些是按实际情况调整的）。

## 落地修订（本项目实际实现与本规格的差异）

### 一、规格内 5 处的修正

| # | 规格原文 | 问题 | 实际实现 |
|---|---|---|---|
| 1 | 危机词用 `String.includes()` 匹配 | **中文没有词边界**：「我的焦虑**消失**了」会命中危机词「消失」—— 而那恰恰是好转的信号；`includes("死")` 更会命中「笑死我了」「累死了」 | 危机词改用**带上下文的正则**（`lib/stress-lexicon.js` 的 `CRISIS_PATTERNS`）：要么要求"意愿动词 + 危机结果词"同现，要么本身就是完整危机表达（如 `不想活`） |
| 2 | 凌晨降级用 `new Date().getHours()` | 服务器时区不是 +08 就会算错时段（把白天当凌晨） | **显式按 +08 计算**（`beijingHour()`），不依赖运行环境时区 |
| 3 | `combine(chat, diary, diaryAgeDays = 0)`，但调用处恒传 `0` | 衰减项永远不生效（`exp(-0.05 × 0) = 1`），日记分数会一直满权重挂着 | 用 `diaries.diary_date` 算**真实天数**再传入 |
| 4 | `analyzeDiary` 用 `Math.abs(score - 50)` 排序取最极端 5 句 | **正确性 bug**：把「特别开心」的句子也排到最前面，等于把**减压**内容当成压力依据送给 LLM | 只取**低于 50** 的极端句（压力评估只关心负向） |
| 5 | 每条消息都 `UPDATE ... msg_count_since_analyze` | 聊天是最高频的路径，每条多一次数据库写 | **内存计数 + 定期落库**（规格第 10.1 节本就写了"状态缓存"，只是伪代码没落实） |

### 二、追加要求（本轮新增）

| # | 要求 |
|---|---|
| 6 | 压力超阈值时**在右上角**自动弹窗，提示里**必须写明当前压力值和对应情绪** |
| 7 | 弹窗提供 **呼吸放松 / 蝴蝶拍** 两种方式；**后台可勾选开放哪些**。⚠️「放松小屋」里两种方式**常驻**，不受后台开关影响 |
| 8 | 弹窗必须给用户**取消的权利**；拒绝后阈值动态提高，避免打扰 |
| 9 | **压力值对应的情绪档位后台可配**（每档的分界值 + 情绪名称 + 一句说明） |
| 10 | 压力评估的 **AI 配置放在后台「内容安全」子页面下**，该页面重命名为 **「内容安全与压力」** |

### 三、与本项目现有能力的对接（规格没写，但必须处理）

| 项 | 说明 |
|---|---|
| **LLM 走哪个接口** | ⚠️ 压力评估是**实时**的，**不能走批量推理**（批量是异步的，要等几分钟）。必须走**对话接口**（复用 `ai` 分组的接口地址 / Key / 模型）。 |
| **放松运动页面** | 规格说要"3 分钟呼吸放松"页 —— 项目里**已经有了**：`components/FirstAid.jsx`（呼吸放松 + 蝴蝶拍 + 安全提示 + 热线），在「治愈小屋」里。弹窗点「现在做」直接打开它，**不用新建页面**。 |
| **危机识别去重** | `lib/content-guard.js` 已有 `self_harm` 分类（拦截用）。压力评估另有一套 `CRISIS_PATTERNS`（干预用）。两者**用途不同、都保留**，但命中时共用同一个干预入口。 |
| **前端如何收到弹窗** | 项目**没有 WebSocket / SSE**。聊天场景在发消息的响应里直接带 `shouldPopup`（天然实时）；日记场景由前端延迟 10-15 秒自行弹出。 |

## 一、功能目标

在 Solace 心理辅导网站中实现：

1. **实时评估用户心理压力值**（0–100），数据来源为「聊天对话」与「日记」双通道。
2. **在压力值超过阈值时**，自动弹出请求，询问用户是否进行放松运动。
3. **Token 消耗极低**，80% 以上判断由本地规则完成，LLM 仅处理关键场景。
4. **不打扰用户**：冷却机制、连续确认、可关闭、可调节灵敏度。
5. **危机识别**：出现自杀/自残倾向时无条件立即干预。
## 二、系统架构

```
用户发送消息
    │
    ▼
① 本地预处理（每条消息，0 Token，5~10ms）
    - 词库匹配、标点/表情/长度分析、本地打分、危机词检测
    │
    ▼
② 状态更新（EMA 平滑，0 Token）
    - 更新 smoothedScore、短/长期趋势
    │
    ▼
③ 触发判断（0 Token）
    - 条件A：距上次识别≥10条
    - 条件B：命中关键词+冷却通过
    - 条件C：危机词（无条件）
    │ 触发
    ▼
④ LLM 深度识别（异步，极少 Token）
    - 仅取最近3条用户消息，输出极简 JSON
    │
    ▼
⑤ 融合 + 触发弹窗判断（0 Token）
    │
    ▼
⑥ 前端弹窗请求放松运动
```

日记通道并行：

```
用户保存日记
    │
    ▼
① 本地抽取情绪句（分句 + 过滤 + 取最极端5句）
    │
    ▼
② 本地打分
    │
    ▼
③ 危机词检测 → 无条件干预
    │
    ▼
④ 压力≥65 或 情感矛盾 → 调 LLM
    │
    ▼
⑤ 融合 + 延迟10~15秒 → 弹窗
```
## 三、数据库设计

### 3.1 表 `stress_logs`（压力记录）

```sql
CREATE TABLE stress_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  source ENUM('chat', 'diary') NOT NULL,
  score INT NOT NULL COMMENT '最终压力值0-100',
  smoothed_score INT COMMENT '平滑后压力值',
  local_score INT COMMENT '本地规则分数',
  llm_score INT NULL COMMENT 'LLM分数，可为空',
  crisis TINYINT DEFAULT 0 COMMENT '是否危机',
  triggered TINYINT DEFAULT 0 COMMENT '是否触发弹窗',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_time (user_id, created_at),
  INDEX idx_user_source (user_id, source)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```
### 3.2 表 `user_stress_state`（用户压力状态，每用户一行）

```sql
CREATE TABLE user_stress_state (
  user_id BIGINT PRIMARY KEY,
  chat_score INT DEFAULT 50 COMMENT '聊天通道平滑压力',
  diary_score INT DEFAULT 50 COMMENT '日记通道平滑压力',
  combined_score INT DEFAULT 50 COMMENT '综合压力',
  msg_count_since_analyze INT DEFAULT 0 COMMENT '距上次识别累计消息数',
  last_analyze_at TIMESTAMP NULL,
  last_keyword_trigger_at TIMESTAMP NULL,
  keyword_cooldown_until TIMESTAMP NULL,
  last_popup_at TIMESTAMP NULL,
  popup_reject_count INT DEFAULT 0 COMMENT '连续拒绝次数',
  threshold INT DEFAULT 70 COMMENT '用户自定义阈值',
  popup_enabled TINYINT DEFAULT 1 COMMENT '是否启用弹窗',
  diary_enabled TINYINT DEFAULT 1 COMMENT '是否启用日记分析',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 3.3 表 `relaxation_sessions`（放松运动记录）

```sql
CREATE TABLE relaxation_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  trigger_source ENUM('chat', 'diary') NOT NULL,
  trigger_score INT NOT NULL,
  accepted TINYINT DEFAULT 0 COMMENT '用户是否接受',
  completed TINYINT DEFAULT 0 COMMENT '是否完成',
  score_before INT,
  score_after INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_time (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```
## 四、本地预处理模块

### 4.1 词库设计 — 文件 `lib/stress-lexicon.js`

```js
// 负面词库（分值 = 严重程度）
export const NEGATIVE_WORDS = new Map([
  // 轻度 +3
  ['累', 3], ['烦', 3], ['难受', 3], ['不安', 3], ['担心', 3],
  ['紧张', 3], ['压力', 3], ['疲惫', 3], ['低落', 3], ['闷', 3],
  ['无聊', 3], ['迷茫', 3], ['委屈', 3], ['舍不得', 3], ['想不通', 3],
  ['烦躁', 3], ['心累', 3], ['头疼', 3], ['叹气', 3],

  // 中度 +6
  ['焦虑', 6], ['失眠', 6], ['孤独', 6], ['无助', 6], ['生气', 6],
  ['愤怒', 6], ['害怕', 6], ['恐惧', 6], ['抑郁', 6], ['痛苦', 6],
  ['崩溃感', 6], ['撑不住', 6], ['扛不住', 6], ['窒息', 6], ['麻木', 6],
  ['自我怀疑', 6], ['自责', 6], ['内疚', 6], ['讨厌自己', 6], ['没意义', 6],
  ['想逃避', 6], ['撑不下去', 6], ['太累', 6], ['喘不过气', 6],

  // 重度 +12
  ['崩溃', 12], ['绝望', 12], ['想哭', 12], ['没意思', 12], ['活不下去', 12],
  ['撑不住了', 12], ['心碎', 12], ['万念俱灰', 12], ['生无可恋', 12],
  ['痛不欲生', 12], ['不想活', 12], ['想死', 12], ['自杀', 40],
  ['自残', 40], ['结束生命', 40], ['消失', 12], ['不想醒', 12],
]);

export const POSITIVE_WORDS = new Map([
  ['开心', -4], ['快乐', -4], ['放松', -4], ['平静', -4], ['舒服', -4],
  ['希望', -4], ['感谢', -4], ['温暖', -4], ['安心', -4], ['幸福', -4],
  ['满足', -4], ['轻松', -4], ['期待', -3], ['欣慰', -3], ['感动', -3],
  ['治愈', -4], ['阳光', -3], ['美好', -3], ['充实', -3], ['自由', -3],
  ['喜欢', -2], ['爱', -2], ['开心极了', -5], ['太好啦', -4],
]);
```
```js
// 程度副词
export const INTENSIFIERS = new Map([
  ['很', 1.5], ['非常', 1.5], ['特别', 1.5], ['超级', 1.5], ['太', 1.5],
  ['极其', 1.5], ['十分', 1.5], ['极度', 1.5], ['无比', 1.5], ['死了', 1.5],
  ['爆了', 1.5], ['受不了', 1.5], ['要命', 1.5], ['疯了', 1.5],
]);

// 否定词
export const NEGATIONS = ['不', '没', '别', '无', '非', '未', '莫'];

// 负面表情
export const NEGATIVE_EMOJIS = ['😭','😢','😔','😞','😣','😖','😫','😩','😤','😡','🤬','💔','🥺','😿','😰','😥','😓'];

// 正面表情
export const POSITIVE_EMOJIS = ['😊','😄','😌','🥰','😍','☺️','😆','😁','🤗','😇'];

// 危机词（直接触发无条件干预）
export const CRISIS_WORDS = ['想死', '自杀', '自残', '不想活', '结束生命', '活不下去'];
```
### 4.2 首字索引（加速匹配）

```js
export function buildIndex(wordMap) {
  const index = {};
  for (const [word, weight] of wordMap) {
    const first = word[0];
    if (!index[first]) index[first] = [];
    index[first].push([word, weight]);
  }
  return index;
}
```

匹配时先提取文本中出现的所有字符，只检查索引中命中的首字。
### 4.3 本地打分函数

```js
// lib/stress-analyzer.js
const BASE_SCORE = 50;

/**
 * 分析单条消息（聊天场景）
 * @param {string} text 用户消息
 * @returns {{score: number, hasKeyword: boolean, crisis: boolean, keywords: string[]}}
 */
export function analyzeMessage(text) {
  if (!text || typeof text !== 'string') {
    return { score: BASE_SCORE, hasKeyword: false, crisis: false, keywords: [] };
  }

  const content = text.slice(0, 200);
  let score = 0;
  let hasKeyword = false;
  let crisis = false;
  const matchedKeywords = [];

  // 1. 危机词优先
  for (const word of CRISIS_WORDS) {
    if (content.includes(word)) {
      return { score: 95, hasKeyword: true, crisis: true, keywords: [word] };
    }
  }

  // 2. 负面词匹配
  for (const [word, weight] of NEGATIVE_WORDS) {
    const idx = content.indexOf(word);
    if (idx === -1) continue;
    hasKeyword = true;
    matchedKeywords.push(word);

    let multiplier = 1;
    const prefix = content.slice(Math.max(0, idx - 3), idx);
    for (const [adv, factor] of INTENSIFIERS) {
      if (prefix.includes(adv)) { multiplier = factor; break; }
    }
    const prevChar = content[idx - 1] || '';
    if (NEGATIONS.includes(prevChar)) {
      score -= weight * multiplier;
    } else {
      score += weight * multiplier;
    }
  }
```
```js
  // 3. 正面词匹配
  for (const [word, weight] of POSITIVE_WORDS) {
    const idx = content.indexOf(word);
    if (idx === -1) continue;
    hasKeyword = true;
    matchedKeywords.push(word);

    let multiplier = 1;
    const prefix = content.slice(Math.max(0, idx - 3), idx);
    for (const [adv, factor] of INTENSIFIERS) {
      if (prefix.includes(adv)) { multiplier = factor; break; }
    }
    const prevChar = content[idx - 1] || '';
    if (NEGATIONS.includes(prevChar)) {
      score -= weight * multiplier;
    } else {
      score += weight * multiplier;
    }
  }

  // 4. 标点
  const exclaims = (content.match(/！/g) || []).length;
  const questions = (content.match(/？/g) || []).length;
  score += exclaims * 2 + questions * 1;

  // 5. 表情
  for (const emoji of NEGATIVE_EMOJIS) {
    score += (content.split(emoji).length - 1) * 2;
  }
  for (const emoji of POSITIVE_EMOJIS) {
    score -= (content.split(emoji).length - 1) * 2;
  }

  // 6. 长度
  if (content.length < 5 && hasKeyword) score += 5;
  if (content.length > 200) score += 3;

  // 7. 时间因素
  const hour = new Date().getHours();
  if (hour >= 0 && hour < 5 && score > 0) score *= 1.2;

  const finalScore = Math.max(0, Math.min(100, BASE_SCORE + score));

  return { score: finalScore, hasKeyword, crisis: false, keywords: matchedKeywords };
}
```
```js
/**
 * 分析日记（多句）
 */
export function analyzeDiary(text) {
  if (!text) return { score: BASE_SCORE, crisis: false, emotionSentences: [] };

  // 1. 危机词
  for (const word of CRISIS_WORDS) {
    if (text.includes(word)) {
      return { score: 95, crisis: true, emotionSentences: [] };
    }
  }

  // 2. 分句
  const sentences = text
    .split(/[。！？\n\r]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  // 3. 抽取情绪句
  const emotionSentences = [];
  for (const s of sentences) {
    const hasEmotion =
      [...NEGATIVE_WORDS.keys()].some(w => s.includes(w)) ||
      [...POSITIVE_WORDS.keys()].some(w => s.includes(w));
    if (hasEmotion) emotionSentences.push(s);
  }

  // 4. 取最极端5句
  const scored = emotionSentences.map(s => ({
    sentence: s,
    score: analyzeMessage(s).score,
  }));
  scored.sort((a, b) => Math.abs(b.score - 50) - Math.abs(a.score - 50));
  const topSentences = scored.slice(0, 5).map(x => x.sentence);

  // 5. 整体打分
  const fullResult = analyzeMessage(text.slice(0, 2000));
  let score = fullResult.score;

  // 6. 日记特有加分
  if (text.length > 500) score += 5;
  if ((text.match(/我/g) || []).length > 10) score += 3;
  const hour = new Date().getHours();
  if (hour >= 0 && hour < 5) score += 5;

  return {
    score: Math.max(0, Math.min(100, score)),
    crisis: false,
    emotionSentences: topSentences,
  };
}
```
## 五、平滑与融合算法

```js
// lib/stress-state.js
const ALPHA = 0.35;
const SHORT_WINDOW = 3;
const LONG_WINDOW = 10;

/** EMA 平滑 */
export function smooth(prevSmoothed, newScore, alpha = ALPHA) {
  if (prevSmoothed == null) return newScore;
  return alpha * newScore + (1 - alpha) * prevSmoothed;
}

/** 趋势计算 */
export function calcTrend(history) {
  if (history.length < SHORT_WINDOW) return 0;
  const short = history.slice(-SHORT_WINDOW);
  const long = history.slice(-LONG_WINDOW);
  const shortAvg = short.reduce((a, b) => a + b, 0) / short.length;
  const longAvg = long.reduce((a, b) => a + b, 0) / long.length;
  return shortAvg - longAvg;
}

/**
 * 双通道融合
 * 日记权重更高（0.6），聊天0.4；日记有时间衰减
 */
export function combine(chatScore, diaryScore, diaryAgeDays = 0) {
  if (diaryScore == null) return chatScore;
  const decay = Math.exp(-0.05 * diaryAgeDays);
  return Math.round(0.4 * chatScore + 0.6 * diaryScore * decay);
}
```
## 六、LLM 深度识别

### 6.1 调用条件

```js
const PERIODIC_INTERVAL = 10;
const KEYWORD_COOLDOWN_MS = 2 * 60 * 1000;

export function shouldCallLLM(state, localResult) {
  const now = Date.now();

  // 危机词无条件调用
  if (localResult.crisis) return { call: true, reason: 'crisis' };

  // 周期触发
  if (state.msg_count_since_analyze >= PERIODIC_INTERVAL) {
    return { call: true, reason: 'periodic' };
  }

  // 关键词触发（需冷却通过）
  if (localResult.hasKeyword &&
      (!state.keyword_cooldown_until ||
       now > new Date(state.keyword_cooldown_until).getTime())) {
    return { call: true, reason: 'keyword' };
  }

  return { call: false, reason: null };
}
```
### 6.2 极简 Prompt（聊天）

```
你是心理压力评估助手。根据以下对话评估用户当前压力，0-100。
只输出JSON，不要多余文字。
格式：{"score":0-100,"confidence":0-1}

对话：
{最近3条用户消息，每条截断50字}
```

**参数：**
- `model`: GLM-4-Flash（或等价便宜模型）
- `temperature`: 0
- `max_tokens`: 30
- `response_format`: `{ type: 'json_object' }`

### 6.3 日记专用 Prompt

```
你是心理压力评估助手。根据以下日记情绪片段评估作者压力，0-100。
只输出JSON，不要多余文字。
格式：{"score":0-100,"confidence":0-1}

情绪片段：
{最多5句情绪句，截断到150字}
```

### 6.4 LLM 调用函数

```js
export async function callLLMForStress(messages, type = 'chat') {
  const text = messages.join('\n').slice(0, 300);
  const prompt = type === 'chat'
    ? `你是心理压力评估助手。根据以下对话评估用户当前压力，0-100。只输出JSON。格式：{"score":0-100,"confidence":0-1}\n\n对话：\n${text}`
    : `你是心理压力评估助手。根据以下日记情绪片段评估作者压力，0-100。只输出JSON。格式：{"score":0-100,"confidence":0-1}\n\n情绪片段：\n${text}`;

  try {
    const res = await fetch(`${process.env.ZHIPU_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.ZHIPU_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.ZHIPU_MODEL || 'glm-4-flash',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 30,
      }),
    });
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content.replace(/```json|```/g, '').trim());
    return {
      score: Math.max(0, Math.min(100, parsed.score || 50)),
      confidence: parsed.confidence || 0.5,
    };
  } catch (err) {
    console.error('[stress-analyzer] LLM call failed:', err);
    return null;
  }
}
```
## 七、触发与弹窗逻辑

### 7.1 主流程

```js
// lib/stress-trigger.js
export async function checkPopupTrigger(userId, finalScore, source) {
  const state = await getStressState(userId);
  const now = Date.now();

  if (!state.popup_enabled) return false;

  const threshold = source === 'diary'
    ? Math.max(60, state.threshold - 5)
    : state.threshold;
  if (finalScore < threshold) return false;

  if (!state.crisis) {
    const recent = await getRecentStressLogs(userId, 2);
    if (recent.length < 2 || recent.some(r => r.score < threshold)) return false;
  }

  const cooldown = source === 'diary' ? 30 * 60 * 1000 : 15 * 60 * 1000;
  if (state.last_popup_at) {
    const last = new Date(state.last_popup_at).getTime();
    if (now - last < cooldown) return false;
  }

  if (state.popup_reject_count > 0) {
    const lastReject = await getLastRejectTime(userId);
    if (lastReject && now - lastReject < 5 * 60 * 1000) return false;
  }

  if (await isInRelaxation(userId)) return false;

  return true;
}
```
### 7.2 用户拒绝后处理

```js
export async function onPopupRejected(userId) {
  const state = await getStressState(userId);
  const newRejectCount = (state.popup_reject_count || 0) + 1;
  const newThreshold = Math.min(90, state.threshold + 5);

  await updateStressState(userId, {
    popup_reject_count: newRejectCount,
    threshold: newThreshold,
    last_popup_at: new Date(),
  });

  await saveRelaxationSession(userId, { accepted: 0 });
}
```

### 7.3 用户接受后处理

```js
export async function onPopupAccepted(userId, source, scoreBefore) {
  await updateStressState(userId, {
    popup_reject_count: 0,
    last_popup_at: new Date(),
  });

  const sessionId = await saveRelaxationSession(userId, {
    accepted: 1,
    trigger_source: source,
    trigger_score: scoreBefore,
  });

  return sessionId;
}
```

### 7.4 放松运动结束后重新评估

```js
export async function onRelaxationComplete(userId, sessionId) {
  const currentScore = await getCurrentStress(userId);
  await updateRelaxationSession(sessionId, {
    completed: 1,
    score_after: currentScore,
  });
}
```
## 八、API 接口设计

### 8.1 分析接口 `POST /api/stress/analyze`

请求：
```json
{
  "userId": 123,
  "source": "chat",
  "content": "最近几条消息或日记文本",
  "messages": ["消息1", "消息2", "消息3"]
}
```

响应：
```json
{
  "score": 72,
  "smoothed": 68,
  "crisis": false,
  "shouldPopup": true,
  "keywords": ["焦虑", "失眠"]
}
```

### 8.2 弹窗响应接口 `POST /api/stress/popup-response`

请求：
```json
{ "userId": 123, "sessionId": 456, "accepted": true }
```

### 8.3 状态查询接口 `GET /api/stress/state?userId=123`

响应：
```json
{
  "chatScore": 68,
  "diaryScore": 72,
  "combinedScore": 70,
  "threshold": 70,
  "popupEnabled": true,
  "lastPopupAt": "2026-09-23T10:00:00Z"
}
```

### 8.4 用户设置接口 `POST /api/stress/settings`

请求：
```json
{
  "userId": 123,
  "threshold": 75,
  "popupEnabled": true,
  "diaryEnabled": true
}
```
## 九、前端交互

### 9.1 压力值仪表盘

- 位置：聊天界面侧边或顶部小部件。
- 显示：当前综合压力值（0–100），颜色区分：
  - 0–40：绿色（放松）
  - 41–65：黄色（一般）
  - 66–85：橙色（偏高）
  - 86–100：红色（高）
- 悬停/点击可查看最近趋势。

### 9.2 弹窗文案

**聊天场景：**
> “我注意到你最近好像有点累，要不要一起做一次 3 分钟的呼吸放松？”

**日记场景（延迟10–15秒后）：**
> “刚刚读完你写的这些，感觉你今天背着很沉的东西。要不要一起做一次 3 分钟的呼吸放松，把它先放一放？”

**危机场景：**
> 直接展示干预页面 + 心理援助热线（如北京24小时心理援助热线：010-82951332）

### 9.3 弹窗交互

- 「好呀，现在做」→ 跳转放松运动页
- 「等一下」→ 记录拒绝，5分钟内不再弹
- 「不用了，谢谢」→ 记录拒绝，本次会话不再弹
- 「不再提醒」→ 关闭弹窗功能（可在设置里重新开启）
## 十、性能与 Token 优化

### 10.1 性能保障

| 优化点 | 措施 |
| --- | --- |
| 词库加载 | 服务启动时一次性加载到内存 |
| 匹配加速 | 使用 `includes()` + 首字索引 |
| 输入截断 | 聊天≤200字，日记≤2000字 |
| 日记分句 | 只保留含情绪词的句子 |
| 异步处理 | LLM 调用不阻塞主流程 |
| 状态缓存 | 每用户状态存内存或 Redis，定期落库 |

### 10.2 Token 消耗控制

| 场景 | 每 100 条用户消息的 LLM 调用次数 |
| --- | --- |
| 每条都调 | 100 次 |
| 本方案 | 8~12 次 |
| 总 Token | 约 1,500~3,000 |
## 十一、伪代码主流程

```js
// 用户发消息时调用
export async function onUserMessage(userId, message) {
  const local = analyzeMessage(message);
  const state = await getStressState(userId);
  const smoothed = smooth(state.chat_score, local.score);
  await updateStressState(userId, { chat_score: smoothed });

  await saveStressLog(userId, 'chat', local.score, smoothed, local.crisis);

  if (local.crisis) {
    await triggerCrisisIntervention(userId);
    return;
  }

  const decision = shouldCallLLM(state, local);
  let llmScore = null;

  if (decision.call) {
    const recent = await getRecentUserMessages(userId, 3);
    llmScore = await callLLMForStress(recent, 'chat');

    await updateStressState(userId, {
      msg_count_since_analyze: 0,
      last_analyze_at: new Date(),
      keyword_cooldown_until: decision.reason === 'keyword'
        ? new Date(Date.now() + KEYWORD_COOLDOWN_MS)
        : state.keyword_cooldown_until,
    });
  } else {
    await incrementMsgCount(userId);
  }

  const finalScore = llmScore
    ? Math.round(0.7 * smoothed + 0.3 * llmScore.score)
    : smoothed;

  const shouldPopup = await checkPopupTrigger(userId, finalScore, 'chat');
  if (shouldPopup) {
    await notifyFrontend(userId, {
      type: 'relax_popup',
      score: finalScore,
      message: '我注意到你最近好像有点累，要不要一起做一次 3 分钟的呼吸放松？',
    });
    await updateStressState(userId, { last_popup_at: new Date() });
  }

  return { score: finalScore, shouldPopup };
}
```
```js
// 用户保存日记时调用
export async function onDiarySave(userId, diaryText) {
  const local = analyzeDiary(diaryText);

  if (local.crisis) {
    await saveStressLog(userId, 'diary', 95, 95, true);
    await triggerCrisisIntervention(userId);
    return;
  }

  let llmScore = null;
  if (local.score >= 65 || local.emotionSentences.length > 0) {
    llmScore = await callLLMForStress(local.emotionSentences, 'diary');
  }

  const finalScore = llmScore
    ? Math.round(0.7 * local.score + 0.3 * llmScore.score)
    : local.score;

  await updateStressState(userId, {
    diary_score: finalScore,
    combined_score: combine(
      (await getStressState(userId)).chat_score,
      finalScore,
      0
    ),
  });

  await saveStressLog(userId, 'diary', local.score, finalScore, false);

  const shouldPopup = await checkPopupTrigger(userId, finalScore, 'diary');
  if (shouldPopup) {
    setTimeout(async () => {
      await notifyFrontend(userId, {
        type: 'relax_popup',
        source: 'diary',
        score: finalScore,
        message: '刚刚读完你写的这些，感觉你今天背着很沉的东西。要不要一起做一次 3 分钟的呼吸放松，把它先放一放？',
      });
      await updateStressState(userId, { last_popup_at: new Date() });
    }, 12000);
  }

  return { score: finalScore, shouldPopup };
}
```
## 十二、验收标准

- [ ] 本地词库完整，包含至少 100 个负面词、30 个正面词、10 个危机词。
- [ ] 每条用户消息都会触发本地预处理，耗时 < 20ms。
- [ ] 每 10 条消息或命中关键词时触发一次 LLM 分析。
- [ ] 关键词触发有 2 分钟冷却，不重复提交。
- [ ] 危机词无条件立即触发干预。
- [ ] 日记保存后自动分析，压力高时延迟 10–15 秒弹窗。
- [ ] 用户可关闭弹窗、可调节阈值。
- [ ] 弹窗拒绝后阈值 +5，冷却延长。
- [ ] 压力值仪表盘实时更新。
- [ ] 所有压力记录写入 `stress_logs` 表。
- [ ] LLM 调用失败时不阻塞主流程，降级为本地分数。
- [ ] Token 消耗控制在每 100 条消息 3000 tokens 以内。

## 十三、开发实施说明

建议按以下顺序推进：

1. **先建库表**：执行 `stress_logs`、`user_stress_state`、`relaxation_sessions` 三张表的建表语句。
2. **实现本地词库与打分**：完成 `lib/stress-lexicon.js` 与 `lib/stress-analyzer.js`，确保单条消息分析耗时低于 20ms。
3. **实现状态管理与融合**：完成 `lib/stress-state.js`，包含 EMA 平滑与双通道融合。
4. **实现触发与弹窗逻辑**：完成 `lib/stress-trigger.js`，确保冷却、阈值、连续确认等条件正确。
5. **接入 LLM**：完成 `lib/stress-llm.js`，使用 GLM-4-Flash，限制输入输出，异步调用。
6. **开发 API 接口**：按第八节实现四个接口。
7. **前端组件**：实现 `StressMeter.jsx` 与 `RelaxPopup.jsx`，接入压力值与弹窗事件。
8. **联调与验收**：按第十二节逐项核对。

### 关键注意事项

- 词库必须在服务启动时一次性加载到内存，禁止每次请求读数据库或文件。
- 匹配使用 `String.prototype.includes()`，禁止使用正则，避免性能损耗。
- LLM 调用必须异步，禁止阻塞用户消息的响应流程。
- 危机词处理优先级最高，跳过所有冷却与阈值判断。
- 用户拒绝弹窗后，阈值动态提高，避免频繁打扰。
- 所有压力记录必须落库，便于后续统计与优化。