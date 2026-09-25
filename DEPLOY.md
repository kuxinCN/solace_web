# Solace 部署详细教程

> 环境：**CentOS 7 或 CentOS 8.5 + 宝塔面板 + MySQL 5.7 / 8.0 + Node.js 20 LTS（CentOS 8.5 上 22 / 24 也能用）**
> 预计耗时：**30 ~ 45 分钟**
> 全程只需要「宝塔面板 + 一个 SSH 终端」，不需要 yum 安装任何编译工具。

---

## ⚠️ 先读：几条在实践中反复踩到的关键点

本文档是最初写的，**主体流程仍然有效**；下面这些是实际部署中踩出来的坑，**请以它们为准**
（详细步骤见 [docs/OPERATIONS.md](./docs/OPERATIONS.md)，文档索引见 [docs/README.md](./docs/README.md)）：

| 主题 | 正确做法 |
|---|---|
| **只保留一个实例** | pm2 和宝塔「Node 项目」**二选一**。两个都跑会出现「改代码一半生效」「域名 502」—— 见下方方式 A / 方式 B |
| **端口** | 应用固定跑 **3000**（`ecosystem.config.js` 里写死），Nginx 反代必须指向 3000 |
| **构建前后** | `pm2 stop solace` → `npm run build` → `pm2 start solace`。**构建很吃内存**，服务器内存小于 2G 时务必先停应用再构建 |
| **构建成功判据** | 必须看到 `✓ Compiled successfully`。看到 `Killed` 说明内存不足，先加 2G swap |
| **拿到新代码后** | 先 `npm install`（本项目依赖会更新，例如 `react-easy-crop`） |
| **改了代码没变化** | `build` 后**必须重启进程**；浏览器用无痕窗口或 `Ctrl+F5` 强刷 |
| **报 `Build failed because of webpack errors`** | 真正原因在上面几行，执行 `npm run build 2>&1 \| grep -A4 "Can't resolve"` 直接看缺什么 |
| **Node 版本** | 宝塔装的 **v20 及以上**都可用（本项目在 v24 上验证通过） |
| **备份** | 用项目自带的 `scripts/backup-db.sh` + 定时任务（支持保留天数，数据库密码不落进程列表） |
| **监控** | 部署后接一个外部探针指向 `/api/health`，网站挂了能自动收到提醒 |
| **内存小** | 建议加 2G swap，构建和 MySQL 都更稳（步骤见 OPERATIONS.md） |

---

## 0. 开始之前，把这几样准备好

| 需要的东西 | 从哪来 | 备注 |
| --- | --- | --- |
| 服务器 IP + root 密码 | 你的云服务商控制台 | 完整教程以 root 为例 |
| 宝塔面板地址 + 账号密码 | 安装宝塔时给的 | 形如 `http://IP:8888/xxxx` |
| 域名（建议有） | 域名服务商 | **已解析**到服务器 IP；国内服务器还要 ICP 备案 |
| MySQL 库名/用户名/密码 | 教程第 2 步里创建 | |
| 智谱 API Key | open.bigmodel.cn 控制台 | 对话 AI 用 |
| 网易邮箱 + SMTP 授权码 | 163/126 邮箱 → 设置 → POP3/SMTP/IMAP | **授权码不是登录密码** |
| 手机验证器 App | 微软 Authenticator / Google Authenticator / 1Password | 登录后台要用的动态码 |

本项目用到的端口，先有个概念：

| 端口 | 用途 | 是否要对外网开放 |
| --- | --- | --- |
| 3000 | Node 内部服务 | ❌ 不用开，走 Nginx 转发即可 |
| 80 / 443 | 网站访问 | ✅ 放行 |
| 3306 | MySQL | ❌ 只给本机用，不要对外开放 |
| 8888 | 宝塔面板 | ✅ 放行（建议限制来源 IP） |

---

## 1. 检查环境 & 安装 Node.js

### 1.1 登录服务器

宝塔面板 → 终端，或用自己的 SSH 工具（Xshell / FinalShell / Windows 的 `ssh root@服务器IP`）。

### 1.2 三件事先做掉

```bash
# ① 时区设为北京时间（动态验证码和登录会话都依赖时间准确，这一步很重要）
timedatectl set-timezone Asia/Shanghai
date          # 确认输出里带 CST，且时间对得上手机时间

# ② 确认 MySQL 能连（root 密码在「宝塔 → 数据库」页面可以查到）
mysql -uroot -p -e "select version();"
# 期望看到 5.7.x 或 8.0.x（本项目在两者上都能跑）

# ③ 确认服务器能出网（这三条对我们都关键）
curl -sS -o /dev/null -w "智谱AI: %{http_code}\n" https://open.bigmodel.cn/api/paas/v4
curl -sS -o /dev/null -w "npm镜像: %{http_code}\n" https://registry.npmmirror.com
timeout 5 bash -c "</dev/tcp/smtp.163.com/465" && echo "SMTP 465: 可达" || echo "SMTP 465: 不可达"
```

✅ **检查点**：前两条返回 404 / 401 之类都算通（说明网络能到）；只要不是超时或连接失败就行。第三条要显示「可达」。

### 1.3 安装 Node.js（版本按系统选）

先确认系统版本：`cat /etc/redhat-release`，再对照下表：

| 系统 | glibc | 可用的 Node | 建议 |
| --- | --- | --- | --- |
| CentOS 8.5 / 8、Rocky 8、Alma 8 | 2.28 | 20 / 22 / 24 都行 | **装 20.x 最稳**；已经装了 24 也可以直接用 |
| CentOS 7 | 2.17 | **只有 20.x** | Node 22+ 会报 `GLIBC_2.28 not found` |

