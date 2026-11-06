# 全站体检与优化方案

> 体检时间：2026-09-21
> 环境：4 核 / 3.6G 内存 / 30G 磁盘 · CentOS 8.5 · MySQL 5.7 · Next.js 14
> 体检方式：`scripts/health-check.sh`（只读脚本）

---

## 一、体检结论

| 维度 | 得分 | 依据 |
|---|---|---|
| CPU | 🟢 **优秀** | 负载 `0.26` / 4 核 = **只用 6.5%** |
| 内存 | 🟡 **偏紧** | available `2.0G`，但 swap 已被用掉 **302MB** |
| 磁盘 | 🟢 **优秀** | 30G 用 7.8G（**26%**） |
| 应用响应 | 🟢 **优秀** | `/` **6.5ms** · `/api/health` **20ms** · `/api/music/playlist` **42ms** |
| MySQL 连接 | 🟢 **优秀** | **2 / 500** |
| 进程稳定性 | 🔴 **有问题** | pm2 **重启 208 次**（平均每 21 分钟一次） |
| 慢查询 | 🔴 **有问题** | 后台概览一条 SQL **600-700ms** |

---

## 二、🔴 已修复的问题

### 2.1 慢查询：后台概览 600-700ms

**现象**（来自 `logs/pm2-error.log`）：

```
[db] 慢查询 724ms：SELECT u.id, u.email, u.username, u.avatar_url, COUNT(m.id) AS messageCount
                   FROM users u JOIN messages m ON m.user_id = u.id ...
```

**根因**：原来是

```sql
SELECT u.id, u.email, u.username, u.avatar_url, COUNT(m.id) AS messageCount
  FROM users u
  JOIN messages m ON m.user_id = u.id
 WHERE m.created_at >= ?
 GROUP BY u.id, u.email, u.username, u.avatar_url
 ORDER BY messageCount DESC
 LIMIT 5
```

三件事同时发生：
1. **两个表 JOIN 后再分组、再排序** → 临时表 + 文件排序
2. **`WHERE` 只有 `created_at`，而 `messages` 上没有以它开头的索引** → 全表扫
3. **`GROUP BY` 带了 4 个字段**（其中 3 个是 `users` 的），无法用索引完成

**改成**（`app/api/admin/dashboard/route.js`）：

```sql
SELECT u.id, u.email, u.username, u.avatar_url, t.cnt AS messageCount
  FROM (
    SELECT user_id, COUNT(*) AS cnt
      FROM messages
     WHERE created_at >= ?
     GROUP BY user_id
     ORDER BY cnt DESC
     LIMIT 5
  ) t
  JOIN users u ON u.id = t.user_id
 ORDER BY t.cnt DESC
```

**为什么快**：聚合阶段只碰 `messages` 一张表（能吃覆盖索引），JOIN 阶段只处理 **5 行**。

**配套索引**（见 2.3）。

### 2.2 PM2 反复重启 208 次

**现象**：

```
│ restarts           │ 208        │
│ max memory restart │ 629145600  │  ← 600MB
│ uptime             │ 13m        │  ← 13 分钟前刚重启
│ unstable restarts  │ 0          │  ← 不是"崩溃后快速重启"
```

**根因**：**`max_memory_restart` 和 V8 堆上限不匹配**。

- V8 默认堆上限 = **物理内存的一半** → 3.6G 机器上约 **1.8G**
- 也就是 Node 自己觉得"我还能用 1.8G"，**但 PM2 一到 600MB 就直接杀**
- 结果就是「应用还在正常跑，却被 PM2 反复重启」

`unstable restarts = 0` 正好印证：不是崩溃，是**稳定运行一段后被阈值杀掉**。

**修法**（`ecosystem.config.js`）：

```js
node_args: "--max-old-space-size=450",   // 堆到 450MB 就让 GC 积极回收
max_memory_restart: "700M",              // GC 也压不住时的安全网
```

**⚠️ 生效方式**：`node_args` 是**启动参数**，`pm2 restart` **不会重新读取**，必须：

```bash
pm2 delete solace
pm2 start ecosystem.config.js
```

### 2.3 需要手动执行的索引

