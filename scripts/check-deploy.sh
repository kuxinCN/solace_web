#!/bin/bash
#
# Solace 部署完成检查 —— 跑一遍就知道"这次到底部署上了没有"。
#
# 用法（服务器上）：
#   bash /www/wwwroot/solace/scripts/check-deploy.sh
#
# ⚠️ 为什么需要它：部署命令是一条 `&&` 链 ——
#    `pm2 stop` → `rm -rf .next` → `npm run build` → `pm2 start`
#    SSH 一断、或者构建失败，链子就停在中间，**最怕停在 `pm2 stop` 之后** ——
#    那时进程没了、`.next` 可能还被删了，站点直接 down。
#    所以这个脚本**先查"活没活着"，再查"是不是新版本"**。
#
# ⚠️ 它只读不写（除了读 `.env.local`），随时可以放心跑。

APP_DIR="${1:-/www/wwwroot/solace}"
cd "$APP_DIR" 2>/dev/null || { echo "❌ 进不去 $APP_DIR"; exit 1; }

PASS=0
FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS + 1)); }
no()  { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }
warn(){ echo "  ⚠️  $1"; }

echo "════════════════════════════════════════════"
echo " Solace 部署检查 · $(date '+%F %T')"
echo " 目录：$APP_DIR"
echo "════════════════════════════════════════════"

# ---------------------------------------------------------------- ① 构建产物
echo
echo "── ① 构建产物 ──"
if [ -f .next/BUILD_ID ]; then
  ok ".next/BUILD_ID 存在（构建于 $(stat -c %y .next/BUILD_ID 2>/dev/null | cut -d. -f1)）"
  echo "      BUILD_ID = $(cat .next/BUILD_ID)"
else
  no "没有 .next/BUILD_ID —— **构建没跑完**（或构建失败被删掉了）"
fi

# ---------------------------------------------------------------- ② 进程
echo
echo "── ② pm2 进程 ──"
if pm2 describe solace 2>/dev/null | grep -qE "status\s+.*online"; then
  uptime=$(pm2 describe solace 2>/dev/null | grep -oE "uptime.*" | head -1)
  ok "solace 是 online（$uptime）"
  restarts=$(pm2 describe solace 2>/dev/null | grep -oE "restarts[^0-9]*[0-9]+" | grep -oE "[0-9]+$" | head -1)
  [ -n "$restarts" ] && [ "$restarts" -gt 20 ] 2>/dev/null && warn "重启次数 $restarts —— 偏多，看日志确认不是在崩"
elif pm2 describe solace >/dev/null 2>&1; then
  no "solace 在 pm2 里但**不是 online** —— 站点现在是 down 的"
else
  no "pm2 里根本没有 solace —— **站点是 down 的**"
fi

# ---------------------------------------------------------------- ③ 端口
echo
echo "── ③ 端口 3000 ──"
if (ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null) | grep -q ':3000'; then
  ok "3000 端口在监听"
else
  no "3000 端口没动静 —— 应用没起来"
fi