判断方法很简单：敲 `node -v`，能正常输出版本号就是可用；报 GLIBC 错误就是不可用，必须换版本。

Next.js 14 要求 Node ≥ 18.17，所以 20 / 22 / 24 都满足；只是 Next 14 官方只测到 20，**用 22/24 万一遇到奇怪的报错，切回 20 就好**（宝塔里多个版本可以共存，不用卸载）。

⚠️ CentOS 7 和 CentOS 8 都已停止维护，`yum` 源可能已失效 —— 但**本项目不需要 yum 装任何东西**（所有依赖都是纯 JS，不会触发编译）。万一以后要用 yum 装别的软件而报源错误，CentOS 8.5 可以这样切到 vault 源：

```bash
sed -i 's/mirror.centos.org/vault.centos.org/g; s/^#baseurl/baseurl/g; s/^mirrorlist/#mirrorlist/g' /etc/yum.repos.d/CentOS-*.repo
sed -i 's/\$releasever/8.5.2111/g' /etc/yum.repos.d/CentOS-*.repo
yum clean all && yum makecache
```

**方式 A：宝塔图形化（推荐，最省事）**

1. 宝塔 → 软件商店 → 搜索「Node」（Node.js版本管理器）→ 安装
2. 打开它 → 安装 `v20.x`（挑最新的 20.x 就行）
3. 点该版本右侧的「**设置 CLI 版本**」/「命令行版本」→ 选 20 —— 这样终端里的 `node` 默认就是 20
4. 回到终端验证：

```bash
node -v      # 期望 v20.x.x
npm -v
```

**方式 B：官方包手动安装（宝塔商店里没有该插件时用）**

```bash
cd /usr/local/src
VER=$(curl -fsSL https://nodejs.org/dist/latest-v20.x/ | grep -oE 'node-v20\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz' | head -n 1)
echo "即将安装：$VER"
curl -fsSLO "https://nodejs.org/dist/latest-v20.x/$VER"
tar -xf "$VER" -C /usr/local
mv "/usr/local/${VER%.tar.xz}" /usr/local/node20
echo 'export PATH=/usr/local/node20/bin:$PATH' > /etc/profile.d/node20.sh
source /etc/profile.d/node20.sh
node -v && npm -v
```

⚠️ 注意：方式 B 装完后，**以后每个新开的 SSH 会话都会自动带上 PATH**（`/etc/profile.d` 生效），但宝塔终端如果不会加载 profile，可以手动 `source /etc/profile.d/node20.sh`。

✅ **检查点**：`node -v` 输出 `v20.` 开头。不是的话不要继续，后面的 `npm run build` 会失败。

---

## 2. 建一个空数据库（表由安装向导自动创建）

### 2.1 在宝塔里建库（**可以直接跳过**）

安装向导支持自己建库：第 8 步填数据库信息时，勾选「这个数据库还不存在，帮我创建」，
并填 **root 账号 + root 密码**（root 密码在「宝塔 → 数据库」页面可以看到），
向导会自动建库 + 建全部 10 张表，连这一步都不用做。

如果你更愿意手动建库（推荐给不想把 root 密码填进网页的人）：

宝塔 → 数据库 → 添加数据库：

- 数据库名：`solace`
- 用户名：`solace`（宝塔会自动创建同名用户）
- 密码：点「随机」或自己设一个复杂点的，**记下来**
- 编码/字符集：`utf8mb4`

**建完就够了，不需要导表。** 第 8 步访问 `/install` 时，安装向导会自动把 10 张表全部建好：

- 后台：`admin_users`、`admin_sessions`、`settings`、`audit_logs`、`email_codes`
- 用户端：`users`、`user_sessions`、`conversations`、`messages`、`diaries`

### 2.2 （备选）手动导表

不想用安装向导、或想提前把表建好，也可以手动导入 `db/schema.sql`：

- 宝塔图形化：数据库 → 找到 `solace` → 右侧「导入」→ 选择项目里的 `db/schema.sql`
- 命令行：

```bash
cd /www/wwwroot/solace      # 你放代码的目录
mysql -usolace -p solace < db/schema.sql
```

验证：

```bash
mysql -usolace -p solace -e "show tables;"
# 应该看到上面那 5 张表
```

⚠️ 如果报错 1071（索引过长）：说明你的 InnoDB 行格式不是 `DYNAMIC`。执行
`ALTER TABLE email_codes ROW_FORMAT=DYNAMIC;` 后重新导入，或者把 `schema.sql` 里
`idx_code_email_purpose` 那行改成只索引 `(email)`。

---

## 3. 上传代码

建议目录：`/www/wwwroot/solace`（和上面的命令保持一致）。

💡 **Windows 上一键打包**：项目里带了 `scripts/package.ps1`。运行它（右键 →「使用 PowerShell 运行」，
或 `powershell -ExecutionPolicy Bypass -File scripts\package.ps1`）会自动排除
`node_modules`、`.next`、`.env.local`、`config/db.json`、`config/installed.lock`、`logs`，
并在**项目上一级目录**（与项目文件夹同级）生成一个可直接上传的 zip。
打包脚本运行完会停住等按回车，避免窗口一闪而过看不到结果。

**方式 A：宝塔文件管理（最简单）**

1. 把项目打包成 `solace.zip`（**打包前删掉本地的 `node_modules`、`.next`、`config/db.json`，`.env.local` 也建议不要传**）
2. 宝塔 → 文件 → 进入 `/www/wwwroot/` → 上传 → 解压到 `solace` 目录

