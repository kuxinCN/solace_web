# 蓝蝴蝶桌宠（技术文档）

> 这份文档讲的是**已经上线**的那只蓝蝴蝶 —— 就是聊天页右下角、可以拖着走、点一下会说话的那只。
>
> ⚠️ **别和另外两份搞混**：[PET-DESIGN.md](./PET-DESIGN.md) 和 [PET-ART-SPEC.md](./PET-ART-SPEC.md)
> 讲的是**还没实现**的「虚拟宠物」方案（猫 / 狗造型、数据表、`lib/pet-lines.js` 语料库）。
> 那两份是设计稿和画师需求，**改这只蝴蝶不用看它们**。
>
> 代码：组件 `components/ButterflyEffect.jsx` + 挂载点 `app/chat/page.js`
> + 内容读写 [`lib/pet-store.js`](../lib/pet-store.js) + 后台面板 [`components/PetPanel.jsx`](../components/PetPanel.jsx)。
> 素材：后台上传的在 `public/pets/`；出厂兜底图是 `public/stickers/blue_butterfly.png`。
>
> ⚠️ **2026-10 起，形象 / 显示尺寸 / 情绪选项 / 回复话术全部可以在管理后台「桌宠」页配置，
> 数据库是唯一事实来源。** 本文档里凡是写"内置五个情绪""`MOODS` 数组"的地方，
> 指的都是**代码里的出厂兜底值**（`FALLBACK_MOODS` / `FALLBACK_SIZE`）——
> 只在配置读不到（表没建好、接口挂了）时才生效。

---

## 一、它是什么（30 秒版）

| 项 | 值 |
|---|---|
| 组件 | `components/ButterflyEffect.jsx` |
| 挂载位置 | `app/chat/page.js`（`<ButterflyEffect …/>`）—— **只有 `/chat` 页面有**；切 tab 不消失，`/home`、`/admin` 上没有 |
| 配置来源 | 进站时 `GET /api/pet` **一次拿全**（开关 / 形象 / 尺寸 / 情绪与话术池）；⚠️ 点情绪时**不再请求网络** |
| 形象 | 后台「形象库」里选中的那张（上传的存 `public/pets/`）；没配或读不到时用内置 `/stickers/blue_butterfly.png`（**1269×1239px / 1.26MB**，见 §七 的体积问题） |
| 显示尺寸 | 后台「显示边长」，默认 **70px**（代码兜底 `FALLBACK_SIZE = 70`） |
| 层级 | 本体 `z-index: 9999`；浮动文案与气泡 `z-index: 9998` |
| 初始位置 | **右下角、聊天输入框上方**（就是「发送」键的上面）：横向 `window.innerWidth - SIZE - 16`；纵向以输入区容器的上沿为基准（`barTop - SIZE - 8`），拿不到输入框时兜底 `window.innerHeight - SIZE - 132` |
| 初始行为 | 挂载后只在**客户端**定位（首帧先藏在 `translate(-9999px,-9999px)`，避免 SSR 闪一下） |
| 交互 | 拖动（鼠标 + 触摸）、点击开气泡、后台配的情绪选项（出厂五个）、压力状态、蝴蝶拍联动 |
| 持久化 | `localStorage["solace_butterfly_state"]`（低垂一个布尔）+ `localStorage["solace_butterfly_lines"]`（话术去重记录）；**位置不持久化** |

### 它接七个 props

前三个是老本事（交互 / 压力 / 蝴蝶拍），后四个是 2026-10 加进来的**配置注入**：
全部由 `app/chat/page.js` 从 `/api/pet` 拿，**后台「桌宠」页配什么，用户端就长什么样**。

| prop | 类型 | 谁传 | 作用 |
|---|---|---|---|
| `onWantToTalk` | `(text) => void` | `app/chat/page.js` 的 `handleButterflyTalk` | 唯一会"跳页"的行为：切到聊天 tab 并自动发一条消息 |
| `stressData` | `{ score, level:{label,hint}, history, trend } \| null` | `StressMeter` 的 `onData` 回调 | 气泡里「看看现在的状态」的数据来源 |
| `butterflyPat` | `{ open, running, phase }` | `HealingCottage` → `FirstAid` → `ButterflyPat` 逐层上报 | 蝴蝶拍联动：飞进弹窗、按节拍扇翅 |
| `imageUrl` | `string \| undefined` | `page.js` 从 `/api/pet` 拿 | 当前形象；不传 / 传空 → 内置蓝蝴蝶 |
| `size` | `number \| undefined` | 同上 | 显示边长（后台「显示边长」）；不合法 → `FALLBACK_SIZE` |
| `moods` | `Array \| undefined` | 同上 | 点开后那排按钮：每条含 label / anim / stay / droop / 自己的回复话术池；为空 → `FALLBACK_MOODS` |
| `lineRepeatHours` | `number \| undefined` | 同上 | 话术去重的时间窗（小时，默认 24，0 = 不限制） |

