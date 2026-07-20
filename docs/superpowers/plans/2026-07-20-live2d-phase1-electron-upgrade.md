# Live2D Phase 1 — Electron 31→43 升级 + 全回归 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把项目从 Electron `^31.0.0`(已停止支持)升级到受支持的 Electron 43.x 最新补丁,同步升级构建工具链,并通过自动化 + 真机回归证明现有全部能力(透明置顶宠物窗、点击穿透、托盘、热键、IPC、设置/聊天/气泡/待办、截屏与桌面/浏览器控制、语音 Sidecar、Windows 安装包)行为不退化——为后续 Live2D 阶段提供一个受支持、可打 WebGL 的运行时底座。

**Architecture:** 这是一次**纯版本升级 + 回归**,不引入任何新功能、不改任何业务逻辑。改动集中在 `package.json` / 构建配置 / 极少量受 breaking-change 影响的调用点。绝大多数验收是**真机手动回归**(本项目既定惯例:自动化检查过 ≠ 能跑),plan 对此如实标注、不假装可自动化。GPU 硬件加速决策(`app.disableHardwareAcceleration()` / Phase 0 的 `gpuBootDecision`)**不在本阶段改动范围**——本阶段只需保证在"当时分支上存在的 GPU 模式"下渲染不退化。

**Tech Stack:** Electron 43.x(pin 精确版) · electron-vite · electron-builder(NSIS) · Vite · Vitest · TypeScript(strict) · pnpm。运行时依赖全为纯 JS(`@anthropic-ai/sdk` / `openai` / `adm-zip` / `playwright-core`),无原生 node-gyp 模块。

## Global Constraints

- **平台**:Windows 10/11 x64 only(与现状一致)。
- **绝不添加 `"type": "module"`**:Electron 主进程/preload 必须是 CommonJS,ESM 主进程静态 import CJS `electron` 会崩 Node 的 cjs 导出预解析器。electron-vite 默认发 CJS。
- **安全基线不变**:`contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`、`index.html` 的 CSP、渲染层零文件系统访问。
- **本阶段零新增运行时依赖**;只升级已有 devDependencies(electron 及构建链)。
- **依赖 pin 精确版本、不用 `^` 浮动**(spec §13):electron 及构建链锁定到执行时验证过的确切版本,保证升级可复现、且锁死对打包崩溃敏感的 Chromium 版本。
- **GPU 决策不动**:不新增/删除/修改 `disableHardwareAcceleration` 或 Phase 0 的 `gpuBootDecision` 逻辑;回归时按"当时分支存在的 GPU 模式"验证。
- **打包环境坑**(README「打包构建说明」):`pnpm dist` 在普通 Windows 终端会因 `winCodeSign` 内 darwin `.dylib` 符号链接无权限而失败——按 README 三选一绕过(开发者模式 / 管理员 / 预解压缓存跳过 darwin)。
- **沙箱 shell 坑**:若 shell 设了 `ELECTRON_RUN_AS_NODE=1`,先 `unset ELECTRON_RUN_AS_NODE` 再启动。
- **验收铁律**:任何动主进程/preload/renderer/躯壳的改动,除自动检查外必须 `pnpm dev` 或 `pnpm preview` 真机肉眼验证。

## 依赖关系与边界

- **前置**:本阶段可独立于 Phase 0(GPU)进行,但两者都改 `main/index.ts` 与 `package.json` 附近。**推荐先让 Phase 0 的 `worktree-gpu-accel-reboot-degrade` reconcile 并合并进 main,再从更新后的 main 拉本阶段的 worktree**,避免两次围绕 GPU/启动路径的改动互相冲突。若 Phase 0 尚未合并,本阶段仍可做,但 Task 5 的"GPU 两模式回归"退化为"当前单一软渲染模式回归",并在收尾说明。
- **不做**:任何 Live2D、PixiJS、宠物包 v2、资源协议、动态窗口相关改动——那些是 Phase 2+。本阶段结束时代码库功能与升级前**逐条等价**。

## File Structure(本阶段会碰的文件)

