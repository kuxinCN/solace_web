-- ============================================================================
-- Solace 管理后台数据库结构（MySQL 5.7 / 8.0 均可）
-- ----------------------------------------------------------------------------
-- 使用步骤（宝塔面板）：
--   1. 宝塔面板 → 数据库 → 添加数据库
--        数据库名：solace      编码：utf8mb4
--        记下宝塔生成的 用户名 / 密码（通常和数据库同名）
--   2. 宝塔面板 → 数据库 → 该库右侧「导入」→ 选择本文件 db/schema.sql
--      或者命令行：mysql -u solace -p solace < db/schema.sql
--   3. 把连接信息填到项目根目录 .env.local（见 .env.example），
--      之后也可以在后台「数据库」页面里直接修改。
--
-- 说明：
--   * 包含「管理后台」与「用户端」两部分，共 10 张表。
--     后台：admin_users / admin_sessions / settings / audit_logs / email_codes
--     用户端：users / user_sessions / conversations / messages / diaries
--   * 语法按 MySQL 5.7.44 编写：没有使用 8.0 独有的 CTE / 窗口函数 / JSON 函数。
--   * 索引长度按 utf8mb4 计算，要求 InnoDB 行格式为 DYNAMIC（MySQL 5.7 的默认值）。
--     如果你的实例把 innodb_default_row_format 改成了 COMPACT/REDUNDANT，
--     email_codes 的复合索引可能报错 1071，此时把行格式改回 DYNAMIC，
--     或者把 idx_code_email_purpose 改成只索引 (email)。
--   * 表中时间字段由应用按「服务器本地时间」写入，避免 Node 与 MySQL 时区
--     不一致时出现会话莫名失效、验证码冷却时间错乱等问题。
-- ============================================================================

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------
-- 1. 管理员账号：账号密码（bcrypt 哈希） + TOTP 动态验证码
--    TOTP 即微软 / Google 验证器那种 30 秒刷新一次的 6 位数字
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `admin_users` (
  `id`              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username`        VARCHAR(64)  NOT NULL COMMENT '登录账号',
  `password_hash`   VARCHAR(100) NOT NULL COMMENT 'bcrypt 哈希，永不存明文',
  `totp_secret`     VARCHAR(64)  NOT NULL COMMENT 'TOTP 密钥（base32）',
  `failed_attempts` SMALLINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '连续登录失败次数',
  `locked_until`    DATETIME     NULL COMMENT '锁定到期时间，NULL 表示未锁定',
  `last_login_at`   DATETIME     NULL,
  `created_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_admin_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='后台管理员';

-- ---------------------------------------------------------------------------
-- 2. 后台登录会话：浏览器只存随机 token，数据库存它的 sha256
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `admin_sessions` (
  `token_hash`   CHAR(64)     NOT NULL COMMENT '登录 token 的 sha256（十六进制）',
  `admin_id`     INT UNSIGNED NOT NULL,
  `ip`           VARCHAR(45)  NULL COMMENT '登录来源 IP（兼容 IPv6）',
  `user_agent`   VARCHAR(255) NULL,
  `created_at`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at`   DATETIME     NOT NULL,
  PRIMARY KEY (`token_hash`),
  KEY `idx_session_admin` (`admin_id`),
  KEY `idx_session_expires` (`expires_at`),
  CONSTRAINT `fk_session_admin` FOREIGN KEY (`admin_id`)
    REFERENCES `admin_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='后台登录会话';

-- ---------------------------------------------------------------------------
-- 3. 系统配置：后台里能改的东西都存这里，value 是 JSON 字符串
--    分组（name）：
--      ai     对话 AI 接口（服务商 / baseUrl / apiKey / 模型 / 参数）
--      tts    文字转语音接口
--      smtp   发信邮箱（网易 163/126 SMTP，用于发送邮箱验证码）
--      login  邮箱验证码规则（长度 / 有效期 / 频率限制 / 邮件模板）
--      site   站点信息
--    注意：数据库连接信息不在这里，见 config/db.json（否则会先有鸡还是先有蛋）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `settings` (
  `name`       VARCHAR(64) NOT NULL COMMENT '配置分组名',
  `value`      MEDIUMTEXT  NOT NULL COMMENT 'JSON 字符串',
  `updated_at` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='系统配置';

-- ---------------------------------------------------------------------------
-- 4. 操作日志：后台每一步敏感操作都留痕，答辩时也是加分项
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `admin_id`   INT UNSIGNED NULL,
  `username`   VARCHAR(64)  NULL COMMENT '冗余保存，管理员被删后日志仍可读',
  `action`     VARCHAR(48)  NOT NULL COMMENT '如 login / save_settings / save_database',
  `detail`     TEXT         NULL,
  `ip`         VARCHAR(45)  NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_log_created` (`created_at`),
  KEY `idx_log_action` (`action`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='后台操作日志';

-- ---------------------------------------------------------------------------
-- 5. 邮箱验证码（本轮先把表和发送能力做好，用于后台「发送测试邮件」；
--    下一轮用户端用邮箱验证码登录时直接复用，不需要再改表）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `email_codes` (
  `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `email`      VARCHAR(190) NOT NULL,
  `code_hash`  CHAR(64)     NOT NULL COMMENT '验证码的 sha256，不存明文',
  `purpose`    VARCHAR(32)  NOT NULL DEFAULT 'login' COMMENT 'login / register / reset',
  `attempts`   TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '已尝试校验次数',
  `used`       TINYINT(1)   NOT NULL DEFAULT 0,
  `expires_at` DATETIME     NOT NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_code_email_purpose` (`email`, `purpose`),
  KEY `idx_code_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='邮箱验证码';

-- ============================================================================
-- 6. 用户端账号：由「邮箱验证码登录」自动创建（首次验证通过即注册）
-- ============================================================================
CREATE TABLE IF NOT EXISTS `users` (
  `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `email`         VARCHAR(190) NOT NULL COMMENT '登录邮箱',
  `account`       VARCHAR(64)  NULL COMMENT '登录账号（后台添加的用户用）',
  `password_enc`  VARCHAR(255) NULL COMMENT '可逆加密(AES)后的密码，后台可解密查看',
  `username`      VARCHAR(64)  NULL COMMENT '显示名称',
  `avatar_url`    VARCHAR(255) NULL,
  `gender`        VARCHAR(16)  NULL COMMENT '性别',
  `birthday`      VARCHAR(10)  NULL COMMENT '出生年月，YYYY-MM 或 YYYY-MM-DD',
  `phone`         VARCHAR(32)  NULL COMMENT '手机号',
  `remark`        VARCHAR(255) NULL COMMENT '备注',
  `status`        TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '1 正常 0 禁用',
  `source`        VARCHAR(16)  NOT NULL DEFAULT 'email' COMMENT 'email 自助注册 / admin 后台添加',
  `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_login_at` DATETIME     NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_email` (`email`),
  UNIQUE KEY `uk_users_account` (`account`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户账号';

-- 老部署升级：如果 users 表是老版本建的，用下面这些语句补列（新装可忽略）
--   ALTER TABLE `users` ADD COLUMN `account` VARCHAR(64) NULL AFTER `email`;
--   ALTER TABLE `users` ADD COLUMN `password_enc` VARCHAR(255) NULL AFTER `account`;
--   ALTER TABLE `users` ADD COLUMN `gender` VARCHAR(16) NULL AFTER `avatar_url`;
--   ALTER TABLE `users` ADD COLUMN `birthday` VARCHAR(10) NULL AFTER `gender`;
--   ALTER TABLE `users` ADD COLUMN `phone` VARCHAR(32) NULL AFTER `birthday`;
--   ALTER TABLE `users` ADD COLUMN `remark` VARCHAR(255) NULL AFTER `phone`;
--   ALTER TABLE `users` ADD COLUMN `status` TINYINT(1) NOT NULL DEFAULT 1 AFTER `remark`;
--   ALTER TABLE `users` ADD COLUMN `source` VARCHAR(16) NOT NULL DEFAULT 'email' AFTER `status`;
--   ALTER TABLE `users` ADD UNIQUE KEY `uk_users_account` (`account`);
-- （安装向导 / 后台会自动检查并补列，一般不需要手动执行）

-- ---------------------------------------------------------------------------
-- 7. 用户端登录会话（浏览器只存随机 token，库里存 sha256）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_sessions` (
  `token_hash` CHAR(64)     NOT NULL,
  `user_id`    INT UNSIGNED NOT NULL,
  `ip`         VARCHAR(45)  NULL,
  `user_agent` VARCHAR(255) NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` DATETIME     NOT NULL,
  PRIMARY KEY (`token_hash`),
  KEY `idx_user_session_user` (`user_id`),
  KEY `idx_user_session_expires` (`expires_at`),
  CONSTRAINT `fk_user_session_user` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户登录会话';

-- ---------------------------------------------------------------------------
-- 8. 会话 / 消息 / 日记（外键都指向 users，删用户会级联删除其数据）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `conversations` (
  `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`    INT UNSIGNED NOT NULL,
  `title`      VARCHAR(120) NOT NULL DEFAULT '新对话',
  `pinned`     TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 表示已置顶',
  `pinned_at`  DATETIME     NULL COMMENT '置顶时间',
  `last_message_at` DATETIME NULL COMMENT '最后一条消息时间（列表排序用）',
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_conv_user` (`user_id`, `created_at`),
  CONSTRAINT `fk_conv_user` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='聊天会话';

CREATE TABLE IF NOT EXISTS `messages` (
  `id`              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `conversation_id` INT UNSIGNED NOT NULL,
  `user_id`         INT UNSIGNED NOT NULL,
  `role`            ENUM('user','assistant') NOT NULL,
  `content`         MEDIUMTEXT NOT NULL,
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_msg_conv` (`conversation_id`, `created_at`),
  KEY `idx_msg_user` (`user_id`),
  CONSTRAINT `fk_msg_conv` FOREIGN KEY (`conversation_id`)
    REFERENCES `conversations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_msg_user` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='聊天消息';

CREATE TABLE IF NOT EXISTS `diaries` (
  `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`    INT UNSIGNED NOT NULL,
  `title`      VARCHAR(120) NOT NULL DEFAULT '无题',
  `content`    MEDIUMTEXT NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_diary_user` (`user_id`, `created_at`),
  CONSTRAINT `fk_diary_user` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户日记';
-- ============================================================================
