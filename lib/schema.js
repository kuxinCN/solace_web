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
  "assessment_results",
  "user_memories",
  "trash",
  "ai_usage",
  "ai_usage_daily",
  "safety_flags",
  "music_tracks",
  "content_review_tasks",
  "content_review_batches",
  "stress_logs",
  "user_stress_state",
  "relaxation_sessions",
  "assessment_scales",
  "keyword_groups",
  "suspected_words",
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
    \`diary_background_url\` MEDIUMTEXT NULL COMMENT '我的页封面背景（base64 data URL）',
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
    \`is_pinned\`    TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 表示已置顶',
    \`is_favorited\` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 表示已收藏',
    \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`idx_diary_user\` (\`user_id\`, \`created_at\`),
    CONSTRAINT \`fk_diary_user\` FOREIGN KEY (\`user_id\`)
      REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户日记'`,

  `CREATE TABLE IF NOT EXISTS \`assessment_results\` (
    \`id\`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`user_id\`     INT UNSIGNED NOT NULL,
    \`type\`        VARCHAR(16)  NOT NULL COMMENT 'personality=性格倾向 / emotion=情绪自评',
    \`data\`        JSON         NOT NULL COMMENT '{"I":78,"N":82,"T":65,"P":71} 或 {"phq9":12,"gad7":9}',
    \`created_at\`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`idx_assessment_user\` (\`user_id\`, \`type\`, \`created_at\`),
    CONSTRAINT \`fk_assessment_user\` FOREIGN KEY (\`user_id\`)
      REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='测评历史记录'`,

  `CREATE TABLE IF NOT EXISTS \`user_memories\` (
    \`id\`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`user_id\`    INT UNSIGNED NOT NULL,
    \`content\`    VARCHAR(200) NOT NULL COMMENT '一条长期记忆，如"她养了一只叫团子的猫"',
    \`category\`   VARCHAR(32)  NULL COMMENT '分类标签，可为空',
    \`created_at\` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`idx_memory_user\` (\`user_id\`, \`created_at\`),
    CONSTRAINT \`fk_memory_user\` FOREIGN KEY (\`user_id\`)
      REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户长期记忆'`,

  `CREATE TABLE IF NOT EXISTS \`trash\` (
    \`id\`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`user_id\`    INT UNSIGNED NOT NULL,
    \`item_type\`  VARCHAR(16)  NOT NULL COMMENT 'diary / conversation / message / memory',
    \`title\`      VARCHAR(160) NULL COMMENT '回收站列表里展示的标题',
    \`payload\`    JSON         NOT NULL COMMENT '被删除条目的完整内容，用于恢复',
    \`deleted_at\` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`expire_at\`  DATETIME     NOT NULL COMMENT '到期后由清理任务彻底删除',
    PRIMARY KEY (\`id\`),
    KEY \`idx_trash_user\` (\`user_id\`, \`deleted_at\`),
    KEY \`idx_trash_expire\` (\`expire_at\`),
    CONSTRAINT \`fk_trash_user\` FOREIGN KEY (\`user_id\`)
      REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='回收站（默认保留 3 天）'`,

  `CREATE TABLE IF NOT EXISTS \`ai_usage\` (
    \`id\`                INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`user_id\`           INT UNSIGNED NULL COMMENT '不设外键：用户注销后仍要保留用量统计',
    \`kind\`              VARCHAR(16)  NOT NULL COMMENT 'chat / tts / mood / title',
    \`model\`             VARCHAR(120) NULL,
    \`prompt_tokens\`     INT UNSIGNED NOT NULL DEFAULT 0,
    \`completion_tokens\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`latency_ms\`        INT UNSIGNED NOT NULL DEFAULT 0,
    \`ok\`                TINYINT(1)   NOT NULL DEFAULT 1,
    \`created_at\`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`idx_usage_created\` (\`created_at\`),
    KEY \`idx_usage_user\` (\`user_id\`, \`created_at\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI 调用量统计'`,

  `CREATE TABLE IF NOT EXISTS \`ai_usage_daily\` (
    \`id\`                INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`day\`               DATE         NOT NULL COMMENT '统计日期',
    \`kind\`              VARCHAR(16)  NOT NULL COMMENT 'chat / tts / mood / title',
    \`calls\`             INT UNSIGNED NOT NULL DEFAULT 0,
    \`prompt_tokens\`     BIGINT UNSIGNED NOT NULL DEFAULT 0,
    \`completion_tokens\` BIGINT UNSIGNED NOT NULL DEFAULT 0,
    \`total_latency_ms\`  BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '用于算平均耗时',
    \`failures\`          INT UNSIGNED NOT NULL DEFAULT 0,
    \`updated_at\`        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uk_daily_kind\` (\`day\`, \`kind\`),
    KEY \`idx_daily_day\` (\`day\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI 用量按天汇总（明细清理后仍能看长期趋势）'`,

  `CREATE TABLE IF NOT EXISTS \`safety_flags\` (
    \`id\`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`user_id\`    INT UNSIGNED NULL COMMENT '不设外键：注销后仍保留记录',
    \`category\`   VARCHAR(24)  NOT NULL COMMENT 'self_harm / violence / illegal',
    \`matched\`    VARCHAR(64)  NULL COMMENT '命中的规则名（不存原文）',
    \`source\`     VARCHAR(16)  NOT NULL DEFAULT 'chat',
    \`created_at\` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`idx_flag_created\` (\`created_at\`),
    KEY \`idx_flag_user\` (\`user_id\`, \`created_at\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='内容安全命中记录（只记类别，不存原文）'`,

  `CREATE TABLE IF NOT EXISTS \`music_tracks\` (
    \`id\`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`title\`      VARCHAR(160) NOT NULL DEFAULT '未命名',
    \`artist\`     VARCHAR(160) NULL COMMENT '歌手，可空',
    \`source\`     VARCHAR(16)  NOT NULL DEFAULT 'local' COMMENT 'local=本地上传 / url=外链直链 / netease=网易云',
    \`url\`        TEXT         NULL COMMENT 'local 存 /music/xxx.mp3；url 存完整外链',
    \`netease_id\` VARCHAR(32)  NULL COMMENT '网易云内容 ID（歌曲或歌单）',
    \`netease_type\` VARCHAR(4) NOT NULL DEFAULT '2' COMMENT '网易云播放器类型：2=单曲 / 0=歌单（官方 outchain 的 type 参数）',
    \`admin_note\` TEXT NULL COMMENT '管理员备注，只在后台可见，用户端不显示',
    \`sort_order\` INT          NOT NULL DEFAULT 0 COMMENT '越小越靠前',
    \`enabled\`    TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '1 启用 / 0 停用',
    \`created_at\` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`idx_music_order\` (\`enabled\`, \`sort_order\`, \`id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='背景音乐歌单（全局共享，不属于某个用户）'`,

  // 内容审核队列：用户每改一次头像/背景/昵称/签名就入一条，等 AI 判定
  `CREATE TABLE IF NOT EXISTS \`content_review_tasks\` (
    \`id\`           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`user_id\`      INT UNSIGNED NOT NULL,
    \`task_kind\`    VARCHAR(16)  NOT NULL DEFAULT 'review' COMMENT 'review=内容审核 / diary_mood=日记情绪打标',
    \`target_id\`    INT UNSIGNED NULL COMMENT '目标记录 id（日记打标时是 diaries.id）',
    \`field\`        VARCHAR(32)  NOT NULL COMMENT 'username / bio / avatar_url / ai_avatar_url / chat_background_url / diary_background_url / diary_mood',
    \`content\`      MEDIUMTEXT   NULL COMMENT '待审内容：文本原样，图片是 data URL',
    \`is_image\`     TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 表示图片，审核时走多模态消息体',
    \`status\`       VARCHAR(16)  NOT NULL DEFAULT 'pending' COMMENT 'pending 待提交 / submitted 已提交 / pass / reject / failed',
    \`batch_id\`     VARCHAR(128) NULL COMMENT '所属的远端批次 id',
    \`provider\`     VARCHAR(32)  NULL COMMENT 'mimo-batch / inline / manual',
    \`reason\`       VARCHAR(255) NULL COMMENT 'AI 或管理员给出的理由',
    \`submitted_at\` DATETIME     NULL,
    \`reviewed_at\`  DATETIME     NULL,
    \`created_at\`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`idx_review_status\` (\`status\`, \`id\`),
    KEY \`idx_review_user\` (\`user_id\`, \`id\`),
    KEY \`idx_review_batch\` (\`batch_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='内容审核队列（异步，结果延迟返回）'`,

  // 审核批次：一次提交对应一行，用来轮询状态和统计
  `CREATE TABLE IF NOT EXISTS \`content_review_batches\` (
    \`id\`             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`remote_id\`      VARCHAR(128) NULL COMMENT '上游批次 id',
    \`provider\`       VARCHAR(32)  NOT NULL COMMENT 'mimo-batch / inline',
    \`status\`         VARCHAR(16)  NOT NULL DEFAULT 'submitted' COMMENT 'submitted / completed / failed',
    \`file_id\`        VARCHAR(128) NULL COMMENT '上传的 JSONL 文件 id',
    \`output_file_id\` VARCHAR(128) NULL COMMENT '结果文件 id',
    \`expires_at\`     DATETIME     NULL COMMENT '上游给的批次过期时间（用来验证「最长等待时间」是否生效）',
    \`task_count\`     INT UNSIGNED NOT NULL DEFAULT 0,
    \`pass_count\`     INT UNSIGNED NOT NULL DEFAULT 0,
    \`reject_count\`   INT UNSIGNED NOT NULL DEFAULT 0,
    \`failed_count\`   INT UNSIGNED NOT NULL DEFAULT 0,
    \`error\`          VARCHAR(500) NULL,
    \`submitted_at\`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`completed_at\`   DATETIME     NULL,
    PRIMARY KEY (\`id\`),
    KEY \`idx_batch_status\` (\`status\`, \`id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='内容审核批次'`,

  /* ---------------- 压力评估与放松干预 ---------------- */

  // ⚠️ user_id 用 INT UNSIGNED（和 users.id 对齐）—— 不要写成 BIGINT。
  //    类型不一致会让 JOIN 走不了索引，迁移时也容易踩坑。
  `CREATE TABLE IF NOT EXISTS \`stress_logs\` (
    \`id\`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`user_id\`        INT UNSIGNED NOT NULL,
    \`source\`         ENUM('chat','diary') NOT NULL,
    \`score\`          TINYINT UNSIGNED NOT NULL DEFAULT 50 COMMENT '最终压力值 0-100',
    \`smoothed_score\` TINYINT UNSIGNED NOT NULL DEFAULT 50 COMMENT '平滑后的值',
    \`local_score\`    TINYINT UNSIGNED NOT NULL DEFAULT 50 COMMENT '本地规则分',
    \`llm_score\`      TINYINT UNSIGNED NULL COMMENT 'LLM 分（没调用就是 NULL）',
    \`crisis\`         TINYINT NOT NULL DEFAULT 0 COMMENT '是否命中危机词',
    \`triggered\`      TINYINT NOT NULL DEFAULT 0 COMMENT '这次是否触发了弹窗',
    \`created_at\`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`idx_user_time\` (\`user_id\`, \`created_at\`),
    KEY \`idx_user_source\` (\`user_id\`, \`source\`),
    KEY \`idx_user_llm_day\` (\`user_id\`, \`created_at\`, \`llm_score\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='压力记录'`,

  `CREATE TABLE IF NOT EXISTS \`user_stress_state\` (
    \`user_id\`                 INT UNSIGNED NOT NULL,
    \`chat_score\`              TINYINT UNSIGNED NOT NULL DEFAULT 50 COMMENT '聊天通道平滑压力',
    \`diary_score\`             TINYINT UNSIGNED NOT NULL DEFAULT 50 COMMENT '日记通道平滑压力',
    \`combined_score\`          TINYINT UNSIGNED NOT NULL DEFAULT 50 COMMENT '综合压力',
    \`msg_count_since_analyze\` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '距上次深度识别的消息数（平时只在内存累加）',
    \`last_analyze_at\`         DATETIME NULL,
    \`last_keyword_trigger_at\` DATETIME NULL,
    \`keyword_cooldown_until\`  DATETIME NULL,
    \`last_popup_at\`           DATETIME NULL,
    \`popup_reject_count\`      INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '连续拒绝次数（每次拒绝把阈值 +5）',
    \`threshold\`               TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '用户自己调的阈值；0 = 跟随后台配置',
    \`popup_enabled\`           TINYINT NOT NULL DEFAULT 1 COMMENT '是否启用弹窗',
    \`diary_enabled\`           TINYINT NOT NULL DEFAULT 1 COMMENT '是否分析日记',
    \`updated_at\`              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`user_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户压力状态'`,

  `CREATE TABLE IF NOT EXISTS \`relaxation_sessions\` (
    \`id\`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`user_id\`        INT UNSIGNED NOT NULL,
    \`trigger_source\` ENUM('chat','diary') NOT NULL DEFAULT 'chat',
    \`trigger_score\`  TINYINT UNSIGNED NOT NULL DEFAULT 0,
    \`method\`         VARCHAR(24) NULL COMMENT 'breathing / butterfly',
    \`accepted\`       TINYINT NOT NULL DEFAULT 0,
    \`completed\`      TINYINT NOT NULL DEFAULT 0,
    \`score_before\`   TINYINT UNSIGNED NULL,
    \`score_after\`    TINYINT UNSIGNED NULL,
    \`created_at\`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`idx_user_time\` (\`user_id\`, \`created_at\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='放松运动记录'`,

  /* ---------------- 测评题库（可上传、可启停的那一类） ---------------- */

  // ⚠️ 内置题库（PSS-10）由 `lib/scales.js` 的 `ensureBuiltinScales()` 播种进来，
  //    播种用「只插缺的 id」策略 —— 管理员调过阈值之后，下次部署不会被覆盖回去。
  `CREATE TABLE IF NOT EXISTS \`assessment_scales\` (
    \`id\`          VARCHAR(64)  NOT NULL COMMENT '题库 id，也是 assessment_results.type 的值',
    \`name\`        VARCHAR(120) NOT NULL COMMENT '显示名称',
    \`description\` TEXT NULL COMMENT '量表简介（后台展示）',
    \`version\`     VARCHAR(16)  NOT NULL DEFAULT '1.0',
    \`source\`      VARCHAR(500) NULL COMMENT '出处（学术量表建议写上）',
    \`enabled\`     TINYINT NOT NULL DEFAULT 1 COMMENT '停用后不在用户端列出',
    \`builtin\`     TINYINT NOT NULL DEFAULT 0 COMMENT '内置题库只能停用、不能删',
    \`questions\`   JSON NOT NULL COMMENT '题目数组',
    \`scoring\`     JSON NOT NULL COMMENT '计分规则（不下发给用户端）',
    \`dimensions\`  JSON NULL COMMENT '维度列表',
    \`meta\`        JSON NULL COMMENT '作者 / 标签 / 时间等',
    \`created_at\`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`idx_enabled\` (\`enabled\`, \`id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='测评题库'`,

  /* ---------------- 统一词表（安全词 + 压力词） ---------------- */

  // ⚠️ 六张词表：自伤倾向 / 伤害他人 / 违法行为（安全）+ 轻度 / 中度 / 重度（压力）。
  //    由 `lib/lexicon-store.js` 的 `ensureKeywordGroups()` 播种，**只插缺的 id** ——
  //    管理员调过词表之后，下次部署不会被改回默认值。
  `CREATE TABLE IF NOT EXISTS \`keyword_groups\` (
    \`id\`         VARCHAR(32)  NOT NULL COMMENT 'selfHarm / harmOthers / illegal / mild / moderate / severe',
    \`label\`      VARCHAR(64)  NOT NULL COMMENT '显示名',
    \`kind\`       VARCHAR(16)  NOT NULL COMMENT 'safety=安全词 / stress=压力词',
    \`type\`       VARCHAR(16)  NOT NULL DEFAULT 'list' COMMENT 'list=词数组 / contextPairs=上下文短语对',
    \`enabled\`    TINYINT NOT NULL DEFAULT 1,
    \`weight\`     SMALLINT NOT NULL DEFAULT 0 COMMENT '压力词分值（3 / 6 / 12）；安全词为 0',
    \`hint\`       VARCHAR(500) NULL COMMENT '给管理员的说明',
    \`warning\`    VARCHAR(500) NULL COMMENT '给管理员的警示（比如"别放单字"）',
    \`content\`    JSON NOT NULL COMMENT '词数组 或 短语对数组',
    \`builtin\`    TINYINT NOT NULL DEFAULT 0 COMMENT '内置词表不可删，只能停用或改内容',
    \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`idx_kind\` (\`kind\`, \`id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='统一词表'`,

  /* ---------------- 疑似误报词（给运营判断用） ---------------- */

  // ⚠️ 命中词表、但**语义上可能是日常用法**的片段会被记在这里（比如「想死」出现在
  //    「我想死磕这对 cp」里）。AI 判过之后把结论也存下来，
  //    攒够次数就能看出"这个词该加进例外表了"，不用靠人肉回忆。
  //
  // ⚠️ **不存用户原话** —— 只存命中的那个片段 + 截断过的短上下文，
  //    既够判断又不会把隐私留下来。
  `CREATE TABLE IF NOT EXISTS \`suspected_words\` (
    \`id\`         INT AUTO_INCREMENT PRIMARY KEY,
    \`word\`       VARCHAR(64)  NOT NULL COMMENT '命中的片段，如「想死」',
    \`category\`   VARCHAR(32)  NOT NULL DEFAULT 'self_harm',
    \`verdict\`    VARCHAR(16)  NOT NULL DEFAULT 'unknown' COMMENT 'ai_no=AI判为日常用法 / ai_yes=AI确认有风险 / unknown=没结论 / no_tag=AI没给标记',
    \`hits\`       INT NOT NULL DEFAULT 1 COMMENT '累计命中次数',
    \`samples\`    JSON NULL COMMENT '最近几条短上下文（截断过，不存完整原文）',
    \`note\`       VARCHAR(255) NULL COMMENT '运营备注（比如"已加进例外表"）',
    \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY \`uniq_word\` (\`word\`, \`category\`),
    KEY \`idx_hits\` (\`hits\`),
    KEY \`idx_verdict\` (\`verdict\`, \`hits\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='疑似误报词'`,
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
  { name: "diary_background_url", ddl: "ADD COLUMN `diary_background_url` MEDIUMTEXT NULL COMMENT '我的页封面背景' AFTER `chat_background_url`" },
  { name: "ai_persona", ddl: "ADD COLUMN `ai_persona` VARCHAR(16) NULL COMMENT '偏好的 AI 人格：male / female' AFTER `bio`" },
  // 内容审核：显式的「未审核」tag —— 后台列表能一眼看出谁还有内容没过审
  { name: "review_pending", ddl: "ADD COLUMN `review_pending` VARCHAR(255) NULL COMMENT '待审核字段列表（逗号分隔）' AFTER `ai_persona`" },
  { name: "review_flagged", ddl: "ADD COLUMN `review_flagged` VARCHAR(255) NULL COMMENT '最近一次因违规被改回默认值的字段' AFTER `review_pending`" },

  // ---- 心理画像（本地算法算出，**用户端不可见**，只在后台展示）----
  // ⚠️ 存的是**完整 JSON**（含 basis 判定依据 + sourceScores 原始分数），不只是标签 ——
  //    后台要"标签 + 依据"一起展示，光存标签的话运营只能猜。
  { name: "portrait", ddl: "ADD COLUMN `portrait` JSON NULL COMMENT '心理画像（标签/判定依据/原始分数）' AFTER `review_flagged`" },
  { name: "portrait_version", ddl: "ADD COLUMN `portrait_version` VARCHAR(16) NULL COMMENT '画像算法版本，便于追溯是哪版规则算的' AFTER `portrait`" },
  { name: "portrait_updated_at", ddl: "ADD COLUMN `portrait_updated_at` DATETIME NULL COMMENT '画像最后更新时间' AFTER `portrait_version`" },
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