> ⚠️ **`size` 不是"只管大小"的一个数**：初始定位、拖动夹取、气泡定位、飞行目标四处都用它算
> （所以后台把 70 改成 110，这四个地方一起跟着变 —— 这是有意的，改一处就能整体放大）。
> ⚠️ 唯一**故意不跟它走**的是"初始定位那个 effect"（依赖数组是空的）：
> 否则配置一到，用户刚拖到别处的蝴蝶会被拽回默认落点（右下角）。
>
> ⚠️ 定位锚点是聊天页输入区上的 `data-chat-input-bar`：**换布局时别把这个标记删了** ——
> 删了不会报错，只是蝴蝶会静默退回到"距底 132px"的兜底位置，看起来"位置不太对"。

> ⚠️ `stressData` **不是蝴蝶自己请求的** —— 它和右上角那个压力小球共用同一个数据源（`page.js` 里
> `<StressMeter … onData={setStressData} />`）。所以"蝴蝶里显示的分数"和"小球里的分数"必然一致，
> 调试时别在蝴蝶里找接口调用。

---

## 二、交互地图

### 2.1 拖动

- `pointerdown` → 在 **window** 上挂 `pointermove` / `pointerup` / `pointercancel`；
- 松手时判断：**只要过程中收到过 `pointermove` 就算拖动**，否则当成"点击"→ 开关情绪气泡；
- 每帧把坐标夹在视口内（`0 … window.innerWidth - SIZE`），不会拖出屏幕；
- 窗口 resize 时按当前位置重新夹一次，蝴蝶不会被留在视野外。

⚠️ **拖动这一段和音乐浮窗 / 压力小球**不是同一套实现 —— 那两个用 `lib/use-draggable.js`
（带 4px 位移阈值、`reclamp` 等）。蝴蝶是**自研**的，改一边不会影响另一边，反过来也一样。

⚠️ **这里刻意不用 `setPointerCapture`** —— 代码注释记着原因：capture 会把后续事件锁在蝴蝶上，
**曾经导致气泡里的按钮和输入框点不中**。所以监听挂在 window 上。

⚠️ **它没有 4px 位移阈值**：`movedRef` 在任何一次 `pointermove` 就会置真。
理论上手抖 1px 就被判成"拖动"，点击就不生效了。如果你遇到"有时候点了没反应"，
先往这条上想（想改的话：照 `use-draggable.js` 那样加一个阈值即可）。

拖动过程中**同时**做两件事：直接写 `el.style.transform`（下一帧立刻跟手，不等 React），
再 `setPos()` 让 React 状态跟上同一个值（避免下一次渲染把蝴蝶弹回旧位置）。
文件里那句注释写的是"直接改 DOM，不走 setState"，实际是**两边都写**，读代码时别误会。

### 2.2 点击 → 情绪气泡（出厂五个，后台可增删改）

点击蝴蝶 → 原地弹出情绪气泡（**不跳页面**）。按钮来自 `/api/pet` 返回的 `moods`
（管理后台「桌宠」页可增删改；出厂值在组件顶部的 `FALLBACK_MOODS`）。
每条情绪带四个可配项 —— 用户看到的**文案**、**动画**、**停留时长**、**是否进入低垂**，
外加它自己的**回复话术池**：

| key（不可改） | 按钮文案 | 动画 | 出厂回复 | 停留 | 低垂 |
|---|---|---|---|---|---|
| `unhappy` | 我今天不开心 | `bf-droop` 下垂慢扇 | 那就先不开心一会儿，不着急好起来 | 3s | ✔ |
| `tired` | 我今天好累 | `bf-descend` 原地半闭翅、轻轻下沉 | 不用撑着，歇着吧 | 5s | ✔ |
| `anxious` | 我心里很烦 | `bf-shake` 快速抖翅两下再慢下来 | Solace 帮你收一会儿 | 3s | ✔ |
| `unclear` | 我说不清 | `bf-spin` 原地缓缓转一圈 | 说不清就先不说，我一直在 | 3s | ✘ |
| `talk` | 就是想找人说说话 | `goto`（无动画，直接回调） | （没有话术，直接去聊天） | — | ✘ |

