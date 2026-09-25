# 故障与事故记录

记录已经发生过的、影响用户或协作的问题。每条都写清 **现象 → 根因 → 修复 → 预防**，
目的是不再犯第二次，也方便后来的人理解某些代码为什么要写成那样。

> 排查任何线上问题，第一步都建议先看服务端日志：
> ```bash
> pm2 logs solace --lines 40 --nostream
> ```

---

## INC-001｜日记页数据"消失"：引用了不存在的导出函数

| 项 | 内容 |
|---|---|
| **发生时间** | 2026-09-20 |
| **发现方式** | 用户在日记页刷新后发现列表为空；但后台能看到全部日记 |
| **严重程度** | **高** |
| **是否丢数据** | **否** —— 数据一直完好，只是接口 500 导致前端渲染不出来 |

### 现象

1. 首页、聊天页均正常，**只有日记页刷新后列表为空**；
2. 情绪标签从来不出现；
3. 后台「用户数据 → 日记」能看到全部日记 —— 说明数据在库里好好的。

### 根因

`app/api/user/diaries/route.js` 与 `app/api/user/diaries/mood/route.js` 里写的是：

```js
import { ensureDiaryColumnsOnce } from "@/lib/schema";
```

但 `lib/schema.js` **从未导出过 `ensureDiaryColumnsOnce`**。它实际导出的是：

- `ensureDiaryColumns()` —— 没有 `Once` 后缀
- `ensureUserColumnsOnce()` —— 内部已经包含 diaries 的补列

于是运行到这一行时抛 `TypeError: ensureDiaryColumnsOnce is not a function`，
接口直接返回 500，前端拿不到日记列表。

### 为什么构建没拦住

`next build` 遇到"导入了不存在的命名导出"时通常**只给警告**，把它当成 `undefined` 放过去，
**构建照常成功**。只有真正请求那个接口才会崩 —— 典型的 **"构建通过 ≠ 功能正常"**。

### 修复

两处 import 与调用统一改为 `ensureUserColumnsOnce()`。同时做了两项加固：

1. **补列失败不再拖垮主流程** —— `ensureUserColumnsOnce()` 在 diaries / conversations / messages
   等接口里都用 `try/catch` 包住：即使补列失败（例如数据库账号没有 `ALTER` 权限），
   用户依然能看到自己的数据；
2. 前端 `requestDiaryMood` 的失败分支加了一行 `console.warn`（对用户仍然静默），
   便于现场排查。

### 预防措施（已纳入流程）

1. **新增跨模块引用后，必须实际请求一次那个接口** —— 不能只以"build 成功"为准；
2. "某个功能突然不可用、但其他都正常"时，**第一件事看服务端日志**：
   `TypeError` / `is not a function` 会直接打在那里；
3. 涉及"升级兼容"的自动补列 / 自动修复逻辑，**一律用 `try/catch` 包住**，
   不允许影响主流程；
4. 协作场景下，**同一份代码分发给别人之前，先自测关键路径**（日记列表与新增、发消息、登录），
   避免把缺陷扩散出去。

### 相关文件

- `app/api/user/diaries/route.js`
- `app/api/user/diaries/mood/route.js`
- `lib/schema.js`
- `app/chat/page.js`

---

## INC-002｜域名 502 / 应用 500：同一项目跑了两个实例

| 项 | 内容 |
|---|---|
| **发生时间** | 2026-09-19 ~ 09-20 |
| **严重程度** | **高**（反复出现多次） |
| **是否丢数据** | 否 |

### 现象

- 用域名访问报 `502 Bad Gateway`（Nginx），或页面只有一句 `Internal Server Error`；
- 但 `http://127.0.0.1:3000` 或 IP 直连却是正常的；
- 改了代码后页面没变化，"一半生效一半不生效"。

### 根因

服务器上**同时跑了两个实例**：

| 端口 | 谁启动的 |
|---|---|
| 3000 | pm2（`ecosystem.config.js`） |
| 3001 | 宝塔「Node 项目」 |

Nginx 的 `proxy_pass` 指向了其中一个，而那个恰好是**在构建产物残缺时启动、之后没重启过**的旧进程。

叠加的另一个因素：`rm -rf .next` 之后 `npm run build` 没有成功（内存不足被系统杀掉），
`.next` 处于残缺状态，进程启动时直接报：

```
Could not find a production build in the '.next' directory.
```

### 修复

1. 只保留一个实例：停掉宝塔的 Node 项目（**只停别删**，删除可能连站点配置一起删掉），
   或反过来 `pm2 delete solace`；
2. Nginx 的 `proxy_pass` 指向正在跑的那个端口；
3. `rm -rf .next` → `npm run build`（确认 `✓ Compiled successfully`）→ `pm2 start`；
4. 加 2G swap，避免构建时内存不足被 OOM 杀掉。

### 预防措施

- **只保留一个实例**，随时用 `ss -lntp | grep -E ':3000|:3001'` 确认；
- **构建前后**：`pm2 stop solace` → `npm run build` → `pm2 start solace`；
- **构建产物更新后，所有跑着旧产物的进程都必须重启**。

---

## INC-003｜MySQL 被系统杀掉，导致全站卡住后 500

| 项 | 内容 |
|---|---|
| **发生时间** | 2026-09-20 |
| **严重程度** | **高** |
| **是否丢数据** | 否 |

### 现象

- 所有请求先**卡住很久**（十几秒），然后返回 500；
- `curl http://127.0.0.1:3000/api/health` 也是长时间无响应后 500；
- 与"代码写错"的区别很明显：**代码错误是秒返回**。

### 根因

`systemctl status mysqld` 显示 `inactive (dead)` —— MySQL 被停了。
时间点与 `npm run build` 高度吻合：**构建占满内存，内存不足时系统杀掉了 MySQL 进程**。

应用侧表现出的"卡住"，是在等数据库连接超时（`connectTimeout: 8000`）。

### 修复

```bash
systemctl start mysqld
systemctl enable mysqld      # 顺带打开开机自启
pm2 restart solace           # 让应用重建数据库连接
curl -s https://你的域名/api/health
```

### 预防措施

1. 内存小的服务器**先加 2G swap**；
2. **构建前先 `pm2 stop solace`**，把内存让给构建；
3. 打开 MySQL 的开机自启；
4. 接一个外部监控探针指向 `/api/health`，挂了能第一时间收到提醒。

---

## 记录规范

新增记录时按上面的结构写，并在表头标注**时间 / 严重程度 / 是否丢数据**。
标题用一句话说清"谁坏了"，不要只写编号。