/** music_tracks 后来新增的列 */
const MUSIC_EXTRA_COLUMNS = [
  {
    name: "netease_type",
    ddl: "ADD COLUMN `netease_type` VARCHAR(4) NOT NULL DEFAULT '2' COMMENT '网易云播放器类型：2=单曲 / 0=歌单' AFTER `netease_id`",
  },
  {
    name: "admin_note",
    ddl: "ADD COLUMN `admin_note` TEXT NULL COMMENT '管理员备注，只在后台可见' AFTER `enabled`",
  },
];

/** 给已存在的 music_tracks 表补列（老库升级用） */
export async function ensureMusicColumns() {
  return addMissingColumns("music_tracks", MUSIC_EXTRA_COLUMNS);
}

/**
 * diaries 表后加的列：情绪标签。
 * 设计上只做「温和描述」（如"有点沉""平静"），不做数值评分、不做好坏判断 ——
 * 这个产品的定位是陪伴，不是给用户的情绪打分。
 *
 * ⚠️ 这里曾经把字段写成 `definition`（而 addMissingColumns 读的是 `ddl`），
 *    导致补列时执行的是 `ALTER TABLE diaries undefined` 直接报错 —— 而且这个错会
 *    中断 ensureUserColumnsOnce 后面的建表步骤。已修正为 `ddl`。
 */
