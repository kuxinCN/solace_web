# 还能做的优化清单

> 生成时间：2026-09-21
> 前提：已完成一轮全站体检（见 `PERFORMANCE.md`），本文件只列**还没做**的。
> 已修复的不在此列（慢查询、PM2 内存配置）。

---

## 已完成的（不用再看）

| 项 | 状态 |
|---|---|
| 后台概览慢查询 600-700ms → 先聚合再 JOIN | ✅ 已改代码 |
| `messages(created_at, user_id)` 覆盖索引 | ⚠️ 已给命令，**待你执行** |
| PM2 `node_args` + `max_memory_restart` 匹配 | ✅ 已改配置 |
| 消息本地缓存（localStorage 持久化） | ✅ 已做 |
| 音乐音频走 Node 路由（绕开 Nginx 静态规则） | ✅ 已做 |
| 音乐防盗链 | ✅ 已做 |
| 回收站 / 记忆删除接进回收站 | ✅ 已做 |
| 修改密码五项校验 | ✅ 已做 |
| `pm2-logrotate` 日志轮转 | ✅ 已装 |
| 2G swap | ✅ 已加 |

---

# P0 —— 该做，直接影响或安全

## P0-1. ⚠️ 检查 MySQL `innodb_buffer_pool_size`

**为什么**：体检时这条查询报错了（我脚本的锅），所以**这个值到现在还不知道**。它是 MySQL **最重要的一个参数** —— 缓存表数据和索引的地方。

**如果它太小**（MySQL 5.7 默认 **128MB**），那么每次查询都要去读磁盘，**所有 SQL 都会慢**。

**先查**：

```bash
mysql -uroot -p'你的密码' -N -B -e "
SELECT CONCAT('buffer_pool: ', ROUND(@@innodb_buffer_pool_size/1024/1024), ' MB');
SELECT CONCAT('buffer_pool_instances: ', @@innodb_buffer_pool_instances);
SELECT CONCAT('库总大小: ', ROUND(SUM(data_length+index_length)/1024/1024, 1), ' MB')
  FROM information_schema.TABLES WHERE table_schema='solace';
SELECT CONCAT('buffer pool 命中率: ',
  ROUND((1 - (SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME='Innodb_buffer_pool_reads')
           / (SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME='Innodb_buffer_pool_read_requests')) * 100, 2), '%');
"
```

**判读**：

| 看到什么 | 结论 |
|---|---|
| `buffer_pool` ≥ 库总大小 | ✅ 够了，不用动 |
| `buffer_pool` 明显小于库大小 | ⚠️ 调大 |
| **命中率 < 99%** | ⚠️ **说明在频繁读磁盘，一定要调** |
| 命中率 ≥ 99.9% | ✅ 很好 |

**怎么调**（假设库 100MB 以内，服务器可用内存 2G）：

```bash
# 宝塔 → 软件商店 → MySQL → 配置修改
# 或直接编辑：
vim /etc/my.cnf        # 宝塔一般是 /www/server/mysql/etc/my.cnf

# 在 [mysqld] 段加：
innodb_buffer_pool_size = 256M      # 建议值：库大小的 2-4 倍，且不超过可用内存的 40%
innodb_buffer_pool_instances = 1    # 小内存机器设为 1，避免每个实例额外开销

# 重启生效（会短暂断连）
systemctl restart mysqld
```

**⚠️ 注意**：这台机器可用内存 2G，**不要超过 512M**，否则会和 Node 抢内存。

**预期收益**：如果原来是 128M，调大后**所有查询都会快**（尤其是带排序、聚合的那些）。

**风险**：低。重启 MySQL 会断连几秒。

---

## P0-2. ⚠️ 检查 Nginx 有没有开 gzip

**为什么**：JS/CSS 压缩后能小 **60-70%**。你首屏要下载的东西少一半，手机上体感差别很明显。

**先查**：

```bash
grep -rn "gzip" /www/server/nginx/conf/nginx.conf | head -10
```

