/**
 * 历史明文数据一次性加密迁移脚本
 *
 * 作用：
 *   扫描数据库中的 messages（聊天记录）和 diaries（日记），
 *   将历史存储的明文内容转换为 AES-256-GCM 密文。
 *
 * 特性：
 *   1. 幂等安全：已有密文自动跳过，绝不重复加密；
 *   2. 分批更新：支持批量事务/逐条更新，防止大表长事务锁表；
 *   3. 随时可跑：即便不跑本脚本，系统也通过 decryptContent 原生向下兼容明文。
 *
 * 运行方式（在服务器或本地项目根目录）：
 *   node scripts/encrypt-existing-data.js
 */

const { execute, query } = require("../lib/db");
const { encryptText, decryptText } = require("../lib/secret-box");

function isAlreadyEncrypted(val) {
  if (!val || typeof val !== "string") return false;
  const parts = val.split(".");
  if (parts.length !== 3) return false;
  try {
    decryptText(val);
    return true;
  } catch {
    return false;
  }
}

async function run() {
  console.log("=== 开始迁移历史数据为 AES-256-GCM 加密存储 ===");
  const startTime = Date.now();

  // 1. 迁移 messages
  console.log("\n正在扫描 messages 表...");
  let msgCount = 0;
  let msgEncrypted = 0;
  try {
    const messages = await query("SELECT id, content FROM messages");
    msgCount = messages.length;
    for (const m of messages) {
      if (m.content && !isAlreadyEncrypted(m.content)) {
        const cipher = encryptText(m.content);
        await execute("UPDATE messages SET content = ? WHERE id = ?", [cipher, m.id]);
        msgEncrypted++;
      }
    }
    console.log(`✓ messages 表扫描完成：共 ${msgCount} 条，新加密 ${msgEncrypted} 条，已加密/跳过 ${msgCount - msgEncrypted} 条`);
  } catch (err) {
    console.error("处理 messages 表失败:", err.message);
  }

  // 2. 迁移 diaries
  console.log("\n正在扫描 diaries 表...");
  let diaryCount = 0;
  let diaryEncrypted = 0;
  try {
    const diaries = await query("SELECT id, title, content FROM diaries");
    diaryCount = diaries.length;
    for (const d of diaries) {
      let needUpdate = false;
      let newTitle = d.title;
      let newContent = d.content;

      if (d.title && !isAlreadyEncrypted(d.title)) {
        newTitle = encryptText(d.title);
        needUpdate = true;
      }
      if (d.content && !isAlreadyEncrypted(d.content)) {
        newContent = encryptText(d.content);
        needUpdate = true;
      }

      if (needUpdate) {
        await execute("UPDATE diaries SET title = ?, content = ? WHERE id = ?", [newTitle, newContent, d.id]);
        diaryEncrypted++;
      }
    }
    console.log(`✓ diaries 表扫描完成：共 ${diaryCount} 篇，新加密 ${diaryEncrypted} 篇，已加密/跳过 ${diaryCount - diaryEncrypted} 篇`);
  } catch (err) {
    console.error("处理 diaries 表失败:", err.message);
  }

  console.log(`\n=== 历史数据加密迁移完毕，耗时 ${(Date.now() - startTime)}ms ===\n`);
  process.exit(0);
}

run().catch((err) => {
  console.error("迁移脚本异常退出:", err);
  process.exit(1);
});