const DIARY_EXTRA_COLUMNS = [
  {
    name: "mood",
    ddl: "ADD COLUMN `mood` VARCHAR(16) NULL COMMENT '情绪标签（AI 打标）' AFTER `content`",
  },
  {
    name: "user_mood",
    ddl: "ADD COLUMN `user_mood` VARCHAR(16) NULL COMMENT '用户自己选的情绪标签（和 AI 打的分开存）' AFTER `mood`",
  },
  {
    name: "source",
    ddl: "ADD COLUMN `source` VARCHAR(8) NOT NULL DEFAULT 'user' COMMENT 'user=用户自己写的 / ai=AI 根据聊天记录生成' AFTER `user_mood`",
  },
  {
    // ⚠️ 这一列解决一个很具体的问题：AI 日记是根据**昨天**的聊天生成的，
    //    但 created_at 记的是"生成的那一刻"（今天 23 点）。
    //    只看 created_at 的话，用户在列表里看到的是"今天"，会以为是今天的日记。
    //    diary_date 存的是这篇日记**对应哪一天**，展示时就以它为准。
    name: "diary_date",
    ddl: "ADD COLUMN `diary_date` DATE NULL COMMENT '这篇日记对应哪一天（AI 生成的是聊天那天，不是生成时刻）' AFTER `source`",
  },
  { name: "is_pinned", ddl: "ADD COLUMN `is_pinned` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 表示已置顶'" },
  { name: "is_favorited", ddl: "ADD COLUMN `is_favorited` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 表示已收藏'" },
];