- Modify: `package.json` — `devDependencies` 里 electron 及构建链版本;`scripts` 不变。
- Modify: `pnpm-lock.yaml` — `pnpm install` 自动重写。
- Modify(按需,可能 no-op): `electron.vite.config.ts` — 仅当新 electron-vite 要求配置形状变化时。
- Modify(按需,可能 no-op): `electron-builder.yml` — 仅当新 electron-builder 要求字段变化时。
- Modify(按需,预计 no-op): `src/main/media/imagePrep.ts` / `src/main/pets/petAvatar.ts` — 仅当 nativeImage 图像往返在新版出现色彩/编码退化时。
- Modify: `PROGRESS.md` — 收尾追加本阶段状态与遗留。
- Reference only(不改):`src/main/index.ts`(GPU 决策=Phase 0 领域)、`src/main/shell/petWindow.ts`、`src/renderer/index.html`(CSP)。

---

### Task 1: 隔离环境 + 升级前基线快照

**Files:**
- 无代码改动;产出一份基线记录(写入 worktree 内 `docs/superpowers/plans/notes/2026-07-20-phase1-baseline.md`,gitignored `docs/*` 仅在磁盘)。

**Interfaces:**
- Consumes: 无。
- Produces: 一份"升级前已知良好"基线——测试通过数、三包 build 成功、一次手动冒烟观察记录。后续每个 Task 的验收都以此为对照。

- [ ] **Step 1: 建立隔离 worktree**

REQUIRED SUB-SKILL:执行时用 superpowers:using-git-worktrees 建隔离工作区(勿在主工作树直接改)。分支名建议 `live2d/phase1-electron-upgrade`,base 取"已 reconcile Phase 0 后的 main"(见上「依赖关系」)。

- [ ] **Step 2: 记录自动化基线**

在 worktree 内运行,把输出计数抄进基线记录:

```bash
pnpm install
pnpm typecheck   # 期望:无错误
pnpm test        # 期望:全部通过——抄下确切的 "N passed" 数字(升级后必须 ≥ 此数、无新增失败)
pnpm build       # 期望:三包(main/preload/renderer)均成功
```

Expected:三条自动化命令全绿;记下 `pnpm test` 的通过总数 N(作为 Task 4 的对照基准)。

- [ ] **Step 3: 记录升级前手动冒烟基线**

```bash
pnpm dev   # 或 pnpm build && pnpm preview(更接近打包版)
```

肉眼确认并记录当前行为(作为升级后逐条对照的"应保持不变"参照):透明置顶窗显示宠物 luluka 播 idle、可拖拽、托盘右键退出、任务栏无图标、透明区域点击穿透。

Expected:窗口正常渲染,记录基线观察(截图或文字)。若此步在当前 sandbox 无显示器而无法进行,标注"基线手动冒烟由用户在真机完成"并继续——不阻塞后续 Task,但 Task 5/6 的真机回归必须补上。

- [ ] **Step 4: 提交基线记录**

```bash
git add docs/superpowers/plans/notes/2026-07-20-phase1-baseline.md
git commit -m "chore(electron-upgrade): 记录 Electron 升级前基线(测试数/构建/冒烟)"
```

---

### Task 2: 升级 Electron 与构建工具链版本

**Files:**
- Modify: `package.json`(`devDependencies`)
- Modify: `pnpm-lock.yaml`(自动)
- Modify(按需): `electron.vite.config.ts` / `electron-builder.yml`

**Interfaces:**
- Consumes: Task 1 的绿色基线。
- Produces: 一套装好的、可 typecheck + build 通过的新版本工具链;确切的 pin 版本号(供 Task 3 审计在正确版本上复核)。

- [ ] **Step 1: 查出要 pin 的确切版本**

在执行时(不要照抄本 plan 里的占位)查最新受支持版本:

```bash
npm view electron@^43.0.0 version              # 取最新 43.x patch → 记为 <ELECTRON_VER>
npm view electron-vite version                 # 最新;确认其 README/peer 支持 Electron 43
npm view electron-builder version              # 最新 24.x 或 25.x
```

若 `electron-vite` / `electron-builder` 最新版声明支持的 Electron 上限低于 43,选它们各自支持 43 的最高版本,并在基线记录里注明。

- [ ] **Step 2: 写入精确 pin 版本(去掉 `^`)**

编辑 `package.json` 的 `devDependencies`,把这几项改成 Step 1 查到的**精确**版本(无 `^`):

