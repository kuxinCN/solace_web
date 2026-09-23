/**
 * 已废弃：用户端数据已从 Supabase 迁移到自建 MySQL。
 *
 * 现在：
 *   * 登录走邮箱验证码，接口在 app/api/auth/*
 *   * 会话 / 消息 / 日记 / 资料走 app/api/user/*
 *   * 服务端逻辑在 lib/user-auth.js、lib/mailer.js
 *
 * 这个文件已经没有任何地方引用，可以放心删除（连 @supabase/supabase-js 依赖一起删）。
 */
export {};
