# 部署清单（本次更新）

本文对应「TTS MiMo 适配 → 提示词后台可改 → 稳定性/安全加固 → 体验功能」这一轮的全部改动。
按顺序照做即可，全程约 10 分钟。

---

## 一、本次要上传的文件（共 23 个）

### 新增文件（8 个）

| 文件 | 作用 |
|---|---|
| `app/api/health/route.js` | 健康检查接口 `GET /api/health` |
| `app/api/user/diaries/mood/route.js` | 日记情绪标签 `POST /api/user/diaries/mood` |
| `app/api/user/conversations/title/route.js` | 对话标题自动生成 `POST /api/user/conversations/title` |
| `scripts/backup-db.sh` | 数据库自动备份脚本 |
| `docs/OPERATIONS.md` | 运维手册（备份 / 日志轮转 / 故障速查） |
| `app/api/admin/dashboard/route.js` | 后台数据看板接口 |
| `docs/API.md` | 完整 API 文档（45 个端点） |
| `scripts/bench.sh` | 简易压测脚本 |

### 修改文件（15 个）

| 文件 | 改了什么 |
|---|---|
| `lib/ai.js` | 小米 MiMo 协议、朗读风格指令、接口地址智能拼接、情绪标签与标题生成 |
| `lib/settings.js` | AI 提示词默认值、TTS 朗读风格默认值 |
| `lib/db.js` | 数据库错误默认脱敏（详情进日志） |
| `lib/schema.js` | `diaries` 表新增 `mood` 列 + 自动补列 |
| `app/admin/page.js` | 后台提示词编辑框、TTS 接口类型下拉、字段说明文案、**数据看板** |
| `app/page.js` | 登录页页签移动端优化（平分宽度 + 去掉点击延迟） |
| `app/api/chat/route.js` | 系统提示词从数据库注入、接口地址智能拼接 |
| `app/api/install/route.js` | 安装入口限流、错误详细化（引导用） |
| `app/api/admin/setup/route.js` | 初始化入口限流 |
| `app/api/admin/database/route.js` | 数据库错误详细化（管理员可见） |
| `app/api/admin/overview/route.js` | 同上 |
| `app/api/user/upload/route.js` | 上传限流 + 文件头魔数校验 |
| `app/api/user/password/route.js` | 改密码限流 |
| `app/api/user/email/route.js` | 改邮箱限流 |
| `app/api/user/diaries/route.js` | 列表返回情绪标签、改正文清空标签 |

> ⚠️ `.env.local`、`config/db.json`、`config/installed.lock` **不要上传**（打包时已排除），否则会覆盖服务器上的配置。

---

## 二、本地打包（Windows PowerShell）

```powershell
# 1) 重建临时目录
$src = "E:\ai web project\solace"
$dst = "E:\temp\solace-pkg"
Remove-Item -Recurse -Force $dst -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dst | Out-Null

# 2) 复制（排除不该上传的目录与文件）
robocopy $src $dst /E `
  /XD node_modules .next .vercel .git .reasonix logs backups `
  /XF .env.local db.json installed.lock

# 3) 打成 zip
$zip = "E:\solace-deploy.zip"
Remove-Item -Force $zip -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($dst, $zip)

Get-Item $zip | Select-Object Name, @{n="MB";e={[math]::Round($_.Length/1MB,2)}}
```

---

## 三、服务器部署

### 1. 先备份当前代码（万一要回滚）

```bash
cd /www/wwwroot/solace
tar czf /root/solace-code-$(date +%Y%m%d-%H%M).tar.gz \
  --exclude=node_modules --exclude=.next --exclude=logs --exclude=backups .
ls -lh /root/solace-code-*.tar.gz | tail -1
```

### 2. 上传并解压

把 `solace-deploy.zip` 传到服务器（宝塔文件管理器拖进 `/tmp/` 即可）：

```bash
cd /tmp
rm -rf solace-new && mkdir solace-new
unzip -o solace-deploy.zip -d solace-new
```

### 3. 覆盖代码（不会动配置，因为包里没有配置文件）

```bash
cp -rf /tmp/solace-new/. /www/wwwroot/solace/

# 顺手确认配置还在
ls -l /www/wwwroot/solace/.env.local /www/wwwroot/solace/config/db.json
```

### 4. 构建

```bash
cd /www/wwwroot/solace
npm run build
```