```sql
-- 给 messages 加一条覆盖索引：WHERE created_at >= ? GROUP BY user_id
-- 有了它，上面那条聚合查询可以只读索引、不回表
ALTER TABLE `messages`
  ADD INDEX `idx_msg_created_user` (`created_at`, `user_id`);
```

**⚠️ 执行前先看表有多少行**：

```sql
SELECT COUNT(*) FROM messages;
```

- **10 万行以内**：直接执行，几秒钟
- **更多**：加 `ALGORITHM=INPLACE, LOCK=NONE` 避免锁表

```sql
ALTER TABLE `messages`
  ADD INDEX `idx_msg_created_user` (`created_at`, `user_id`),
  ALGORITHM=INPLACE, LOCK=NONE;
```

**验证是否走索引**：

```sql
EXPLAIN SELECT user_id, COUNT(*) FROM messages
 WHERE created_at >= '2026-09-01' GROUP BY user_id;
-- 期望：key = idx_msg_created_user，Extra 里没有 "Using temporary; Using filesort"
```

---

## 三、🟡 建议处理（待你确认）

### 3.1 `opencode` 占 305MB

```
PID     RSS      COMMAND
1036708 305232   /root/.opencode/bin/opencode serve --hostname 127.0.0.1 --port 4096
```

它一个人吃了服务器 **8.5% 的内存**（比 MySQL 的 272MB 还多）。同时在本地开了 4096 端口。

**如果是临时工具、现在不用了**：

```bash
kill 1036708
# 禁止以后随机启动（如果在 systemd 里注册过）
systemctl disable opencode 2>/dev/null
```

### 3.2 `dockerd` 占 111MB

```
158012aaa8bc  ghcr.io/jasonxu114514/opencode2api:latest  Up 7 hours
             127.0.0.1:18080->8080/tcp, 127.0.0.1:18081->8081/tcp
```

服务器上跑着一个叫 `opencode2api` 的容器。**如果不需要**：

```bash
docker stop opencode2api && docker rm opencode2api
systemctl stop docker && systemctl disable docker
```

**两项合计可释放约 416MB 内存**，swap 占用会明显下降。

### 3.3 ⚠️ 安全：3000 端口对外暴露

```
查到的端口：20 21 22 80 443 888 3000 3306 39000-40000 41195 8888
```

**3000 端口对外开放意味着可以绕过 Nginx、以 HTTP 明文直接访问应用。**
Nginx 本身是用 `127.0.0.1:3000` 反代的，所以对外开这个端口**没有用**。

```bash
# 先确认 Nginx 是不是走本机回环
grep -r "proxy_pass" /www/server/panel/vhost/nginx/ | head

# 确认后关掉
firewall-cmd --permanent --remove-port=3000/tcp
firewall-cmd --reload
```

### 3.4 ⚠️ 安全：3306 全网开放

组员本地开发要连这台库，**不能直接关**，但可以加白名单：

```bash
# 先问组员的公网 IP，再执行：
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="组员IP" port port=3306 protocol=tcp accept'
firewall-cmd --permanent --remove-port=3306/tcp
firewall-cmd --permanent --remove-port=3306/udp
firewall-cmd --reload
```

⚠️ **如果组员是动态 IP（家用宽带）/ 经常换网络，就别加白名单**，改为：

```sql
-- 至少给数据库账号限来源主机
-- （在宝塔 → 数据库 → 权限 里改，或直接执行）
```

### 3.5 宝塔面板端口（41195 / 8888）对外

建议在宝塔设置里开启 **「面板 SSL」** + **「面板授权 IP」**。

### 3.6 FTP（20 / 21）

如果不用 FTP 传文件（宝塔文件管理器 / scp 就够）：

```bash
systemctl stop pure-ftpd && systemctl disable pure-ftpd
firewall-cmd --permanent --remove-port=20/tcp
firewall-cmd --permanent --remove-port=21/tcp
firewall-cmd --reload
```

---

## 四、⚪ 可以忽略的（不是问题）