```jsonc
"devDependencies": {
  "electron": "<ELECTRON_VER>",              // 例如 "43.1.4",按 Step1 实测填
  "electron-builder": "<EB_VER>",
  "electron-vite": "<EV_VER>",
  // vite / vitest / typescript / @types/adm-zip 暂不动;仅当 Step 4 构建报不兼容再按提示最小上调
  ...
}
```

不改 `dependencies`(运行时依赖全为纯 JS,不受 Electron ABI 影响,无需重建)。

- [ ] **Step 3: 重装依赖**

```bash
pnpm install
```

Expected:安装成功。留意 v42 起 "electron 不再经 postinstall 自下载"——若安装日志出现 electron 二进制下载相关告警/失败,按 electron 官方说明处理(通常 `pnpm install` 仍会拉到二进制;必要时清 store 重试)。记录任何异常。

- [ ] **Step 4: typecheck + build 验证工具链**

```bash
pnpm typecheck   # 期望:无错误
pnpm build       # 期望:三包成功
```

Expected:两条均绿。若 electron-vite 报配置形状变化(如 externalize 插件、rollup 选项),按其报错**最小化**调整 `electron.vite.config.ts`——只改被要求的字段,不顺手重构。若 electron-builder 报字段变化,同法最小改 `electron-builder.yml`。任何配置改动在本 Task 内完成。

- [ ] **Step 5: 确认运行时 Node 版本(记录用)**

```bash
node -e "console.log('host node', process.version)"
# 打印一次 Electron 内置 Node/Chromium 版本(dev 启动时或临时脚本):process.versions.node / process.versions.chrome
```

把 Electron 内置的 Node/Chromium 版本抄进基线记录(供后续排查参考)。

- [ ] **Step 6: 提交**

```bash
git add package.json pnpm-lock.yaml electron.vite.config.ts electron-builder.yml
git commit -m "build(electron-upgrade): 升级 Electron 至 43.x + 构建工具链,pin 精确版本"
```

---

### Task 3: 复核并适配 breaking-change 触点

**Files:**
- Modify(按需,多数预计 no-op): `src/main/media/imagePrep.ts`、`src/main/pets/petAvatar.ts`
- 其余仅复核(grep 确认不命中)

**Interfaces:**
- Consumes: Task 2 装好的新版本。
- Produces: 一份"每条 breaking-change 对本项目的命中判定 + 处理"记录;凡命中项已改并保持 typecheck/test/build 绿。

> **审计表(已基于 32→43 官方 breaking-changes 文档 + 本代码库 grep 预判;执行者需在新版本上逐条复核,不是照单全收)。**

| 版本 | 变更 | 本项目命中? | 处理 |
|---|---|---|---|
| v32 | `File.path` 移除,改 `webUtils.getPathForFile()` | 否——渲染层走 `FileReader`/canvas + `clipboardData`(`dialog.ts:286`),主进程 `dialog` 读字节;全库 grep `.path` 无 File 对象用法 | 复核 grep,记 no-op |
| v32 | navigationHistory API 迁移 | 否(未用) | — |
| v33 | 原生模块需 C++20 | 否(无 node-gyp 原生模块) | — |
| v33 | 自定义协议 Windows 路径处理变化 | 本阶段否(`kibo-pet://` 是 Phase 2) | 记入 Phase 2 注意事项 |
| v35 | protocol 方法重组;preload 注册 API 替换 `setPreloads/getPreloads` | 否(用 `webPreferences.preload`,未用 `setPreloads`) | 复核 grep,记 no-op |
| v36 | `NativeImage.getBitmap()`→`toBitmap()` 弃用 | 否(`imagePrep`/`petAvatar`/`tray` 用 `createFromBuffer/createFromPath` + `toPNG/toJPEG`,未用 `getBitmap`) | 复核 grep;Step 3 验证图像往返 |
| v36 | `app.commandLine` switch 转小写 | 复核(grep `appendSwitch`;当前未见) | 复核,预计 no-op |
| v39 | desktopCapturer 需 `NSAudioCaptureUsageDescription`(macOS 14.2+) | 否(macOS-only;本项目 Windows-only) | — |
| v40 | 渲染层直接用 Electron `clipboard` 弃用 | 否(渲染层用 DOM `clipboardData`;Electron `clipboard` 只在主进程 `clipboardTools.ts`) | 复核,记 no-op |
| v42 | electron 不再 postinstall 下载;`ELECTRON_SKIP_BINARY_DOWNLOAD` 移除 | 可能(install/CI 行为) | Task 2 Step 3 已留意;记录 |
| v43 | dialog 默认目录改为 Downloads(不再记忆上次目录) | 是(`MEDIA_PICK_IMAGE` 选图 / `importPet` 选文件夹 / 语音安装路径选择器) | 纯 UX 行为变化,非破坏;Task 5 手动验收确认可接受 |
| v43 | `NativeImage.toBitmap()` 归一化到 sRGB | 否(未用 `toBitmap`) | — |