**方式 B：Git（如果你有仓库）**

```bash
cd /www/wwwroot
git clone 你的仓库地址 solace
```

⚠️ **不要上传**：`node_modules`（服务器上重新装）、`.next`（服务器上重新构建）、`config/db.json`（含数据库密码）、`config/installed.lock`（含安装锁，传过去会让新服务器误判成"已安装"）、`.env.local`（含各种密钥）。

✅ **检查点**：`ls /www/wwwroot/solace` 能看到 `package.json`、`app`、`lib`、`db`、`ecosystem.config.js`。

---

## 4. 安装依赖并写环境变量

💡 **懒人版**：第 4~6 步可以用一条命令完成（自动装依赖 → 构建 → PM2 启动）：

```bash
cd /www/wwwroot/solace
bash scripts/deploy.sh
```

（想顺便配开机自启就加个参数：`bash scripts/deploy.sh --startup`）
`.env.local` 仍然建议自己确认一遍（见本节末尾），其余交给脚本即可。

下面是手动逐步做的完整版本：

```bash
cd /www/wwwroot/solace

# 换成国内镜像，装得飞快
npm config set registry https://registry.npmmirror.com

# 用 install：本轮新增了依赖，package-lock.json 还没同步，npm ci 会直接报错
npm install
```

⚠️ **这一步不要用 `npm ci`**：它会严格比对 `package-lock.json` 和 `package.json`，而 lock 文件里还没有本轮新增的 `mysql2` / `nodemailer` / `otplib` / `qrcode` / `bcryptjs`，会直接报
`npm ci can only install packages when your package.json and package-lock.json are in sync` 然后中断。
用 `npm install` 跑过一次、lock 文件更新好之后，以后再部署就可以用 `npm ci` 了。

本轮新增的依赖：`mysql2`、`nodemailer`、`otplib`、`qrcode`、`bcryptjs` —— 全是纯 JS，**不会触发 node-gyp 编译**。

### 写 `.env.local`

```bash
cp .env.example .env.local
vi .env.local      # 不会用 vi 的话：宝塔 → 文件 → 找到该文件 → 双击编辑
```

填成这样（**改掉中文的地方**）：

```ini
# 数据库（宝塔里建的库）
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=solace
DB_PASSWORD=宝塔里那个数据库密码
DB_NAME=solace

# 后台安全（建议设置：两串随机的英文数字混排即可，别用中文）
ADMIN_SETUP_KEY=换成你自己的随机口令
CODE_SECRET=换成另一串随机字符

# 对话 AI 可以先不填，等会儿在后台里配
ZHIPU_API_KEY=
ZHIPU_BASE_URL=https://open.bigmodel.cn/api/paas/v4
ZHIPU_MODEL=glm-4-flash

# 用户端（聊天 / 日记）不需要额外配置：它和后台用同一个 MySQL 库，
# 登录走邮箱验证码，发信使用你在后台「邮箱 / 验证码」页面里配置的 SMTP
```

顺手把权限收紧：

```bash
chmod 600 .env.local
```

💡 数据库这几项也可以先留空，等会儿在第 8 步的「数据库」页面里填 —— 那时会存到 `config/db.json`，效果一样。

---

## 5. 构建

```bash
cd /www/wwwroot/solace
npm run build
```

✅ **检查点**：最后输出一堆路由表 + `✓ Compiled successfully`，没有 `Failed to compile`。

⚠️ **构建失败常见原因**：

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `JavaScript heap out of memory` | 内存不够（1G 小机器常见） | 见下面「加 swap」 |
| `Node.js 版本过低` / 语法报错 | node 不是 20 | 回第 1 步重装 |
| `Cannot find module 'xxx'` | 依赖没装全 | 重新 `npm install` |
| ESLint 报错导致失败 | 代码里有 lint error | 先 `npm run lint` 看具体位置 |

**内存不够就加 swap（1 分钟，一劳永逸）**：

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
free -h      # 应该能看到 Swap 有 2G
```

也可以临时加大 Node 内存上限再构建：

```bash
NODE_OPTIONS=--max-old-space-size=768 npm run build
```

---

## 6. 启动服务

### 方式 A：PM2（推荐，用项目自带的配置文件）

```bash
cd /www/wwwroot/solace
mkdir -p logs

# 安装 PM2（全局）
npm install -g pm2

# 启动
pm2 start ecosystem.config.js

# 设置开机自启
pm2 save
pm2 startup
# ↑ 这条会打印一行 sudo env PATH=... 的命令，把那一行复制粘贴执行一次
```

### 方式 B：宝塔「Node 项目」（图形化）

> 新版宝塔：网站 → Node 项目 → 添加 Node 项目
> 项目目录选 `/www/wwwroot/solace`，Node 版本选 20.x 及以上，启动命令填 `npm run start`，端口 **3000**。
> 如果你的宝塔没有这个菜单，直接用方式 A。

⚠️⚠️ **方式 A 和方式 B 只能选一个，不要都做！**

这是实际部署中最容易踩的坑：先用 pm2 起了一个实例（占用 3000），又在宝塔里建了 Node 项目（也会占端口），
结果**两个进程同时在跑**：

- Nginx 可能指向了"没更新"的那个 → **改了代码页面却没变化**，或者直接 **502**
- 两个进程互相抢内存，内存小的服务器会把 **MySQL 挤掉**（表现为所有请求卡住后报 500）

**正确的做法**：

- 用**方式 A（pm2）** → 就别在宝塔建 Node 项目；已经建了的，去宝塔把它**停止**并关掉「开机自启」
  （**只停，别删** —— 删除可能连站点配置一起删掉）
- 用**方式 B（宝塔）** → 先 `pm2 delete solace && pm2 save`，以后统一在宝塔面板重启

**随时用这两条确认只有一个实例**：

```bash
ss -lntp | grep -E ':3000|:3001'   # 应该只有 3000 在监听
pm2 list                            # 或者只有宝塔里那一个项目
```

另外：后台的登录会话和配置缓存是进程内的，**开多实例（PM2 cluster）会出现「登录时好时坏」**，所以只跑单实例。

### 验证服务真的起来了

```bash
pm2 list                          # 状态应该是 online，重启次数 0
pm2 logs solace --lines 30        # 看到 "Ready on http://..." 之类

