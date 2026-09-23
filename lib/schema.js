/**
 * 建表语句集中在这里，安装向导（/install）会用它们自动建好所有表，
 * 所以用户不必手动导入 db/schema.sql。
 *
 * ⚠️ 这里和 db/schema.sql 必须保持一致：改了表结构要同时改两处。
 * 语法兼容 MySQL 5.7 与 8.0。
 */
import { execute, query } from "./db";

export const TABLE_NAMES = [
  "admin_users",
  "admin_sessions",
  "settings",
  "audit_logs",
  "email_codes",
  "users",
  "user_sessions",
  "conversations",
  "messages",
  "diaries",
];

// 注意顺序：admin_sessions 有外键指向 admin_users，必须先建 admin_users
export const TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS \`admin_users\` (
    \`id\`              INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`username\`        VARCHAR(64)  NOT NULL COMMENT '登录账号',
    \`password_hash\`   VARCHAR(100) NOT NULL COMMENT 'bcrypt 哈希，永不存明文',
    \`totp_secret\`     VARCHAR(64)  NOT NULL COMMENT 'TOTP 密钥（base32）',
    \`failed_attempts\` SMALLINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '连续登录失败次数',
    \`locked_until\`    DATETIME     NULL COMMENT '锁定到期时间，NULL 表示未锁定',
    \`last_login_at\`   DATETIME     NULL,
    \`created_at\`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uk_admin_username\` (\`username\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='后台管理员'`,

  `CREATE TABLE IF NOT EXISTS \`admin_sessions\` (
    \`token_hash\`   CHAR(64)     NOT NULL COMMENT '登录 token 的 sha256（十六进制）',
    \`admin_id\`     INT UNSIGNED NOT NULL,
    \`ip\`           VARCHAR(45)  NULL COMMENT '登录来源 IP（兼容 IPv6）',
    \`user_agent\`   VARCHAR(255) NULL,
    \`created_at\`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`expires_at\`   DATETIME     NOT NULL,
    PRIMARY KEY (\`token_hash\`),
    KEY \`idx_session_admin\` (\`admin_id\`),
    KEY \`idx_session_expires\` (\`expires_at\`),
    CONSTRAINT \`fk_session_admin\` FOREIGN KEY (\`admin_id\`)
      REFERENCES \`admin_users\` (\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='后台登录会话'`,

  `CREATE TABLE IF NOT EXISTS \`settings\` (
    \`name\`       VARCHAR(64) NOT NULL COMMENT '配置分组名',
    \`value\`      MEDIUMTEXT  NOT NULL COMMENT 'JSON 字符串',
    \`updated_at\` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`name\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='系统配置'`,

  `CREATE TABLE IF NOT EXISTS \`audit_logs\` (
    \`id\`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`admin_id\`   INT UNSIGNED NULL,
    \`username\`   VARCHAR(64)  NULL COMMENT '冗余保存，管理员被删后日志仍可读',
    \`action\`     VARCHAR(48)  NOT NULL COMMENT '如 login / save_settings / save_database',
    \`detail\`     TEXT         NULL,
    \`ip\`         VARCHAR(45)  NULL,
    \`created_at\` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`idx_log_created\` (\`created_at\`),
    KEY \`idx_log_action\` (\`action\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='后台操作日志'`,

  `CREATE TABLE IF NOT EXISTS \`email_codes\` (
    \`id\`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`email\`      VARCHAR(190) NOT NULL,
    \`code_hash\`  CHAR(64)     NOT NULL COMMENT '验证码的 sha256，不存明文',
    \`purpose\`    VARCHAR(32)  NOT NULL DEFAULT 'login' COMMENT 'login / register / reset',
    \`attempts\`   TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '已尝试校验次数',
    \`used\`       TINYINT(1)   NOT NULL DEFAULT 0,
    \`expires_at\` DATETIME     NOT NULL,
    \`created_at\` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`idx_code_email_purpose\` (\`email\`, \`purpose\`),
    KEY \`idx_code_expires\` (\`expires_at\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='邮箱验证码'`,

  // ---------------- 用户端（聊天 / 日记）----------------

  `CREATE TABLE IF NOT EXISTS \`users\` (
    \`id\`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`email\`         VARCHAR(190) NOT NULL COMMENT '登录邮箱',
    \`account\`       VARCHAR(64)  NULL COMMENT '登录账号（后台添加的用户用）',
    \`password_enc\`  VARCHAR(255) NULL COMMENT '可逆加密(AES)后的密码，后台可解密查看',
    \`username\`      VARCHAR(64)  NULL COMMENT '显示名称',
    \`avatar_url\`    MEDIUMTEXT   NULL COMMENT '头像（base64 data URL）',
    \`ai_avatar_url\` MEDIUMTEXT   NULL COMMENT 'AI 头像（base64 data URL）',
    \`chat_background_url\` MEDIUMTEXT NULL COMMENT '聊天背景（base64 data URL）',
    \`gender\`        VARCHAR(16)  NULL COMMENT '性别',
    \`birthday\`      VARCHAR(10)  NULL COMMENT '出生年月，YYYY-MM 或 YYYY-MM-DD',
    \`phone\`         VARCHAR(32)  NULL COMMENT '手机号',
    \`remark\`        VARCHAR(255) NULL COMMENT '备注',
    \`bio\`           VARCHAR(100) NULL COMMENT '个性签名',
    \`status\`        TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '1 正常 0 禁用',
    \`source\`        VARCHAR(16)  NOT NULL DEFAULT 'email' COMMENT 'email 自助注册 / admin 后台添加',
    \`created_at\`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`last_login_at\` DATETIME     NULL,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uk_users_email\` (\`email\`),
    UNIQUE KEY \`uk_users_account\` (\`account\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户账号'`,

  `CREATE TABLE IF NOT EXISTS \`user_sessions\` (
    \`token_hash\` CHAR(64)     NOT NULL,
    \`user_id\`    INT UNSIGNED NOT NULL,
    \`ip\`         VARCHAR(45)  NULL,
    \`user_agent\` VARCHAR(255) NULL,
    \`created_at\` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`expires_at\` DATETIME     NOT NULL,
    PRIMARY KEY (\`token_hash\`),
    KEY \`idx_user_session_user\` (\`user_id\`),
    KEY \`idx_user_session_expires\` (\`expires_at\`),
    CONSTRAINT \`fk_user_session_user\` FOREIGN KEY (\`user_id\`)
      REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户登录会话'`,

  `CREATE TABLE IF NOT EXISTS \`conversations\` (
    \`id\`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`user_id\`    INT UNSIGNED NOT NULL,
    \`title\`      VARCHAR(120) NOT NULL DEFAULT '新对话',
    \`pinned\`     TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 表示已置顶',
    \`pinned_at\`  DATETIME     NULL COMMENT '置顶时间',
    \`last_message_at\` DATETIME NULL COMMENT '最后一条消息时间（列表排序用）',
    \`created_at\` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`idx_conv_user\` (\`user_id\`, \`created_at\`),
    CONSTRAINT \`fk_conv_user\` FOREIGN KEY (\`user_id\`)
      REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='聊天会话'`,

  `CREATE TABLE IF NOT EXISTS \`messages\` (
    \`id\`              INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`conversation_id\` INT UNSIGNED NOT NULL,
    \`user_id\`         INT UNSIGNED NOT NULL,
    \`role\`            ENUM('user','assistant') NOT NULL,
    \`content\`         MEDIUMTEXT NOT NULL,
    \`created_at\`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`idx_msg_conv\` (\`conversation_id\`, \`created_at\`),
    KEY \`idx_msg_user\` (\`user_id\`),
    CONSTRAINT \`fk_msg_conv\` FOREIGN KEY (\`conversation_id\`)
      REFERENCES \`conversations\` (\`id\`) ON DELETE CASCADE,
    CONSTRAINT \`fk_msg_user\` FOREIGN KEY (\`user_id\`)
      REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='聊天消息'`,

  `CREATE TABLE IF NOT EXISTS \`diaries\` (
    \`id\`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`user_id\`    INT UNSIGNED NOT NULL,
    \`title\`      VARCHAR(120) NOT NULL DEFAULT '无题',
    \`content\`    MEDIUMTEXT NOT NULL,
    \`mood\`       VARCHAR(16)  NULL COMMENT '情绪标签（AI 打标，温和描述，不做评分）',
    \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`idx_diary_user\` (\`user_id\`, \`created_at\`),
    CONSTRAINT \`fk_diary_user\` FOREIGN KEY (\`user_id\`)
      REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户日记'`,
];