**如果没有 `gzip on;`**：

```bash
vim /www/server/nginx/conf/nginx.conf
# 在 http { } 段里加：
gzip on;
gzip_min_length 1k;
gzip_comp_level 5;
gzip_types text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml;
gzip_vary on;
gzip_disable "msie6";

nginx -t && nginx -s reload
```

**验证**：

```bash
curl -H "Accept-Encoding: gzip" -sI http://127.0.0.1:3000/ | grep -i content-encoding
curl -H "Accept-Encoding: gzip" -sI https://solace.l.cd/ | grep -i content-encoding
```

**⚠️ 注意**：Next.js 自己也会压缩。如果最后一行有 `content-encoding: gzip`，说明**已经开了**（不管是 Nginx 还是 Next 开的），就不用动。

**预期收益**：首屏 JS/CSS 传输体积**减少 60% 以上**。

**风险**：无。改完 `nginx -t` 验证语法再 reload。

---

## P0-3. ⚠️ 降低 `vm.swappiness`

**为什么**：你的 swap 被用掉了 **302MB**。默认 `swappiness=60` 意味着"内存用到六成就开始往 swap 搬东西"。对于一个需要快速响应的 Web 应用，**这会让响应变慢**（swap 在磁盘上）。

**先查**：

```bash
cat /proc/sys/vm/swappiness
```

**如果 ≥ 30**：

```bash
# 临时生效
sysctl vm.swappiness=10

# 永久生效
echo "vm.swappiness=10" >> /etc/sysctl.conf
sysctl -p
```

**判读**：

| 值 | 含义 |
|---|---|
| 60（默认） | 内存一紧张就搬 swap，Web 应用不推荐 |
| **10** | **只在快 OOM 时才用 swap**，响应更稳 ✅ |
| 0 | 完全不用 swap（也不太好，失去缓冲） |

**⚠️ 注意**：改完**不会立刻把已用的 swap 释放**。想立刻释放（会短暂卡顿）：

```bash
# 可选，不急的话不用做
swapoff -a && swapon -a
```

**预期收益**：内存压力下响应更稳定，不再"突然卡一下"。

**风险**：极低。

---

## P0-4. ⚠️ 关闭 3000 端口对外

**为什么**：Nginx 用 `127.0.0.1:3000` 反代，**对外开这个端口没有任何用处**，只意味着别人能**绕过 Nginx 用 HTTP 明文直接访问你的应用**（绕过 HTTPS、绕过 Nginx 的限流规则）。

**先确认 Nginx 是走本机**：

```bash
grep -rn "proxy_pass" /www/server/panel/vhost/nginx/ | grep 3000
# 期望看到：proxy_pass http://127.0.0.1:3000;
```

**确认是 127.0.0.1 之后**：

```bash
firewall-cmd --permanent --remove-port=3000/tcp
firewall-cmd --reload
firewall-cmd --list-ports
```

**验证**：从外网访问 `http://154.201.67.103:3000` 应该**连不上**；`https://solace.l.cd` 仍然正常。

**风险**：低。但如果 Nginx 配的是 `154.201.67.103:3000` 而不是 `127.0.0.1:3000`，关掉会导致 502 —— **所以第 1 步的确认不能省**。

---

## P0-5. ⚠️⚠️ 检查密钥是不是还在用默认值

**为什么**：`lib/secret-box.js` 里，用户密码的 AES 加密密钥取值顺序是：

```
USER_PASSWORD_KEY（环境变量） → CODE_SECRET（环境变量） → 内置默认值
```

**如果两个环境变量都没设**，就是在用**源码里写死的默认密钥** —— 意味着**任何拿到源码的人都能解密你数据库里所有用户的密码**。

**先查**：

```bash
cd /www/wwwroot/solace

# 看有没有 .env.local，里面有没有设这两个变量
ls -la .env.local 2>/dev/null && grep -E "USER_PASSWORD_KEY|CODE_SECRET" .env.local

# 看 pm2 启动时带了哪些环境变量
pm2 describe solace | grep -A 30 "env"
```