**必须看到 `✓ Compiled successfully`** 才算成功。看到 `Failed to compile` 就把报错发出来。

> 如果报 `Cannot find module 'xxx'`，先跑一次 `npm install` 再 build。

### 5. 重启

```bash
pm2 restart solace
```

> 确认只有这一个实例在跑：`ss -lntp | grep -E ':3000|:3001'` 应该只有 3000。

### 6. 验证

```bash
# 健康检查（应返回 ok:true 和数据库版本）
curl -s https://solace.l.cd/api/health

# 域名与本机都通
curl -s -o /dev/null -w "本机:%{http_code} " http://127.0.0.1:3000/api/health
curl -s -o /dev/null -w "域名:%{http_code}\n" https://solace.l.cd/api/health
```

---

## 四、功能验证清单

| # | 验证项 | 怎么验 | 期望 |
|---|---|---|---|
| 1 | 健康检查 | `curl -s https://solace.l.cd/api/health` | `ok:true`，含 `database.version` |
| 2 | 后台提示词编辑 | 后台 →「对话 AI」往下拉 | 能看到两个大文本框，内容已填好 |
| 3 | 提示词即时生效 | 改一句 → 保存 → 用户端发消息 | 回复风格立刻变化，无需重启 |
| 4 | TTS 小米 MiMo | 后台「语音 TTS」→ 接口类型选小米 MiMo → 地址填 `https://api.xiaomimimo.com/v1` → 试听 | 能出声 |
| 5 | 上传校验 | 用户端换头像 | 正常图片能传；传个 txt 改名成 jpg 会被拒 |
| 6 | 日记情绪标签 | 写日记 → 调 `POST /api/user/diaries/mood` | 返回 8 个标签之一 |
| 7 | 对话标题生成 | 聊两句 → 调 `POST /api/user/conversations/title` | 返回具体标题 |
| 8 | 数据库备份 | `bash scripts/backup-db.sh` | `backups/` 下生成 `.sql.gz` |
| 9 | 错误脱敏 | 随便造个数据库错误 | 前端只看到通用提示，详情在 `pm2 logs` |
| 10 | 移动端登录页 | 手机上打开登录页 | 两个页签都能点，且够大 |

> 第 6、7 项要登录态，最方便是在浏览器控制台里执行：
> ```js
> await fetch("/api/user/diaries/mood", {
>   method: "POST",
>   headers: { "Content-Type": "application/json" },
>   body: JSON.stringify({ id: 1 }),
> }).then(r => r.json())
> ```

---

## 五、配置定时任务（部署完顺手做）

```bash
# 数据库每天 3 点自动备份，保留 7 天
crontab -e
# 加入这一行：
0 3 * * * cd /www/wwwroot/solace && bash scripts/backup-db.sh >> logs/backup.log 2>&1

# 先手动跑一次确认没问题（Windows 上传的脚本要先去 CRLF）
sed -i 's/\r$//' /www/wwwroot/solace/scripts/backup-db.sh
bash /www/wwwroot/solace/scripts/backup-db.sh

# pm2 日志轮转（防止日志撑爆磁盘）
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

---

## 六、出问题怎么回滚

```bash
cd /www/wwwroot/solace

# 找回刚才的备份包名
ls -lh /root/solace-code-*.tar.gz

# 解回去
tar xzf /root/solace-code-你的时间戳.tar.gz

# 重新构建并重启
npm run build && pm2 restart solace
```

> 回滚代码**不会**影响数据：`diaries.mood` 这个新列留着也无害，旧代码不读它而已。

---

## 七、这次改动相关的前端对接（转给前端同学）

### 1. 对话标题自动生成

首轮对话结束后调一次：

```js
const res = await fetch("/api/user/conversations/title", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ conversationId, messages: recentTwoMessages }),
});
const data = await res.json();
if (data.ok && !data.skipped) setConversationTitle(data.title);
```

### 2. 日记情绪标签

保存日记成功后调一次：

```js
const res = await fetch("/api/user/diaries/mood", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ id: savedDiary.id }),
});
const data = await res.json();
if (data.ok) setMood(data.mood);   // 显示成小标签
```

> 设计约定：标签只用「温和描述」（轻快 / 平静 / 安稳 / 有点沉 / 疲惫 / 烦躁 / 孤单 / 说不清），
> **不做评分、不做趋势对比、不用红黄绿分级配色** —— 这个产品是陪伴，不是给用户的情绪打分。
