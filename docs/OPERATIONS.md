# Solace 运维手册

面向部署后的日常维护。部署流程见 `DEPLOY.md`，这里只讲**上线之后怎么保证它稳定运行**。

---

## 一、数据库自动备份（最重要）

**为什么必须做**：数据库是单点。误删数据、被人扫库、服务器故障，没有备份就直接归零。比赛/演示前尤其要有。

### 1. 脚本位置

```
scripts/backup-db.sh
```

它会自动读取 `config/db.json` 里的连接信息，把整库导出成 `backups/solace-日期时间.sql.gz`，并自动清理超过 7 天的旧备份。

### 2. 先手动跑一次，确认能成功

```bash
cd /www/wwwroot/solace

# ⚠️ 从 Windows 上传的文件可能带 CRLF 换行，先转一次
sed -i 's/\r$//' scripts/backup-db.sh

bash scripts/backup-db.sh
```

成功的话会看到：

```
[2026-09-19 03:00:01] 开始备份 solace → /www/wwwroot/solace/backups/solace-20260919-030001.sql.gz
[2026-09-19 03:00:03] 备份完成，大小 248K
[2026-09-19 03:00:03] 当前备份文件：
  solace-20260919-030001.sql.gz  248K
```

> 如果提示找不到 `mysqldump`：
> ```bash
> yum install -y mysql
> # 或直接用宝塔自带的（推荐）
> # 编辑脚本，把 mysqldump 换成 /www/server/mysql/bin/mysqldump
> ```

### 3. 配置每天自动备份

```bash
crontab -e
```

加入这一行（每天凌晨 3 点备份，日志写在 `logs/backup.log`）：

```
0 3 * * * cd /www/wwwroot/solace && bash scripts/backup-db.sh >> logs/backup.log 2>&1
```

确认已生效：

```bash
crontab -l
tail -n 20 /www/wwwroot/solace/logs/backup.log
```

### 4. 恢复方法（记住这条）

```bash
cd /www/wwwroot/solace
gunzip < backups/solace-20260919-030001.sql.gz | mysql -u root -p solace
```

> **建议**：把备份再复制一份到**别的机器或网盘**（比如每天 rsync 拉回自己电脑）。同一台服务器上的备份，遇到磁盘故障时一起丢。

---

## 二、pm2 日志轮转（防止磁盘被撑爆）

**为什么必须做**：pm2 默认**无限追加**日志。跑几个月后 `logs/pm2-out-0.log` 可能长到几个 G，**磁盘满 → 应用直接崩**。

### 安装（一次就够）

```bash
pm2 install pm2-logrotate

# 配置：单文件最大 20M，保留 7 个，每天切割一次
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
pm2 set pm2-logrotate:compress true

# 查看当前配置
pm2 conf pm2-logrotate
```

### 顺手清理 Nginx 日志

```bash
ls -lh /www/wwwlogs/ | sort -k5 -h | tail
```

如果 `solace.log` 很大，可以在宝塔的「网站 → 日志」里设置自动切割，或手动清理：

```bash
: > /www/wwwlogs/solace.log
```

---

## 三、健康检查接口

### 地址

```
GET /api/health
```

### 返回

```json
{
  "ok": true,
  "service": "solace",
  "time": "2026-09-19T17:20:00.000Z",
  "uptimeSeconds": 3600,
  "checks": {
    "app": { "ok": true },
    "database": { "ok": true, "version": "5.7.44" }
  },
  "latencyMs": 12
}
```

- `ok: true` + HTTP **200** → 一切正常
- `ok: false` + HTTP **503** → 数据库连不上，看 `checks.database.error`

### 用法

```bash
# 本机
curl -s http://127.0.0.1:3000/api/health | head -c 300

# 走域名
curl -s https://solace.l.cd/api/health
```

这个地址不含任何敏感信息（没有地址、账号、密码），可以放心接入宝塔监控或第三方可用性监控（如 UptimeRobot），网站挂了会给你发提醒。

---

## 四、日常巡检清单（每周 2 分钟）

```bash
cd /www/wwwroot/solace

# 1. 服务是否活着、重启次数是否异常
pm2 list

# 2. 健康检查
curl -s https://solace.l.cd/api/health

# 3. 备份是否在正常产生
ls -lh backups/ | tail -5

# 4. 磁盘和内存
df -h /
free -h

# 5. 最近的应用错误
tail -n 30 logs/pm2-error-0.log

# 6. 有没有别人在扫你的服务
tail -n 50 /www/wwwlogs/solace.log | grep -E '(/\.env|/wp-|/admin\.php)' | head
```

---

## 五、常见故障速查

| 现象 | 先查什么 | 常见原因 |
|---|---|---|
| 整站 `Internal Server Error` | `pm2 logs solace --lines 100 --nostream` | `.next` 构建不完整（删 `.next` 重新 build）；数据库连不上 |
| 域名 500 但 `127.0.0.1:3000` 正常 | `grep proxy_pass /www/server/panel/vhost/nginx/node_solace.conf` | **跑了两个实例**，Nginx 指向了旧的；或宝塔把端口写回去了 |
| 页面能开但按钮点不动 | 看是不是只有移动端/某个运营商 | 首屏 JS 加载慢（水合延迟）；开 gzip / 静态资源走 CDN |
| 移动用户特别慢 | `https://ping.pe/服务器IP` | CN2 线路对移动不友好，静态资源走 CDN |
| 后台登录提示"账号已锁定" | `SELECT failed_attempts, locked_until FROM admin_users;` | 连续错 5 次锁 10 分钟，清掉即可：`UPDATE admin_users SET failed_attempts=0, locked_until=NULL;` |
| 数据库连不上 | `systemctl status mysqld` | MySQL 没启动；密码变了；`config/db.json` 丢了 |

---

## 六、改动代码后的标准流程

**务必按这个顺序**，避免出现"改了不生效 / 一半生效"：

```bash
cd /www/wwwroot/solace

# 1. 确认只有一个实例在跑
pm2 list
ss -lntp | grep -E ':3000|:3001'

# 2. 构建（一定要看到 ✓ Compiled successfully）
npm run build

# 3. 重启
pm2 restart solace

# 4. 验证
curl -s -o /dev/null -w "本机: %{http_code}\n" http://127.0.0.1:3000/api/health
curl -s -o /dev/null -w "域名: %{http_code}\n" https://solace.l.cd/api/health
```

> **铁律**：构建产物更新后，**所有**跑着旧产物的进程都必须重启。同一个项目跑两个实例时，只重启一个就会出现"域名 500、IP 正常"的怪现象。