- ⚠️ **"要不要低垂"现在读 `droop` 字段**。改造前是前端写死 `["unhappy","tired","anxious"]`
  三个名字判断的 —— 后台新加的负面情绪永远进不了低垂，改标签也改不动行为（这个坑已经填了）；
- **回复话术是随机挑的**：从这条情绪自己的话术池里挑一句，且**同一句在去重时间内不重复**
  （默认 24 小时，存在浏览器 localStorage，不落库、不发请求）；池子里的句子全在窗口内时
  兜底随便挑一句 —— **宁可重复也不能"点了不说话"**（用户点完什么都没发生，看起来就是坏了）；
- 话术池是空的（比如刚新增的情绪还没写回复）→ 只播动画、不说话，后台面板上会提示这一点；
- `talk` 是**唯一跳页项**：调 `onWantToTalk(label)` → `page.js` 切到聊天 tab →
  用两次 `requestAnimationFrame` 等渲染完 → 填进输入框 → `handleSend()` 自动发出去；
- 点气泡外面关闭（window 的 `pointerdown`，排除蝴蝶本体和 `[data-bf-bubble]`）。

### 2.3 压力状态（气泡里的展开区）

气泡第一行永远是「**看看现在的状态**」，点一下展开：

- 左边 `StressRing`（44px 圆环）+ 中间的分数（无数据时显示 `--`）；
- 右边：档位文案 `stressData.level.label` + 一句 `level.hint`；
- 下面「最近的变化」：`StressTrend` 折线 + 一句人话（"比之前紧了一些 / 缓下来了一点 / 比较平稳 / 还没有足够的数据"）；
- 档位颜色走 `toneOf(score)`，没数据走 `NO_DATA_TONE` —— 和压力小球**同一套口径**。

⚠️ 产品红线还记得的话：这里显示的是**「现在的状态」**，不是"你有焦虑倾向" ——
措辞、档位定义都在后台可配，改文案改后台，别写死在前端。

### 2.4 蝴蝶拍联动（治愈小屋）

数据流（三层上报，一层落下）：

```
HealingCottage (onButterflyPatChange)
  └─ FirstAid (onButterflyPatChange)
       └─ ButterflyPat (onStateChange)  → { open, running, phase }
            └─ app/chat/page.js 的 butterflyPat state
                 └─ <ButterflyEffect butterflyPat={…} />
```

行为：

| 时机 | 蝴蝶做什么 |
|---|---|
| `open: true` | **锁定**（不能拖、不能点，`cursor: default`）；记下当前坐标（`homePosRef`）；关闭情绪气泡；下一帧去取 `[data-butterfly-pat-card]` 卡片的真实位置，飞到**卡片高度的 32% 处**（上方三分之一 —— 避免放大后压住下面「左拍/右拍」的文字）；1.8s `transform` transition + 中层弧线动画 |
| 卡片找不到 | 兜底飞向"视口上方 1/3"，并夹在屏幕内 |
| `running: true` | 内层动画切换为 **`bf-metronome` 节拍扇翅**（2s 一轮：左拍 1s + 右拍 1s），同时放大到 **1.6 倍** |
| `open: false` | 飞回 `homePosRef` 记的原位，然后清空它 |

- 飞行的"结束"靠 `onTransitionEnd`（只认 `propertyName === "transform"`）来清 `flight` 标记，
  清掉之后才恢复可拖动、弧线动画也停；
- ⚠️ **飞行途中按下** → 立刻取消飞行，把**当前屏幕上的实际位置**固化为 `pos` 再开始拖。
  不这么做的话蝴蝶会"跳"回飞行路线的起点（因为 `pos` 还是旧值）。

---

## 三、状态与持久化