/** 逐条执行 CREATE TABLE IF NOT EXISTS，并返回实际存在的表 */
export async function ensureTables() {
  for (const statement of TABLE_STATEMENTS) {
    await execute(statement);
  }

  const rows = await query(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()"
  );
  const existing = rows.map((row) => String(row.name));
  const missing = TABLE_NAMES.filter((name) => !existing.includes(name));

  return { tables: existing, missing };
}

/**
 * users 表后来新增的列（老部署升级用）。
 * MySQL 5.7/8.0 都不支持 ADD COLUMN IF NOT EXISTS，所以先查 information_schema 再补。
 */
export const USER_EXTRA_COLUMNS = [
  { name: "account", ddl: "ADD COLUMN `account` VARCHAR(64) NULL COMMENT '登录账号' AFTER `email`" },
  { name: "password_enc", ddl: "ADD COLUMN `password_enc` VARCHAR(255) NULL COMMENT '可逆加密的密码' AFTER `account`" },
  { name: "gender", ddl: "ADD COLUMN `gender` VARCHAR(16) NULL COMMENT '性别' AFTER `avatar_url`" },
  { name: "birthday", ddl: "ADD COLUMN `birthday` VARCHAR(10) NULL COMMENT '出生年月' AFTER `gender`" },
  { name: "phone", ddl: "ADD COLUMN `phone` VARCHAR(32) NULL COMMENT '手机号' AFTER `birthday`" },
  { name: "remark", ddl: "ADD COLUMN `remark` VARCHAR(255) NULL COMMENT '备注' AFTER `phone`" },
  { name: "status", ddl: "ADD COLUMN `status` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1 正常 0 禁用' AFTER `remark`" },
  { name: "source", ddl: "ADD COLUMN `source` VARCHAR(16) NOT NULL DEFAULT 'email' COMMENT '来源' AFTER `status`" },
  { name: "bio", ddl: "ADD COLUMN `bio` VARCHAR(100) NULL COMMENT '个性签名' AFTER `source`" },
  { name: "ai_avatar_url", ddl: "ADD COLUMN `ai_avatar_url` MEDIUMTEXT NULL COMMENT 'AI 头像' AFTER `avatar_url`" },
  { name: "chat_background_url", ddl: "ADD COLUMN `chat_background_url` MEDIUMTEXT NULL COMMENT '聊天背景' AFTER `ai_avatar_url`" },
];

