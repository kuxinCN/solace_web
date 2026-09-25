# Solace 压力评估系统 — 精简规格

> ⚠️ 本文是精简版。**落地修订见 [STRESS-DESIGN.md](./STRESS-DESIGN.md) 开头那一节**，
> 完整技术方案在同目录。

## 技术栈
Next.js 14 + MySQL + Node.js 20。

⚠️ **模型不由本文指定** —— 复用后台「对话 AI」里配好的接口地址 / Key / 模型（小米 MiMo）。
⛔ **不能走批量推理**：批量是异步的，要等几分钟，而压力评估要求实时。

## 架构（四层漏斗）
1. 本地预处理（每条消息，0 Token，<20ms）
2. 状态更新（EMA 平滑，α=0.35）
3. 触发判断：每 10 条 或 命中关键词（2 分钟冷却）或 危机词
4. LLM 精算（仅触发时，取最近 3 条用户消息，输出 `{"score":0-100,"confidence":0-1}`，max_tokens=30）

## 词库（lib/stress-lexicon.js）
- 负面词 Map：轻度 +3（累/烦/难受/不安/担心/紧张/疲惫/低落/迷茫/委屈）、中度 +6（焦虑/失眠/孤独/无助/生气/愤怒/害怕/恐惧/抑郁/痛苦/撑不住/窒息/自责/内疚/没意义）、重度 +12（崩溃/绝望/想哭/没意思/活不下去/心碎/生无可恋）
- 正面词 Map：-2~-5（开心/快乐/放松/平静/舒服/希望/感谢/温暖/安心/幸福/满足/轻松/治愈）
- 程度副词 Map（×1.5）：很/非常/特别/超级/太/极其/十分/极度/无比/死了/爆了/受不了
- 否定词：不/没/别/无/非/未（翻转情感）
- 负面表情 +2：😭😢😔😞😣😖😫😩😤😡🤬💔🥺
- 正面表情 -2：😊😄😌🥰😍
- **危机词 → 95 分 + 无条件干预**

### ⚠️ 危机词改用「带上下文的正则」
**原规格的 `includes()` 在中文里是错的**：
- `includes("消失")` → 「我的焦虑**消失**了」被判成危机（可那是好转！）
- `includes("死")` → 「笑死我了」「累死了」全部误报

实际实现（`CRISIS_PATTERNS`）要求**上下文同现**：
```
(想|要|准备|打算|决定|不如|干脆).{0,6}(死|自杀|自残|轻生|了结|结束生命)
(不想活|活不下去|活着没意思|死了算了|不如死了|死了更好)
(自杀|自残|割腕|跳楼|上吊|安眠药|烧炭|吞药)
(遗书|告别信|告别这个世界|不用找我了)
```

## 本地打分（lib/stress-analyzer.js）
```
analyzeMessage(text):
  截断 200 字
  1. 危机词 → 直接返回 {score:95, crisis:true}
  2. 遍历负面词：score += weight × 程度副词 × (否定?-1:1)
  3. 遍历正面词：score += weight × 程度副词 × (否定?-1:1)
  4. 感叹号×2、问号×1（全角半角都算）
  5. 负面表情×2、正面表情×-2
  6. 长度<5字且有关键词 +5；>200字 +3
  7. 凌晨 0-5 点 ×1.2         ← ⚠️ 显式按 +08 算，不用 getHours()
  8. clamp(0,100)，基准 50

analyzeDiary(text):
  1. 危机词 → 95 分
  2. 按句号/感叹号/换行分句
  3. 只保留含情绪词的句子
  4. 排序取最极端 5 句
     ← ⚠️ 修正为「只取 score > 50 的」：原写法用 |score-50| 排序，
        会把「今天特别开心」排到最前面，等于把减压证据当压力证据送给 LLM
  5. 对整篇打分 + 日记加分（>500字 +5，我>10次 +3，凌晨 +5）
```