**如果没设**：

```bash
cd /www/wwwroot/solace
cat >> .env.local <<'EOF'
# 用户密码可逆加密的密钥（32 字节的随机字符串）
# 生成方式：openssl rand -base64 32
USER_PASSWORD_KEY=在这里粘贴你生成的随机串
EOF

chmod 600 .env.local
```

**生成密钥**：

```bash
openssl rand -base64 32
```

**⚠️⚠️⚠️ 严重警告**：

**改这个密钥会导致"已存在用户的密码无法解密"**（因为旧密码是用旧密钥加密的）。

所以：
- ✅ **如果现在库里全是测试数据** → **随便改**，改完让用户重新设密码
- ⚠️ **如果已经有真实用户** → **不能直接改**，需要写迁移脚本（用旧密钥解密、新密钥加密，逐条更新）

**鉴于你说过"线上全是测试数据"，现在是最好的时机** —— 越晚改成本越高。

**风险**：改完必须重启应用，且要考虑存量数据（见上）。

---

# P1 —— 体验明显提升

## P1-1. ⚠️ 头像/背景图上传时先在浏览器压缩

**为什么**：现在的头像和背景图是 **base64 存数据库、随接口下发**。如果用户传一张 3MB 的手机照片：

- **上传**：3MB 走一遍网络
- **存储**：base64 后变成 **4MB**（膨胀 33%）存在 `users.avatar_url`
- **每次下发**：聊天页面每个接口都可能带上它 → **4MB 又走一遍**
- **服务端处理**：每次读出来、序列化、发出去，**占 Node 内存和 CPU**

**这很可能就是"内存涨到 600MB 被 PM2 重启"的元凶之一。**

**怎么做**（前端，用 canvas）：

```jsx
/**
 * 在浏览器里把图片压到指定尺寸和大小，再上传。
 * 一般能把 3MB 的照片压到 100-200KB，视觉上几乎无差别。
 */
async function compressImage(file, { maxSize = 512, quality = 0.82 } = {}) {
  const bitmap = await createImageBitmap(file);

  // 等比缩放到 maxSize 以内
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);

  // WebP 优先（同画质下比 JPEG 小 30%），不支持时退回 JPEG
  const type = canvas.toDataURL("image/webp").startsWith("data:image/webp")
    ? "image/webp"
    : "image/jpeg";

  return canvas.toDataURL(type, quality);
}
```

**建议参数**：

| 用途 | maxSize | quality |
|---|---|---|
| **头像** | **256** | 0.82 |
| **AI 头像** | **256** | 0.82 |
| **聊天背景** | **1280** | 0.78 |
| **我的页封面** | **1280** | 0.78 |

**预期收益**：
- 头像从 3MB → **约 30KB**（**减少 99%**）
- 接口响应明显变小，**内存压力大幅下降**
- 手机端加载变快

**风险**：低。但要**保留原图裁剪逻辑**（现在用的 `react-easy-crop`，裁剪后拿到的是 canvas，本来就有压缩的好时机）。

---

## P1-2. ⚠️ TTS 合成结果缓存（省钱）

**为什么**：现在每次让 AI "读出来"，都要调一次小米 MiMo 的 TTS 接口 —— **按量付费**。

但很多内容是**重复的**：
- 预设的情绪安抚话术（内容安全命中时返回的那些）
- 常见的"我在听""嗯，你说"这类短句
- 同一条 AI 回复被重复播放（用户来回切页面）

**怎么做**：在服务端用「文本内容的哈希」当 key，把音频缓存到磁盘：