- [ ] **Step 1: 逐条复核审计表(grep 确认)**

对表中"复核"项运行确认,把结果写进审计记录:

```bash
# File.path / webUtils(应为空或仅无关命中)
# setPreloads / getPreloads(应为空)
# getBitmap（应为空）/ appendSwitch（应为空）
```

用 Grep 工具在 `src/` 内搜 `File.*\.path`、`getPathForFile`、`setPreloads`、`getPreloads`、`getBitmap`、`appendSwitch`,确认无命中(或仅注释/无关命中)。任一出现真实命中 → 按对应版本官方迁移指引在本 Task 内改掉,并补/改相应单测。

- [ ] **Step 2: 若无命中,记录 no-op 并跳到 Step 3**

若 Step 1 全部无命中(预期结果),在审计记录写明"代码侧 breaking-change 零命中,仅 v43 dialog 默认目录为运行时 UX 变化,留 Task 5 验收",本 Task 无代码改动。

- [ ] **Step 3: 图像往返健全性(imagePrep/petAvatar 的最小验证)**

`imagePrep.ts` / `petAvatar.ts` import electron 无法被 Vitest 直接跑(既有约定,靠真机)。在 Task 5 的手动回归里附带确认:识图选一张 png + 一张 jpg 能正常降采样识别、宠物头像(petAvatar 的 webp→dataURL)在聊天左栏正常显示、托盘图标正常。此处仅记录待验项,不写虚假单测。

- [ ] **Step 4: 提交(仅当有实际改动)**

```bash
# 若 Step 1 有真实命中并改动:
git add src/... docs/superpowers/plans/notes/2026-07-20-phase1-baseline.md
git commit -m "fix(electron-upgrade): 适配 Electron 43 breaking change <具体项>"
# 若全 no-op:仅提交审计记录
git add docs/superpowers/plans/notes/2026-07-20-phase1-baseline.md
git commit -m "chore(electron-upgrade): 记录 breaking-change 审计(代码侧零命中)"
```

---

### Task 4: 自动化回归(与基线逐条对齐)

**Files:** 无改动;仅运行验证。

**Interfaces:**
- Consumes: Task 2/3 的产物。
- Produces: 与 Task 1 基线等价或更好的自动化结果——作为"逻辑未退化"的必要(非充分)证据。

- [ ] **Step 1: 全量单测**

```bash
pnpm test
```

Expected:通过总数 ≥ Task 1 记录的 N,且**无新增失败**。若出现新失败,逐个定位:区分"测试用例本身依赖了旧 Electron 行为"(极少,本库纯逻辑测试不 import electron)与"真实退化"。任何真实退化在此修复后重跑至绿,再继续。

- [ ] **Step 2: 类型检查**

```bash
pnpm typecheck
```

Expected:无错误。新版 electron 的 `.d.ts` 若收紧了某些类型导致 TS 报错,按新签名最小修正调用点(不 `as any` 掩盖),并在提交信息注明。

- [ ] **Step 3: 三包构建**

```bash
pnpm build
```

Expected:main/preload/renderer 三包均成功。

- [ ] **Step 4: 提交(仅当有修复)**

```bash
git add -A
git commit -m "test(electron-upgrade): 修复升级引入的类型/测试退化,自动化回归全绿"
```

---

### Task 5: 开发态手动回归矩阵(真机肉眼验收)

**Files:** 无改动;执行 spec §13 的回归清单。

**Interfaces:**
- Consumes: 前序全绿的构建。
- Produces: §13 全清单的真机通过记录——这是本阶段"能跑"的主证据(自动化过 ≠ 能跑)。

