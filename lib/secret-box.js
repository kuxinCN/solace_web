/**
 * 可逆加密（AES-256-GCM），用于「后台能查看用户密码」这一需求。
 *
 * ⚠️ 安全说明（重要，答辩时可能被问到）：
 *   * 这里用的是**可逆**加密，也就是说拿到密钥的人可以把密码还原成明文。
 *     它比明文存储好（数据库被翻出来时看不到裸密码），但**不等于安全**：
 *     密钥在服务器的 .env.local 里，能读到密钥的人就能解出所有密码。
 *   * 更安全的做法是只存 bcrypt 哈希（像后台管理员那样），代价是任何人都
 *     看不到明文、只能重置。本项目按需求选择了可逆方案。
 *   * 因为密钥参与加密：**不要随意更换 USER_PASSWORD_KEY / CODE_SECRET**，
 *     换了之后已经存进库的密码就再也解不开了。
 */
import crypto from "node:crypto";

function resolveKey() {
  const source =
    process.env.USER_PASSWORD_KEY ||
    process.env.CODE_SECRET ||
    "solace-default-password-key";
  // 统一派生 32 字节密钥，避免直接用短口令
  return crypto.createHash("sha256").update(`solace-pw|${source}`).digest();
}

/** 明文 -> "iv.tag.密文"（base64 三段）；空值返回空字符串 */
export function encryptText(plain) {
  const text = plain === null || plain === undefined ? "" : String(plain);
  if (text === "") return "";

  const key = resolveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64"),
  ].join(".");
}

/** 解密；数据损坏或密钥不匹配时返回空字符串（不抛异常） */
export function decryptText(payload) {
  if (!payload) return "";

  const parts = String(payload).split(".");
  if (parts.length !== 3) return "";

  try {
    const key = resolveKey();
    const iv = Buffer.from(parts[0], "base64");
    const tag = Buffer.from(parts[1], "base64");
    const data = Buffer.from(parts[2], "base64");

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

/** 当前是否用的默认密钥（没配 USER_PASSWORD_KEY / CODE_SECRET 时为 true） */
export function usingDefaultKey() {
  return !process.env.USER_PASSWORD_KEY && !process.env.CODE_SECRET;
}
