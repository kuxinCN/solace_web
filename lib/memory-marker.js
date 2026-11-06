/**
 * 模型自主决策记忆的标记提取与展示文本剥离工具。
 *
 * 协议：
 *   大语言模型具备真正的上下文语义理解能力，当判断出值得长期记住的事实时，
 *   在回复末尾单独一行输出 `[MEMORY:一句话]`（内容 ≤200 字）。
 *   聊天接口在流式收尾时：
 *     ① `extractMemoryMarkers` 摘出标记；
 *     ② `stripMemoryMarkers` 从展示/入库文本里剥离（气泡不残留）；
 *     ③ fire-and-forget 把摘出的内容写进 user_memories。
 *
 * ⚠️ 坚决不做本地硬编码正则判断：
 *   中文博大精深（如“我叫你鲸鲸好不好”、“我叫什么名字呀”），硬编码正则
 *   无法识别疑问/反问/主被动，极易生成严重的脏数据。记忆提炼全面依托
 *   大语言模型（聊天实时标记 + 异步多轮对话提炼）。
 */
const MARKER_RE = /\[MEMORY:([^\]]{1,200})\]/g;
const STRIP_RE = /\n\s*\[MEMORY:[^\]]{0,200}\]\s*/g;

/** 摘出所有 [MEMORY:xxx] 的内容（取 trim 后的值；格式不符的自动忽略） */
export function extractMemoryMarkers(text) {
  const markers = [];
  const source = String(text || "");
  let match;
  MARKER_RE.lastIndex = 0;
  while ((match = MARKER_RE.exec(source)) !== null) {
    const value = match[1].trim();
    if (value) markers.push(value);
  }
  return markers;
}

/** 从文本中剥掉记忆标记（连带标记所在行），返回干净的展示文本 */
export function stripMemoryMarkers(text) {
  return String(text || "").replace(STRIP_RE, "\n").replace(MARKER_RE, "").trim();
}