# ---------------------------------------------------------------- ④ 活接口
echo
echo "── ④ 接口能不能通 ──"
health=$(curl -s -m 10 http://127.0.0.1:3000/api/health 2>/dev/null)

if echo "$health" | grep -q '"ok":true'; then
  ok "/api/health 正常：$(echo "$health" | tr -d '\n' | head -c 160)"
elif [ -n "$health" ]; then
  no "/api/health 返回了但 ok 不为 true：$(echo "$health" | tr -d '\n' | head -c 200)"
else
  no "/api/health 完全没响应"
fi

# ---------------------------------------------------------------- ⑤ 新代码生效了吗
echo
echo "── ⑤ 这次的**新接口**在不在（看返回码）──"
# ⚠️ 这是判断"新版本有没有真的部署上"最硬的证据 ——
#    新接口都是要管理员身份的，所以**未登录时正确返回 401**。
#    如果返回 404，说明跑的还是旧构建。
check_route() {
  local path="$1" want="$2" label="$3"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://127.0.0.1:3000${path}" 2>/dev/null)
  if [ "$code" = "$want" ]; then
    ok "$label（$path → $code）"
  else
    no "$label（$path → ${code:-无响应}，期望 $want）—— **跑的可能还是旧版本**"
  fi
}
check_route "/api/admin/keywords" 401 "词表管理接口"
check_route "/api/admin/scales"   401 "题库管理接口"
check_route "/api/user/scales"    401 "用户端量表接口"

# ---------------------------------------------------------------- ⑥ 数据库
echo
echo "── ⑥ 数据库（新表 / 新列 / 词表播种）──"

# 从 .env.local 里把连接信息摸出来（变量名有几种写法，都试一遍）
envval() {
  grep -iE "^($1)=" .env.local 2>/dev/null | head -1 | cut -d= -f2- |
    sed "s/^[\"']//;s/[\"']$//" | tr -d '\r'
}
DB_HOST=$(envval 'DB_HOST|MYSQL_HOST|DB_SERVER'); DB_HOST=${DB_HOST:-127.0.0.1}
DB_USER=$(envval 'DB_USER|MYSQL_USER')
DB_PASS=$(envval 'DB_PASSWORD|DB_PASS|MYSQL_PASSWORD')
DB_NAME=$(envval 'DB_NAME|DB_DATABASE|MYSQL_DATABASE')

if [ -z "$DB_USER" ] || [ -z "$DB_NAME" ]; then
  warn "没能从 .env.local 读出数据库账号/库名 —— 跳过这一节"
  echo "      看看你的变量叫什么：grep -oE '^[A-Z_]*(DB|MYSQL)[A-Z_]*=' .env.local"
elif ! command -v mysql >/dev/null 2>&1; then
  warn "没装 mysql 客户端 —— 跳过这一节"
else
  q() { mysql -h"$DB_HOST" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -B -e "$1" 2>/dev/null; }

  for t in keyword_groups assessment_scales; do
    if [ "$(q "SHOW TABLES LIKE '$t'")" = "$t" ]; then
      ok "表 $t 在"
    else
      no "表 $t 不在 —— 访问一次 /api/health 会触发建表"
    fi
  done

  if [ "$(q "SHOW COLUMNS FROM users LIKE 'portrait'")" != "" ]; then
    ok "users.portrait / portrait_version / portrait_updated_at 已加"
  else
    no "users 表还没有 portrait 列"
  fi

  # 六张词表有没有播种上（⚠️ 播种是"只插缺的 id"，不会覆盖你改过的内容）
  kw=$(q "SELECT id FROM keyword_groups ORDER BY id" 2>/dev/null | tr '\n' ' ')
  if [ -n "$kw" ]; then
    n=$(echo "$kw" | wc -w)
    ok "词表已播种 $n 张：$kw"
    [ "$n" -lt 6 ] && warn "期望 6 张（selfHarm/harmOthers/illegal/mild/moderate/severe）"
  else
    no "keyword_groups 表是空的 —— 播种没跑（访问一次 /api/health）"
  fi

  # 安全词表不能是空的（空了 = 危机识别失效）
  sh=$(q "SELECT COUNT(*) FROM keyword_groups WHERE id='selfHarm' AND JSON_LENGTH(content) > 0" 2>/dev/null)
  [ "$sh" = "1" ] && ok "自伤倾向词表有内容" || no "自伤倾向词表是空的 —— **危机识别会失效**"
fi

# ---------------------------------------------------------------- ⑦ 日志
echo
echo "── ⑦ 最近日志里的报错 ──"
errs=$(pm2 logs solace --lines 60 --nostream 2>/dev/null | grep -icE "error|unhandled|ECONNREFUSED|Cannot find module")
if [ "${errs:-0}" -eq 0 ]; then
  ok "最近 60 行日志没有明显报错"
else
  warn "最近 60 行里有 $errs 行含 error 字样 —— 贴出来看看："
  pm2 logs solace --lines 60 --nostream 2>/dev/null | grep -iE "error|unhandled|Cannot find module" | tail -8 | sed 's/^/      /'
fi

# ---------------------------------------------------------------- 总结
echo
echo "════════════════════════════════════════════"
echo "  通过 $PASS 项 ／ 失败 $FAIL 项"
if [ "$FAIL" -eq 0 ]; then
  echo "  ✅ 部署完成，可以正常用了"
else
  echo "  ❌ 还有 $FAIL 项没过 —— 看下面怎么补："
  echo
  echo "     ① 如果只是「没有 .next」或「不是 online」："
  echo "        cd $APP_DIR && npm run build && pm2 delete solace 2>/dev/null; pm2 start ecosystem.config.js"
  echo
  echo "     ② 如果接口通了但数据库表/词表缺失："
  echo "        curl -s http://127.0.0.1:3000/api/health   # 访问一次就会自动建表 + 播种"
  echo
  echo "     ③ 如果新接口返回 404（跑的还是旧版本）："
  echo "        说明 .next 是旧的，重跑一次构建："
  echo "        cd $APP_DIR && rm -rf .next && npm run build && pm2 restart solace"
fi
echo "════════════════════════════════════════════"