```js
// lib/tts-cache.js（新文件）
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CACHE_DIR = path.join(process.cwd(), "public", "tts-cache");
const MAX_AGE_MS = 30 * 24 * 3600 * 1000; // 30 天

/** 文本 → 缓存文件名（sha256 前 32 位 + 模型名 + 音色） */
function keyOf({ text, voice, model }) {
  return crypto
    .createHash("sha256")
    .update(`${model}|${voice}|${text}`)
    .digest("hex")
    .slice(0, 32);
}

export function readTtsCache(key) {
  const file = path.join(CACHE_DIR, `${key}.mp3`);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > MAX_AGE_MS) {
      fs.unlinkSync(file);
      return null;
    }
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

export function writeTtsCache(key, buffer) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `${key}.mp3`), buffer);
  } catch {
    /* 写失败不影响主流程 */
  }
}

export { keyOf };
```

**接入点**：`app/api/chat/tts/route.js`（或你现在的 TTS 接口）里，调 API 之前先查缓存。

**⚠️ 注意**：`public/tts-cache/` 也要**加进备份**（和 `public/music` 一样）。

**预期收益**：内容安全话术、常用短句的 TTS **完全不花钱**了。按你现在全站测试的调用量，**可能省掉一半以上的 TTS 费用**。

**风险**：极低。缓存目录要定期清理（可以加进 `scripts/cleanup.mjs`）。

---

## P1-3. 悬浮会话时预取消息

**为什么**：现在切对话要等接口返回（虽然有缓存了，但第一次打开还是要等）。

**怎么做**：鼠标悬停在会话列表某项上 **200ms 后**，静默预取那个对话的消息：

```jsx
const prefetchTimer = useRef(null);

// 在会话列表项上：
onMouseEnter={() => {
  prefetchTimer.current = setTimeout(() => {
    if (getCachedMessages(conv.id)) return;   // 已有缓存就不用预取
    apiRequest(`/api/user/messages?conversationId=${conv.id}`)
      .then((data) => {
        if (data?.messages) touchMessagesCache(conv.id, data.messages);
      })
      .catch(() => {});
  }, 200);                                    // 200ms 防抖：只是划过不算
}}
onMouseLeave={() => clearTimeout(prefetchTimer.current)}
```

**为什么是 200ms**：用户真的想点那个对话时，手会在上面停留；只是扫一眼滑过去的话，200ms 内就走了，**避免无用的预取把连接池占满**。

**预期收益**：**点开对话基本是瞬时的**（比单纯缓存更进一步 —— 缓存是"你打开过才有"，预取是"你还没点就好了"）。

**风险**：低。但要**限制并发**（同时最多预取 2 个），否则鼠标快速划过会连发十几个请求。

---

## P1-4. 静态资源加长缓存头

**为什么**：Next.js 的 `.next/static/` 里的文件名带内容哈希（`main-a1b2c3d4.js`），**内容变了文件名就变** —— 这类文件**可以缓存一年**。

**怎么做**（Nginx 里给这些路径加）：

```nginx
# 在 solace 站点的 nginx 配置里（宝塔 → 网站 → 设置 → 配置文件）
location ^~ /_next/static/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    expires 1y;
    add_header Cache-Control "public, immutable";
}

# public 目录里的图片（表情包等），文件名不带哈希，缓存 7 天比较稳妥
location ^~ /stickers/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    expires 7d;
}

# 音乐：内容不变，缓存 1 天
location ^~ /api/music/file {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    # 注意：这里不加 expires，因为响应里已经有 Cache-Control
}
```

**⚠️ 改完必须 `nginx -t && nginx -s reload`**。

**预期收益**：用户第二次访问**不再重新下载 JS/CSS**，首屏快很多。

**风险**：中。**`immutable` 用错会导致用户更新不到新版** —— 所以只对 `/_next/static/` 用（那里文件名带哈希，安全）。

---

## P1-5. 歌单接口加短缓存

**为什么**：`/api/music/playlist` 每次进站都查一次库。但歌单**很少改**。

**怎么做**：在 `app/api/music/playlist/route.js` 的响应里加：

```js
return json(
  { ok: true, music, tracks, neteaseTracks },
  200,
  { "Cache-Control": "public, max-age=30, stale-while-revalidate=300" }
);
```

