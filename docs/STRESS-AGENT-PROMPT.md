请为 Solace 心理辅导网站实现「心理压力评估与放松干预系统」。项目技术栈：Next.js 14 App Router + MySQL + Node.js 20。

严格按照以下规格实现：

## 1. 文件结构
- lib/stress-lexicon.js — 词库（负面词、正面词、程度副词、否定词、表情、危机词）
- lib/stress-analyzer.js — 本地预处理与打分（analyzeMessage、analyzeDiary）
- lib/stress-state.js — 状态管理、EMA平滑、双通道融合
- lib/stress-trigger.js — 触发判断与弹窗逻辑
- lib/stress-llm.js — LLM 调用（极简 Prompt）
- app/api/stress/analyze/route.js — 分析接口
- app/api/stress/popup-response/route.js — 弹窗响应接口
- app/api/stress/state/route.js — 状态查询
- app/api/stress/settings/route.js — 用户设置
- components/StressMeter.jsx — 压力值仪表盘
- components/RelaxPopup.jsx — 放松弹窗组件

## 2. 数据库
创建 stress_logs、user_stress_state、relaxation_sessions 三张表，字段见规格文档。

## 3. 核心逻辑
- 每条用户消息触发本地预处理（0 Token，<20ms）
- 每 10 条消息或命中关键词时触发 LLM 深度识别
- 关键词触发有 2 分钟冷却
- 危机词（想死、自杀、自残等）无条件立即触发干预
- 日记保存后自动分析，延迟 10-15 秒弹窗
- 压力值 EMA 平滑（α=0.35）
- 双通道融合：聊天 0.4 + 日记 0.6（日记有时间衰减）
- 用户拒绝弹窗后阈值 +5，冷却延长
- 弹窗条件：阈值 + 连续2次 + 冷却 + 未拒绝 + 不在放松中

## 4. LLM 调用
- 模型：GLM-4-Flash
- 输入：最近 3 条用户消息，每条截断 50 字
- 输出：{"score":0-100,"confidence":0-1}
- max_tokens=30, temperature=0
- 异步调用，不阻塞主流程
- 失败降级为本地分数

## 5. 前端
- 聊天界面显示压力值仪表盘（0-100，颜色分级）
- 压力超阈值时弹出 RelaxPopup 组件
- 用户可关闭弹窗、调节阈值

## 6. 性能要求
- 本地预处理单次 <20ms
- 词库预加载到内存
- 使用 includes() 而非正则
- 输入截断（聊天200字，日记2000字）

## 7. Token 控制
每 100 条消息的 LLM 调用不超过 12 次，总 Token < 3000。

请严格按以上规格生成完整可运行代码，不要省略任何细节。所有函数需有 JSDoc 注释。输出时按文件路径分块。