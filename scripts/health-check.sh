#!/usr/bin/env bash
#
# Solace 全站体检脚本
#
# ⚠️ 这是**只读**脚本：只采集信息，不重启服务、不改配置、不删文件。
#
# 用法：
#   cd /www/wwwroot/solace
#   bash scripts/health-check.sh
#
# 结果会打印到屏幕，同时存一份到 backups/health-YYYYmmdd-HHMM.txt
# 把输出发出来，据此定优化方案。
#
set -u

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$APP_DIR/backups"
STAMP="$(date +%Y%m%d-%H%M)"
OUT_FILE="$BACKUP_DIR/health-${STAMP}.txt"

mkdir -p "$BACKUP_DIR"

# 边打印边存文件
run() {
  echo ""
  echo "==================================================================="
  echo "== $1"
  echo "==================================================================="
}

# 所有输出同时写文件
exec > >(tee "$OUT_FILE") 2>&1

echo "Solace 全站体检报告"
echo "时间：$(date '+%Y-%m-%d %H:%M:%S')"
echo "主机：$(hostname)  系统：$(cat /etc/redhat-release 2>/dev/null || uname -sr)"
echo "应用目录：$APP_DIR"
echo "报告文件：$OUT_FILE"

# ---------------------------------------------------------------- 1
run "1. CPU 与负载"
echo "CPU 核数：$(nproc)"
uptime
echo ""
echo "（判读：load average 三个值都低于核数 = 很闲；接近或超过核数 = 吃紧）"

# ---------------------------------------------------------------- 2
run "2. 内存与 swap"
free -h
echo ""
echo "--- swap 明细 ---"
swapon --show 2>/dev/null || echo "（没有启用 swap）"
echo ""
echo "--- 内存占用 TOP 5 ---"
ps -eo pid,ppid,%cpu,%mem,rss,comm --sort=-%mem | head -6
echo ""
echo "（判读：available 有几百 MB 以上 = 够用；swap 被大量使用 = 内存吃紧）"

# ---------------------------------------------------------------- 3
run "3. 磁盘"
df -h / /www 2>/dev/null | sort -u
echo ""
echo "--- inode 使用率 ---"
df -i / | tail -1
echo ""
echo "--- /tmp 占用 ---"
du -sh /tmp 2>/dev/null

# ---------------------------------------------------------------- 4
run "4. 关键进程占用"
for name in node mysqld nginx php-fpm; do
  line="$(ps -eo pid,%cpu,%mem,rss,etime,comm | awk -v n="$name" '$6==n')"
  if [ -n "$line" ]; then
    echo "--- $name ---"
    echo "  PID   %CPU  %MEM   RSS(KB)  运行时长"
    echo "$line"
    total_rss="$(echo "$line" | awk '{s+=$4} END {print s}')"
    echo "  合计 RSS：$((total_rss / 1024)) MB"
  else
    echo "--- $name：未运行 ---"
  fi
done
echo ""
echo "（判读：node 单进程 RSS 超过 500MB、或 %CPU 长期 > 50% = 需要关注）"

