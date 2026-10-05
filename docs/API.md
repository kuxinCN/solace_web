# Solace API 文档

所有接口都在同一个域名下，前后端同源调用，**不需要配置 CORS**。

## 通用约定

| 项 | 说明 |
|---|---|
| 基础地址 | `https://solace.l.cd`（本地开发：`http://localhost:3000`） |
| 数据格式 | 请求与响应都是 JSON；`Content-Type: application/json` |
| 认证方式 | **HttpOnly Cookie**（不返回 token 给前端，避免 XSS 窃取） |
| 管理端 Cookie | `solace_admin`（8 小时有效） |
| 用户端 Cookie | `solace_user`（更长有效期，登录后可续） |
| 成功响应 | `{ "ok": true, ...数据 }` |
| 失败响应 | `{ "error": "中文提示" }` + 对应 HTTP 状态码 |
| 缓存 | 所有接口都返回 `Cache-Control: no-store`（防止代理缓存个人数据） |

### 常见状态码

| 码 | 含义 | 前端建议 |
|---|---|---|
| 200 | 成功 | 正常处理 |
| 400 | 参数错误 | 把 `error` 文案直接提示用户 |
| 401 | 未登录 / 登录已过期 | 跳回登录页 |
| 403 | 无权限 / 账号被禁用 | 提示原因 |
| 404 | 资源不存在或不属于当前用户 | 提示并刷新列表 |
| 429 | 触发限流 | 用 `error` 里的秒数倒计时 |
| 500 | 服务端错误 | 提示「稍后再试」，详情只在服务器日志里 |
| 502 | 上游 AI 服务失败 | 提示「AI 暂时不可用」 |
| 503 | 数据库不可用 | 见 `/api/health` |

### 限流一览

| 接口 | 限制 |
|---|---|
| `POST /api/auth/send-code` | 每 IP 10 次 / 10 分钟，另加邮箱冷却与每日上限 |
| `POST /api/auth/verify` | 每 IP 30 次 / 10 分钟 |
| `POST /api/auth/login` | 每 IP 20 次 / 10 分钟，且每账号 8 次 / 10 分钟 |
| `POST /api/chat` | 每用户 60 次 / 分钟，每 IP 120 次 / 分钟 |
| `POST /api/user/upload` | 每用户 30 次 / 10 分钟 |
| `PUT /api/user/password` | 每用户 10 次 / 10 分钟 |
| `PUT /api/user/email` | 每用户 5 次 / 小时 |
| `POST /api/user/diaries/mood` | 每用户 20 次 / 小时 |
| `POST /api/user/conversations/title` | 每用户 30 次 / 小时 |
| `POST /api/install`、`POST /api/admin/setup` | 每 IP 10 次 / 10 分钟 |

---

## 一、健康检查

### `GET /api/health`

无需认证。用于监控与排障。

```json
// 200 正常
{
  "ok": true,
  "service": "solace",
  "time": "2026-09-19T17:20:00.000Z",
  "uptimeSeconds": 3600,
  "checks": { "app": { "ok": true }, "database": { "ok": true, "version": "5.7.44" } },
  "latencyMs": 12
}
```

数据库异常时返回 **503**，`checks.database.error` 给出原因。

---

## 二、安装向导（公开，受安装锁保护）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/install` | 安装状态、环境检测、当前数据库配置、TOTP 二维码（未安装时） |
| `POST` | `/api/install` | 提交数据库配置 + 管理员账号，自动建库建表并登录 |

- 已安装后返回 `installed: true`，不再提供二维码。
- 确实要重装：`.env.local` 设 `ALLOW_REINSTALL=1` + `REINSTALL_KEY=口令`，重启服务后在页面填口令。
- **重装只重置 `admin_users` / `admin_sessions`，业务数据（用户、聊天、日记）不受影响。**

---

