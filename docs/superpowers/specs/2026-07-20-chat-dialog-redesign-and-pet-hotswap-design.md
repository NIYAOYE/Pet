# 对话框瘦身 + 展开态双栏聊天 + 宠物热切换 · 设计文档

## 背景

当前对话框(`dialog.html`/`dialog.ts`)有两个体验问题,均由本次分支处理:

1. **折叠态有一大片空白冗余**。折叠窗口是固定 `320×120` 的方块,输入胶囊靠 `#bar { margin-top:auto }` 钉在底部,上方约 64px 全是 `#panel` 的 `--app-bg` 底色(一个空的圆角矩形)。用户只想要"最下方那颗输入胶囊",上面那片空矩形要去掉。

2. **展开态只是单栏聊天,且只能对当前一只宠物说话**。换宠物目前是"改 `settings.json` 的 `activePetId` 后重启"的既定流程(见 `resolvePetHome`)。用户希望把展开态做成《蔚蓝档案》MomoTalk 那样的双栏聊天界面(左侧好友列表 / 右侧聊天),**点头像即可热切换宠物**——桌面上的宠物精灵、人设、记忆、语音全部换成被点的那只(同一时刻桌面只有一只宠物),同时右侧聊天内容热切换到那只宠物自己的历史,**时间戳保留**。

对话框此前已经是 MomoTalk 结构风格(头像栏 + 描边气泡 + 时间戳,见 `2026-07-11-dialog-settings-theme-unify-design.md`),本次是在这个既有结构上**加左侧宠物列表 + 后端热切换能力**,不是推倒重来。

**关键既有事实(降低本设计的实现风险)**:
- 每只宠物早已各自独立存储对话:`userData/pets/<id>/memory/transcript.json`,由 `createMemoryManager({ dir })` 编排。所以"聊天内容热切换"有现成落盘后端。
- `ChatMessage` 早已带 `timestamp?: number`(epoch ms),`appendMessage` 落盘时补齐。所以"保留时间戳"天然成立,渲染层 `groupMessages`/`formatClockTime` 已支持。
- `listPets({ bundledPetsDir, userPetsDir })` 已能枚举全部可用宠物(合并内置只读包 + userData 包,坏包跳过,按 displayName 排序)。
- `ensurePetHome({ activePetId })` 已能把"内置只读包"首次播种到 `userData/pets/<id>/`(含记忆迁移)——热切换到一只从未激活过的内置宠物时复用它。
- Electron `nativeImage` 支持 `.crop(rect)`/`.resize()`/`.toDataURL()`(`imagePrep.ts` 已在用 nativeImage),主进程可据此裁出每只宠物的列表头像。

## 范围

- **改**:`dialog.html`/`dialog.ts`(折叠瘦身 + 展开双栏 + 列表交互)、`dialogWindow.ts`(折叠/展开尺寸)、`src/shared/ipc.ts`(新增通道 + 类型)、`src/preload/index.ts`(暴露新方法)、`src/main/shell/index.ts`(抽出 `PetSession` + `switchPet` + 新 IPC 处理器)。
- **新增**:`src/main/shell/petSession.ts`(宠物作用域会话工厂 + `dispose`)、`src/main/pets/petChatList.ts`(纯逻辑:列表项组装/末条消息预览截断/排序,可单测)、`src/renderer/petListFormat.ts` 或复用 `chatFormat.ts`(纯逻辑,可单测)。
- **不改**:`bubble.html`(折叠态回复仍走跟随气泡窗,不动)、`settings.html`(设置窗里既有的"宠物"页选择+重启流程保留,作为热切换之外的兜底,不删)、记忆/agent/工具/语音各内核模块的**内部实现**(只改变它们的**生命周期归属**——从"startShell 一次性构造"变成"PetSession 可重建")。
- **不做**:同屏多宠物(用户已明确选"同一时刻只有一只");列表未读红点/排序下拉(用户已选"头像+名字+末条消息"档,非目标见下);拖拽调整分栏宽度;设置窗套双栏结构。

---

## 一、折叠态瘦身

**目标**:折叠态只显示那颗输入胶囊(带 ＋/📷/展开 三个圆钮),上方不再有空的圆角矩形;附带图片缩略图带时,窗口按需长高、清空后缩回。