**含义**：
- **30 秒内**浏览器直接用缓存，**不发请求**
- **30 秒后**先用旧数据渲染，**后台再去更新**
- 后台改了歌单，最多 30 秒后生效

**预期收益**：进站的请求数少一个；服务器压力略降。

**风险**：低。但如果后台刚改完歌单想立刻看到效果，可能要等 30 秒（可以刷新强制）。

---

# P2 —— 稳定性与可观测性

## P2-1. ⚠️ 备份异地存放（**一直没做，最该补的一项**）

**为什么**：现在备份和数据库**在同一台机器上**。如果服务器磁盘坏了、被删库、或者服务商跑路 —— **备份和源数据一起没了**。

**这是唯一一个"平时看不出用、出事时救命"的东西。**

**怎么做（最简单可行的方案）**：

**方案 A：备份完自动传到另一台机器**（如果组员有别的服务器）

```bash
# 在 scripts/backup-db.sh 末尾加：
rsync -avz -e ssh "$BACKUP_DIR/" user@另一台机器:/backups/solace/ --delete
```

**方案 B：传到对象存储**（阿里云 OSS / 腾讯云 COS / 七牛）

```bash
# 用 ossutil / coscmd 之类的命令行工具
ossutil cp -r "$BACKUP_DIR/" oss://你的bucket/solace/ --update
```

**方案 C：最省事 —— 用宝塔的"计划任务"传到又拍云/七牛**

宝塔自带「网站备份」+「云存储」插件，可以设定时上传。

**方案 D：应急方案 —— 定期下载到本地**

```bash
# 在你自己的电脑上（Windows PowerShell）：
scp -r root@154.201.67.103:/www/wwwroot/solace/backups/ "E:\solace-backups\"
```

**⚠️ 无论用哪种，关键是：备份不能只存在数据库所在的那台机器上。**

---

## P2-2. ⚠️ 备份恢复演练（**一直没做**）

**为什么**：**没验证过的备份等于没有备份。** 你可能在真正需要恢复的那天才发现备份是坏的、或者不会恢复。

**怎么做**：找一台机器（或者本机开个 MySQL 容器），把备份导入进去，确认数据完整。

```bash
# 在测试环境（不要在生产库上做！）：
mysql -uroot -p'密码' -e "CREATE DATABASE solace_test CHARACTER SET utf8mb4;"
gunzip < backups/solace-20260921-xxxx.sql.gz | mysql -uroot -p'密码' solace_test

# 验证：对比关键表的行数
mysql -uroot -p'密码' -N -B -e "
SELECT 'users', COUNT(*) FROM solace_test.users UNION ALL
SELECT 'messages', COUNT(*) FROM solace_test.messages UNION ALL
SELECT 'diaries', COUNT(*) FROM solace_test.diaries;
"

# 和线上对比，行数应该一致（或接近）
mysql -uroot -p'密码' -N -B -e "
SELECT 'users', COUNT(*) FROM solace.users UNION ALL
SELECT 'messages', COUNT(*) FROM solace.messages UNION ALL
SELECT 'diaries', COUNT(*) FROM solace.diaries;
"
```

**做完把步骤补进 `docs/OPERATIONS.md`** —— 这样以后忘了也能照着做。

**预期收益**：心里有底。答辩时被问"你的数据安全怎么保证"也能答。

---

## P2-3. ⚠️ 接外部监控（一直在建议）

**为什么**：现在服务器挂了，**你只能等用户反馈才知道**。加上你是参赛作品，评委可能在你不知道的时候访问。

**怎么做**（免费方案）：