| 项 | 说明 |
|---|---|
| key | `solace_butterfly_state`（低垂）+ `solace_butterfly_lines`（话术去重记录） |
| 内容 | 前者 `{ drooped: boolean, ts: 时间戳 }` —— 就一个布尔；<br>后者 `{ "<情绪key>": [{ text, at }] }` —— 这条情绪最近说过的句子与时间戳 |
| 何时读 | 组件挂载后（`useEffect`，保证只在客户端，避免 SSR 读到 `undefined`） |
| 何时写 | 低垂：点勾了「低垂」的情绪 → `true`；点「我好点了」→ `false`。<br>去重记录：每次挑完话术顺手写一条（并把已经说出窗口的旧条目清掉） |
| 读写失败 | 静默吞掉（`try/catch`）—— 无痕模式 / 禁用 localStorage 时不许崩 |
| 低垂的表现 | 动画降级为 **2.8s 慢扇**（`bf-drooped`）+ 颜色 `saturate(0.45) brightness(0.9)` |
| 刷新后 | 低垂状态**保留**；位置**不保留**（回到右下角默认落点） |
| 「我好点了」按钮 | 只在低垂时出现；点了恢复常态色（默认 2.5s 缓慢回蓝） |

---

## 四、三层结构（为什么这么拆）

蝴蝶本体是三层叠出来的，**每层只管一件事**：

| 层 | 管什么 | 怎么实现 |
|---|---|---|
| 外层（位置层） | 蝴蝶在屏幕上的位置 | `transform: translate(pos)`；飞行时叠 `transition: transform 1.8s ease-in-out` |
| 中层（弧线层） | 飞行时的"飘"感 | `bf-arc` 关键帧：上下波动 ±8px + 左右轻微摇摆，**和位置解耦** |
| 内层（扇翅层） | 翅膀动画 + 颜色浓度 | `bf-flap` / 情绪 class / `bf-metronome`；颜色用**内联 `filter` + `transition`** |

**为什么颜色不写进 keyframes**：切换情绪时颜色要**在两个颜色之间插值**，
写进 keyframes 会先回到原色（视觉上"闪一下蓝"）。所以颜色走内联 `filter`，
靠 `transition: filter` 直接过渡：

| 状态 | filter | 过渡时长 |
|---|---|---|
| `bf-droop`（不开心） | `saturate(0.5)` | 1.5s |
| `bf-descend`（好累） | `saturate(0.3) brightness(0.85)` | 2.5s |
| `bf-shake`（心烦） | `saturate(0.4)` | 0.2s（抖得快） |
| `bf-spin`（说不清） | `saturate(0.6) blur(0.5px)` | 3s |
| 持久低垂 | `saturate(0.45) brightness(0.9)` | 2.5s |
| 常态 / 恢复 | 无（`2.5s` 缓慢回蓝） | 2.5s |

⚠️ **情绪只用"蓝色系内部的浓度"表达**（饱和度 + 明度 + 速度），
最深不低于 `saturate(0.2) brightness(0.7)`，**不用黑色、不用红黄绿** ——
和压力评估"不给情绪打分、不用红黄绿"是同一条产品红线。
另外 `drop-shadow` 永远保留（写死在 `innerFilter` 里），否则蝴蝶飞起来会看着"没有重量"。

动画只用 `transform` / `opacity` / `filter`：不触发布局重排，**不影响聊天流式渲染**（这是硬要求）。

---

## 五、改动入口速查

| 想改什么 | 改哪里 |
|---|---|
| 情绪文案 / 停留时长 / 新增一种情绪 | **管理后台 → 桌宠**（新增情绪时选动画；停留时长按毫秒填）。<br>⚠️ 只有想加一种**新动画**时才需要改代码：`ANIMS` + 对应 keyframes class + 颜色分支 |
| 每条情绪的回复话术 | **管理后台 → 桌宠 → 展开某条情绪**（可挂多句；随机挑一句，同一句在去重时间内不重复） |
| 蝴蝶大小 | **管理后台 → 桌宠设置 → 显示边长**；代码兜底 `FALLBACK_SIZE`。<br>⚠️ 这个数同时参与初始定位、拖动夹取、气泡定位、飞行目标四处计算，改一处全都跟着变 |
| 当前用哪张形象 / 换素材 | **管理后台 → 桌宠 → 形象库**（可放多张、选一张「设为当前」、停用、删除；删掉当前那张会自动回退到内置默认图）。<br>上传的图存 `public/pets/`，要求：正方形、透明底、翅膀在下方 1/3（因为 `transform-origin: center bottom`） |
| 桌宠总开关 | **管理后台 → 桌宠设置 → 启用桌宠**（关掉后用户端根本不渲染这个组件） |
| 初始位置 / 距底部距离 | 挂载定位的 `useEffect`（那个 `120`） |
| 情绪颜色浓度 | `moodFilter` 那一段（五档 + 低垂）—— ⚠️ 颜色跟**动画种类**走，不跟情绪名字走：后台新加的情绪选了 `bf-droop` 就自动是那个浓度 |
| 动画节奏 | `<style>` 里的 `@keyframes`（`bf-flap` / `bf-droop` / `bf-descend` / `bf-shake` / `bf-spin` / `bf-metronome` / `bf-arc`） |
| 飞行速度 / 放大倍数 | 位置层 `transition: transform 1.8s`、中层的 `scale(1.6)` |
| 气泡里的文案 | "看看现在的状态"「最近的变化」那几句（以及 `level.hint` 来自后台配置） |
| 层级 | 本体 `zIndex: 9999`、气泡与浮出文案 `z-[9998]`（低一位：**保证蝴蝶本体永远在最上层、可点**）。⚠️ 全项目只有这里用到 9999/9998 这一档，所以它会盖在其它浮层（音乐浮窗、压力小球等）之上 —— 以后加新浮层时要留意别被它挡住 |