## 三、后台认证

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/admin/setup` | 是否需要初始化；需要时返回 TOTP 密钥与二维码 |
| `POST` | `/api/admin/setup` | 提交账号 + 密码 + 6 位验证码，创建第一个管理员并登录 |
| `GET` | `/api/admin/session` | 当前登录的管理员 |
| `POST` | `/api/admin/session` | 登录（账号 + 密码 + TOTP 动态验证码） |
| `DELETE` | `/api/admin/session` | 退出登录 |

**登录保护**：连续 5 次失败锁定 10 分钟。锁定状态存在 `admin_users.locked_until`，清除方式：

```sql
UPDATE admin_users SET failed_attempts = 0, locked_until = NULL;
```

---

## 四、后台管理接口（都要管理员登录）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/admin/overview` | 环境信息、数据库状态、各模块是否配置就绪、最近审计日志 |
| `GET` | `/api/admin/dashboard?days=7` | **数据看板**：总量、今日新增、活跃用户、用户/消息趋势、情绪分布、活跃用户 Top5 |
| `GET` | `/api/admin/settings` | 读取全部配置分组（`ai` / `tts` / `smtp` / `login` / `site` / `admin` / `users` / `pet` / `sticker`） |
| `PUT` | `/api/admin/settings` | 保存某个分组：`{ group, values }` |
| `GET` | `/api/admin/users` | 用户列表，支持 `?keyword=&status=&page=&pageSize=` |
| `POST` | `/api/admin/users` | 新建用户 |
| `PATCH` | `/api/admin/users` | 修改用户（含禁用/启用、重置密码） |
| `DELETE` | `/api/admin/users?id=` | 删除用户（级联删其对话/消息/日记） |
| `GET` | `/api/admin/users?revealPassword=1&id=` | 查看某用户的**明文密码**（写审计日志 `reveal_user_password`） |
| `GET` | `/api/admin/user-data?userId=&type=profile\|diaries\|conversations\|messages` | 查看某用户的详细数据 |
| `DELETE` | `/api/admin/user-data?type=diary\|conversation\|message&id=` | 删除某条用户数据 |
| `GET` | `/api/admin/logs` | 审计日志（分页） |
| `GET` | `/api/admin/database` | 当前数据库配置（不含密码） |
| `POST` | `/api/admin/database` | 保存并热切换数据库连接（先测试连通性，失败不改） |
| `POST` | `/api/admin/mail/test` | 发送测试邮件 |
| `POST` | `/api/admin/tts/test` | 试听语音合成 |
| `GET` / `POST` / `PATCH` / `DELETE` | `/api/admin/pet/images` | 桌宠**形象库**：列表（含"当前用哪张"与磁盘占用）/ 新增 / 改名与启停 / 删除（删掉当前那张会自动回退内置默认图） |
| `POST` | `/api/admin/pet/images/upload` | 上传形象（multipart：`file`；≤2MB；扩展名白名单 + **魔数嗅探**，拒收改名成图片的 SVG；存 `public/pets/`） |
| `POST` | `/api/admin/pet/images/active` | 设为当前形象（`{ id }`；`0` = 用内置默认图；会校验该形象存在且启用） |
| `GET` / `POST` / `PATCH` / `DELETE` | `/api/admin/pet/moods` | 桌宠**情绪选项**：增删改查 / 启停 / 动画 / 停留时长 / 是否低垂（`mood_key` 建好不可改；删除会级联删该情绪的话术） |
| `GET` / `POST` / `PATCH` / `DELETE` | `/api/admin/pet/lines` | 桌宠**回复话术**（挂在情绪下，一条情绪最多 20 句；`?moodId=` 可过滤） |
| `GET` / `PATCH` / `DELETE` | `/api/admin/stickers` | 表情包**素材**：列表（含每个目录的磁盘占用）/ 启停与排序 / 删除（连带删磁盘文件） |
| `POST` | `/api/admin/stickers/upload` | 上传素材（multipart：`file` + `category`；≤2MB；魔数嗅探；**保留原文件名**，同名追加时间戳不覆盖） |
| `POST` | `/api/admin/stickers/scan` | 「重新扫描目录」：把分类目录里还没登记过的图批量补登记（`{ category }`）—— 给"手工往目录丢图"的老流程兜底 |
| `GET` / `POST` / `PATCH` / `DELETE` | `/api/admin/stickers/categories` | 表情包**分类（= 情绪）**：增删改查 / 启停 / 关键词词表 / 优先级 / 深夜放宽 / 是否纳入 AI 判定 / 是否可主动发图（删除前要求先清空该分类的素材） |