**渲染层(`dialog.html`/`dialog.ts`)**:
- 折叠态给 `#panel` 去掉可见容器外观:`#panel.collapsed` 背景透明、去阴影、去圆角、去 `--app-bg`(整窗只剩胶囊自己的白底 `#bar` 卡片可见)。展开态 `#panel.expanded` 维持现有卡片外观不变。
- `#bar` 的 `margin-top:auto` 在折叠态失去意义(窗口高度将贴合内容),保留无害;关键是让折叠窗口高度 = 内容自然高度。

**折叠态高度自适应(复用既有 `bubble` 的测量上报模式)**:
- 折叠态高度不再写死。渲染层在折叠态测量 `#panel` 的自然高度(`scrollHeight`,含可选的 `#attach` 缩略图带),通过**新 IPC** `DIALOG_REPORT_COLLAPSED_HEIGHT(height:number)` 上报;主进程夹取到合理范围(`[MIN=52, MAX=200]`)后 `setSize(width, clampedHeight)`。触发时机:`setCollapsed(true)` 后、`renderPending()` 增删缩略图后、`visibilitychange` 变可见后。
- 这是继 `BUBBLE_RESIZE`(`bubbleApi.reportSize`)之后第二处"渲染层测量→主进程夹取重设尺寸"的复用,不引入新机制。
- 校验:`@shared/ipcValidation.ts` 加 `validateCollapsedHeight`(仿既有 `validateBubbleHeight`:有限正数、夹取范围)。

**主进程(`dialogWindow.ts`)**:
- `COLLAPSED` 的 `height` 不再是权威值,改由上报高度驱动;`width` 不变(320)。`toggle()`/首帧用一个保守初值(如 56)避免上报到达前闪一下大方块。
- `EXPANDED` 见第二节(要变宽)。

> 边界:折叠态窗口极矮(~56px)时,OS 级拖拽区域(`#panel { -webkit-app-region: drag }`)仍覆盖胶囊四周留白即可;胶囊本身的输入框/按钮已是 `no-drag`,不受影响。

---

## 二、展开态双栏结构(MomoTalk 化)

展开窗口变宽为**两栏**;折叠态仍是单栏胶囊(左栏/历史仅展开态存在)。

```
┌ #panel.expanded ───────────────────────────────┐
│ ┌ #pet-list ─────┐ ┌ #chat-pane ──────────────┐ │
│ │ 宠物1 头像+名  │ │ #chat-head 头像+名+收起  │ │
│ │  末条消息预览  │ │ #history 消息列表/时间戳 │ │
│ │────────────────│ │                          │ │
│ │ 宠物2 …(active)│ │                          │ │
│ │ 宠物3 …        │ │ #attach(缩略图带)       │ │
│ │                │ │ #bar(输入胶囊)          │ │
│ └────────────────┘ └──────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

- **左栏 `#pet-list`(约 150px 宽,可纵向滚动)**:一行一只已安装宠物。行内:圆形头像(该宠物自己 idle 首帧,主进程裁好后随列表下发,见第五节)+ `displayName` + 末条消息单行预览(`text-overflow:ellipsis`;无历史则显示占位如「还没聊过」)。当前活跃宠物的行高亮(`--accent-soft` 背景 + 左侧 3px `--accent` 竖条,复用设置窗侧栏 `.navitem.active` 的既有视觉惯例)。整行 `-webkit-app-region: no-drag`、`cursor:pointer`,点击 → 切换(第三节)。
- **右栏 `#chat-pane`**:即现有展开态整体(`#chat-head` + `#history` + `#attach` + `#bar`),原样保留。`#chat-head` 的头像/名字在切换后更新为新活跃宠物。
- **头像来源(右栏头部)**:维持现状(`dialog.ts` 里 `loadAvatar()` 从 `petApi.getPet()` 裁 idle 首帧);切换后需要刷新为新宠物,见第三节。

**窗口尺寸(`dialogWindow.ts`)**:`EXPANDED` 从 `{ 320, 470 }` 调整为约 `{ 520, 470 }`(左栏 ~150 + 右栏 ~370)。摆位逻辑(优先宠物右侧、溢出翻左、夹取工作区)不变,仅宽度变化会更常触发"翻到左侧",既有夹取已覆盖。