# ---------------------------------------------------------------- 5
run "5. pm2 状态"
if command -v pm2 >/dev/null 2>&1; then
  pm2 list 2>/dev/null || echo "pm2 list 执行失败"
  echo ""
  echo "--- pm2 日志体积 ---"
  for f in "$APP_DIR"/logs/*.log; do
    [ -f "$f" ] && ls -lh "$f" | awk '{print "  " $9 "  " $5}'
  done
else
  echo "（未安装 pm2，可能用的是宝塔 Node 项目管理）"
fi

# ---------------------------------------------------------------- 6
run "6. 端口监听"
if command -v ss >/dev/null 2>&1; then
  ss -lntp 2>/dev/null | grep -E "LISTEN" || ss -lnt
else
  netstat -lntp 2>/dev/null | grep LISTEN
fi
echo ""
echo "（判读：3000 端口只应有一个进程监听，出现两行以上说明起了两个实例）"

# ---------------------------------------------------------------- 7
run "7. MySQL"
DB_CONF="$APP_DIR/config/db.json"
DB_USER="root"
DB_PASS=""
DB_NAME=""

if [ -f "$DB_CONF" ]; then
  read_json() {
    grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$DB_CONF" 2>/dev/null \
      | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//'
  }
  DB_USER="$(read_json username)"
  DB_PASS="$(read_json password)"
  DB_NAME="$(read_json database)"
  [ -z "$DB_USER" ] && DB_USER="root"
fi

if [ -n "$DB_NAME" ]; then
  TMP_CNF="$(mktemp)"
  chmod 600 "$TMP_CNF"
  trap 'rm -f "$TMP_CNF"' EXIT
  cat > "$TMP_CNF" <<EOF
[client]
host=127.0.0.1
port=3306
user=${DB_USER}
password=${DB_PASS}
EOF

  MY="mysql --defaults-extra-file=$TMP_CNF -N -B"

  echo "--- 连接与线程 ---"
  # ⚠️ @@Uptime 不是系统变量，MySQL 5.7 会报 Unknown system variable —— 要从 SHOW GLOBAL STATUS 取
  $MY -e "SELECT CONCAT('当前连接数: ', COUNT(*)) FROM information_schema.PROCESSLIST;
          SELECT CONCAT('最大连接数: ', @@max_connections);
          SELECT CONCAT('连接使用率: ', ROUND(COUNT(*)/@@max_connections*100, 1), '%') FROM information_schema.PROCESSLIST;" 2>/dev/null || echo "  连接失败，跳过"

  UP="$(mysql --defaults-extra-file="$TMP_CNF" -N -B -e "SHOW GLOBAL STATUS LIKE 'Uptime'" 2>/dev/null | awk '{print $2}')"
  if [ -n "$UP" ]; then
    echo "  MySQL 已运行: $(awk -v s="$UP" 'BEGIN{printf "%.1f", s/3600}') 小时"
  fi

  echo ""
  echo "--- 关键参数 ---"
  $MY -e "SELECT CONCAT('innodb_buffer_pool_size: ', ROUND(@@innodb_buffer_pool_size/1024/1024), ' MB');
          SELECT CONCAT('max_allowed_packet: ', ROUND(@@max_allowed_packet/1024/1024), ' MB');
          SELECT CONCAT('slow_query_log: ', @@slow_query_log);
          SELECT CONCAT('long_query_time: ', @@long_query_time);" 2>/dev/null || true

  echo ""
  echo "--- 数据库各表大小 TOP 10 ---"
  $MY -e "SELECT table_name AS 表名,
                  table_rows AS 行数,
                  ROUND((data_length+index_length)/1024/1024, 1) AS 大小MB
             FROM information_schema.TABLES
            WHERE table_schema='$DB_NAME'
            ORDER BY (data_length+index_length) DESC
            LIMIT 10;" 2>/dev/null || echo "  查询失败，跳过"

  echo ""
  echo "--- 数据库总大小 ---"
  $MY -e "SELECT CONCAT(ROUND(SUM(data_length+index_length)/1024/1024, 1), ' MB') AS 总大小
             FROM information_schema.TABLES
            WHERE table_schema='$DB_NAME';" 2>/dev/null || true

  echo ""
  echo "--- 慢查询条数（本次启动以来）---"
  $MY -e "SHOW GLOBAL STATUS LIKE 'Slow_queries';" 2>/dev/null || true

  echo ""
  echo "--- 表数量 ---"
  $MY -e "SELECT CONCAT(COUNT(*), ' 张表') FROM information_schema.TABLES WHERE table_schema='$DB_NAME';" 2>/dev/null || true
else
  echo "（读不到 config/db.json 里的 database，跳过 MySQL 检查）"
fi

# ---------------------------------------------------------------- 8
run "8. Nginx"
# 宝塔的 nginx 错误日志路径不止一种，挨个探测
NGINX_ERR=""
for candidate in /www/wwwlogs/error.log /www/wwwlogs/nginx_error.log /var/log/nginx/error.log /www/server/nginx/logs/error.log; do
  if [ -f "$candidate" ]; then
    NGINX_ERR="$candidate"
    break
  fi
done

if [ -n "$NGINX_ERR" ]; then
  echo "日志文件：$NGINX_ERR"
  echo "--- 错误日志尾部 15 行 ---"
  tail -15 "$NGINX_ERR"
  echo ""
  echo "--- 错误日志体积 ---"
  ls -lh "$NGINX_ERR" | awk '{print "  " $5}'
else
  echo "（找不到 $NGINX_ERR，尝试其他位置）"
  ls -lh /www/wwwlogs/*.log 2>/dev/null | awk '{print "  " $9 "  " $5}' | head -10
fi

# ---------------------------------------------------------------- 9
run "9. 应用接口耗时（本机直连 3000）"
for path in "/" "/api/health" "/api/music/playlist"; do
  result="$(curl -s -o /dev/null -w "%{http_code}  %{time_total}s  %{size_download} bytes" \
    --max-time 10 "http://127.0.0.1:3000${path}" 2>/dev/null)"
  printf "  %-28s %s\n" "$path" "${result:-请求失败}"
done
echo ""
echo "（判读：time_total > 1s 就要查；/api/health 应该很快）"

# ---------------------------------------------------------------- 10
run "10. 静态资源体积"
echo "--- public 目录 ---"
du -sh "$APP_DIR/public" 2>/dev/null
du -sh "$APP_DIR/public/music" 2>/dev/null || echo "  public/music 不存在"
echo ""
echo "--- public 下各子目录 ---"
du -sh "$APP_DIR/public"/* 2>/dev/null | sort -rh | head -10
echo ""
echo "--- .next 构建产物 ---"
du -sh "$APP_DIR/.next" 2>/dev/null
du -sh "$APP_DIR/.next/static" 2>/dev/null
echo ""
echo "--- node_modules ---"
du -sh "$APP_DIR/node_modules" 2>/dev/null

# ---------------------------------------------------------------- 11
run "11. 日志体积"
for dir in "$APP_DIR/logs" /www/wwwlogs "/root/.pm2/logs"; do
  if [ -d "$dir" ]; then
    echo "--- $dir ---"
    du -sh "$dir" 2>/dev/null
    ls -lhS "$dir" 2>/dev/null | head -6 | awk 'NR>1 {print "  " $9 "  " $5}'
  fi
done

# ---------------------------------------------------------------- 12
run "12. 备份情况"
if [ -d "$BACKUP_DIR" ]; then
  echo "备份目录：$BACKUP_DIR"
  du -sh "$BACKUP_DIR" 2>/dev/null
  echo ""
  echo "--- 最近 5 个备份 ---"
  ls -lht "$BACKUP_DIR" 2>/dev/null | head -6
else
  echo "（还没有 backups 目录）"
fi

# ---------------------------------------------------------------- 13
run "13. 系统日志里的异常信号"
echo "--- 最近的内核 OOM 记录 ---"
dmesg 2>/dev/null | grep -i "out of memory" | tail -3 || echo "  （读不到 dmesg 或被限制）"
echo ""
echo "--- journalctl 里的 mysql/node 异常（最近 20 条）---"
journalctl -u mysqld --no-pager -n 10 2>/dev/null | tail -10 || echo "  （journalctl 不可用）"

# ---------------------------------------------------------------- 摘要
run "摘要（把这一段发我就行）"
{
  echo "CPU 核数　　　：$(nproc)"
  echo "负载(1/5/15)　：$(uptime | sed 's/.*load average: //')"
  echo "内存　　　　　：$(free -h | awk '/Mem:/ {print "总 " $2 " / 已用 " $3 " / 可用 " $7}')"
  echo "Swap　　　　　：$(free -h | awk '/Swap:/ {print "总 " $2 " / 已用 " $3}')"
  echo "根分区　　　　：$(df -h / | awk 'NR==2 {print "总 " $2 " / 已用 " $3 " (" $5 ") / 可用 " $4}')"
  echo "Node RSS　　：$(ps -eo rss,comm | awk '$2=="node" {s+=$1; n++} END {if(n) printf "%d MB (%d 个进程)\n", s/1024, n; else print "未运行"}')"
  echo "MySQL RSS　　：$(ps -eo rss,comm | awk '$2=="mysqld" {printf "%d MB\n", $1/1024}')"
  echo "3000 端口　　：$(ss -lntp 2>/dev/null | grep -c ':3000' ) 个监听"
  echo "public 体积　：$(du -sh "$APP_DIR/public" 2>/dev/null | cut -f1)"
  echo ".next 体积　　：$(du -sh "$APP_DIR/.next" 2>/dev/null | cut -f1)"
  echo "报告文件　　　：$OUT_FILE"
} 2>/dev/null

echo ""
echo "==================================================================="
echo "体检完成。把上面这段「摘要」以及需要关注的区块发出来即可。"
echo "完整报告已存到：$OUT_FILE"
echo "==================================================================="
