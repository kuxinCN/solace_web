# 文档索引

这个目录放的是**上线之后**会用到的文档。第一次从零部署，看根目录的 [DEPLOY.md](../DEPLOY.md)。

## 目录

| 文档 | 什么时候看 | 内容 |
|---|---|---|
| [API.md](./API.md) | 对接接口、排查接口报错 | 全部 45 个端点的说明、认证方式、状态码、限流一览、数据库表结构 |
| [INCIDENTS.md](./INCIDENTS.md) | 遇到"以前出过的问题"、复盘 | 已发生的故障记录（现象 / 根因 / 修复 / 预防） |
| [MUSIC.md](./MUSIC.md) | 改音乐功能、配网易云 | 三种音源、网易云官方播放器参数、能力边界、自动降级、备份迁移 |
| [CONTENT-REVIEW.md](./CONTENT-REVIEW.md) | 配数据审核 / 排查审核不生效 | 用户资料异步审核（小米 MiMo 批量推理）、打标与处置、默认值配置、定时任务、常见问题 |
| [PERFORMANCE.md](./PERFORMANCE.md) | 觉得卡 / 要调优 / 答辩要讲性能 | 全站体检实测数据、慢查询根因与修法、PM2 内存坑、安全建议、明确不用做的事 |
| [OPTIMIZATION-TODO.md](./OPTIMIZATION-TODO.md) | 想继续优化但不知道做什么 | 还没做的 18 项优化，按 P0-P3 分级，每项含具体命令、预期收益、风险 |
| [PET-ART-SPEC.md](./PET-ART-SPEC.md) | 画师 / 组员要画桌宠 | 桌宠美术交付规格（画布 / 图层拆分 / 尺寸 / 命名 / 动画参数 / 配色 / 验收）—— **可直接发给画师** |
| [PET-DESIGN.md](./PET-DESIGN.md) | 要做虚拟宠物时 | 桌宠完整方案（定位 / 红线 / 功能清单 / 后端 / 前端 / **算力评估** / **性能优化** / **美术需求**）—— 已设计未实现 |
| [DEV-HISTORY.md](./DEV-HISTORY.md) | 写技术报告 / 开发历程随笔 | 项目从 0 到 1 的关键节点、踩过的坑、可展开的写作角度 |
| [OPERATIONS.md](./OPERATIONS.md) | 部署完成后、日常维护 | 数据库备份与恢复、pm2 日志轮转、健康检查、巡检清单、故障速查、改代码标准流程 |
| [DEPLOY-CHECKLIST.md](./DEPLOY-CHECKLIST.md) | 每次发版 | 要上传哪些文件、打包/上传/构建命令、验证清单、回滚方法、前端对接说明 |

## 按场景找

| 我要做的事 | 看哪一份 |
|---|---|
| 第一次把项目部署到服务器 | [../DEPLOY.md](../DEPLOY.md) |
| 改完代码，要发布到线上 | [DEPLOY-CHECKLIST.md](./DEPLOY-CHECKLIST.md) |
| 网站打不开了 / 报 500 / 502 | [OPERATIONS.md](./OPERATIONS.md) → 五、常见故障速查 |
| 配置数据库自动备份 | [OPERATIONS.md](./OPERATIONS.md) → 一、数据库自动备份 |
| 配 pm2 日志轮转、防止磁盘满 | [OPERATIONS.md](./OPERATIONS.md) → 二、pm2 日志轮转 |
| 接监控告警 | [OPERATIONS.md](./OPERATIONS.md) → 三、健康检查接口 |
| 前端要对接接口 | [API.md](./API.md) |
| 忘记后台密码 / 账号被锁定 | [OPERATIONS.md](./OPERATIONS.md) → 五、常见故障速查 |
| 压测、看性能数据 | [OPERATIONS.md](./OPERATIONS.md) → 六；脚本在 `scripts/bench.sh` |
| 了解整体功能、架构、安全设计 | [../README.md](../README.md) |
| 配背景音乐 / 加网易云歌曲 | [MUSIC.md](./MUSIC.md) |
| 配数据审核 / 用户内容要不要审 | [CONTENT-REVIEW.md](./CONTENT-REVIEW.md) |
| 觉得网站卡 / 要讲性能优化 | [PERFORMANCE.md](./PERFORMANCE.md) |
| 想继续优化，不知道做什么 | [OPTIMIZATION-TODO.md](./OPTIMIZATION-TODO.md) |
| 要给画师提桌宠需求 | [PET-ART-SPEC.md](./PET-ART-SPEC.md) |
| 要做虚拟宠物（桌宠） | [PET-DESIGN.md](./PET-DESIGN.md) → 含算力评估、性能优化、美术需求 |

## 维护约定

改代码时顺手维护文档，能省下以后大量的排障时间：

- 改动涉及**接口**（新增/修改端点、字段、状态码）→ 更新 `API.md`
- 改动涉及**运维流程**（备份、日志、监控、发布步骤、端口）→ 更新 `OPERATIONS.md`
- 每次发版前，核对 `DEPLOY-CHECKLIST.md` 的文件清单，避免漏传文件
- 踩到新的坑 → 补进 `OPERATIONS.md` 的「常见故障速查」表

## 几个关键约定（新人先看这里）

| 约定 | 说明 |
|---|---|
| **应用端口** | 统一 **3000**（`ecosystem.config.js` 里写死），Nginx 反代必须指向它 |
| **只保留一个实例** | 要么用 pm2，要么用宝塔 Node 项目，**不要两个都跑** —— 否则会出现"改了代码一半生效"或 502 |
| **构建后必须重启** | `npm run build` 只是生成 `.next`，运行中的进程还加载着旧代码 |
| **内存小就先停应用再构建** | `pm2 stop solace` → `npm run build` → `pm2 start solace` |
| **配置不进版本库** | `.env.local`、`config/db.json`、`config/installed.lock` 都不要上传/外发 |