> **本 Task 大部分需真实 Windows 显示器/输入,本仓库 agent 会话通常无显示器驱动;按项目既定惯例由用户在真机执行。** 执行者(或用户)逐项对照 Task 1 基线,勾选"行为与升级前一致"。

- [ ] **Step 1: 启动**

```bash
pnpm build && pnpm preview   # preview 比 dev 更接近打包版、启动更稳
```

- [ ] **Step 2: 逐项走查 spec §13 回归清单(与基线对照,期望"无变化")**

- [ ] 透明置顶窗渲染 luluka + idle 动画;`alwaysOnTop`(screen-saver 级)压住其它窗口。
- [ ] 点击穿透:透明区域点击落到下层窗口;宠物实体像素上不穿透(`isPetPixel` 判定)。
- [ ] 拖拽移窗:按住拖动跟手、放下平滑;跨屏/不同 DPI 不漂移(记忆 [[pet-movement-fixes-2026-07-08]] 关注项)。
- [ ] 托盘:右键菜单出现、退出可用;任务栏不显图标。
- [ ] 全局热键:呼出/关闭对话框正常。
- [ ] IPC + context isolation/sandbox:`window.petApi`/`chatApi`/`settingsApi` 等桥接可用,渲染层无 Node 访问。
- [ ] 设置窗:预设/baseURL/model/key、测试连接、保存生效;首开不闪白异常放大(已知 Minor)。
- [ ] 聊天:发送→逐字流式回复、Markdown 渲染、来源链接系统浏览器外开;取消可用。
- [ ] 气泡窗:折叠态跟随宠物、自适应高度、瞬态台词与流式回复互斥不串扰。
- [ ] 待办:面板增删改、到点触发提醒。
- [ ] 截屏 + 桌面控制:`take_screenshot` 有图;`click_at`/`type_text`/`focus_window` 实际生效;`"<宠物名> 正在控制鼠标"`提示条显示且用后隐;人工抓鼠标即中断(记忆 [[real-machine-testing-can-hit-users-real-windows]]:验证前确保前台是测试目标窗口,别打进用户真实文件)。
- [ ] 浏览器控制(Playwright):隔离 profile 打开/导航/点击;关开关后工具消失、无残留进程。
- [ ] 语音 Sidecar:启用 TTS 的宠物朗读正常;切宠物端口正确释放重启(记忆 [[ws-package-binarytype-fake-blindspot]] 类问题关注音频帧到达)。
- [ ] 图像往返(承 Task 3 Step 3):png/jpg 识图、宠物头像、托盘图标显示正常。
- [ ] **v43 dialog 目录变化**:选图/导入宠物文件夹/选语音安装路径的默认目录变为 Downloads —— 确认这是可接受的 UX(非 bug)。

- [ ] **Step 3: GPU 模式回归(取决于 Phase 0 是否已合并)**

- 若 Phase 0(`gpuBootDecision`)已合并进 base:分别在**默认(软件渲染)**与**设置里勾选"尝试启用硬件加速渲染(实验性)"重启后(硬件渲染)**两种模式下,确认宠物窗均正常出画、无空白/无崩溃。
- 若 Phase 0 未合并:仅验证当前单一软件渲染模式;在收尾记录"GPU 两模式回归延后到 Phase 0 合并后补做"。

- [ ] **Step 4: 记录结果**

把逐项结果(通过/异常 + 现象)写入基线记录的"升级后"栏。任何异常回到对应 Task 修复后重验。

---

### Task 6: 打包回归 + 真机安装冒烟(用户真机任务)

**Files:** 无改动;产出并安装 NSIS 包。

**Interfaces:**
- Consumes: 前序全绿。
- Produces: 可安装、可运行的升级后安装包——覆盖 `pnpm preview` 永远暴露不了的打包/GPU/盘符路径(记忆 [[packaged-gui-gpu-crash]])。

> **本 Task 必须真机执行,且是历史上最易崩的路径(MVP-06 打包秒退根因即 GPU 子进程)。agent 会话跑不起打包 GUI 的 GPU 路径,只能由用户完成。**

- [ ] **Step 1: 打包**

```bash
pnpm dist   # → dist/Kibo Setup <ver>.exe
```

Expected:出包成功。若卡 `winCodeSign` darwin 符号链接 → 按 README「打包构建说明」三选一绕过。

- [ ] **Step 2: 真机安装冒烟(C: / D:)**