| 现象 | 说明 |
|---|---|
| `Error: Failed to find Server Action "x"` | **用户浏览器缓存了旧版页面**，部署后必然出现几条。用户刷新即可，无害 |
| `public/music` 只有 4K | 还没有上传本地歌曲，正常 |
| `logs/` 692K | `pm2-logrotate` 生效了，很健康 |
| Nginx `nginx_error.log` 是 0 字节 | 说明没有错误 |
| swap 用了 302MB | 处理完 3.1 / 3.2 后会自然下降 |

---

## 五、❌ 明确**不需要**做的

| 想法 | 为什么不用做 |
|---|---|
| 加内存 / 换服务器 | available 还有 2G，处理完 3.1/3.2 就宽裕了 |
| 上 Redis | 连接数只有 2，会话和配置量极小，纯增加复杂度 |
| 上 CDN | 图片都在数据库里，静态资源才 356K |
| 再优化接口 | 已经 6-42ms，继续优化是浪费 |
| 加更多索引 | 表都很小，加多了反而拖慢写入 |
| 负载均衡 / 多实例 | 负载 6.5%，一台绰绰有余；而且会话是进程内的，多实例会出 bug |
| 图片改存 OSS | 收益是带宽，但现在没有带宽压力 |

---

## 六、执行顺序

```bash
# ① 部署本次代码（含慢查询修复 + PM2 配置）
#     ⚠️ 先构建、最后才切换服务（INC-014）；.next 不用删，next build 会自己覆盖
cd /www/wwwroot/solace
npm run build

# ② 加索引（先看行数）
mysql -uroot -p'密码' solace -e "SELECT COUNT(*) FROM messages;"
mysql -uroot -p'密码' solace -e "ALTER TABLE messages ADD INDEX idx_msg_created_user (created_at, user_id);"

# ③ ⚠️ 必须 delete + start（node_args 是启动参数，restart 不生效）
pm2 delete solace
pm2 start ecosystem.config.js

# ④ 验证配置生效
pm2 describe solace | grep -Ei "restarts|max memory|uptime|node args"

# ⑤ 观察 30 分钟，看重启次数有没有再涨
watch -n 60 'pm2 describe solace | grep restarts'
```

---

## 七、优化效果预期

| 指标 | 优化前 | 优化后（预期） |
|---|---|---|
| 后台概览那条 SQL | **600-700ms** | **< 50ms** |
| pm2 重启频率 | 每 21 分钟一次 | **稳定，不再重启** |
| 可用内存 | 2.0G | **2.4G+**（如果停掉 opencode/docker） |
| swap 占用 | 302MB | **< 200MB** |
| 偶发"打不开" | 存在 | **消失** |

---

## 八、复检

改完之后再跑一次体检：

```bash
cd /www/wwwroot/solace
bash scripts/health-check.sh
```

重点看：
- `摘要` 里的 **负载** 和 **内存**
- pm2 的 **restarts** 是否停止增长
- `logs/pm2-error.log` 里 **还有没有慢查询**

---

## 九、2026-10：桌宠 / 表情包配置化的性能处理

这两个功能的内容改成了「后台可配、数据库驱动」，于是聊天热路径上多了**读一次分类配置**这件事。
做法与代价记在这里，免得以后有人看到"多了一次查询"就当成退步：

| 处理 | 为什么这么做 |
|---|---|
| 表情包分类配置（spec）带 **30 秒进程内缓存**（`lib/sticker-store.js` 的 `SPEC_TTL_MS`） | 它本来要 2 次查询（分类 + 素材），而**每条用户消息**都会用到 —— 不缓存等于每条消息多 2 次库往返。分类是"改一次管很久"的东西，30 秒足够 |
| 后台任何写操作立刻 `invalidateStickerSpec()` | 有缓存就必须有失效。否则管理员改完要等最多 30 秒才生效，他会以为"没保存上"然后再改一遍 |
| 桌宠配置走**一次拿全**的公开接口 `GET /api/pet` | 用户点情绪是即时交互：那一刻再去请求，动画就要等网络往返。所以进站预取好（同理 `/api/stickers`） |
| 表情包总开关关闭时**直接返回** | 关掉的功能连情绪判定都不做（省一次判定 + 两次查询） |
| 读配置失败回落出厂默认、不重试 | 配置读不到不该让功能整个消失；不重试则保证"库有问题时也不会把热路径拖慢" |
| 进站多出两个轻量请求（`/api/pet`、`/api/stickers`） | 都不阻塞聊天，响应很小；`/api/pet` 还是组件挂载后才拉，不参与首屏 |
| 图片体积 | 上传限制 2MB，但**桌宠兜底图仍是 1.26MB 的 1269×1239 PNG**（首访会白花这笔流量，见 `docs/PET.md` §七）—— 想省流量就把它压到 200×200 以内 |