> 视觉细节(精确配色/间距/头像尺寸)在实现期用 `pnpm preview` 真机 + 可选 HTML mockup 迭代确认,本设计只定结构与数据流。配色沿用 `theme.css` 既有 token(紫色系),不引入 MomoTalk 原版黄色,与上一版对话框设计一致。

---

## 三、宠物热切换架构(核心)

### 3.1 问题

`startShell()`(约 1093 行)把**所有宠物作用域的东西**都绑死在启动时的单个 `petDir` 上,内联散落:`memoryDir`/`memory`(MemoryManager)、`chat`(ChatStore,构造时捕获 `petDir`+`memory`)、per-send 的 `loadPersona(petDir)`、语音 sidecar(`startVoiceIfConfigured` 读 `petDir` 下的 voice 文件)、`appFocusWatcher`(读该宠物 `lines.json`)、`controlIndicator`(把宠物名烘进窗口 HTML)、以及渲染层精灵(petWin 通过 `GET_PET` 读 `petDir`)。要做到不重启就换宠物,必须把这些抽成"可重建的一束"。

### 3.2 方案:抽出 `createPetSession(petId)` 工厂 + startShell 持 `let session`

**新文件 `src/main/shell/petSession.ts`**,导出:

```ts
export interface PetSession {
  petId: string
  petDir: string
  memoryDir: string
  memory: MemoryManager
  chat: ChatStore
  messages(): ChatMessage[]      // = memory.messages(),给列表/推送用
  startVoice(): void             // 显式启动语音 sidecar(与工厂构造分离,见 3.3 端口冲突处理)
  dispose(): Promise<void>       // 停语音 sidecar、停 appFocusWatcher、取消在途 chat
}

export function createPetSession(petId: string, deps: PetSessionDeps): PetSession
```

`PetSessionDeps` 收敛**跨会话共享的全局件**(由 startShell 建一次、每个 session 复用):`userData`/`petCatalogDirs`/`legacyMemoryDir`、`loadSettings`/`saveSettings`、各 secrets store、`skills`、`todoStore`、全局自动化件(`automationWithTracking`/`indicatorGate`/`browserControl`)、`getEmbedder` 构造依赖、以及渲染层推送回调(`pushUpdate`/`pushStream`/`pushStatus`/`pushDone`/`pushError`/`emitPetEvent`/`openSettings`)、语音接线所需的 `petWin.webContents` 发送口与 provider 工厂。

**`createPetSession` 内部**做的正是现在 startShell 里那段"宠物相关构造"的搬迁:
1. `ensurePetHome({ userDataDir, bundledPetsDir, activePetId: petId, legacyMemoryDir })` → 拿 `petHome`/`memoryDir`(切到内置只读包时首次播种)。`legacyMemoryDir` 迁移仍只对默认宠物生效(判定沿用 `resolvePetHome` 的既有口径,不扩大)。
2. `memory = createMemoryManager({ dir: memoryDir, getEmbedder })`。
3. `chat = createChatStore({ petDir: petHome, memory, skills, todoStore, ...全局注入 })`(工厂参数与现状逐一对应,只是 `petDir`/`memory` 换成本会话的)。
4. 启 `appFocusWatcher = startAppFocusWatcher(petDir, {...})`;建 `controlIndicator`(烘新宠物名)。
5. 语音:**只做接线,不启 sidecar**。现有 `startVoiceIfConfigured` 的异步启动逻辑整体移入,但包在本会话的 `startVoice()` 方法里由调用方显式触发(见 3.3——语音 sidecar 端口固定 8850/8851,必须等旧会话 dispose 释放端口后再启,不能在工厂构造期自动启动);读本会话 `petDir` 下 voice 文件,失败静默降级(既有行为)。
6. `dispose()`:`chat.cancel()` → `appFocusWatcher.stop()` → `voiceSidecarInstance?.stop()` → `controlIndicator` 销毁/隐藏。**必须幂等且不抛**,任一子项失败只 warn。

