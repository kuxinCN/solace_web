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

**判据是 `npm run build` 的退出码为 0**（末尾打印出 Route 表）。⚠️ 不要只看那一行
`✓ Compiled successfully` —— 它在 lint 之前就打印了，lint 报 Error 时构建仍以退出码 1 结束，
你会以为成功、直接重启，结果 `.next` 半更新：**新路由能请求到、用户端 JS 却还是旧的**。

```bash
npm run build || { echo "❌ 构建失败，别重启"; exit 1; }
```

看到 `Failed to compile` 就把报错发出来（`npm run lint` 能一次列出全部 Error）。

> 如果报 `Cannot find module 'xxx'`，先跑一次 `npm install` 再 build。

### 5. 重启

```bash
pm2 restart solace          # 日常更新够用
```

> ⚠️ 改过 `ecosystem.config.js`（尤其 `node_args` / `max_memory_restart`）时必须用
> **`pm2 delete solace && pm2 start ecosystem.config.js`** —— `node_args` 是启动参数，`pm2 restart` 不会重新读取（INC-008 / `docs/PERFORMANCE.md`）。

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

---

## 八、2026-10：桌宠与表情包可配置化（文件清单 + 注意事项）

本次是**四批一起上线**：① 数据层 → ② 桌宠 → ③ 表情包 → ④ 文档。
功能说明见 [CHANGELOG.md](../CHANGELOG.md) 顶部那一节。

### 1. 要上传的文件

**新增（15 个）**

```
lib/pet-store.js                          桌宠内容读写 + 播种
lib/sticker-store.js                      表情包分类/素材读写 + 播种 + 配置缓存
app/api/pet/route.js                      用户端桌宠配置（公开）
app/api/stickers/route.js                 用户端表情包资源表（公开）
app/api/admin/pet/images/route.js         形象库 CRUD
app/api/admin/pet/images/upload/route.js  形象上传
app/api/admin/pet/images/active/route.js  设为当前形象
app/api/admin/pet/moods/route.js          情绪选项 CRUD
app/api/admin/pet/lines/route.js          回复话术 CRUD
app/api/admin/stickers/route.js           素材 CRUD
app/api/admin/stickers/categories/route.js 分类 CRUD
app/api/admin/stickers/upload/route.js    素材上传
app/api/admin/stickers/scan/route.js      重新扫描目录
components/PetPanel.jsx                   后台「桌宠」面板
components/StickerPanel.jsx               后台「表情包」面板
docs/PET.md                               桌宠技术文档
```

**修改（主要几个）**

```
lib/sticker-engine.js     分类/词表/优先级改成"读注入的 spec"，只留出厂默认（⚠️ 这批最核心的改动）
lib/settings.js           新增 pet / sticker 两个配置分组
lib/schema.js             注册 5 张新表 + 老库自动播种
db/schema.sql             同上（5 张表）
app/api/chat/route.js     表情包：读分类 spec + 总开关
app/chat/page.js          桌宠与表情包都改成进站预取配置
app/admin/page.js         新增「桌宠」「表情包」两个标签页
components/ButterflyEffect.jsx  形象/尺寸/情绪/话术改为 props，低垂改读 droop 字段
docs/STICKER.md、docs/API.md、docs/README.md、README.md、docs/OPERATIONS.md、
docs/PERFORMANCE.md、docs/DEV-HISTORY.md、CHANGELOG.md
```

### 2. ⚠️ 三个必须知道的注意事项

1. **不用手动建表**，但**要触发一次**：新表与播种挂在 `ensureUserColumnsOnce()` 上（老库升级链），
   部署后**访问一次后台任意页或用户页**就会自动建 5 张表 + 播种 4 个分类与磁盘上已有的 4 张素材。
   想更稳妥就直接执行一次 `db/schema.sql`（全是 `CREATE TABLE IF NOT EXISTS`）。
2. **上传的素材不在数据库里**：桌宠形象在 `public/pets/`、表情包素材在 `public/stickers/<分类>/`。
   打包上传**不会删掉**服务器上已有的文件（`\cp -rf` 只覆盖不删除），所以线上已有的素材是安全的；
   但**备份/迁移时要一起带走**（见 OPERATIONS.md 第一节第 5 条）。
   ⚠️ 反过来：在**本地**后台上传的图，线上没有这个文件 → 破图。本地测完请把那张形象删掉 / 停用。
