#!/usr/bin/env bash
#
# Solace 数据库自动备份
#
# 用法（在项目根目录执行）：
#   bash scripts/backup-db.sh
#
# 配置定时任务（每天凌晨 3 点备份，保留 7 天）：
#   crontab -e
#   然后加一行：
#   0 3 * * * cd /www/wwwroot/solace && bash scripts/backup-db.sh >> logs/backup.log 2>&1
#
# 可选环境变量：
#   BACKUP_DIR  备份目录（默认 <项目>/backups）
#   KEEP_DAYS   保留天数（默认 7）
#
# ⚠️ 如果这个文件是在 Windows 上编辑后上传的，先执行一次：
#     sed -i 's/\r$//' scripts/backup-db.sh
#   否则会报 "bash: $'\r': command not found"
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="$APP_DIR/config/db.json"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
KEEP_DAYS="${KEEP_DAYS:-7}"
STAMP="$(date +%Y%m%d-%H%M%S)"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

if [ ! -f "$CONFIG_FILE" ]; then
  log "错误：找不到 $CONFIG_FILE"
  log "请先登录后台 → 「数据库」页面 → 保存并生效，生成该配置文件后再运行本脚本。"
  exit 1
fi

if ! command -v mysqldump >/dev/null 2>&1; then
  log "错误：找不到 mysqldump 命令"
  log "CentOS 可执行：yum install -y mysql  （或使用宝塔自带的 /www/server/mysql/bin/mysqldump）"
  exit 1
fi

# 从 config/db.json 读取连接信息（用 node 解析，避免依赖 jq）
read_json() {
  node -e '
    const fs = require("fs");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(cfg[process.argv[2]] ?? ""));
  ' "$CONFIG_FILE" "$1"
}

DB_HOST="$(read_json host)"
DB_PORT="$(read_json port)"
DB_USER="$(read_json user)"
DB_PASS="$(read_json password)"
DB_NAME="$(read_json database)"

if [ -z "$DB_NAME" ]; then
  log "错误：config/db.json 里没有 database 字段"
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# 用临时配置文件传密码，避免密码出现在 ps 进程列表里
TMP_CNF="$(mktemp)"
chmod 600 "$TMP_CNF"
trap 'rm -f "$TMP_CNF"' EXIT
cat > "$TMP_CNF" <<EOF
[client]
host=${DB_HOST:-127.0.0.1}
port=${DB_PORT:-3306}
user=${DB_USER:-root}
password=${DB_PASS}
EOF

OUT_FILE="$BACKUP_DIR/${DB_NAME}-${STAMP}.sql.gz"

log "开始备份 $DB_NAME → $OUT_FILE"

# --single-transaction：InnoDB 一致性快照，不锁表，线上可安全执行
mysqldump \
  --defaults-extra-file="$TMP_CNF" \
  --single-transaction \
  --quick \
  --routines \
  --events \
  --default-character-set=utf8mb4 \
  "$DB_NAME" | gzip > "$OUT_FILE"

SIZE="$(du -h "$OUT_FILE" | cut -f1)"
log "备份完成，大小 $SIZE"

# 顺手把音乐目录也备一份：
# 音频存在磁盘上、不在数据库里，只备份数据库的话换服务器会丢掉所有音乐。
MUSIC_SRC="$APP_DIR/public/music"
if [ -d "$MUSIC_SRC" ] && [ -n "$(ls -A "$MUSIC_SRC" 2>/dev/null)" ]; then
  MUSIC_OUT="$BACKUP_DIR/music-${STAMP}.tar.gz"
  if tar czf "$MUSIC_OUT" -C "$APP_DIR/public" music 2>/dev/null; then
    log "音乐目录已备份，大小 $(du -h "$MUSIC_OUT" | cut -f1)"
  else
    log "⚠️ 音乐目录备份失败（不影响数据库备份）"
  fi
else
  log "跳过音乐备份（public/music 为空或不存在）"
fi

# 清理过期备份
DELETED="$(find "$BACKUP_DIR" -maxdepth 1 \( -name "${DB_NAME}-*.sql.gz" -o -name "music-*.tar.gz" \) -type f -mtime "+$KEEP_DAYS" -print -delete | wc -l)"
if [ "$DELETED" -gt 0 ]; then
  log "已清理 $DELETED 个超过 $KEEP_DAYS 天的旧备份"
fi

log "当前备份文件："
ls -lh "$BACKUP_DIR" | tail -n +2 | awk '{print "  " $9 "  " $5}'

# 提示：恢复方法
#   gunzip < backups/solace-20260919-030000.sql.gz | mysql -u root -p solace