/** 给已存在的 diaries 表补上情绪标签列 */
export async function ensureDiaryColumns() {
  return addMissingColumns("diaries", DIARY_EXTRA_COLUMNS);
}

/**
 * content_review_batches 后来新增的列。
 *
 * expires_at 存的是**上游返回的批次过期时间** —— 它同时也是
 * 「我设的『最长等待时间』到底有没有被接受」的证据：
 *   设 168h（7 天）后，上游返回的过期时间如果真是 7 天后，说明认了；
 *   如果还是 24 小时后，说明它忽略了这个值（接口文档标注的是"固定 24h"）。
 */
const REVIEW_BATCH_EXTRA_COLUMNS = [
  {
    name: "expires_at",
    ddl: "ADD COLUMN `expires_at` DATETIME NULL COMMENT '上游给的批次过期时间，用来验证最长等待时间是否生效' AFTER `output_file_id`",
  },
];

/** 给已存在的 content_review_batches 补列（老库升级用） */
export async function ensureReviewBatchColumns() {
  return addMissingColumns("content_review_batches", REVIEW_BATCH_EXTRA_COLUMNS);
}

/** content_review_tasks 后来新增的列（日记情绪打标用） */
const REVIEW_TASK_EXTRA_COLUMNS = [
  {
    name: "task_kind",
    ddl: "ADD COLUMN `task_kind` VARCHAR(16) NOT NULL DEFAULT 'review' COMMENT 'review=内容审核 / diary_mood=日记情绪打标' AFTER `user_id`",
  },
  {
    name: "target_id",
    ddl: "ADD COLUMN `target_id` INT UNSIGNED NULL COMMENT '目标记录 id（日记打标时是 diaries.id）' AFTER `task_kind`",
  },
  {
    // ⚠️ 自动重试的计数。
    //    失败的任务会被重新捞回队列（见 content-review.js 的 takePending），
    //    这个字段用来**防无限重试** —— 到上限就永久停在 failed，等人工处理。
    name: "retry_count",
    ddl: "ADD COLUMN `retry_count` TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '已自动重试次数（防无限重试）' AFTER `target_id`",
  },
  {
    // ⚠️ 去重键 —— **同一份"内容"在队列里只应该有一条活跃任务**。
    //
    //    出过的事：用户先点「重试失败任务」（把旧的 failed 打回队列），
    //    又点「为昨天排生成任务」，结果**同一天生成了两篇一模一样的日记**。
    //    根因是两处都没查队列：排任务的去重只看 `diaries` 表
    //    （上一次生成失败时那儿根本没有记录），而 `enqueueReview` 从来不查重。
    //
    //    现在每个任务入队时都算一个 key：
    //      · 内容审核   review:{userId}:{字段}:{内容哈希}
    //      · 日记打标   diary_mood:{diaryId}:{内容哈希}
    //      · 生成日记   diary_generate:{userId}:{日期}
    //    入队前先查同 key 的**活跃任务**（pending / submitted / manual），有就跳过。
    //    改过内容之后哈希变了，所以"改完日记重新打标"不受影响。
    name: "dedupe_key",
    ddl: "ADD COLUMN `dedupe_key` VARCHAR(191) NULL COMMENT '去重键：同内容只保留一条活跃任务' AFTER `retry_count`",
  },
];