## EMA 平滑（lib/stress-state.js）
```
smooth(prev, new) = 0.35*new + 0.65*prev
双通道融合：combined = 0.4*chat + 0.6*diary（日记按天数衰减 exp(-0.05*age)）
  ← ⚠️ age 必须传真实天数（用 diaries.diary_date 算），传 0 等于不衰减
```

## 触发条件（lib/stress-trigger.js）
```
每条消息后判断：
- 危机词 → 立即触发
- msgCount >= 10 → 触发LLM，计数器归零
- 命中关键词 且 now > keywordCooldownUntil → 触发LLM，计数器归零，设2分钟冷却
- 否则计数器+1
```
⚠️ 计数器**先在内存里累加**，只在触发 / 落库时写一次数据库 —— 聊天是最高频路径，不该每条都 UPDATE。

## 弹窗条件（必须全部满足）
- finalScore >= 阈值（默认 70，日记 65）
- 连续 2 次 >= 阈值
- 距上次弹窗 >= 15 分钟（日记 30 分钟）
- 最近 5 分钟没拒绝过
- 用户不在放松运动中
- 用户未关闭弹窗
- **危机词跳过以上所有限制**

## 用户拒绝后
阈值 +5（最高 90），记录拒绝次数

## 弹窗形态（追加要求）
- 位置：**右上角**
- 内容：**必须写明当前压力值和对应情绪**（例：「读到 78 分 · 压力很高」）
- 提供：**呼吸放松 / 蝴蝶拍**（后台可勾选开放哪些）
- ⚠️「放松小屋」里两种方式**常驻**，不受后台开关影响
- 必须能取消

## 压力档位（后台可配）
| 区间 | 默认情绪名 | 说明 |
|---|---|---|
| 0-40 | 很放松 | 读起来你现在挺稳的 |
| 41-65 | 有点累 | 能感觉到一些疲惫 |
| 66-85 | 压力偏高 | 这份沉有点压着你了 |
| 86-100 | 压力很高 | 你现在背的东西很重 |

⚠️ 分界值、情绪名、说明**都在后台改**（内容安全与压力 → 压力档位）。

## 数据库（3 张表）
- stress_logs：user_id, source(chat/diary), score, smoothed, local_score, llm_score, crisis, triggered, created_at
- user_stress_state：user_id, chat_score, diary_score, combined_score, msg_count_since_analyze, last_analyze_at, keyword_cooldown_until, last_popup_at, popup_reject_count, threshold, popup_enabled, diary_enabled
- relaxation_sessions：user_id, trigger_source, trigger_score, accepted, completed, score_before, score_after, created_at

## 文件结构
- lib/stress-lexicon.js
- lib/stress-analyzer.js
- lib/stress-state.js
- lib/stress-trigger.js
- lib/stress-llm.js
- app/api/stress/analyze/route.js
- app/api/stress/popup-response/route.js
- app/api/stress/state/route.js
- app/api/stress/settings/route.js
- components/StressMeter.jsx（压力仪表盘，0-40绿/41-65黄/66-85橙/86-100红）
- components/RelaxPopup.jsx（弹窗组件）

## 性能要求
- 词库启动时预加载到内存
- 用 `includes()` 不用正则（危机词除外）
- LLM 调用异步，不阻塞主流程，失败降级为本地分数
- 输入截断：聊天 200 字，日记 2000 字

## Token 目标
每 100 条消息 LLM 调用 ≤12 次，总 Token < 3000

## 弹窗文案
- 聊天：「现在的状态读到 **{压力值}** 分 · {情绪档位}。要不要一起做一次 3 分钟的呼吸放松？」
- 日记（延迟 12 秒）：「刚刚读完你写的这些，读到 **{压力值}** 分 · {情绪档位}。要不要一起做一次 3 分钟的呼吸放松，把它先放一放？」
- 危机：直接展示干预页 + 心理援助热线 400-161-9995
