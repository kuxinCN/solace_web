/**
 * 日志脱敏：写进日志之前，把可能暴露隐私的内容盖掉。
 *
 * 为什么需要它：日志会被长期保存，也经常被复制粘贴到聊天里求助。
 * 明文邮箱、手机号、API Key 一旦进去就很难收回。这里做「够用」的替换 ——
 * 目标是日志依然可读（能定位问题在哪个用户身上），但看不出具体是谁。
 *
 * ⚠️ 只用于日志，不要拿它处理要存库或要返回给用户的数据。
 */

/** abc@qq.com → ab***@qq.com */
export function maskEmail(text) {
  return String(text ?? "").replace(
    /([A-Za-z0-9._%+-]{1,64})@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    (_, name, domain) => {
      if (name.length <= 2) return `${name.slice(0, 1)}***@${domain}`;
      return `${name.slice(0, 2)}***@${domain}`;
    }
  );
}

/** 13812345678 → 138****5678 */
export function maskPhone(text) {
  return String(text ?? "").replace(/\b(1[3-9]\d)\d{4}(\d{4})\b/g, "$1****$2");
}

/** sk-abcdef... / 各种长 token → 只留前 6 位 */
export function maskToken(text) {
  return String(text ?? "").replace(
    /\b(sk-|tp-|Bearer\s+)?([A-Za-z0-9_-]{20,})\b/g,
    (match, prefix = "") => {
      const body = match.slice(prefix.length);
      // 全是数字的长串一般是时间戳/ID，不做处理，避免把有用的信息也盖掉
      if (/^\d+$/.test(body)) return match;
      return `${prefix}${body.slice(0, 6)}***`;
    }
  );
}

/**
 * 组合脱敏：字符串直接处理；对象/数组先 JSON 序列化再处理。
 * 任何异常都退回原文 —— 脱敏失败不该让日志本身丢掉。
 */
export function sanitizeLog(input) {
  try {
    let text;
    if (typeof input === "string") {
      text = input;
    } else if (input instanceof Error) {
      text = `${input.name}: ${input.message}`;
    } else {
      try {
        text = JSON.stringify(input);
      } catch {
        text = String(input);
      }
    }
    return maskToken(maskPhone(maskEmail(text)));
  } catch {
    return String(input);
  }
}