> `GET /api/admin/settings` 返回的内容**包含 API Key 与 SMTP 密码**（后台需要能编辑回显），所以这个接口必须走登录态，不要外泄响应内容。

---

## 五、用户端认证

### `POST /api/auth/send-code`

```json
// 请求
{ "email": "user@example.com" }
// 响应
{ "ok": true, "message": "验证码已发送到 user@example.com", "expiresInSeconds": 300 }
```

验证码位数、有效期、冷却时间、每日上限在后台「邮箱 / 验证码」页面配置。

### `POST /api/auth/verify`

```json
// 请求
{ "email": "user@example.com", "code": "123456" }
// 响应
{ "ok": true, "created": true, "user": { "id": 1, "email": "...", "username": "" } }
```

**注册与登录是同一个入口**：邮箱没有账号时自动创建。成功后会种下 `solace_user` Cookie。

### `POST /api/auth/login`

账号密码登录（与验证码登录并存）。

```json
{ "account": "user@example.com 或自定义账号", "password": "..." }
```

账号或密码错误统一返回 401「账号或密码不正确」，不区分是哪个错（防止探测账号是否存在）。

### `GET /api/auth/session`

返回当前登录用户；未登录返回 `{ ok: true, user: null }`。

### `POST /api/auth/logout`

退出登录，清除 Cookie。

---

## 六、用户端数据接口（都要用户登录）

### 资料

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/user/profile` | 读取资料（snake_case 全字段；`avatar_url` 等图片是 base64 data URL） |
| `PUT` | `/api/user/profile` | 局部更新（只传要改的字段） |
| `POST` | `/api/user/upload` | 上传图片：`{ kind: "avatar"\|"aiAvatar"\|"background", dataUrl }` |
| `PUT` | `/api/user/email` | 换登录邮箱（会清空所有会话，需重新登录） |
| `PUT` | `/api/user/password` | 设置 / 修改密码 |
| `GET` | `/api/user/stats` | 个人统计（对话数、消息数、日记数等） |

**上传接口的校验**：kind 白名单 → data URL 前缀 → **文件头魔数比对真实格式** → 格式声明一致性。解出的字节上限 700KB。

### 对话与消息

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/user/conversations` | 对话列表（含置顶状态） |
| `POST` | `/api/user/conversations` | 新建对话 |
| `PATCH` | `/api/user/conversations` | 改标题 / 置顶：`{ id, title?, pinned? }` |
| `DELETE` | `/api/user/conversations?id=` | 删除对话（先删其消息） |
| `POST` | `/api/user/conversations/title` | **自动生成标题**：`{ conversationId, messages }`。用户改过名字的不覆盖 |
| `GET` | `/api/user/messages?conversationId=` | 读取某对话的消息 |
| `POST` | `/api/user/messages` | 保存一条消息：`{ conversationId, role, content }` |
| `DELETE` | `/api/user/messages?id=` | 删除一条消息 |
| `GET` | `/api/user/message-index` | 消息索引（供搜索用：id / 对话 id / 内容摘要） |