**`startShell` 的变化**:
- 保留在 startShell 的**全局件**:`petWin`/`dialog`/`bubble`/`settings`/`todoWin`、tray、hotkeys、scheduler、`browserControl`、`automationControl`/`indicatorGate`、各 secrets、`skills`、`todoStore`、全部**非宠物作用域**的 IPC 处理器。
- 宠物件收进 `let session: PetSession`,初值 `createPetSession(configuredPetId, deps)`。
- 所有原先直接引用 `chat`/`memory`/`memoryDir`/`petDir` 的闭包改成 `session.chat` / `session.memory` / `session.memoryDir`(事件触发时取当前 session,天然拿到切换后的那只)。涉及:`IPC.CHAT_SEND`→`session.chat.handleSend`、`IPC.CANCEL_CHAT`→`session.chat.cancel`、`dialog.onOpened` 推 `session.messages()`、`indicatorGate.onOverride`→`session.chat.cancel`、tray `onQuickAction`→`session.chat.runQuickAction`、`IPC.OPEN_MEMORY_DIR`→`session.memoryDir`、`IPC.GET_PET`/`GET_SETTINGS.activePetVoice`→读 `session.petDir`、`fireReminder` 等。
- `app.on('will-quit')` 追加 `void session.dispose()`。

### 3.3 `switchPet(petId)` 流程(startShell 内新函数)

采用**先建后弃**(build-new-before-discarding-old):新会话构造成功后才 dispose 旧会话,任一步失败都保住旧会话原封不动。语音因端口固定(8850/8851)必须等旧 sidecar 停掉再启,所以 `startVoice()` 排在旧会话 dispose 之后。

```
1. 若 petId === session.petId → no-op 返回(点自己)。
2. 校验 petId 合法(isValidPetId)且在 listPets 结果内;否则忽略并 pushError,旧会话不动。
3. next = createPetSession(petId, deps)        // 建新会话(含 ensurePetHome 播种);可能抛
       └─ 抛错(如宠物包切换瞬间损坏)→ pushError 返回,旧 session 原封不动
4. await session.dispose()                      // 旧会话:取消在途、停 watcher、停旧语音(释放端口)
5. session = next                               // 切换权威引用
6. session.startVoice()                         // 端口已释放,启新宠物语音(未配置则静默不启)
7. saveSettings({ ...loadSettings(), activePetId: petId })   // 持久化:下次启动即这只
8. petWin.webContents.send(IPC.PET_CHANGED)     // 渲染层重载精灵(3.4)
9. dialog.pushUpdate(session.messages())        // 右栏历史热切换到新宠物
10. dialog.window()?.webContents.send(IPC.PET_SWITCHED, { petId, displayName, avatarDataUrl })
                                                // 对话框刷新右栏头部 + 左栏高亮
11. 清理跨宠物残留:clearAmbientLine();bubbleHasContent=false;bubble.clear()
```

> `startShell` 初始化时也走同一套语音拆分:`session = createPetSession(configuredPetId, deps); session.startVoice()`(替代现在的 `void startVoiceIfConfigured()`)。

### 3.4 渲染层精灵热重载(petWin)

- 新 IPC `PET_CHANGED`(main→petWin 推送,无 payload)。
- `petApi` 加 `onPetChanged(cb)`。`src/renderer/main.ts` 收到后:重新 `petApi.getPet()` → 用新 `manifest`+`spritesheetDataUrl` 重建/重置 `SpritePlayer`(换图集与动画表)→ `PetController` 复位当前动画到 idle(避免用旧行号索引新图集导致错帧)。窗口尺寸 `PET_WINDOW_SIZE` 固定不变,位置不动。
- 需要 `PetController`/`SpritePlayer` 支持"换宠物数据"的重载入口(目前是构造期一次性载入);新增一个 `reload(pet: LoadedPet)` 方法,内部逻辑与首帧 `start()` 载入路径复用同一函数,避免两套加载代码。

---

## 四、新增 IPC 契约(四文件 lockstep)