curl -sS -o /dev/null -w "首页: %{http_code}\n"   http://127.0.0.1:3000/
curl -sS -o /dev/null -w "后台: %{http_code}\n"   http://127.0.0.1:3000/admin
curl -sS http://127.0.0.1:3000/api/admin/session  # 返回一段 JSON
```

✅ **检查点**：
- 首页、后台都返回 `200`
- `/api/admin/session` 返回的 JSON 里，`"dbReady": true`（说明数据库连上了）
- 如果 `dbReady` 是 `false`，别慌，直接打开网站去后台的「数据库」页面填连接信息即可（见第 8 步）

---

## 7. 域名 + Nginx 反向代理 + HTTPS

> **这个应用在宝塔里算什么类型？** 它是 **Node.js 应用** —— 既不是 PHP 站点，也不能当纯静态站点托管。
> 正确做法是：**建一个普通站点（纯静态即可）→ 反向代理到 `http://127.0.0.1:3000`**。
> 千万不要把代码丢进网站根目录指望 Nginx 直接跑：Next.js 的程序必须由 Node 进程（PM2）提供。

### 7.1 添加站点

宝塔 → 网站 → 添加站点 → 域名填 `你的域名`（如 `solace.example.com`）→ 不要选 PHP 版本（纯静态即可）→ 提交。

### 7.2 设置反向代理

站点 → 设置 → 反向代理 → 添加反向代理：

- 代理名称：`solace`
- 目标 URL：`http://127.0.0.1:3000`
- 发送域名：`$host`

提交即可。此时用域名访问应该已经能打开 Solace 的登录页了。

### 7.3 开 HTTPS

站点 → 设置 → SSL → Let's Encrypt → 申请 → 成功后打开「强制 HTTPS」。

### 7.4 （建议）给后台加两道防线

**限制 /admin 只能从特定 IP 访问**（比如只允许家里/学校的 IP）：
站点 → 设置 → 配置文件，在 `server { }` 里加：

