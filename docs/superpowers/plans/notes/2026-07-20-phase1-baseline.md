# Phase 1 Electron 升级 — 升级前基线

日期:2026-07-20
Worktree:`.claude/worktrees/live2d-phase1-electron-upgrade`(分支 `worktree-live2d-phase1-electron-upgrade`,base = 当时的 `main` @ `e607d16`)
说明:此时 Phase 0(GPU reboot-degrade,worktree `gpu-accel-reboot-degrade`)**尚未合并进 main**,本阶段按计划的 Task 5 Step 3 fallback 走"单一软渲染模式回归"。

## 升级前版本

```
electron:         ^31.0.0
electron-vite:     ^2.3.0
electron-builder:  ^24.13.3
```

## 自动化基线

```
pnpm typecheck   → 通过,无错误
pnpm test        → 89 files / 789 tests 全部通过
                   (首次运行 pets/luluka 缺失导致 petLoader.test.ts 1 个失败——
                    非回归,worktree 是全新 git checkout,pets/luluka 按 CLAUDE.md
                    是有意 gitignore、仅存在于主仓库磁盘;从主仓库 cp -r pets 拷入
                    worktree 后复测,789/789 全绿)
pnpm build       → 三包(main/preload/renderer)均构建成功
```

**基准数字(供 Task 4 对照)**:N = 789(全部通过,0 失败)。

## 手动冒烟基线

本 sandbox 无显示器,升级前手动冒烟由用户在真机完成(按项目既定惯例)。Task 5/6 的真机回归需覆盖:透明置顶窗渲染 idle 动画、拖拽跟手、点击穿透、托盘退出、任务栏不显图标。

## Electron 内置运行时版本(升级前,记录用)

未在本 Task 单独起 Electron 进程探测 `process.versions`;留给 Task 2 Step 5 与升级后版本一并对照记录。

## Task 2:升级后版本(2026-07-20)

```
electron:         43.1.1   (精确 pin,原 ^31.0.0)
electron-vite:     5.0.0   (精确 pin,原 ^2.3.0)
electron-builder: 26.15.3  (精确 pin,原 ^24.13.3)
vite:             ^6.4.3   (被迫最小上调,原 ^5.3.0;原因见下)
```

`npm view` 依据(执行时查得,均非 deprecated):

```
npm view electron@^43.0.0 version   → 43.1.1 是当前最新 43.x patch(43.0.0/43.1.0/43.1.1)
npm view electron-vite version      → 5.0.0(peerDependencies.vite: "^5.0.0 || ^6.0.0 || ^7.0.0",无硬编码 Electron 版本上限——它只在构建/dev 时 externalize 'electron' 模块,不校验 Electron 版本号)
npm view electron-builder version   → 26.15.3(无 electron 版本硬约束,靠自身逻辑适配)
```

### 被迫的 vite 最小上调(electron-vite 5.0.0 的类型定义问题)

pin 好 electron-vite@5.0.0 后,`electron.vite.config.ts` 在原 vite ^5.3.0(实测锁定 5.4.21)下 `pnpm typecheck` 报:

```
electron.vite.config.ts(7,14): error TS2769: No overload matches this call.
  Object literal may only specify known properties, and 'rollupOptions' does not exist in type 'MainBuildOptions'.
```

排查:electron-vite@5.0.0 的 `MainBuildOptions`/`PreloadBuildOptions` 类型继承自 vite 的 `BuildEnvironmentOptions`(vite 6 引入的 Environment API 类型),而 vite 5.4.21(vite 5.x 最新版,已核实无更高 5.x)整个包里**不存在**这个类型导出(`grep -r BuildEnvironmentOptions node_modules/vite` 零命中)。也就是说 electron-vite@5.0.0 虽然 `peerDependencies` 仍声明兼容 vite ^5,但其类型定义实际要求 vite 6+ 才能编译通过——这是 electron-vite 自身的问题,不是本项目 config 写法的问题。

处理:按 Task 2 brief 允许的"仅当 Step4 报不兼容才最小上调"原则,把 `vite` 从 `^5.3.0` 上调到 `^6.4.3`(vite 6.x 最新 patch,而非直接跳到 vite 7,尽量保持改动最小)。`electron.vite.config.ts` 本身**未做任何改动**——升级 vite 后原有 `rollupOptions` 写法就能正常通过类型检查,说明这纯粹是类型定义版本错配,不是配置形状的破坏性变更。

风险提示(留给 Task 4,**Task 2 复审已解除**):`vitest@2.1.9` 的 `dependencies.vite` 硬依赖 `^5.0.0`,与项目顶层 `vite@^6.4.3` 版本不一致;`node-linker=hoisted` 下 pnpm 为 vitest 单独嵌套安装了它自己的 vite@5。复审时已实测 `pnpm test`:789/789 通过,与升级前基线完全一致——该版本错配不影响测试运行,Task 4 无需为此单独排查。

`electron-builder.yml` 未做任何改动——升级到 26.15.3 后本 Task 范围内(`pnpm typecheck`/`pnpm build`)未触发它,`pnpm dist`(实际打包)未在本 Task 验证。

### Electron 43.1.1 内置运行时版本(实测)

通过 `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe -e "console.log(JSON.stringify(process.versions))"` 探测(仅用于一次性诊断,非常规启动方式):

```
electron: 43.1.1
node:     24.18.0
chrome:   150.0.7871.114
v8:       15.0.245.15-electron.0
```

宿主 `node -e "process.version"` = v24.15.0(与内置 node 24.18.0 接近但不同,属预期——Electron 内置 Node 是独立编译的)。

补充:Electron ≥42 起不再通过 npm `postinstall` 生命周期脚本下载二进制(`node_modules/electron/package.json` 没有 `scripts` 字段),而是改为 `require('electron')`(即 `node_modules/electron/index.js`)首次被调用时懒下载。`pnpm install` 本身**不会**触发下载——这与 plan 里"通常 pnpm install 仍会拉到二进制"的预期不符,已在此记录更正。`pnpm typecheck`/`pnpm build` 也不触发下载(只用 vite/tsc,不 spawn electron 二进制)。本 Task 为了拿到 process.versions,手动跑了一次 `node node_modules/electron/install.js` 触发下载。后续 `pnpm dev`/`pnpm preview`/`pnpm dist` 第一次运行时会自动懒下载(需要网络访问 Electron 的二进制分发源)。

### 自动化验证结果(Task 2)

```
pnpm typecheck   → 通过,无错误
pnpm build       → 三包(main/preload/renderer)均构建成功(vite v6.4.3)
pnpm test        → 本 Task 未运行(不在 brief Step4 范围,回归修复留给 Task 4)
```
