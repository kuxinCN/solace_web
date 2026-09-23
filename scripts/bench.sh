#!/usr/bin/env bash
#
# Solace 简易压测脚本
#
# 用法：
#   bash scripts/bench.sh                          # 默认：10 并发 × 20 次，打 /api/health
#   bash scripts/bench.sh 20 50                    # 20 并发 × 50 次
#   bash scripts/bench.sh 10 20 http://127.0.0.1:3000 /api/health
#
# 说明：
#   * 优先使用 ab（Apache Bench），没有则用 curl 并发兜底；
#   * 压测目标是本机回环地址，测的是「应用 + 数据库」的处理能力，
#     不包含跨境外网延迟 —— 这样得到的数据才是服务端真实性能。
#   * 不要对着 /api/chat 压测：那会真实消耗 AI 额度。
#
# ⚠️ Windows 上传后先执行：sed -i 's/\r$//' scripts/bench.sh
#
set -euo pipefail

CONCURRENCY="${1:-10}"
REQUESTS_PER_WORKER="${2:-20}"
BASE="${3:-http://127.0.0.1:3000}"
TARGET_PATH="${4:-/api/health}"
TOTAL=$((CONCURRENCY * REQUESTS_PER_WORKER))
URL="${BASE}${TARGET_PATH}"

echo "=============================================="
echo " 目标      : $URL"
echo " 并发      : $CONCURRENCY"
echo " 每并发次数: $REQUESTS_PER_WORKER"
echo " 总请求数  : $TOTAL"
echo "=============================================="

if command -v ab >/dev/null 2>&1; then
  echo "使用 ab 压测…"
  ab -n "$TOTAL" -c "$CONCURRENCY" -k "$URL"
  exit 0
fi

echo "未找到 ab，改用 curl 并发（结果略粗糙但足够看趋势）"
echo "提示：要更专业的报告，可执行  yum install -y httpd-tools  安装 ab"
echo "----------------------------------------------"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

START_MS=$(date +%s%3N)

worker() {
  local id="$1"
  local file="$TMP_DIR/$id.txt"
  : > "$file"
  for _ in $(seq 1 "$REQUESTS_PER_WORKER"); do
    curl -s -o /dev/null -w "%{http_code} %{time_total}\n" "$URL" >> "$file" || true
  done
}

for i in $(seq 1 "$CONCURRENCY"); do
  worker "$i" &
done
wait

END_MS=$(date +%s%3N)
ELAPSED_MS=$((END_MS - START_MS))

cat "$TMP_DIR"/*.txt > "$TMP_DIR/all.txt"

TOTAL_DONE=$(wc -l < "$TMP_DIR/all.txt" | tr -d ' ')
OK_COUNT=$(awk '$1 == 200' "$TMP_DIR/all.txt" | wc -l | tr -d ' ')
FAIL_COUNT=$((TOTAL_DONE - OK_COUNT))

awk -v elapsed_ms="$ELAPSED_MS" -v total="$TOTAL_DONE" -v ok="$OK_COUNT" -v fail="$FAIL_COUNT" '
{
  t = $2 * 1000;             # 秒 -> 毫秒
  sum += t; if (t > max) max = t;
  times[NR] = t;
}
END {
  n = NR;
  if (n == 0) { print "没有拿到任何响应"; exit }
  asort(times);
  p50 = times[int(n * 0.50) + 0];
  p95 = times[int(n * 0.95) + 0];
  p99 = times[int(n * 0.99) + 0];
  secs = elapsed_ms / 1000;
  printf "\n结果\n";
  printf "  成功 %d / 失败 %d （失败含非 200 响应与超时）\n", ok, fail;
  printf "  总耗时     : %.2f 秒\n", secs;
  printf "  吞吐 QPS   : %.1f 请求/秒\n", (secs > 0 ? total / secs : 0);
  printf "  平均响应   : %.1f ms\n", sum / n;
  printf "  P50 / P95 / P99 : %.1f / %.1f / %.1f ms\n", p50, p95, p99;
  printf "  最慢       : %.1f ms\n", max;
}
' "$TMP_DIR/all.txt"

echo ""
echo "解读建议："
echo "  * /api/health 会真实连接一次数据库，它的 P95 能反映数据库响应能力；"
echo "  * 首页 HTML（/）反映 Next.js 的渲染开销；"
echo "  * 如果 P95 远大于平均，说明有慢查询或连接池排队（可调 connectionLimit）；"
echo "  * 压测期间可以在另一个窗口跑：pm2 logs solace --lines 30"