### 日记

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/user/diaries` | 列表（含 `mood` 情绪标签，按 id 倒序） |
| `POST` | `/api/user/diaries` | 新建：`{ title, content }` |
| `PATCH` | `/api/user/diaries` | 编辑：`{ id, title?, content? }`；**改正文会清空情绪标签** |
| `DELETE` | `/api/user/diaries?id=` | 删除 |
| `POST` | `/api/user/diaries/mood` | **分析情绪标签**：`{ id }` → `{ ok: true, mood: "有点沉", cached: false }` |

**情绪标签的设计约定**（改动前请先读）：

- 只有 8 个标签，全部是温和描述：`轻快 / 平静 / 安稳 / 有点沉 / 疲惫 / 烦躁 / 孤单 / 说不清`
- **不做数值评分、不做趋势对比、不用红黄绿分级配色**
- 标签只用于让用户「被看见」，不触发任何自动建议
- 模型输出会经过白名单过滤，胡说的内容会落到「说不清」

---

## 七、AI 能力

### `POST /api/chat`

对话补全。需要用户登录。

```json
// 请求
{
  "messages": [{ "role": "user", "content": "最近好累" }],
  "stream": true,
  "diaryContext": "（可选）刚写完的日记正文"
}
```

- `stream: true` → 返回 `text/event-stream`，格式 `data: {"delta":"文字"}\n\n`，结束时发 `data: [DONE]`
- `stream: false` → 返回 `{ ok: true, reply: "完整回复" }`
- **系统提示词由后端从数据库注入**（后台「对话 AI」可改，保存即生效，不用重启）
- 前端传来的 `system` 消息在后台配置了提示词时会被覆盖；后台留空则使用前端的
- `diaryContext` 会按后台配置的模板（`{diary}` 占位符）拼进上下文
- **朗读标签**（仅小米 MiMo + 开关打开时）：会在心理画像之后、长期记忆之前多注入一条 system 指令，
  让 AI 在回复里带上 `[温柔]`、`(叹气)`；回喂的历史消息里这些标签会先被剥掉（细则见第十节）
- ⚠️ 这条指令**不存在数据库里**，是每次请求现拼的 —— 所以切换接口类型不会留下"AI 还在吐标签"的残留

### `POST /api/tts`

文字转语音。需要用户登录，返回音频二进制（`audio/mpeg` 或 `audio/wav`）。

```json
{ "text": "要朗读的文字", "voice": "（可选）覆盖默认音色" }
```

> ⚠️ 传进来的 `text` 里可能带着朗读标签（`(温柔)` `[叹气]`）：**小米 MiMo 需要它们**来控制语气，
> 所以原样发上游；其它接口类型会在发上游**之前**剥掉 —— 否则标签会被一字一顿念出来。
> 服务端这一层剥离不是多余的：库里存的是带标签的原文，而用户随时可能把接口类型从 MiMo 换成别家。
>
> ⚠️ **发上游前还会做三层"去噪"**（与是否 MiMo 无关），因为那些东西会被念出来：
> ① emoji（`😊` → "笑脸"）；② 颜文字 / ASCII 画 / 网址（`(￣▽￣)ノ 来一个` → 念成「侬来一个」）；
> ③ **白名单之外的括号内容**（人设的"括号动作描写"：半角会被念出来，全角会把整句合成搞成乱码）。
> 所以这个接口读不到的东西，不代表库里没有 —— 屏幕、库、朗读文本三者是按各自规则处理的。
> 细则见 [`TTS.md`](./TTS.md)（§三·五 朗读侧净化）或本文第十节。

支持两种协议，在后台「语音 TTS」的「接口类型」里选：

| 接口类型 | 端点 | 认证头 | 音频位置 |
|---|---|---|---|
| OpenAI 兼容 | `{接口地址}/audio/speech` | `Authorization: Bearer` | 响应体（二进制） |
| 小米 MiMo | `{接口地址}/chat/completions` | `api-key` | `choices[0].message.audio.data`（base64） |

> 接口地址**填到版本目录或填完整地址都行**，程序会自动识别，不会重复拼接。

---

## 八、量表题库与词表

### 用户端 · 量表

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/user/scales` | 列出**已启用**的题库。⚠️ 不下发 `scoring`（计分规则只存服务端），也不返回 `reverse` |
| `POST` | `/api/user/scales` | 提交答案 → 服务端算分 → 存进 `assessment_results`（`type` = 题库 id）→ 触发画像重算 |

**POST 请求体**：`{ "scaleId": "pss-10", "answers": { "q1": 0, "q2": 3 } }`

⚠️ **逐题校验**：必答 + 取值必须在该题的选项里。答错直接 400，**不会静默算出一个错分数**。

**返回** `{ ok, score, level, dimensions, note }` —— 分数和等级**都由服务端算**，
所以后台上传新题库之后前端不用改代码就能用。