3. **必须 `npm run build` + 重启**：本次改了 `lib/sticker-engine.js`（聊天热路径）与两个页面，
   不重启的话跑的仍是旧代码。老规矩：`pm2 delete solace && pm2 start ecosystem.config.js`。

### 3. 上线后三分钟自检

```bash
curl -s http://127.0.0.1:3000/api/health            # {"ok":true,...}
curl -s http://127.0.0.1:3000/api/pet               # 里面应有 5 条情绪
curl -s http://127.0.0.1:3000/api/stickers          # 里面应有 4 个分类、各 1 张图
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/api/admin/pet/images   # 401（未登录，正常）
```

然后登录后台，确认顶部多了「**桌宠**」「**表情包**」两个标签页，且都能列出现有内容。

### 4. 回滚

代码回滚即可。新加的 5 张表留着无害（旧代码不读它们），
`settings` 里多出的 `pet` / `sticker` 两个分组也无害；
但**已经发出去的表情包标记**（`[sticker:xxx]`）在旧代码里同样能被渲染，所以历史消息不受影响。

---

## 九、2026-10：语音朗读标签（文件清单 + 注意事项）

功能说明见 [CHANGELOG.md](../CHANGELOG.md) 顶部那一节，细则见 [`TTS.md`](./TTS.md)。
**没有新表、没有新配置分组** —— 三个新字段挂在已有的 `tts` 分组上，由默认值自动补齐，
**老库不需要任何升级动作**。

### 1. 要上传的文件

**新增（2 个）**

```
lib/tts-tags.js                            标签协议 + 剥离规则 + 提示词指令（前后端共用，唯一的规则实现）
app/api/tts/config/route.js                用户端语音配置（公开，只回 5 个字段）
```

**修改（8 个）**

```
lib/settings.js                            DEFAULTS.tts 增加 styleTags / styleTagWords / eventTagWords
lib/daily-memory.js                        每日记忆汇总：喂 AI 前剥掉 AI 侧标签
app/api/chat/route.js                      注入标签指令（并行读 tts 配置）+ 回喂历史前剥标签
app/api/tts/route.js                       配置只读一次；非 MiMo 时发上游前剥掉标签
app/api/user/conversations/title/route.js  生成标题前剥掉标签
app/chat/page.js                           进站拉 /api/tts/config；气泡渲染剥标签（含流式防闪）
app/admin/page.js                          「语音 TTS」页新增开关 + 两个词表
README.md / docs/*.md                      文档（见第九节第 3 条…即本节下面的说明）
```

### 2. 注意事项

1. **必须 `npm run build` + 重启**：改了 `lib/tts-tags.js`（聊天热路径）、
   `app/api/chat/route.js`、`app/chat/page.js` 三个"不重启就是旧代码"的位置。
   老规矩：`pm2 delete solace && pm2 start ecosystem.config.js`（顺序见本文第三节）。
2. ⚠️ **线上已于 2026-10-03 切到小米 MiMo（`mimo-chat`），所以这次上线后用户端立刻能看到效果**：
   AI 回复会带 `[温柔]` 这类标签（存进数据库），但气泡里显示的是剥掉标签的干净文字。
   换回 OpenAI 兼容协议（`openai-compatible`）则自动回到"不生成、仍旧剥"的安静状态。
3. **换回 OpenAI 兼容时不用改代码**：标签不会被生成，历史消息里的旧标签也会在朗读前剥掉。
4. **验收要看数据库**：气泡里看不到标签的同时，`messages.content` 里**必须还有标签** ——
   这是"存原文、显示剥离"的分界线，别把剥离做进了存库那一步。

### 3. 上线后三分钟自检

```bash
curl -s http://127.0.0.1:3000/api/health        # {"ok":true,...}
curl -s http://127.0.0.1:3000/api/tts/config    # 应含 styleTags / styleTagWords / eventTagWords，且不含 apiKey
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3000/api/tts   # 401（未登录，正常）
```

然后登录后台，确认「语音 TTS」页多了「**朗读标签**」开关和两个词表（词表里应是官方那两张表）。
⚠️ 三个新字段是**默认值补齐**的，所以后台一打开就能看到，不需要先保存一次。

### 4. 回滚

代码回滚即可。`settings` 里多出的三个字段对旧代码无害（旧代码不读它们），
**已经存进库的消息里带的标签**在旧代码里会**直接显示在气泡里**（旧代码不剥）——
这是唯一可见的残留。真要清掉就回滚后再把这几条消息的标签手工删掉，
或者干脆**不回滚**（新代码在非 MiMo 配置下的行为与旧代码一致）。