/** conversations 表后来新增的列 */
export const CONVERSATION_EXTRA_COLUMNS = [
  { name: "pinned", ddl: "ADD COLUMN `pinned` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 表示已置顶' AFTER `title`" },
  { name: "pinned_at", ddl: "ADD COLUMN `pinned_at` DATETIME NULL COMMENT '置顶时间' AFTER `pinned`" },
  { name: "last_message_at", ddl: "ADD COLUMN `last_message_at` DATETIME NULL COMMENT '最后一条消息时间（列表排序与日期显示用）' AFTER `pinned_at`" },
];

async function addMissingColumns(table, columns) {
  const tableRows = await query(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    [table]
  );
  if (!tableRows.length) return { added: [], skipped: true };

  const columnRows = await query(
    "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    [table]
  );
  const existing = columnRows.map((row) => String(row.name));
  const added = [];

  for (const column of columns) {
    if (existing.includes(column.name)) continue;
    try {
      await execute(`ALTER TABLE \`${table}\` ${column.ddl}`);
      added.push(column.name);
    } catch (err) {
      // 并发补列时会撞 ER_DUP_FIELDNAME，忽略即可；其它错误照常抛出
      if (err?.code !== "ER_DUP_FIELDNAME") throw err;
    }
  }

  return { added, skipped: false };
}

/** users 的头像字段原来是 VARCHAR(255)，头像改成 base64 存库后必须扩容 */
async function ensureAvatarColumnType() {
  const rows = await query(
    "SELECT DATA_TYPE AS type FROM information_schema.COLUMNS " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'avatar_url'"
  );
  if (!rows.length) return false;
  if (String(rows[0].type).toLowerCase() === "mediumtext") return false;

  await execute(
    "ALTER TABLE `users` MODIFY COLUMN `avatar_url` MEDIUMTEXT NULL COMMENT '头像（base64 data URL）'"
  );
  return true;
}

/** 给已存在的 users 表补上新列与新索引；表不存在时直接跳过 */
export async function ensureUserColumns() {
  const result = await addMissingColumns("users", USER_EXTRA_COLUMNS);
  if (result.skipped) return result;

  if (await ensureAvatarColumnType()) result.added.push("avatar_url:mediumtext");

  const indexRows = await query(
    "SELECT INDEX_NAME AS name FROM information_schema.STATISTICS " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' " +
      "AND INDEX_NAME = 'uk_users_account'"
  );
  if (!indexRows.length) {
    try {
      await execute("ALTER TABLE `users` ADD UNIQUE KEY `uk_users_account` (`account`)");
      result.added.push("uk_users_account");
    } catch {
      /* 已有重复账号数据时忽略，不影响主流程 */
    }
  }

  return result;
}

/** 给已存在的 conversations 表补上置顶相关列 */
export async function ensureConversationColumns() {
  return addMissingColumns("conversations", CONVERSATION_EXTRA_COLUMNS);
}

/**
 * diaries 表后加的列：情绪标签。
 * 设计上只做「温和描述」（如"有点沉""平静"），不做数值评分、不做好坏判断 ——
 * 这个产品的定位是陪伴，不是给用户的情绪打分。
 */
const DIARY_EXTRA_COLUMNS = [
  { name: "mood", definition: "VARCHAR(16) NULL COMMENT '情绪标签（AI 打标）'" },
];

/** 给已存在的 diaries 表补上情绪标签列 */
export async function ensureDiaryColumns() {
  return addMissingColumns("diaries", DIARY_EXTRA_COLUMNS);
}

let userColumnsChecked = false;

/**
 * 进程内只跑一次。
 * 用于「已经装过、后来升级了代码」的站点：第一次访问时自动把新增的列补上，
 * 否则老表缺列会让用户端直接报 ER_BAD_FIELD_ERROR。
 */
export async function ensureUserColumnsOnce() {
  if (userColumnsChecked) return { added: [], skipped: true };

  const userResult = await ensureUserColumns();
  const conversationResult = await ensureConversationColumns();
  const diaryResult = await ensureDiaryColumns();

  userColumnsChecked = true;
  return {
    added: [...userResult.added, ...conversationResult.added, ...diaryResult.added],
    skipped: false,
  };
}