| 通道常量 | 方向 | 用途 |
|---|---|---|
| `CHAT_LIST_PETS` = `chat:list-pets` | renderer→main invoke | 返回 `PetChatListItem[]`(第五节),供左栏渲染 |
| `SWITCH_PET` = `chat:switch-pet` | renderer→main invoke | 入参 `petId`,执行 3.3;返回 `boolean`(是否切换成功) |
| `PET_SWITCHED` = `chat:pet-switched` | main→dialog 推送 | payload `{ petId, displayName, avatarDataUrl }`,对话框刷新右栏头部+左栏高亮 |
| `PET_CHANGED` = `pet:changed` | main→petWin 推送 | 无 payload,触发精灵重载(3.4) |
| `DIALOG_REPORT_COLLAPSED_HEIGHT` = `dialog:report-collapsed-height` | renderer→main 推送 | 入参 `height:number`,折叠态高度自适应(第一节) |

**类型(`src/shared/ipc.ts`)**:
```ts
export interface PetChatListItem {
  id: string
  displayName: string
  avatarDataUrl: string        // 主进程裁好的小头像;裁失败为 '' (渲染层退回色块占位)
  lastMessage?: string         // 末条消息单行预览(已截断)
  lastMessageTime?: number     // epoch ms;供列表按最近活跃排序(可选)
  active: boolean
}
```

**`ChatApi` 追加**:`listPets(): Promise<PetChatListItem[]>`、`switchPet(id: string): Promise<boolean>`、`onSwitched(cb)`。
> 命名注意:`ChatApi.listPets` 与既有 `SettingsApi.listPets`(返回 `PetSummary[]`,设置窗用)**不同返回形**,是两个不同用途的方法,各自的 IPC 通道也不同(`chat:list-pets` vs `pets:list`),不复用、不混淆。
**`PetApi` 追加**:`onPetChanged(cb)`。
**校验(`ipcValidation.ts`)**:`switchPet` 的 id 走既有 `isValidPetId`/字符串校验;`DIALOG_REPORT_COLLAPSED_HEIGHT` 走新 `validateCollapsedHeight`。

---

## 五、宠物列表数据(头像 + 末条消息)

新文件 `src/main/pets/petChatList.ts`(尽量纯,便于单测),`CHAT_LIST_PETS` 处理器调用它:

1. **枚举**:`listPets(petCatalogDirs)` 拿到全部 `PetSummary`。
2. **解析每只宠物的目录**:userData 包优先(`userData/pets/<id>`),否则内置包(`bundledPetsDir/<id>`)——与 `listPets` 的去重口径一致。
3. **头像**(主进程裁,避免把每只宠物整张图集 data URL 全下发):
   - 读该宠物 `pet.json` 拿 `sheet` + `animations.idle.row`;`frameRect(sheet, idleRow, 0)` 得裁剪矩形。
   - `nativeImage.createFromPath(<该宠物 spritesheet 绝对路径>)` → `.crop(rect)` → `.resize({ width:H, height:H })`(H 为列表头像像素,如 44) → `.toDataURL()`。
   - 缺 idle 动画/裁剪失败 → `avatarDataUrl=''`,渲染层退回 CSS 色块占位(既有 `dialog.ts` 头像失败降级惯例)。
   - **缓存**:按 `petId`+spritesheet mtime 缓存裁好的 data URL(切换/发消息会多次拉列表),避免每次重裁。
4. **末条消息**:
   - 活跃宠物:直接用 `session.messages()` 的最后一条(已在内存,最新)。
   - 非活跃宠物:`loadTranscript(join(petDir,'memory','transcript.json'))` 取 `messages` 末条(从未激活的内置宠物无该文件 → `loadTranscript` 返回空 → 无预览)。
   - 预览文本:纯函数 `previewOf(msg)`——取 `msg.text`,折叠换行为空格,截断到 N 字符(如 20)加省略号;带图占位 `[图片]` 原样保留。可单测。
5. **排序**:默认沿用 `listPets` 的 `displayName` 排序(稳定、可预期);`lastMessageTime` 先随项下发,是否改成"按最近活跃排序"留作实现期小决定(不影响契约)。
6. `active = (id === session.petId)`。

刷新时机(渲染层拉 `CHAT_LIST_PETS`):对话框首次展开、`onSwitched` 到达后、每次 `CHAT_UPDATE` 到达后(保持末条预览新鲜)。

---

## 六、边界与错误处理

