/**
 * 模型自主决策记忆的标记工具。
 *
 * 协议：
 *   AI 在回复末尾单独一行输出 `[MEMORY:一句话]`（内容 ≤200 字），
 *   表示"这句值得长期记住"。聊天接口在流式收尾时：
 *     ① `extractMemoryMarkers` 摘出标记；
 *     ② `stripMemoryMarkers` 从展示/入库文本里剥离（气泡不残留）；
 *     ③ fire-and-forget 把摘出的内容写进 user_memories。
 *
 * ⚠️ 容错：AI 可能忘加、多加、写错格式 —— 提取只认严格格式，
 *    剥离正则覆盖"独立一行 / 行内 / 带前后空白"三种形态。
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