> 实测口径：改完跑 `bash scripts/health-check.sh`，**没有新增慢查询**；
> 聊天首字延迟不受影响（表情包判定本来就是并行发起、流末才取结果，见 `docs/STICKER.md` §五）。

---

## 十、2026-10：语音朗读标签的性能处理

这个功能在生成侧给每次对话**多加了一段 system 指令**、在展示侧给每条消息**多加了一次文本处理**。
两处都做了处理，记在这里免得被当成"白白多花的开销"：

| 处理 | 为什么这么做 |
|---|---|
| TTS 配置与 AI 配置**并行读**（`Promise.all([getGroup("ai"), getGroup("tts")])`） | 标签指令要不要注入取决于 TTS 分组，但**不能为此多加一次串行库往返** —— 首字延迟是这个项目最敏感的数字 |
| 不生效时**一条 system 都不加**（函数返回空串） | 接口类型不是 MiMo 的部署（例如换回 `openai-compatible`）在这条路径上是**零变化**：不注入、不剥、不多读一次配置内容 |
| 展示侧剥离走**开括号快路径**（`/[\[［(（<]/` 不命中直接原样返回） | 绝大多数消息根本不含标签。先做一次不含 `g` 的廉价判定，能挡掉大部分消息，省下"每次构造一个几十分支的正则" |
| 解析好的词表**存 state、不存原始配置** | 词表在渲染期每条消息都要用；不能每次渲染都把那 80 个词重新解析一遍 |
| 词表为空/读不到 → 回落出厂值；配置读不到 → 两端都不动手 | 与第九节同一条原则：配置有问题不能让功能消失，也不能把热路径拖慢（**不做重试**） |
| 多了一次公开的轻量请求 `/api/tts/config` | 进站拉一次、只回 5 个字段（不含密钥与地址），不阻塞聊天；拉不到就不剥（等于没上这个功能） |
| 代价：每次对话的输入**长约 600 字符**（约 300～400 token） | 这是"让模型按词表选标签"必须付的成本。嫌贵就缩后台的两个词表 —— 指令长度随之线性下降，不用改代码 |
| 代价：**只有不剥标签的服务端副本**（`/api/tts` 在非 MiMo 时多一次 `stripTtsTags`） | 一次字符串处理，与网络请求相比可忽略 |

> ⚠️ 一个**不需要担心**的点：标签只写在助手的回复里，**不会进标题、不会进记忆** ——
> 标题生成和每日记忆汇总在喂给 AI 之前都先剥一遍（见 `docs/TTS.md` §一）。

---

## 十一、2026-10：聊天 SSE 首字延迟 + 记忆衰减每日任务

### 11.1 首字慢：不是模型慢，是"开流前在串行等库"

聊天接口在 `fetch(上游 AI)` 之前要读好几样东西：登录会话、AI/TTS 配置、心理画像、记忆候选、内容安全配置。
它们**互不依赖**，但早先是串着 `await` 的 —— 每多一次远端往返，首字就晚 0.5~1.5 秒。