/** 给已存在的 content_review_tasks 补列（老库升级用） */
export async function ensureReviewTaskColumns() {
  return addMissingColumns("content_review_tasks", REVIEW_TASK_EXTRA_COLUMNS);
}

let userColumnsChecked = false;

/**
 * 进程内只跑一次。
 * 用于「已经装过、后来升级了代码」的站点：第一次访问时自动把新增的列补上，
 * 否则老表缺列会让用户端直接报 ER_BAD_FIELD_ERROR。
 */
export async function ensureUserColumnsOnce() {
  if (userColumnsChecked) return { added: [], skipped: true };

  // ⚠️ 每一步单独兜底，不要用一串裸 await：
  //    以前是顺序 await，任何一步抛错都会**中断后面所有步骤** ——
  //    曾经因为 diaries 的补列语句写错（ALTER TABLE diaries undefined）报错，
  //    结果连「建新表」那一步都没跑到，新表怎么也建不出来，排查了很久。
  //    补列/建表本身是「有就跳过、失败也无妨」的事，不该拖垮别的步骤。
  const safe = async (label, fn) => {
    try {
      return await fn();
    } catch (err) {
      console.error(`[schema] ${label} 失败（已跳过）：`, err?.code || err?.message || err);
      return { added: [], skipped: true };
    }
  };

  const userResult = await safe("补 users 列", ensureUserColumns);
  const conversationResult = await safe("补 conversations 列", ensureConversationColumns);
  const diaryResult = await safe("补 diaries 列", ensureDiaryColumns);
  const musicResult = await safe("补 music_tracks 列", ensureMusicColumns);
  const reviewResult = await safe("补 content_review_batches 列", ensureReviewBatchColumns);
  const reviewTaskResult = await safe("补 content_review_tasks 列", ensureReviewTaskColumns);

  // 新表也要兜底：老库不会重跑安装向导，而 CREATE TABLE IF NOT EXISTS 是幂等的，
  // 顺带执行一遍，保证 user_memories、content_review_tasks 这类新表在老部署上也能建出来。
  const tableResult = await safe("建表", ensureTables);

  // ⚠️ **播种内置题库**（PSS-10 等）—— 必须排在建表之后。
  //    幂等策略是"只插库里没有的 id"：管理员调过阈值之后，下次部署不会被覆盖回去。
  //    用动态 import 引入，避免 schema.js 被到处引用时把整条依赖链拖长。
  await safe("播种内置题库", async () => {
    const { ensureBuiltinScales } = await import("./scales.js");
    const result = await ensureBuiltinScales();
    return { added: [], scales: result?.added || [] };
  });

  // ⚠️ **播种统一词表**（自伤倾向 / 伤人 / 违法 + 压力词三档）。
  //    同样"只插缺的 id" —— 管理员调过词表之后，下次部署不会被覆盖回去。
  //    播种完**立刻编译进内存**，否则下一次检测用的还是兜底词表。
  await safe("播种统一词表", async () => {
    const { ensureKeywordGroups, refreshLexicons } = await import("./lexicon-store.js");
    const result = await ensureKeywordGroups();
    await refreshLexicons();
    return { added: [], keywords: result?.added || [] };
  });

  // ⚠️ 压力阈值的**语义迁移**（必须排在建表之后）。
  //
  //    早期版本把"跟随后台配置"错误地当成了具体值 70 落库，
  //    导致管理员在后台怎么改「提醒阈值」都不生效（代码总是先取到那个 70）。
  //    现在约定 0 = 跟随。这里把"仍然是 70、而且从没发生过任何弹窗交互"的行改成 0 ——
  //    同时满足这两个条件的行不可能是用户手调的（手动改阈值一定伴随弹窗或拒绝记录）。
  //    幂等：改完就不再是 70，重复执行没有副作用。
  const stressResult = await safe("迁移压力阈值", async () => {
    const result = await execute(
      `UPDATE user_stress_state
          SET threshold = 0
        WHERE threshold = 70
          AND (popup_reject_count = 0 OR popup_reject_count IS NULL)
          AND last_popup_at IS NULL`
    );
    return { added: [], migrated: Number(result?.affectedRows || 0) };
  });

  // ⚠️ 清理**被写脏的日记情绪标签**。
  //
  //    事故：管理员在「数据审核」页对一条日记打标任务点了「驳回」，
  //    `applyManualVerdict` 传下去的字符串 `"reject"` 被当成情绪词写进了
  //    `diaries.mood` —— 用户的日记卡片上就出现了一个「reject」。
  //
  //    代码那边已经加了白名单兜底（不会再写进去）＋ 打标任务不再接受"驳回"。
  //    这一步是把**已经写脏的历史数据**清掉。
  //    幂等：清完就不再有白名单之外的值。
  await safe("清理异常的日记标签", async () => {
    const result = await execute(
      `UPDATE diaries
          SET mood = NULL
        WHERE mood IS NOT NULL
          AND mood <> ''
          AND mood NOT IN ('轻快','平静','安稳','有点沉','疲惫','烦躁','孤单','说不清')`
    );
    return { added: [], cleaned: Number(result?.affectedRows || 0) };
  });

  // ⚠️ 清理**重复生成的 AI 日记**。
  //
  //    事故：排任务时的去重只查 `diaries` 表（上一次生成失败时那儿根本没记录），
  //    而 `enqueueReview` 也从来不查重 —— 于是「重试失败任务」+「再排一次」
  //    会跑出**两篇一模一样的日记**。
  //    代码那边已经补了两道去重，这一步是把**已经产生的重复**清掉。
  //
  //    ⚠️ 条件刻意卡得很死，只删"用户自己改过就不可能匹配"的那种：
  //       同一用户 + 都是 AI 生成 + 同一天 + 内容一字不差 → 只留 id 最小的那篇。
  //    幂等：清完就再也不会有满足条件的行了。
  await safe("清理重复生成的 AI 日记", async () => {
    const result = await execute(
      `DELETE d FROM diaries d
         JOIN diaries keep
           ON keep.user_id = d.user_id
          AND keep.source = 'ai'
          AND keep.diary_date = d.diary_date
          AND keep.content = d.content
          AND keep.id < d.id
        WHERE d.source = 'ai'
          AND d.diary_date IS NOT NULL`
    );
    return { added: [], removed: Number(result?.affectedRows || 0) };
  });

  userColumnsChecked = true;
  return {
    added: [
      ...(userResult.added || []),
      ...(conversationResult.added || []),
      ...(diaryResult.added || []),
      ...(musicResult.added || []),
      ...(reviewResult.added || []),
      ...(reviewTaskResult.added || []),
      ...((tableResult.missing || []).map((name) => `${name}:table`)),
    ],
    skipped: false,
  };
}