### 后台 · 题库管理

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/admin/scales` | 列出全部题库（含停用的）+ 格式说明 |
| `POST` | `/api/admin/scales` | `action`: `upload` / `toggle` / `delete` / `preview` |

- `upload`：支持对象 / 数组 / JSON 字符串，**逐份校验**；`overwrite` 控制是否覆盖同 id，覆盖内置题库时保留 `builtin` 标记
- `preview`：拿一份 JSON 试算，**不校验必答**（用来验证计分规则写没写对）

### 后台 · 统一词表

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/admin/keywords` | 六张词表（安全词 + 压力词）+ **疑似误报词**列表 |
| `POST` | `/api/admin/keywords` | `action`: `save` / `toggle` / `reset` / `test` |

- `save`：⚠️ **安全词表不允许被清空**（那等于这类风险不再识别），要临时关掉请用「停用」
- `test`：拿一句话试，返回它会走哪条路（`urgent` / `safeMode` / `stress` / `none`）
- 改完会调 `refreshLexicons()` 重新编译 —— 词表是**预编译在内存里**的，不在每条消息上读库

### `assessments` 新增字段

`POST /api/user/assessments` 的 `emotion` 类型新增 **`phq9SelfHarm`**（PHQ-9 第 9 题，0-3）：

```json
{ "type": "emotion", "data": { "phq9": 8, "gad7": 12, "phq9SelfHarm": 1 } }
```

⚠️ 这个字段**单独存**：PHQ-9 第 9 题（自伤念头）**有分就一票判"高"**，不看总分、不做加权 —— 见 `docs/PORTRAIT.md`。

### 新增的数据库表

| 表 | 说明 |
|---|---|
| `assessment_scales` | 题库（题目 / 计分规则 / 维度映射都存 JSON） |
| `keyword_groups` | 统一词表六张（自伤倾向 / 伤人 / 违法 + 压力词轻中重三档） |
| `suspected_words` | 疑似误报词（AI 判过的结论 + 累计次数，供运营决定要不要加进例外表） |

---

## 九、桌宠与表情包（用户端配置 + 后台管理）

这两个功能的内容都是**数据库驱动 + 后台可配**的，用户端各有一个**公开**的「一次拿全」接口：

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `GET` | `/api/pet` | 公开 | 桌宠配置：`{ ok, pet: { enabled, imageUrl, imageName, size, lineRepeatHours, moods[] } }`，`moods[]` 每条含 `key / label / anim / stay / droop / lines[]`。⚠️ **一次拿全是刻意的**：用户点情绪时不能再请求网络，否则"蝴蝶回应你"会卡在网络往返上 |
| `GET` | `/api/stickers` | 公开 | 表情包资源表：`{ ok, enabled, categories: [{ key, catKey, label, items: [{ url }] }] }`，只含**启用中**的分类与素材，空分类不返回。前端进站预取后就地改写 `STICKER_MAP`（拉不到就用内置四张兜底） |

后台接口见第四节里 `pet` / `stickers` 那几行。几个约定：

- **配置分组 vs 内容表**：桌宠的开关 / 显示边长 / 话术去重时间走 `PUT /api/admin/settings` 的 `pet` 分组，
  表情包总开关走 `sticker` 分组；形象、情绪、话术、分类、素材都是**独立表 + 独立接口**。
- **改完立即生效**：后台的写操作会让表情包引擎那份分类缓存（30 秒 TTL，`lib/sticker-store.js`）
  立刻失效，用户端刷新页面即按新配置走，**不用重启、也不用等缓存过期**。
- **对 `POST /api/chat` 的影响**：每条用户消息会先读一次表情包的配置（总开关 + 分类 spec）。
  总开关关闭 → 连情绪判定都不做；分类 spec 读不到 → 回落引擎的出厂默认分类（贴纸功能不会因此消失）。
  SSE 事件 `{"sticker":"<标记名>"}` 和消息末尾的 `[sticker:<标记名>]` 协议**没有变**。
- **上传目录**：桌宠形象 → `public/pets/`；表情包素材 → `public/stickers/<分类目录>/`。
  ⚠️ 这些文件**只在服务器磁盘上，不在数据库里** —— 备份与迁移时要一起带走（见 OPERATIONS.md）。

---

## 十、语音朗读标签（TTS 情绪 / 声音事件）