| 处理 | 为什么这么做 |
|---|---|
| 画像查询提到最前面，与记忆候选、配置**同时发起**（`Promise.all` 语义，用到时再 `await`） | 它只是"读一次画像表 + 本地映射"，没有任何理由排在配置读完之后 |
| `checkUserContent` 在 `request.json()` 之后**立刻发起** | 它只依赖本轮用户原话（纯正则 + 一次带 30 秒缓存的 safety 配置读取）；等记忆读完再检测 = 白等一次库往返 |
| 记忆查询超时 **800 → 500ms**（`withMemoryTimeout`） | 记忆是锦上添花：远端库抖动时，宁可这轮不注入，也不把首字拖到 1 秒以上 |
| 记忆注入硬顶 **800 → 500 字**（`MEMORY_TOTAL_CHARS`） | 输入越短 TTFT 越快；500 字仍能装下"画像 + 2 条日报 + 4 条常驻 + 最相关的几条"，因为拼装是从末尾（最相关）往前装的 |
| 每次对话打一条 `[chat] prompt: total=… system=…(blocks=…) history=…` | **只有长度，不含内容**。以后首字再变慢，看日志就知道是人格提示词、画像、记忆还是历史在涨，不用猜 |
| 贴纸决策在流尾 **最多等 400ms** | 它本来与文字流并行，正常早就有结果；但 AI 兜底最长要几秒，不能让它把 `[DONE]` 拖住（前端要等流结束才落库、才能发下一句） |
| 记忆唤醒 `markMemoriesAccessed` **不 await** | 一条 UPDATE 而已，写在主链路上等于白等一次往返 |

前端侧（`app/chat/page.js`）：SSE 每几十毫秒一个 delta，原先每个都 `setMessages`（整条消息数组 map），
中文长回复时肉眼可见地卡。现在用 `createDeltaThrottle` **60ms 合批**，`replace` / `error` / 流结束强制 flush ——
既降了渲染次数，也不会丢最后一段。

> 实测口径：`/api/chat` 的 `[chat] prompt` 日志 + 浏览器 Network 里的首字节时间。
> 开流前的库查询从"串行 3~4 次"变成"并行 1 轮"，正常网络下首字能省 1 秒上下（具体看远端库 RTT）。

### 11.2 记忆衰减：每天一条 UPDATE，不碰聊天热路径

衰减与遗忘（`lib/memory-decay.js`）只挂在 `lib/scheduler.js` 的**每日日期槽**里，
聊天请求只多了一次 fire-and-forget 的唤醒 UPDATE（被注入的记忆 ≤20 条）。

| 处理 | 为什么这么做 |
|---|---|
| 强度按 **绝对天数重算**（`100 - 天数 × 速率`），不做"每日递减" | 幂等：重启、补跑、跨天重复执行都不会多扣一次，也不会因为进程没跑而少扣 |
| 一条 `UPDATE … CASE …` 算完全表 | 逐行 `SELECT` + `UPDATE` 在远端库上会慢得离谱；SQL 里只按类别分支，不调 AI |
| `WHERE last_accessed_at < NOW() - INTERVAL 1 DAY` + `LIMIT 5000` | 跳过刚写入/刚唤醒的行（本来就在 100），并给单次执行一个上限；`ORDER BY` 从最旧开始，避免老数据被饿死 |
| 截字与回收都分批（`LIMIT` + 每 200 条一批删除） | 一条超长 SQL 容易锁表；分批失败也只影响那一批 |
| 归零先写 `trash` 再删 | 自动删除没有用户操作兜底，规则万一误判还得能捞回来（保留 3 天） |
| 存量数据补列时填 `strength=100 / last_accessed_at=NOW()` | 宽限期：否则上线当天，库里躺了几个月的记忆会被一夜清空 |

> 记忆量特别大的部署：调大 `DECAY_BATCH`，或把任务改成"按用户分批"（当前单实例、单次 5000 条足够）。

---

## 十二、2026-10：记忆星云（3D 电子云）为什么不卡

「记忆库」从列表 → 2D Canvas → force-graph 3D 星云 → **原生 Three.js 电子云**（`components/MemoryGraph3D.jsx`）。
这一版没有力导向引擎、也没有动画循环，每条都设了硬边界：