```nginx
# 只允许指定 IP 访问后台；其余 403
location ^~ /admin {
    allow 1.2.3.4;        # 换成你自己的公网 IP
    deny all;
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

**给后台登录接口限速**（防动态码被暴力尝试）。
`limit_req_zone` 只能写在 **http 上下文**，所以在 宝塔 → 软件商店 → Nginx → 「配置修改」里，找到 `http { }` 加上一行：

```nginx
limit_req_zone $binary_remote_addr zone=solace_adminlogin:10m rate=10r/m;
```

保存并重载 Nginx 后，再在站点的配置文件里给登录接口加上引用：

```nginx
location ^~ /api/admin/session {
    limit_req zone=solace_adminlogin burst=5 nodelay;
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

> 不加也没关系 —— 程序内部已经有「连续 5 次失败锁定 10 分钟」的保护。

⚠️ 反向代理一定要带上 `X-Forwarded-Proto`，否则后台可能判断错协议，导致登录 cookie 不生效。

---

## 8. 首次安装（推荐走安装向导 `/install`）

> 💡 **域名还没配好也没关系**：安装阶段直接用 `http://服务器IP:3000/install` 就行
> （先在宝塔「安全」和云服务商安全组放行 3000 端口），装完再回来配域名和 HTTPS。

打开 `https://你的域名/install`（或 `http://服务器IP:3000/install`），跟着向导走 3 步，
**一次搞定**：写数据库配置（可顺带自动建库）→ 自动建表 → 创建管理员 → 绑定验证器 → 直接登录后台。

### 第 1 步：环境自检 + 数据库

页面顶部先做环境自检（Node 版本、`config` 目录是否可写），然后填宝塔里的数据库信息：

- 主机 `127.0.0.1`、端口 `3306`
- 用户名 / 密码 / 库名：宝塔建库时给的那套

点「测试连接」，出现「连接成功，MySQL 版本 x.x.x」后点「下一步：设置管理员」。

### 第 2 步：管理员账号 + 验证器

- 站点名称（会出现在验证码邮件里）
- 管理员账号（3-32 位字母、数字、下划线、点或短横线）
- 密码（至少 8 位，要同时有字母和数字）+ 确认密码
- 用验证器 App 扫右侧二维码（扫不了就手动输入那串密钥）
- 把 App 上显示的 6 位动态码填进去 → 点「开始安装」

### 第 3 步：完成

看到 🎉 就成功了，此时已经自动登录，点「进入后台」即可。
**页面上会提示你把安装入口关掉**，照着做（两种方式二选一）：

```bash
# 方式一：删文件 + 重新构建（最彻底）
cd /www/wwwroot/solace
rm -rf app/install app/api/install
npm run build
pm2 reload solace
```

```nginx
# 方式二：不重新构建，用 Nginx 屏蔽（宝塔站点配置里加这两行，然后重载 Nginx）
location ^~ /install { return 404; }
location ^~ /api/install { return 404; }
```

> 不处理也安全：安装完成后 `/api/install` 会直接返回 403。
> 因为项目会写下安装锁 `config/installed.lock`，而且数据库里已有管理员也会被判定为「已安装」。

### 备选流程：直接访问 `/admin`

跳过安装向导（或已经把安装文件删掉）时，直接打开 `https://你的域名/admin` 也能初始化：

### 情况 1：出现「配置数据库连接」

说明连不上数据库。把宝塔里的信息填进去 → **测试连接** → 成功后 **保存并生效**。
（**首次配置时这一步免登录**也能操作，就是为了防止配错数据库后进不去后台。）

⚠️ 如果本站在**已经装过**的情况下数据库连不上，出于安全考虑，这里会要求填「初始化口令」（`ADMIN_SETUP_KEY`）——
否则任何人只要让数据库连不上，就能把你的数据库地址改成他自己的库从而接管站点。
没设过这个环境变量的话：先在 `.env.local` 里加一行 `ADMIN_SETUP_KEY=一串随机口令`，执行 `pm2 reload solace`，再回来填写。

### 情况 2：提示「缺少数据表」

回第 2 步手动导入 `db/schema.sql`（走 `/install` 的话表是自动建的，不会看到这个提示）。

### 情况 3：出现「初始化管理后台」（第一次部署的正常流程）

1. 手机上打开验证器 App → 添加账号 → 扫描页面上的二维码（扫不了就手动输入那串密钥）
2. 设置管理员账号（3-32 位字母数字）和密码（至少 8 位，要有字母和数字）
3. 把 App 上显示的 6 位动态码填进去 → 提交
4. 成功后会自动登录

> ⚠️ **动态验证码密钥只在初始化时展示一次，务必扫码成功再提交。**
> 页面如果提示「还没有设置 ADMIN_SETUP_KEY」，先回第 4 步把它设上再初始化更安全 —— 否则在初始化完成前，知道这个网址的人都能抢先注册管理员。
> 万一验证器丢了：`mysql -usolace -p solace -e "DELETE FROM admin_users;"`，再访问 `/admin` 重新初始化（只影响后台账号，不动用户数据）。

### 情况 4：出现登录页

说明已经初始化过。输入「账号 + 密码 + 6 位动态码」登录。

### 8.1 装完之后要做的三件事

**① 配对话 AI**（这步做完，用户端聊天立刻用上新配置，前端不用改）
后台 → **对话 AI** → 填：
- 接口地址：`https://open.bigmodel.cn/api/paas/v4`（只写到版本目录，程序自动拼 `/chat/completions`）
- API Key：你的智谱 Key
- 模型名：`glm-4-flash`
- 启用对话 AI：勾上
- 保存

**② 配网易邮箱**（验证码邮件）
后台 → **邮箱 / 验证码** → 填：
- SMTP 服务器：`smtp.163.com`
- 端口：`465`，勾上「使用 SSL」
- 发信邮箱：`你的邮箱@163.com`
- SMTP 授权码：163 邮箱设置里拿到的**授权码**
- 发件人邮箱：**必须和发信邮箱一致**（否则网易会拒收，报 553）
- 启用邮件发送：勾上
- 保存 → 在下面「发送测试邮件」里填一个收件箱 → 点发送 → 去收件箱确认收到

**③ 配 TTS（可选）**
后台 → **语音 TTS** → 填接口地址、Key、模型、音色 → 保存 → 用「试听」按钮验证。

---

## 9. 验收清单

- [ ] `pm2 list` 里 `solace` 是 `online`
- [ ] `http://127.0.0.1:3000/` 返回 200
- [ ] 域名 + HTTPS 能打开用户端登录页
- [ ] `/admin` 能打开，账号 + 密码 + 动态码能登录
- [ ] 后台「概览」里：数据库 ✅、对话 AI ✅
- [ ] 后台「邮箱」能成功发出测试邮件
- [ ] 用户端能在登录页用邮箱验证码登录（收不到邮件就检查后台「邮箱」页面是否已配置并启用）
- [ ] 用户端聊天能拿到 AI 回复（不再是兜底文案「收到」）
- [ ] `/api/admin/session` 返回里 `dbReady` 为 `true`
- [ ] 服务器重启后服务能自动起来（`pm2 save` + `pm2 startup` 都做过）
- [ ] 已走完安装向导，`config/installed.lock` 已生成，并按提示关闭了 `/install` 入口
- [ ] 再次访问 `/install` 显示的是「已完成安装」，而不是安装表单

---

## 10. 日常维护

### 更新代码后重新部署

```bash
cd /www/wwwroot/solace
git pull                     # 或重新上传文件覆盖
npm install                  # 依赖有变化时（比如 package.json 改了）
npm run build
pm2 reload solace            # 平滑重启，不中断服务
```

如果这次更新里**新增了数据表**（例如用户端从 Supabase 迁到 MySQL 那次），再补执行一条（可安全重复执行）：

```bash
mysql -usolace -p solace < db/schema.sql
```

> `db/schema.sql` 里全是 `CREATE TABLE IF NOT EXISTS`，重复执行不会破坏已有数据，只是把缺的表补上。

改了 `.env.local` 也需要 `pm2 reload solace` 才生效。

### 查看日志

```bash
pm2 logs solace              # 实时日志（Ctrl+C 退出）
pm2 logs solace --lines 100  # 看最近 100 行
tail -f logs/pm2-error.log   # 只看错误
```

### 备份数据库

宝塔 → 数据库 → 该库 → 备份（可以设置计划任务每天自动备份）。
手动备份：

```bash
mysqldump -usolace -p solace > /root/solace-$(date +%F).sql
```

### 重启 / 停止 / 移除

```bash
pm2 restart solace
pm2 stop solace
pm2 delete solace
```

---

## 附录 A：常见报错对照表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 域名打开 502 Bad Gateway | Node 进程没起来 | `pm2 list` 看状态，`pm2 logs solace` 看报错 |
| 登录成功但立刻跳回登录页 | Cookie 没落地 | 用域名 + HTTPS 访问；确认反代带了 `X-Forwarded-Proto` |
| 动态验证码一直提示错误 | 手机或服务器时间不准 | `timedatectl set-timezone Asia/Shanghai`，手机开自动对时 |
| 数据库连接失败：`ER_ACCESS_DENIED_ERROR` | 用户名/密码不对 | 用宝塔里的账号密码，别用 root |
| `ER_BAD_DB_ERROR` | 库不存在 | 回第 2 步建库 |
| `ECONNREFUSED` / `ETIMEDOUT` | 连不上 MySQL | 地址填 `127.0.0.1`；确认 MySQL 在运行 |
| 提示缺少数据表 | 没导表 | 回第 2 步 |
| 网易邮箱报 `EAUTH` | 填了登录密码 | 改成 SMTP 授权码 |
| 网易邮箱报 553 / `EENVELOPE` | 发件人与发信邮箱不一致 | 两个都填同一个邮箱 |
| SMTP 超时 | 服务器出网 465 被挡 | 检查云服务商安全组 / 宝塔防火墙出网规则 |
| 聊天只回复「收到」 | AI 没配好 / Key 用完 / 超时 / 触发限流 | 看后台「概览」里 AI 是否就绪；限流是每 IP 每分钟 30 次 |
| 构建时内存溢出 | 小内存机器 | 加 swap（见第 5 步） |
| `node -v` 不是 v20 | Node 版本不对 | 回第 1 步 |
| 改了后台配置没生效 | 配置有 30 秒进程内缓存 | 等半分钟，或 `pm2 reload solace` |
| `/install` 显示「已完成安装」 | 这是正常的保护机制 | 真要重装：`.env.local` 里同时设 `ALLOW_REINSTALL=1` 和 `REINSTALL_KEY=随机口令` → `pm2 reload solace` → 打开 `/install` 并在表单里填「重装口令」 |
| 重装时提示「需要先设置 REINSTALL_KEY」 | 只开了 `ALLOW_REINSTALL=1` 但没设重装口令 | 补上 `REINSTALL_KEY=` 后重启服务（这道口令就是防止安装入口被外人用来重置管理员） |
| 安装时提示「项目目录不可写」 | Node 进程对项目目录没有写权限 | 给目录授权（`chown -R www:www /www/wwwroot/solace`，或 `chmod 755 config`），宝塔所属用户一般是 `www` |
| 安装时提示「建表失败」 | 数据库用户没有建表权限 | 宝塔建库时勾选全部权限，或用 root 账号连接一次 |
| 安装页打开是 404 | 已经按提示删掉了 `app/install` | 用 `/admin` 的初始化流程，或从备份里恢复这两个目录 |
| 改数据库配置时要求填「初始化口令」 | 站点装过、但当前连不上数据库，属于保护机制 | 在 `.env.local` 设置 `ADMIN_SETUP_KEY=一串随机口令` → `pm2 reload solace` → 再填该口令 |
| 提示「需要先设置 ADMIN_SETUP_KEY」 | 同上，服务器还没配这个口令 | 设好后重启服务即可；这条口令是防止有人靠改数据库配置接管站点 |
| 用户端收不到验证码邮件 | SMTP 没配好，或网易限制了发信 | 后台「邮箱 / 验证码」页面配置并启用 → 用「发送测试邮件」先验证；再检查垃圾邮件箱 |
| 用户端提示「验证码发送失败」 | 同上，或触发了发送冷却 / 每日上限 | 等冷却结束（默认 60 秒），或到后台调整验证码规则 |
| 用户端登录后立刻被踢回登录页 | 浏览器没保存登录 cookie | 用域名 + HTTPS 访问，并确认反向代理带了 `X-Forwarded-Proto` |

---

## 附录 B：不用宝塔的纯命令行版本

如果你在一台只有命令行的 CentOS 7 / 8 上部署（没有宝塔面板）：

```bash
# 1. 装 Node 20（见第 1 步方式 B）
# 2. 装 MySQL 5.7 后建库、建用户（这里假设你已经有了）
mysql -uroot -p -e "CREATE DATABASE solace DEFAULT CHARSET utf8mb4;"
mysql -uroot -p -e "CREATE USER 'solace'@'127.0.0.1' IDENTIFIED BY '你的密码'; GRANT ALL ON solace.* TO 'solace'@'127.0.0.1'; FLUSH PRIVILEGES;"

# 3. 放代码、装依赖、写 .env.local
cd /www/wwwroot/solace
npm config set registry https://registry.npmmirror.com
npm install

# 4. 导表
mysql -usolace -p solace < db/schema.sql

# 5. 构建 + 启动
npm run build
mkdir -p logs
npm install -g pm2
pm2 start ecosystem.config.js && pm2 save && pm2 startup

# 6. Nginx 反代（yum 装 nginx，或直接用自带的）
```

对应的 Nginx 配置（`/etc/nginx/conf.d/solace.conf`）：

```nginx
server {
    listen 80;
    server_name 你的域名;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

> HTTPS 用 certbot：`yum install certbot python2-certbot-nginx && certbot --nginx -d 你的域名`
> （CentOS 7 的 certbot 版本较老，宝塔里的 SSL 一键申请会省事很多。）

---

## 附录 C：上线前安全清单

- [ ] `.env.local` 权限 600，`config/db.json`（如果生成了）权限 600，两者都**不能提交到仓库**（`.gitignore` 已忽略）
- [ ] **更换智谱 API Key**：如果原来的 `.env.local` 曾发给别人或传过网盘，去控制台吊销重发
- [ ] 设置 `ADMIN_SETUP_KEY`（防止后台与安装向导被抢注）
- [ ] 确认 `.env.local` 里**没有** `ALLOW_REINSTALL`（用完必须立刻删掉，否则重装入口可能被人利用）
- [ ] 不要删除 `config/installed.lock` 与 `config/db.json`：它们既是「已安装」的判据，也是防止有人改数据库配置接管站点的关键
- [ ] 更换 `CODE_SECRET`
- [ ] `/admin` 在 Nginx 里限制来源 IP
- [ ] 后台登录接口加 Nginx 限速
- [ ] 确认 MySQL 3306 **没有**对公网开放
- [ ] 宝塔面板端口不要用默认 8888，且限制来源 IP
- [ ] `/api/chat` 与 `/api/tts` 需要登录才能调用，并按用户 + 按 IP 双重限流（30 / 20 次每分钟）

---

## 附录 D：完全在宝塔面板里操作（图形化路径表）

**结论：可以。** 全程不需要外部 SSH 工具，用宝塔面板左侧菜单的「**终端**」就够了。
全流程里**只有 3 条命令**必须在终端里敲，其余全是点鼠标。

| 步骤 | 宝塔里的位置 | 鼠标能做完吗 |
| --- | --- | --- |
| 安装 Node 20 | 软件商店 → 搜「Node」→ Node.js版本管理器 → 装 v20.x → 点「**设置 CLI 版本**」选 20 | ✅ 全图形化 |
| 检查端口/出网 | 安全（或云服务商安全组） | ✅ |
| 建数据库 | 数据库 → 添加数据库（库名 `solace`，utf8mb4） | ✅ |
| 建表 | 不用手动导：`/install` 安装向导会自动建表（也可以手动导入 `db/schema.sql`） | ✅ |
| 上传代码 | 文件 → 进入 `/www/wwwroot/` → 上传 `solace.zip` → 右键解压 | ✅ |
| 写 `.env.local` | 文件 → **先点右上角「显示隐藏文件」** → 复制 `icon .env.example` 重命名为 `.env.local` → 双击编辑 | ✅ |
| 安装依赖 | 终端 → `cd /www/wwwroot/solace` → `npm install` | ❌ 需要终端 |
| 构建 | 终端 → `npm run build` | ❌ 需要终端 |
| 启动服务 | 终端 → `pm2 start ecosystem.config.js` + `pm2 save` + `pm2 startup`；或 网站 → **Node 项目** → 添加项目（有该菜单时） | ❌ 建议用终端 |
| 反向代理 | 网站 → 添加站点 → 站点设置 → 反向代理 → 目标 `http://127.0.0.1:3000` | ✅ |
| HTTPS | 站点设置 → SSL → Let's Encrypt → 开启「强制 HTTPS」 | ✅ |
| 首次安装 | 浏览器打开 `https://域名/install`：填数据库 → 自动建表 → 建管理员 → 扫码绑验证器 | ✅ |
| 配 AI / 邮箱 / TTS | 后台页面里填 | ✅ |
| 定时备份 | 计划任务 → 任务类型「备份数据库」→ 选 `solace` → 每天 | ✅ |
| 看日志 | Node 项目/PM2管理器界面，或 文件 → `logs/pm2-out.log` | ✅ |

### 需要终端的三条命令（完整版）

宝塔面板 → 左侧「终端」（或右上角终端图标）→ 逐条粘贴：

```bash
cd /www/wwwroot/solace

npm config set registry https://registry.npmmirror.com
npm install                   # ① 装依赖（不要用 npm ci，见第 4 步说明）
npm run build                 # ② 构建

npm install -g pm2            # ③ 装进程管理器
pm2 start ecosystem.config.js
pm2 save
pm2 startup                   # 会打印一行 sudo 命令，复制再执行一次
```

> 构建比较久（1~3 分钟），**不要中途关掉终端页面**。担心断线可以这样跑：
> `nohup npm run build > /tmp/build.log 2>&1 &` 然后 `tail -f /tmp/build.log` 看进度。

### 宝塔里操作的 6 个坑

1. **`.env.local` 看不到**：它是点开头的隐藏文件，必须在文件管理器里打开「显示隐藏文件」。
2. **终端里的 node 版本不对**：宝塔装完 Node 20 后，一定要回 Node.js版本管理器点「**设置 CLI 版本**」选 20，否则终端里 `node -v` 可能还是老版本，构建会失败。
3. **千万别把代码放到网站根目录当静态站点跑**：本项目有服务端接口（`/api/chat`、`/admin`），不能靠 Nginx 直接托管文件。必须用「PM2/Node 项目起 3000 端口 + 反向代理」。
4. **别开多实例**：宝塔 Node 项目或 PM2 里如果让你填实例数，填 1。后台会话与配置缓存在进程内，多实例会"登录时好时坏"。
5. **改完 `.env.local` 要重启进程**：文件改了不会自动生效，终端执行 `pm2 reload solace`；用宝塔 Node 项目的话点界面上的「重启」。
6. **构建卡死/被杀**：多半是内存不足。宝塔 → 软件商店 → Swapper（或「系统」里的 Swap 设置）加 2G swap，或终端里执行第 5 步那段 `fallocate` 加 swap 的命令。

---

## 附录 E：后台「用户管理」说明

后台 → **用户管理** 页面能做的事情：

- 查看全部用户（支持按邮箱 / 账号 / 昵称 / 手机号搜索，分页）
- 手动添加用户：邮箱（必填）、登录账号、密码、昵称、性别、出生年月、手机号、备注、账号状态
- 编辑 / 删除用户（删除会连带删掉他的聊天记录和日记，不可恢复）
- 启用 / 禁用：被禁用的用户**立刻**无法登录，已登录的会话也会马上失效
- 查看密码：点「显示密码」可以看到明文（见下面说明）；也能「清空密码」，让该用户只能用邮箱验证码登录

### 信息显示开关

页面上有一组复选框，控制列表里**哪些字段显示**：

- **强制显示**：邮箱、账号、密码（不受开关影响）
- **可开关**：昵称、性别、出生年月、手机号、备注、账号状态、注册时间、最后登录时间

改完要点「保存开关」才生效（存在数据库的 `settings` 表里，分组名 `users`）。

### 关于密码是可逆加密（重要）

按需求，用户密码用 **AES-256-GCM 可逆加密**存储，所以后台能解密查看明文。

- 加密密钥取 `USER_PASSWORD_KEY`（没设就退回 `CODE_SECRET`，再没有就用内置默认值）。
  **建议在 `.env.local` 里设置 `USER_PASSWORD_KEY`。**
- ⚠️ **设置后不要随意更换密钥**：换掉之后，库里已经存过的密码就解不开了（后台会显示「解密失败（密钥变过）」），
  需要在用户管理里把那些密码重新保存一遍。
- ⚠️ 风险提示：可逆加密**不等于安全**——能读到服务器 `.env.local` 的人就能解出所有用户密码。
  如果哪天不再需要「后台查看明文」这个功能，更安全的做法是改成只存 bcrypt 哈希（像后台管理员那样）。
- 每次点「显示密码」都会往操作日志里记一条 `reveal_user_password`，方便日后追溯。

---

## 附录 F：后台「用户数据」说明

后台 → **用户数据** 页面用来查看某个用户的日记和聊天记录（类似论坛后台看用户发帖）：

**怎么用**

1. 在「选择用户」里输入邮箱 / 账号 / 昵称 → 点「搜索」→ 点搜索结果里的用户
2. 也可以直接在「用户管理」页点某一行的「**查看数据**」跳过来

**能看到什么**

- 用户基本信息 + 统计（日记几篇、会话几个、消息几条）
- **📓 日记**：标题、正文、时间，可删除单篇
- **💬 聊天会话**：标题、消息条数、创建时间；点「查看消息」展开该会话的完整对话
  （用户消息浅蓝底、AI 回复浅灰底），可删除单条消息，也可删除整个会话（消息一起删）

**对应的接口**：`app/api/admin/user-data/route.js`

| 请求 | 作用 |
| --- | --- |
| `GET ?type=profile&userId=1` | 用户信息 + 各表条数统计 |
| `GET ?type=diaries&userId=1` | 日记列表 |
| `GET ?type=conversations&userId=1` | 会话列表（带消息条数） |
| `GET ?type=messages&userId=1&conversationId=2` | 某个会话的消息 |
| `DELETE ?type=diary\|conversation\|message&id=1` | 删除一条日记 / 一个会话 / 一条消息 |

**注意**

- 所有删除都不可恢复（日记、会话、消息都是直接删除），页面上有二次确认
- 会话删除会连同它的消息一起删；删用户（在「用户管理」里）会连同该用户的全部会话、消息、日记一起删
- 每次删除都会写进操作日志，记录删了什么、属于哪个用户

---

## 附录 G：用户端功能与数据存储一览

前后端融合后，用户端（组员的前端界面）所有数据都存在自建 MySQL 里：

| 功能 | 存在哪 | 对应接口 |
| --- | --- | --- |
| 邮箱验证码登录 / 账号密码登录 / 退出 | `users` + `user_sessions` | `/api/auth/session`、`send-code`、`verify`、`login`、`logout` |
| 会话列表（新建 / 重命名 / **置顶** / 删除 / 批量操作） | `conversations`（含 `pinned`、`pinned_at`） | `/api/user/conversations` |
| 聊天消息（发送 / **重新生成**） | `messages` | `/api/user/messages` |
| 日记（新增 / 编辑 / 删除 / 让 AI 读日记） | `diaries` | `/api/user/diaries` |
| 搜索（标题 + 消息内容） | `messages` 的索引查询 | `/api/user/message-index` |
| 个人资料（昵称 / 性别 / 出生年月 / 个性签名） | `users` | `/api/user/profile` |
| 头像 / AI 头像 / 聊天背景 | `users`（base64 存库） | `/api/user/upload` |
| 修改邮箱 / 修改密码 | `users` | `/api/user/email`、`/api/user/password` |
| 「我的」页统计（陪伴天数 / 日记数 / 今日对话） | 聚合查询 | `/api/user/stats` |
| AI 回复（**支持流式**） | 不落库（只存最终文本到 `messages`） | `/api/chat` |

⚠️ 关于图片：为了部署简单（不用管服务器目录权限、也不用担心文件丢失），头像 / AI 头像 / 聊天背景是以 **base64 直接存在 MySQL 的 `users` 表**里的（MEDIUMTEXT 字段）。
副作用是用户表会随图片变大（一张压缩后的头像约几十 KB），备份数据库时会一并备走。