- **点当前活跃宠物**:no-op(3.3 第 1 步)。
- **在途回复时切换**:`old.dispose()` 内 `chat.cancel()` 取消在途(既有 cancel 贯穿工具执行);被取消的回复静默丢弃(既有语义)。
- **坏宠物包**:`listPets` 已跳过,不出现在列表;万一切换瞬间损坏,先建后弃保住旧会话 + pushError。
- **桌面控制/浏览器自动化在途 + 切换**:`dispose→chat.cancel` 会触发 `endDesktopControlTurn`(finally 兜底),`indicatorGate` 收尾隐藏指示器、停 `manualOverrideWatch`;`browserControl` 是全局件不随会话销毁(跨宠物共享),不在此关闭。
- **语音**:切到无 voice 文件/未装运行时的宠物 → `startVoiceIfConfigured` 静默不启(既有 `resolveVoiceBackend` 返回 null 的降级);切走时旧 sidecar 由 `dispose` 停掉,不残留进程。
- **待办**:全局存储(`userData/todos.json`),不随宠物走——切换不动待办(既有注释已言明其为用户数据非宠物皮肤数据)。
- **onboarding 模式**:`startOnboarding`(无任何可用宠物)分支不建 session、不挂本次新增的 chat 侧 IPC——热切换仅存在于正常启动路径。
- **首帧同步**:折叠高度上报到达前用保守初值,避免闪一下大方块;精灵重载期间 petWin 短暂显示旧帧到新图集载入完成,可接受(几十 ms)。

---

## 七、分阶段实施

- **Phase 1 — 折叠态瘦身(独立可交付)**:第一节 + `DIALOG_REPORT_COLLAPSED_HEIGHT` + `dialogWindow` 折叠尺寸。小、低风险,可先单独真机验收并合并。
- **Phase 2 — 展开双栏 + 热切换**:第二~六节。先做后端(`PetSession` 抽取 + `switchPet` + 列表数据 + 精灵重载 IPC),再做渲染层双栏 UI 与列表交互。

---

## 非目标 / 明确不做

- 同屏多宠物(用户已选"同一时刻一只")。
- 列表未读红点、按未读/最新排序的下拉、搜索框(用户已选"头像+名字+末条消息"档;活跃宠物之外的宠物当前不产生聊天消息,未读红点长期恒为 0,无意义)。
- 拖拽调整左右分栏宽度(固定宽度)。
- 设置窗套双栏结构(设置窗的"宠物"页选择+重启流程保留为兜底)。
- 手机状态栏装饰、打字气泡动画等 MomoTalk 额外元素(延续上一版对话框设计的非目标)。
- 不改各内核(记忆/agent/工具/语音)的内部行为,只改其生命周期归属。

---

## 测试

**纯逻辑(Vitest,先写失败测试)**:
- `petChatList` 的 `previewOf`:换行折叠、超长截断加省略号、`[图片]` 占位保留、空文本处理。
- `petChatList` 列表组装:`active` 标记正确、非活跃宠物无历史时无预览、排序稳定(可注入假 `listPets`/假 transcript 读取)。
- `switchPet` 的守卫决策若可抽纯函数(点自己=no-op、非法/不存在 id=拒绝),单测之。
- `validateCollapsedHeight`:边界(负数/NaN/超范围夹取),仿 `validateBubbleHeight` 既有测试。
- `PetSession.dispose` 幂等 + 不抛(注入假 watcher/假语音,断言各子项被调用一次、其一抛错不影响其余)。

**真机(`pnpm build && pnpm preview`,GUI 无法自动化)**:
- 折叠态只剩胶囊、无空白矩形;附图后长高、移除后缩回。
- 展开态双栏渲染;点左栏另一只头像 → 桌面精灵换成那只、右栏历史换成那只(时间戳仍在)、右栏头部头像/名字更新、左栏高亮移动、`settings.json` 的 `activePetId` 已改。
- 重启后默认加载最后切到的那只。
- 切到内置从未激活的宠物 → 正常播种 + 可聊天。
- 在途回复/桌面控制中途切换 → 旧任务干净取消、无残留指示器/孤儿 powershell/语音进程。
- 切到有语音的宠物念得出、切走后旧语音停。