| 处理 | 为什么这么做 |
|---|---|
| **没有 requestAnimationFrame 循环** | 只在拖拽 / 缩放 / 悬停 / 数据变化时渲染一帧；没人操作时场景**完全静止**（不转、不呼吸、不漂移），CPU / GPU 归零 |
| `OrbitControls.autoRotate = false` + `enableDamping = false` | 自动旋转的开关只有一个；关掉阻尼后松手立即停，没有惯性 |
| **3000 粒子 = 1 个 `Points` + 1 个 `PointsMaterial`** | 一次 BufferGeometry 上传；半径用高斯分布（σ≈52、上限 155）→ 球心厚实、外围稀疏 |
| **150 个节点 = 150 个 `Sprite`，共用 1 张 256×256 星芒贴图** | ⛔ 没有 `SphereGeometry`：节点是 2D 贴图，颜色靠 `SpriteMaterial.color` 染色；150 个节点只有 1 份纹理显存，重建时 `disposeTree()` 跳过 `isSprite` 的（three 内部共享）几何 |
| 光晕 = Sprite + 一张 128×128 径向渐变贴图（共享） | 比再套一层半透明球省 draw call；贴图只生成一次，卸载统一释放 |
| **所有连线合并成 1 个 `LineSegments`** | 每条连线单独建对象会有 300+ draw call；合并后只有 1 个，顶点色区分亮暗 |
| 突触封顶：每节点额外度数 ≤4、额外连线 ≤180 条 | 相似度连线 + 同分类随机连线会成倍增长，不封顶几何体会爆 |
| **节点硬上限 150**（服务端 `graph=1` 的 `MAX_GRAPH_NODES` + 客户端 `slice(0, MAX_NODES)` 双重） | 超出时按「**有效 → 核心 → 强度降序**」排序：先被裁掉的正是**已失效 / 最弱的边缘记忆**，活跃核心不会因为条数多而被挤掉 |
| 记忆星云**按需加载**：`MemoriesModal` 用 `next/dynamic` + `memoriesOpen` 门控，内部 `MemoryGraph3D` 再套一层 dynamic | 首屏不下载 three（WebGL）；第一次点「记忆库」才拉 chunk，文件名带 hash 指纹（`_next/static/chunks/*-<hash>.js`，`immutable` 长缓存），关掉再开直接读缓存 |
| `SpriteMaterial` / `PointsMaterial`、不用光照 / 阴影 / 后处理 | 发光感 = 贴图自带柔光 + 加法混合 (模拟 Bloom)；真上 Bloom 要整屏后处理，代价远大于收益 |
| 拾取用"不可见放大的 Sprite"（scale ×1.3，且 `visible=false`）+ 单个 raycaster | 命中区**不参与渲染** → 每次渲染的 draw call 减半（150 节点：≈300 → ≈150）；⚠️ Raycaster **不检查 `visible`**（three 只在渲染阶段跳过），所以照样点得中 |
| **WebGL 不可用 / 渲染出错 → 退回列表视图** | 关闭硬件加速、驱动黑名单、显存耗尽时 `new WebGLRenderer` 会直接抛异常；`MemoryGraph3D` 接住并回调 `onUnsupported`，`MemoriesModal` 再用错误边界 + 列表替身兜底（列表**不创建任何 three 对象**，开销最低，也不会白屏） |
| 搜索 / 分类筛选只**调透明度与 scale**，不重建场景 | 重建 = 重新生成 150 个 Sprite + 连线缓冲，还会让布局闪一下 |
| **画布透明 + CSS 深空渐变 / 星点** | 背景交给 CSS（零 WebGL 成本）；`alpha:true` + `setClearColor(0x000000, 0)` |
| **卸载清理**：取消 rAF → `controls.dispose()` → dispose 几何/材质/贴图 → `renderer.dispose()` → `forceContextLoss()` | 弹窗反复开关最容易泄漏 WebGL 上下文 |
| `ssr: false` 动态加载 | three 会碰 window / WebGL，不能在服务端预渲染阶段执行 |

> 实测（本机 dev）：点云中心密集、外围稀疏；节点是**彩色星芒贴图**（金 / 青 / 紫 / 灰蓝）；
> 正中心是一颗只比最亮记忆星稍大稍亮的亮白星芒（不刺眼），名字不常驻、悬停才弹「核心（暖言）」；
> 静止时画面不动；拖拽/滚轮可用；不可见放大的 Sprite 让悬停/点击稳定命中；卸载后无 canvas 残留。
> 代价：只需 `three` 一个依赖（`react-force-graph-3d` / `three-spritetext` 已移除），组件懒加载，不影响聊天首屏。