---

## 六、验收清单（每次改完自己点一遍）

1. **拖动**：跟手、拖不出屏幕、把窗口拉小 / 转屏后蝴蝶仍在视野内；
2. **点击**：点一下开气泡、再点一下关；点气泡外面的任意位置也能关；
3. **五种情绪**：文案 / 动画 / 停留时长符合预期；点完前三个后出现「我好点了」；**刷新页面后仍是低垂**；
4. **跳页唯一项**：「就是想找人说说话」→ 自动切到聊天 tab 并**真的把消息发出去**（不是只填进输入框）；
5. **压力状态**：气泡里的分数与右上角压力小球一致；没有数据时显示 `--` 和「还没有足够的数据」；
6. **蝴蝶拍联动**：治愈小屋 → 蝴蝶拍 → 蝴蝶飞进卡片上部（**不压住「左拍/右拍」文字**）→
   点「开始」后按节拍左右扇翅且放大 → 关闭后**飞回原来那个位置**；
7. **不影响主链路**：聊天流式回复期间，蝴蝶动画不掉帧、不打断打字机效果；
8. **后台改文案**（2026-10 后新增）：后台把某条情绪文案改掉、再给它加一句回复 →
   用户端刷新后按钮文案变了，点它会在你挂的那几句里随机说一句；
9. **形象库**（2026-10 后新增）：后台传一张新图并「设为当前」→ 用户端刷新后蝴蝶换成它；
   点「用默认图」→ 回到内置蓝蝴蝶；
10. **总开关**（2026-10 后新增）：后台关掉「启用桌宠」→ 用户端刷新后蝴蝶消失；
    再打开 → 恢复（形象 / 情绪 / 话术都还在）。

---

## 七、已知问题与坑

