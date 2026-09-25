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
cd /www/wwwroot/solace
pm2 stop solace && rm -rf .next && npm run build

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