1. `/api/health` 接口**已经有了**
2. 注册 [UptimeRobot](https://uptimerobot.com/) 或 [BetterStack](https://betterstack.com/)（都免费）
3. 添加监控：`https://solace.l.cd/api/health`
4. 间隔 **5 分钟**，告警方式选**邮件**
5. 再加一条：`https://solace.l.cd/`（首页）

**预期收益**：服务器挂了 **5 分钟内**你会收到邮件。

**风险**：无。

**⚠️ 注意**：免费版 UptimeRobot 每 5 分钟一次，**对服务器几乎无负担**（`/api/health` 只要 20ms）。

---

## P2-4. 完善 PM2 配置（防疯狂重启）

**为什么**：现在 `autorestart: true` 但没设**重启上限**。如果代码有个 bug 导致启动就崩，PM2 会**无限重启**，把 CPU 和日志打满。

**怎么做**（`ecosystem.config.js`）：

```js
{
  name: "solace",
  // ... 现有配置 ...
  autorestart: true,

  // ⚠️ 防止"启动就崩 → 无限重启"打满 CPU 和日志
  min_uptime: "20s",        // 跑够 20 秒才算"启动成功"
  max_restarts: 10,         // 20 秒内最多重启 10 次
  restart_delay: 3000,      // 两次重启之间至少隔 3 秒
  exp_backoff_restart_delay: 100,  // 指数退避：越失败等得越久

  // 优雅关闭：给应用 8 秒处理完正在进行的请求
  kill_timeout: 8000,

  // 合并日志（单实例其实不需要，但多实例时有用）
  merge_logs: true,
}
```

**预期收益**：即使代码出问题，**服务器不会被拖死**，也能从日志看出问题。

**风险**：低。

---

# P3 —— 有余力再做

## P3-1. 拆分 `app/chat/page.js`（4512 行）

**为什么**：单文件 4500 行，**改一处要通读全文**，风险高。而且**整个文件都会进 bundle**。

**怎么做**：按功能拆成 `components/chat/` 下的子组件：

```
components/chat/
  ChatMessages.jsx      消息列表 + 气泡
  ChatInput.jsx         输入框 + 发送
  ConversationList.jsx  会话列表
  DiaryPanel.jsx        日记
  ProfilePanel.jsx      我的
  MemoryPanel.jsx       记忆
```

**预期收益**：
- 可维护性大幅提升
- **按需加载**（切到日记 tab 才下载日记组件）→ 首屏 bundle 变小

**风险**：**高**。4500 行的重构，很容易引入 bug。
**建议**：**比赛期间不要动**，等有充裕时间再做。

---

## P3-2. 图片从 base64 改成存磁盘

**为什么**：base64 存库虽然部署简单，但：
- **体积膨胀 33%**
- **每次下发都要从数据库读出来**
- 数据库体积涨得快

**怎么做**：像音频一样，存 `public/uploads/`，数据库只存路径。

**预期收益**：接口响应变小、数据库变小、内存压力下降。

**风险**：**高**。涉及：
- 所有读写头像/背景的代码
- 存量数据的迁移脚本
- 备份脚本要加上 `public/uploads/`
- **组员前端也要改**（如果他在别处用了这个字段）

**建议**：**先做 P1-1（上传时压缩）**，那个收益 90%，风险只有 10%。

---

## P3-3. 排查其他慢查询

**为什么**：日志里只暴露了那一条（因为后台概览被频繁访问）。**其他接口可能也有慢查询，只是没被触发到。**

**怎么做**：

```bash
# 1. 打开 MySQL 慢查询日志（如果没开）
mysql -uroot -p'密码' -e "
SET GLOBAL slow_query_log = 'ON';
SET GLOBAL long_query_time = 0.3;
SET GLOBAL log_queries_not_using_indexes = 'ON';
"

# 2. 跑一段时间后看慢查询日志
tail -100 /www/server/data/mysql-slow.log 2>/dev/null || \
  tail -100 /var/lib/mysql/*slow*.log 2>/dev/null

# 3. 或者用应用自己的慢查询日志（lib/db.js 里有 SLOW_QUERY_MS = 300）
grep "慢查询" logs/pm2-error.log | tail -30
```

**另外，后台的 `/api/admin/metrics` 能看到所有接口的耗时排行** —— 部署后打开看看，找 `p95` 最高的几个。

**预期收益**：找到 1-2 个隐藏的慢点。

**风险**：无（只读）。

---

## P3-4. 调整数据库连接池

**为什么**：现在 `connectionLimit: 5`。虽然当前连接数只有 2，但如果同时来 6 个请求，第 6 个要**排队等**。

**怎么做**（`lib/db.js`）：

```js
const pool = mysql.createPool({
  // ...
  connectionLimit: 10,      // 从 5 提到 10
  queueLimit: 0,            // 排队不设上限（默认）
  waitForConnections: true,
});
```

**⚠️ 注意**：**不是越大越好**。MySQL 的 `max_connections` 是 500，但每个连接都要占内存。**10 是个合理的值**（够用且不浪费）。

**预期收益**：并发时不再排队。

**风险**：低。

---

# 优先级总览

| 优先级 | 项目 | 收益 | 风险 | 工作量 |
|---|---|---|---|---|
| **P0-1** | MySQL buffer pool 检查 | ⭐⭐⭐ | 低 | 10 分钟 |
| **P0-2** | Nginx gzip 检查 | ⭐⭐⭐ | 无 | 5 分钟 |
| **P0-3** | 降低 swappiness | ⭐⭐ | 极低 | 2 分钟 |
| **P0-4** | 关 3000 对外 | ⭐⭐（安全） | 低 | 5 分钟 |
| **P0-5** | **检查密钥是否默认值** | ⭐⭐⭐（安全） | 中 | 15 分钟 |
| **P1-1** | **上传图片压缩** | ⭐⭐⭐ | 低 | 1 小时 |
| **P1-2** | **TTS 缓存** | ⭐⭐⭐（省钱） | 极低 | 1 小时 |
| **P1-3** | 悬浮预取 | ⭐⭐ | 低 | 30 分钟 |
| **P1-4** | 静态资源长缓存 | ⭐⭐⭐ | 中 | 20 分钟 |
| **P1-5** | 歌单短缓存 | ⭐ | 低 | 5 分钟 |
| **P2-1** | **备份异地** | ⭐⭐⭐（救命） | 无 | 30 分钟 |
| **P2-2** | **恢复演练** | ⭐⭐⭐ | 无 | 1 小时 |
| **P2-3** | 外部监控 | ⭐⭐⭐ | 无 | 15 分钟 |
| **P2-4** | PM2 防疯重启 | ⭐⭐ | 低 | 10 分钟 |
| P3-1 | 拆分 chat/page.js | ⭐⭐ | **高** | 数天 |
| P3-2 | 图片改磁盘 | ⭐⭐ | **高** | 数天 |
| P3-3 | 排查其他慢查询 | ⭐⭐ | 无 | 30 分钟 |
| P3-4 | 连接池 5→10 | ⭐ | 低 | 5 分钟 |

---

# 建议的执行顺序

**第一波（今晚就能做完，全是配置）**

```bash
# 1. swappiness
sysctl vm.swappiness=10 && echo "vm.swappiness=10" >> /etc/sysctl.conf

# 2. 查 buffer pool 和 gzip（先查再决定改不改）
mysql -uroot -p'密码' -N -B -e "SELECT ROUND(@@innodb_buffer_pool_size/1024/1024);"
grep -c "gzip on" /www/server/nginx/conf/nginx.conf

# 3. 关 3000 对外
firewall-cmd --permanent --remove-port=3000/tcp && firewall-cmd --reload
```

**第二波（明天，要动代码）**

- P0-5 密钥检查（**越早越好，因为没有真实数据时成本最低**）
- P1-1 图片压缩（**收益最大的一个代码改动**）
- P2-3 接监控（15 分钟，但救命）

**第三波（有时间再做）**

- P1-2 TTS 缓存
- P2-1 备份异地
- P2-2 恢复演练

**比赛期间不要碰**

- P3-1 拆分 `page.js`
- P3-2 图片改磁盘
