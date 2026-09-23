#!/usr/bin/env bash
# ============================================================================
# Solace 一键部署脚本
# ----------------------------------------------------------------------------
# 用法（在服务器项目目录下执行）：
#     bash scripts/deploy.sh
#     bash scripts/deploy.sh --startup     # 顺便配置开机自启
#
# 它会依次完成：检查 Node -> 换 npm 镜像 -> 装依赖 -> 构建 -> PM2 启动/重启
# 完成后打印「接下来该做什么」。
# ============================================================================

set -e

cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"

echo "============================================================"
echo " Solace 部署脚本"
echo " 项目目录：$APP_DIR"
echo "============================================================"
echo

# ---------- 1. 检查 Node ----------
if ! command -v node >/dev/null 2>&1; then
  echo "[x] 找不到 node 命令。"
  echo "    请先在宝塔「Node.js版本管理器」里安装 20.x 并点「设置 CLI 版本」，"
  echo "    或者把宝塔的 Node 目录加进 PATH："
  echo "      echo 'export PATH=/www/server/nodejs/v20.x.x/bin:\$PATH' > /etc/profile.d/nodejs.sh"
  echo "      source /etc/profile.d/nodejs.sh"
  exit 1
fi

NODE_VERSION="$(node -v)"
NODE_MAJOR="$(echo "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)"
echo "[1/4] Node 版本：$NODE_VERSION"

if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[x] Node 版本过低：Next.js 需要 18.17 以上，请在宝塔里换 20.x 后重试。"
  exit 1
fi

if [ ! -f package.json ]; then
  echo "[x] 当前目录里没有 package.json，请确认本脚本位于 项目目录/scripts/ 下。"
  exit 1
fi

# ---------- 2. 装依赖 ----------
echo
echo "[2/4] 安装依赖（用 npm install，不要用 npm ci）"
npm config set registry https://registry.npmmirror.com >/dev/null 2>&1 || true
npm install

# ---------- 3. 构建 ----------
echo
echo "[3/4] 构建（可能要 1~3 分钟，请不要关闭终端）"
npm run build

# ---------- 4. 启动 ----------
echo
echo "[4/4] 启动 / 重启服务"
mkdir -p logs

if ! command -v pm2 >/dev/null 2>&1; then
  echo "      没检测到 pm2，先安装"
  npm install -g pm2
fi

if pm2 describe solace >/dev/null 2>&1; then
  pm2 reload ecosystem.config.js
else
  pm2 start ecosystem.config.js
fi
pm2 save

if [ "$1" = "--startup" ]; then
  echo
  echo "      配置开机自启（下面会打印一行命令，请把它复制出来再执行一次）"
  pm2 startup || true
fi

echo
echo "============================================================"
echo " 部署完成"
echo "============================================================"
echo " 本机自测（期望输出 200）："
echo "   curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3000/install"
echo
echo " 接下来："
echo "   1) 第一次部署：浏览器打开 http://服务器IP:3000/install 完成安装"
echo "      （宝塔「安全」和云服务商安全组需先放行 3000 端口）"
echo "   2) 绑定域名：宝塔 -> 网站 -> 添加站点 -> 反向代理到 http://127.0.0.1:3000"
echo "   3) 开机自启：pm2 startup，然后把打印出来的那行命令执行一次"
echo "============================================================"
