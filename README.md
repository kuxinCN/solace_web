# Solace

> 给每一个不想说话的灵魂，一点慰藉。

一个情绪陪伴型聊天应用：倾诉、写日记、情绪急救箱，AI 只做倾听与陪伴，不讲道理。

## 技术栈

- **框架**：Next.js 14（App Router）+ React 18 + Tailwind CSS
- **用户端数据**：自建 MySQL（邮箱验证码登录，会话/消息/日记都在同一个库里）
- **管理后台数据**：MySQL 5.7（宝塔自建）
- **对话 AI**：OpenAI 兼容接口（默认智谱 GLM）
- **文字转语音**：OpenAI 兼容 `/audio/speech`
- **登录验证码邮件**：网易邮箱 SMTP（nodemailer）

## 目录结构

```
components/                用户端 UI 组件（疗愈小屋、急救箱、个人资料、开屏动画等）
app/
  page.js                  登录页（用户端：邮箱验证码 / 账号密码 + 开屏欢迎动画）
  chat/page.js             聊天主界面（用户端：会话、消息、日记、疗愈小屋、急救箱、个人资料）
  install/page.js          安装向导（首次部署：数据库 + 管理员 + 验证器绑定）
  install/layout.js        安装页元信息
  admin/page.js            管理后台（概览 / 数据库 / AI / TTS / 邮箱 / 站点 / 日志）
  admin/layout.js          后台页面元信息
  api/
    chat/route.js          对话接口（需登录，读后台配置）
    tts/route.js           文字转语音接口（需登录）
    install/route.js       安装向导接口（测试连接 / 自动建表 / 创建管理员）
    auth/
      send-code/route.js   发送邮箱验证码
      verify/route.js      校验验证码并登录
      login/route.js       账号 + 密码登录（后台添加的用户用）
      session/route.js     当前登录状态
      logout/route.js      退出登录
    user/
      profile/route.js     用户资料（显示名称）
      conversations/route.js  会话列表 / 新建 / 改名 / 删除
      messages/route.js    消息读取与写入
      diaries/route.js     日记列表与新增
      message-index/route.js  搜索用的消息索引
    admin/
      setup/route.js       后台初始化（生成 TOTP 二维码、创建第一个管理员）
      session/route.js     后台登录 / 登录态 / 退出
      settings/route.js    系统配置读写
      database/route.js    数据库连接配置（测试 + 热切换）
      mail/test/route.js   发送测试邮件
      tts/test/route.js    语音试听
      logs/route.js        操作日志
      users/route.js       用户管理（增删改查、启禁用、查看/清空密码）
      user-data/route.js   用户数据（查看/删除某用户的日记、会话与消息）
      overview/route.js    运行状态概览
lib/
  db.js                    MySQL 连接池（支持后台热切换）
  settings.js              配置分组读写与校验
  ai.js                    对话 / 语音接口封装
  mailer.js                网易 SMTP 发信 + 邮箱验证码
  admin-auth.js            后台认证（bcrypt + TOTP + 会话 + 登录锁定 + 审计日志）
  util.js                  小工具（时间、IP、Cookie、JSON 返回）
  user-auth.js             用户端登录会话（邮箱验证码 / 账号密码，替代 Supabase Auth）
  secret-box.js            用户密码的可逆加密（AES-GCM，后台可解密查看）
  rate-limit.js            按 IP 的进程内限流（保护 /api/chat、/api/tts）
  install.js               安装状态与安装锁（config/installed.lock）
  schema.js                建表语句（安装向导自动建表用，与 db/schema.sql 对应）
db/
  schema.sql               后台相关表结构（MySQL 5.7 语法）
utils/supabase.js          已废弃（可删除），用户端数据已迁到自建 MySQL
ecosystem.config.js        PM2 启动配置（命令行部署时用）
DEPLOY.md                  详细部署教程（CentOS 7 + 宝塔 + MySQL 5.7）
```

## 本地开发

```bash
npm install
npm run dev      # http://localhost:3000
```

环境变量：复制 `.env.example` 为 `.env.local` 后填写。

## 首次安装

推荐入口：**`/install`**

1. 环境自检（Node 版本、`config` 目录是否可写）
2. 填数据库连接 → **自动建好全部数据表**（不用手动导 SQL）
3. 设置管理员账号密码 + 扫码绑定动态验证器 → 安装完成并直接登录后台

安装完成后会写下安装锁 `config/installed.lock`，此后 `/install` 与 `/api/install` 一律拒绝再次安装
（确实要重装需在 `.env.local` 设置 `ALLOW_REINSTALL=1`，这需要服务器权限）。
安装成功页会提示把安装入口关掉：删掉 `app/install`、`app/api/install` 后重新构建，或用 Nginx 屏蔽这两个路径
（不处理也安全，接口已经会返回 403）。

> 也可以跳过向导，直接访问 `/admin` 走内置的初始化流程，效果一样，只是表需要自己导入 `db/schema.sql`。

## 管理后台

入口：**`/admin`**

- 必须登录，登录方式为「账号 + 密码 + 动态验证码」（TOTP，微软/Google 验证器扫码绑定）
- 可配置：数据库连接信息、对话 AI 接口、文字转语音接口、网易邮箱 SMTP 与验证码规则、站点信息
- **用户管理**：查看所有用户、手动添加 / 编辑 / 删除、启用或禁用、查看或清空密码；
  并可开关「昵称 / 性别 / 出生年月 / 手机号 / 备注 / 状态 / 时间」等字段是否显示（邮箱、账号、密码强制显示）
- 所有敏感操作都会记录到操作日志

## 部署

服务器部署（CentOS 7 / 8.5 + 宝塔 + MySQL 5.7 / 8.0）请见 **[DEPLOY.md](./DEPLOY.md)**，里面有 Node 版本对照、建库、上传代码、PM2/宝塔启动、Nginx 反代 + HTTPS、`/install` 安装向导、验收清单与常见报错。