| 现象 | 原因 / 怎么办 |
|---|---|
| ⚠️ **首屏多花 1.26MB** | `blue_butterfly.png` 是 1269×1239 的图，却只显示 70×70。浏览器会缓存，第二次不重复下，但**首访**这笔流量是白花的。想优化：压到 200×200 以内、体积 ≤100KB（透明底 PNG / WebP），视觉上几乎看不出差别 |
| 点一下没反应 | ① 蝴蝶拍弹窗开着（锁定态）；② 拖动时手抖了 1px（本组件没有位移阈值，见 §2.1）；③ 点在了浮动文案上（它 `pointer-events-none`，正常不会） |
| 拖动结束顺手把气泡打开了 | 松手时若"没有位移"就会当成点击。位移判定同上，抖动会被算成拖动、反之也可能被算成点击 |
| 蝴蝶拍打开时没飞进卡片 | 卡片缺 `data-butterfly-pat-card` 属性，或那一帧还没挂载 → 会自动兜底飞到视口上方 1/3 |
| 颜色没有回到蓝 | 过渡是慢的（默认 2.5s，`bf-droop` 1.5s），不是坏了；**刷新后仍偏灰**才是低垂状态没清 |
| 改了 `SIZE` 之后位置怪 | `SIZE` 同时参与初始定位、拖动夹取、气泡定位、飞行目标计算 —— 只改大小不改这几处的常量就会偏。现在建议直接用后台「显示边长」 |
| **本地传的形象线上是破图** | 上传的图**只落在服务器磁盘**（`public/pets/`），而那条记录写进了**生产库**。本地开发传的图，线上没有这个文件 → 404。本地测完请把那张形象删掉 / 停用，线上要用的形象在服务器上重新上传 |
| 点了情绪"没说话" | ① 这条情绪的话术池是空的（新增情绪后忘了写回复）→ 只播动画、不说话（后台面板上有提示）；② 池子里的句子都在去重窗口内 → 会兜底挑一句，不该出现"完全不说"；③ 如果是「就是想找人说说话」，它本来就没有话术（直接去聊天） |
| 用户端看不到新形象 / 新文案 | ① 后台没点「设为当前」（形象）或没保存；② 那张形象被停用了；③ 浏览器缓存了旧的 `/api/pet` 响应 —— Ctrl+F5 硬刷新一次 |
| 刚拖到别处，蝴蝶被拽回右下角 | ⚠️ 历史上出过：初始定位如果依赖 `size`，配置一到就会重算位置。现在那个 effect 刻意**不依赖 size** —— 如果你给它加了依赖，这个现象会回来 |
| 蝴蝶顶到屏幕最上边 / 位置看着不对 | ① 切到日记等 tab 时，输入区容器**还挂在 DOM 里但被隐藏**，`getBoundingClientRect().top` 会是 `0` —— 所以定位前先判"top 必须在屏幕下半部分"，否则走兜底；② 输入区上的 `data-chat-input-bar` 标记被删了 |
| 蝴蝶挡住了输入框/发送键 | 定位基准变了（改了输入区容器的 `padding` / 结构，或把 `data-chat-input-bar` 挪到了别的层级）—— 它应当贴在**包含输入框的那一层**上，不是更外层的大容器 |

---

## 八、相关文件

| 文件 | 和它的关系 |
|---|---|
| `components/StressMeter.jsx` | 提供 `toneOf` / `NO_DATA_TONE` / `StressRing` / `StressTrend`，也是 `stressData` 的来源（压力小球） |
| `components/HealingCottage.jsx`、`components/FirstAid.jsx` | 蝴蝶拍的上游：`ButterflyPat` 在这里上报 `{open, running, phase}`，卡片上的 `data-butterfly-pat-card` 也就是它 |
| `app/chat/page.js` | 挂载点 + 七个 props 的来源（`handleButterflyTalk`、`stressData`、`butterflyPat`，以及从 `/api/pet` 拿到的 `imageUrl` / `size` / `moods` / `lineRepeatHours`） |
| [`lib/pet-store.js`](../lib/pet-store.js) | 桌宠内容的读写与播种（形象 / 情绪 / 话术）、出厂默认值；`/api/pet` 和后台接口都走它 |
| `app/api/pet/route.js` | 用户端配置接口（**公开**，进站拉一次：开关 + 形象 + 尺寸 + 情绪与话术池） |
| `app/api/admin/pet/**` | 后台接口：`images`（含 `upload` / `active`）、`moods`、`lines` |
| [`components/PetPanel.jsx`](../components/PetPanel.jsx) | 后台「桌宠」页的内容面板（形象库 / 情绪选项 / 回复话术） |
| `db/schema.sql`、[`lib/schema.js`](../lib/schema.js) | `pet_images` / `pet_moods` / `pet_lines` 三张表，以及老库自动升级（`ensureUserColumnsOnce`）里的播种 |
| `components/WelcomeOverlay.jsx` | ⚠️ **另一只蝴蝶**：开屏动画里飞入 / 悬停的那只侧面蝴蝶，用的是 `blue_butterfly_side.png`（360×240），**不是桌宠**，别拿它当桌宠改 |
| `lib/use-draggable.js` | 音乐浮窗 / 压力小球的拖动 hook —— **蝴蝶没用它**（见 §2.1） |
| [PET-DESIGN.md](./PET-DESIGN.md)、[PET-ART-SPEC.md](./PET-ART-SPEC.md) | 未实现的「虚拟宠物」方案与画师规格；只在这只蝴蝶要**加新造型 / 换素材**时才相关 |
| [STICKER.md](./STICKER.md) | 表情包文档。它里面只有一句和桌宠有关：`blue_butterfly*.png` 是桌宠素材、**勿动** |
| [STRESS-DESIGN.md](./STRESS-DESIGN.md)、[STRESS-SPEC.md](./STRESS-SPEC.md) | 蝴蝶气泡里那套压力口径的上游文档（档位、触发条件） |