---

## 十三、2026-10：远端 MySQL 慢查询治理（会话 / 配置 / 冷启动）

**现象**：日志里一条接一条的 `[db] 慢查询` ——

- `SELECT ... FROM user_sessions s JOIN users u ...` **500~900ms**，几乎每个 user_* 接口都有一条；
- `SELECT value FROM settings WHERE name = ?` **300~540ms**；
- `CREATE TABLE IF NOT EXISTS ...` 300ms 级、一次刷几十条；
- `/api/user/diaries`、`/api/user/conversations` 首次请求 **8~10 秒**。

**根因**：全不是「SQL 本身慢」，而是**远端库的往返次数**。单次往返约 100~500ms，
把次数乘上「每个接口都查一次」就很可观。

| 根因 | 说明 |
|---|---|
| **每个接口都查一次登录会话** | `getCurrentUser()` 是几乎所有 `user_*` 接口的第一句。聊天页一次加载会并发 5~6 个接口 —— 同一个 token 被查 5~6 次。索引没问题（`user_sessions.token_hash` 是主键） |
| **配置缓存太短** | `getGroup()` 只缓存 30 秒，而聊天一次要读 ai / tts / safety / sticker 等多个分组，等于每半分钟就重新付一次往返 |
| **建表把 31 条 CREATE 全跑一遍** | `ensureTables()` 以前无条件执行全部 `CREATE TABLE IF NOT EXISTS`，每条一次往返，冷启动白等约 10 秒。`IF NOT EXISTS` 对已存在的表本来也不会更新列，跑它没有意义 |
| **"只跑一次"用布尔标记 + 补列串行** | 7 个 `ensureXxxColumns` 串行叠加；更要命的是布尔标记要等第一轮跑完才置位，**并发进来的请求会各自再跑一整轮**（日志里同一条 CREATE TABLE 连刷好几次就是这个） |

**处理**：

| 改动 | 效果 |
|---|---|
| `lib/user-auth.js` 加会话短缓存（`token_hash` → 用户，TTL 30 秒，上限 500 条） | 同一 token 的重复查询直接消失；退出登录 / 改邮箱 / 后台改用户 / 用户改资料都**主动失效**（`invalidateUserSessionCache`） |
| `lib/settings.js` 分组缓存 30 秒 → **5 分钟** | 后台保存时 `saveGroup()` 会 `invalidateCache(group)`，所以不影响"改完立即生效" |
| `lib/schema.js` 的 `ensureTables()` 先查一次现有表，**只建缺的** | 冷启动少掉约 30 次往返 |
| `ensureUserColumnsOnce()` 改成 **Promise 单例**（并发请求共享同一个任务）+ 补列步骤 `Promise.all` 并行 | 并发首屏不再重复跑升级链，串行等待压成一次往返级别 |
| `/api/user/profile` PUT、`/api/user/email` PUT、`/api/admin/users` PUT 补 `invalidateUserSessionCache` | 保证昵称 / 头像 / AI 人格 / 封禁不被 30 秒缓存拖慢 |

**实测（本机 dev + 远端库，同一临时会话）**：

| 接口 | 改前 | 改后（二次请求，已排除 dev 编译） |
|---|---|---|
| `/api/user/memories?graph=1` | ~12s（冷）/ 1s+ | **0.27~0.48s** |
| `/api/user/conversations` | 8~10s | **0.30s** |
| `/api/user/profile` | 1.1~2.3s | **0.27s** |
| `/api/user/diaries` | 8~10s | **0.16~0.41s** |

> ⚠️ 首次请求仍会慢一点：dev 模式下每个路由要现场编译（`Compiling ...`），
> 生产环境（`next build` 后）没有这部分开销，只看冷启动的升级链（现在只剩一次往返级别）。
> ⚠️ 会话缓存 30 秒是**安全与性能的折中**：不用等缓存过期来保证"封禁生效"，
> 所有能主动失效的入口都已经显式失效了；新增"改用户状态"的入口时别忘了调 `invalidateUserSessionCache`。