只与**小米 MiMo** 有关的一个能力：让 AI 在回复里自然带上 `[温柔]`、`(叹气)`，MiMo 朗读时按标签控语气。
完整细则（协议、剥离边界、词表、坑）见 [`TTS.md`](./TTS.md)；这里只记接口层的行为。

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `GET` | `/api/tts/config` | 公开 | 用户端剥标签用：`{ ok, tts: { enabled, provider, styleTags, styleTagWords, eventTagWords } }`。⚠️ **只回这五个字段**，绝不含 `apiKey` / `baseUrl`；读配置失败时 `provider` 返回空串 —— 前端因此不剥标签，与服务端"读不到配置就不注入标签指令"自洽 |

三个接口各自的行为：

| 接口 | 朗读标签相关的行为 |
|---|---|
| `POST /api/chat` | 生效时注入一条标签指令；回喂历史前剥掉 assistant 侧的标签（用户消息一律不动） |
| `POST /api/tts` | 小米 MiMo → 原样带上标签；其它接口类型 → 发上游前剥掉。剥到只剩标签时返回 400「剥掉朗读标签后没有可念的内容」。**之后还有三层去噪**（emoji / 颜文字 / 非标签的括号内容），标记与动作描写都不会出现在语音里 |
| `POST /api/user/conversations/title` | 生效时先剥标签再让 AI 总结标题（否则标题里会出现 `[温柔]`） |

另有两处**不经过 HTTP 接口**的剥离：每日记忆汇总（`lib/daily-memory.js`）在捞昨天消息后剥，
`/api/pet`、`/api/stickers` 之类与朗读无关的接口不涉及。

**生效条件**：`tts.enabled` + `tts.styleTags !== false` + `provider` 含 `mimo`，三者同时满足。
⚠️ 这套逻辑只在**接口类型含 `mimo`** 时生效。线上已于 2026-10-03 切到小米 MiMo（`mimo-chat`），
所以它是真在跑：`/api/chat` 注入标签指令、`/api/tts/config` 告诉前端"要剥、按哪份词表剥"、
用户看到的气泡是剥过的文字，而 `/api/tts` 拿到的仍是带标签的原文。
换回 `openai-compatible` 则自动变成"不生成 + 仍旧剥"（历史标签不会再冒出来）。

---

## 附：数据库表（18 张）

| 表 | 说明 |
|---|---|
| `admin_users` | 管理员：bcrypt 密码哈希 + TOTP 密钥 + 失败计数与锁定时间 |
| `admin_sessions` | 后台会话：只存 `sha256(token)`，被拖库也无法直接登录 |
| `settings` | 分组配置，`name` + `value`(JSON)：`ai` / `tts` / `smtp` / `login` / `site` / `admin` / `users` / `pet` / `sticker` |
| `audit_logs` | 审计日志：登录、改配置、查看明文密码等敏感操作 |
| `email_codes` | 邮箱验证码 |
| `users` | 用户：邮箱/账号唯一，密码为可逆加密（后台可查看），头像等图片存 base64 |
| `user_sessions` | 用户会话，同样只存哈希 |
| `conversations` | 对话，支持置顶 |
| `messages` | 消息 |
| `diaries` | 日记，含 AI 情绪标签 `mood` |
| `pet_images` | 桌宠形象库（可放多张；当前用哪张存在 `settings.pet.activeImageId`） |
| `pet_moods` | 桌宠情绪选项（`mood_key` 唯一且**建好不可改**；动画 / 停留时长 / 是否低垂 / 排序 / 启停） |
| `pet_lines` | 桌宠回复话术（挂在情绪下，一条情绪可挂多句） |
| `sticker_categories` | 表情包分类（= 情绪）：`cat_key`（情绪键）/ `sticker_key`（素材目录名 = 标记名）/ 词表 / 优先级 / 深夜放宽 / 是否可触发 |
| `stickers` | 表情包素材（分类目录里的图，含启停与排序） |

**索引**：`messages(conversation_id, created_at)`、`messages(user_id)`、`conversations(user_id, created_at)`、`diaries(user_id, created_at)`、`user_sessions(user_id)`、`email_codes(email, purpose)`、`users.email` / `users.account`（唯一）。