在 C: 和 D: 各装一次并运行,确认:宠物渲染/托盘/对话/记忆落盘(`%APPDATA%\Pet-Agent\...`)/编辑 persona 生效/拷走宠物文件夹可移植/卸载不丢数据。

Expected:与升级前一致,**尤其不得复现打包秒退**。若崩溃,按 [[packaged-gui-gpu-crash]] 诊断法(WER LocalDumps → `%LOCALAPPDATA%\CrashDumps` → python `minidump` 解析搜 `FATAL:...cc(NNN)`)定位;新 Electron 的 Chromium/SwiftShader 行为可能与 31 不同,重点看 GPU 子进程退出码。

- [ ] **Step 3: E: 盘符 caveat(如适用)**

已知 E:(非标准 ACL:显式 RESTRICTED + AppContainer SID)会触发 GPU 子进程 `0xC0000135` 崩溃;用户既定接受"装 C:/D:"。仅在用户仍关心 E: 时验证;否则记录"E: 维持已知限制,不在本阶段解决"。

- [ ] **Step 4: 记录结果**

把安装冒烟结果写入基线记录。

---

### Task 7: 收尾提交 + 文档更新

**Files:**
- Modify: `PROGRESS.md`

**Interfaces:**
- Consumes: 前序全部通过(或明确标注的真机待验项)。
- Produces: 可合并的升级分支 + 交接记录。

- [ ] **Step 1: 更新 PROGRESS.md**

在 PROGRESS.md 顶部状态与路线图追加:Electron 31→43 升级 + 全回归完成情况;明确记录 (a) 本阶段**未改 GPU 决策**(属 Phase 0);(b) 真机待验清单里尚未由用户勾掉的项;(c) pin 的确切 electron/工具链版本。

- [ ] **Step 2: 提交**

```bash
git add PROGRESS.md
git commit -m "docs(electron-upgrade): 更新进度——Electron 43 升级完成 + 真机待验项交接"
```

- [ ] **Step 3: 收尾分支**

REQUIRED SUB-SKILL:用 superpowers:finishing-a-development-branch 决定合并/PR/清理。合并前置条件:自动化全绿(Task 4)+ 用户已完成 Task 5/6 真机回归且无退化。**若真机回归尚未由用户完成,不要自动合并**——按项目惯例把真机验收留给用户,合并时机由用户拍板。

---

## Self-Review(对照 spec §13 与本项目现状)

**1. Spec §13 覆盖**:
- "升级到受支持 Electron 稳定版、目标 43.x 最新补丁 + 同步升级 electron-vite/electron-builder/配置" → Task 2 ✓
- "升级任务与 Live2D 功能提交分离" → 本 plan 即独立阶段,不含任何 Live2D 改动 ✓
- §13 回归清单(透明置顶窗+穿透 / 托盘+热键 / IPC+隔离沙箱 / 设置聊天气泡待办 / 屏幕捕获+桌面浏览器控制 / 语音 Sidecar / Windows 安装包)→ Task 5 逐项 + Task 6 安装包 ✓
- "依赖精确版本不用 `^`" → Global Constraints + Task 2 Step 2 ✓
- "Cubism Core 本地随包/记 SHA-256" → **不属本阶段**(Phase 4/13 后段的 Live2D 依赖引入才做),本 plan 不引入 pixi/引擎/core,已在边界里排除 ✓

**2. Placeholder 扫描**:版本号用 `<ELECTRON_VER>` 等占位是**有意**的——真实版本必须执行时 `npm view` 实测再 pin,硬编码一个我无法验证的补丁号反而是臆造;已在 Task 2 Step 1 给出确切获取命令,非 "TBD"。breaking-change 处理不是 "适当处理",而是给了逐条命中判定表 + grep 复核命令 + 命中时的具体迁移出处。

**3. 类型/命名一致**:本阶段几乎无新代码;涉及的既有符号(`isPetPixel`、`gpuBootDecision`、`imagePrep`、`clipboardData`、`webPreferences.preload`)均与代码库实际一致(已 grep 核对)。

**4. 诚实边界**:明确标注绝大多数验收为真机手动(非自动化可证),GPU 两模式回归依赖 Phase 0 合并状态,E: 盘符维持已知限制——不假装本阶段能解决打包 GPU 崩溃或自动化 GUI 验收。
