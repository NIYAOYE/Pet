# Live2D 呈现改造 · Phase 5:动态窗口/锚点/命中/无闪烁热切换 — 设计文档

## 背景

主设计文档(`docs/superpowers/specs/2026-07-20-live2d-renderer-design.md`)§9/§10/§11 定义了本阶段目标;Phase 0-4 均已完成并合并进 `main`(推送至 `origin/main`)。Phase 4 设计文档明确把"动态窗口尺寸/脚底锚点/气泡锚点消费"和"无闪烁热切换 ACK 通道"列为非目标、留给本阶段。

Phase 4 真机联调时另外发现并修复了一个不在原计划内的回归:热切换(含同类型 Live2D→Live2D)会白屏。根因是 `Live2DPetRenderer.load()` 内部无条件 `await this.destroy()` 后 `new Application()`,而 `Application.destroy()` 会无条件强制 `loseContext()`;当时的修复是"每次热切换都换新 `<canvas>` 元素、整个渲染器实例重建",这是能立刻止血的最小修复,但和主设计文档 §10"热切换只替换模型,不重建 Renderer"的长期目标冲突。

本阶段 brainstorming 阶段已经和用户核对过这处冲突,结论是:冲突的根源被过度泛化了——真正的硬约束只在于"canvas 一旦绑定过某种 `context` 类型就终身不可变"(HTML Canvas 规范),这只影响精灵↔Live2D 之间的切换;Live2D→Live2D 之间从未真正需要换 canvas,只是 Phase 4 为了快速止血选择了统一处理。本阶段按渲染器类型分叉,分别处理。

## 目标

1. `PetRenderer` 接口新增 `prepareSwap()`/`commitSwap()`/`discardSwap()`,`Live2DPetRenderer` 用它们实现"同类型热切换只换 model、不碰 Application/canvas"。
2. `PetController` 的 `prepareReload`/`commitReload`/`discardReload` 三个入口按渲染器类型分叉:同类型走 1 的三段式;跨类型保留 Phase 4 已验证的"新建 canvas+渲染器实例、成功后才接入 DOM"路径,但纳入同一套准备-提交时序。
3. 主进程 `switchPet()` 从"先切会话、Renderer 后加载"改为"Renderer 确认新模型首帧渲染成功后,主进程才提交会话切换"——新增 `PET_PREPARE`/`PET_PREPARE_RESULT`/`PET_COMMIT`/`PET_DISCARD` IPC 握手。
4. Live2D 宠物包的窗口尺寸从硬编码 `256×288` 改为读 `manifest.render.viewport`,夹取到 `最小192×256/默认360×480/最大800×900`;窗口本身从创建起就是 `resizable:true`,尺寸变化只在首次加载/热切换提交时触发一次 `setBounds()`。
5. 窗口尺寸变化时保持"脚底锚点"(约定为窗口内容区 `(0.5, 1.0)`)在屏幕上的绝对位置不跳动。
6. 气泡窗定位从"宠物窗口左上角+固定居中假设"泛化为可配置锚点(`bubbleAnchorX/Y`,精灵包缺省 `(0.5, 0)` 与现状完全一致)。
7. 场景相关的 Live2D 渲染帧率策略(拖拽/说话/动作=60,待机=30,睡眠=15,隐藏/最小化/锁屏=0)落地,并把 Phase 3 就定义、但从未被真正调用过的 `setVisible()` 接上真实的窗口可见性信号。
8. 回归验证:点击穿透/命中检测在窗口尺寸变为动态之后仍然正确。

## 非目标

- **消费 `hitTest()` 返回的 `area` 字段**(按部位触发不同动作/表情)——这是主设计文档 §8.1 描述的能力,但排在 Phase 6(鼠标追踪)范畴,本阶段不新增任何调用方。
- **设置窗宠物下拉改为热切换**——brainstorming 已与用户确认维持现状(保存+重启),只修复对话框/头像点击已经在用的 `SWITCH_PET` 热切换路径。
- **精灵包纳入动态窗口尺寸/脚底锚点体系**——brainstorming 已与用户确认,精灵包窗口尺寸继续等于 `sheet.cellWidth×cellHeight`,不夹取、不引入脚底锚点重定位;只是把窗口尺寸的数据来源从主进程/渲染层各自硬编码的 `256×288` 常量,统一改为读 `manifest.sheet`。
- **鼠标追踪、口型包络平滑、设置/导入预览 UI**——Phase 6。
- **DPI/显示器变化时反应式重算 `resolution`**——`Live2DPetRenderer.load()` 目前只在加载时读一次 `window.devicePixelRatio`,本阶段不新增"跨屏拖拽时重新计算分辨率"的响应式逻辑,这是既有的、本阶段不承诺修的缺口(仍在 §14/真机验收矩阵的测试维度里,但作为已知观察项,不作为本阶段交付物)。
- 不改动 Phase 2 已完成的导入流程/安全校验,不改动 Phase 4 已完成的自动对齐/水印破冰逻辑本身(`needsAutoFit`/`autoFit`/`pickWatermarkBreakExpressionName` 复用不变)。

## 1. 热切换 Renderer 复用策略

`PetController` 把"准备"和"提交/丢弃"拆成三个显式入口(而不是一个不可分割的 `reload()`),因为 §3 的协议要求 `PET_PREPARE` 只触发准备、`PET_COMMIT`/`PET_DISCARD` 才在之后某个时刻触发提交/丢弃——中间主进程还要做会话切换,不能挤在同一次调用里。判断 `source.type === this.rendererType`:

- **同类型**(live2d→live2d 或 sprite→sprite):`prepareReload()` 调用 `this.renderer.prepareSwap(source)`;`commitReload()` 调用 `this.renderer.commitSwap()`;`discardReload()` 调用 `this.renderer.discardSwap()`。当前可见模型/canvas/Application 全程不受影响,直到 `commitReload()` 真正执行。
- **跨类型**(sprite↔live2d):`prepareReload()` 新建一个**不挂进 DOM** 的 `<canvas>` 元素 + 对应类型的新渲染器实例,后台调用其 `load(source)`,成功则把新实例暂存到 `this.pendingRenderer/this.pendingCanvas`(失败则直接销毁新实例并抛错,`pendingRenderer` 保持空);`commitReload()` 把暂存的新 canvas 接入 DOM(替换旧 canvas)、销毁旧渲染器实例、更新 `this.renderer`/`this.canvas`/`this.rendererType`;`discardReload()` 销毁暂存的新实例,DOM 从未变化过。

```ts
async prepareReload(source: PetRenderSource): Promise<void> {
  if (source.type === this.rendererType) {
    await this.renderer.prepareSwap(source) // 抛错交给调用方(main.ts 的 onPetPrepare)上报失败
    return
  }
  const nextCanvas = createDetachedCanvas(this.canvas) // 复制 id,不 replaceWith,不挂 DOM
  const nextRenderer = this.createRenderer(nextCanvas, source.type)
  try {
    await nextRenderer.load(source)
  } catch (err) {
    await nextRenderer.destroy()
    throw err
  }
  this.pendingRenderer = nextRenderer
  this.pendingCanvas = nextCanvas
}

commitReload(): void {
  if (this.pendingRenderer) {
    this.canvas.replaceWith(this.pendingCanvas!)
    void this.renderer.destroy()
    this.renderer = this.pendingRenderer
    this.canvas = this.pendingCanvas!
    this.rendererType = this.pendingRenderer.type
    this.pendingRenderer = null
    this.pendingCanvas = null
    return
  }
  this.renderer.commitSwap()
}

discardReload(): void {
  if (this.pendingRenderer) {
    void this.pendingRenderer.destroy()
    this.pendingRenderer = null
    this.pendingCanvas = null
    return
  }
  this.renderer.discardSwap()
}
```

`main.ts` 收到 `PET_PREPARE` 时调用 `prepareReload(source)`,成功/失败分别 `reportPrepareResult(requestId, true)` / `reportPrepareResult(requestId, false, message)`;收到 `PET_COMMIT` 调 `commitReload()`;收到 `PET_DISCARD` 调 `discardReload()`。首次启动加载不经过这三个方法,仍用现有的 `load()`。

## 2. `PetRenderer` 接口新增

`src/renderer/petRenderer.ts` 新增三个方法(`load`/`playState`/`setFacing`/`setLipSync`/`hitTest`/`setVisible`/`destroy` 不变):

```ts
interface PetRenderer {
  load(source: PetRenderSource): Promise<void>
  prepareSwap(source: PetRenderSource): Promise<void>
  commitSwap(): void
  discardSwap(): void
  resize(viewport: PetViewport): void
  // ...既有方法不变
}
```

- **`Live2DPetRenderer.prepareSwap(source)`**:在**同一个 `this.app`** 上 `Live2DModel.from(newUrl)` 构建新 model(不 `stage.addChild`),按新 manifest 的 `transform` 设好 `anchor`/`scale`/`position`,等待首帧就绪后挂到 `this.pendingModel`,当前可见的 `this.model`/`app`/`canvas` 全程不动。`commitSwap()` 执行 `this.model?.destroy(); this.app.stage.addChild(this.pendingModel); this.model = this.pendingModel; this.pendingModel = null`,同时把 `this.manifest` 切到新 manifest。`discardSwap()` 销毁 `this.pendingModel`(若有)并清空,不影响 `this.model`。
- **`SpriteRenderer.prepareSwap(source)`**:后台解码/校验新 manifest 对应的 spritesheet(`Image` 预解码),校验通过后挂到 `this.pendingSheet`/`this.pendingManifest`;`commitSwap()` 才真正切 `this.sheet`/`this.manifest` 并重置帧索引;`discardSwap()` 清空 pending 字段。2D canvas 没有 context 复用问题,这套三段式主要是为了和 Live2D 接口对称,不是规避某个具体 bug。
- **`resize(viewport)`** 从 no-op 变成真正实现:`Live2DPetRenderer.resize()` 调用 `this.app.renderer.resize(viewport.width, viewport.height)`;`SpriteRenderer.resize()` 保持 no-op(精灵包窗口尺寸固定等于 sheet 格子尺寸,不参与动态 resize,见"非目标")。

## 3. 主进程 `switchPet()` 准备-提交协议

新增单向 IPC(`src/shared/ipc.ts` 统一登记常量 + 类型):

- `PET_PREPARE`(main → renderer):`{ requestId: string; source: PetRenderSource }`
- `PET_PREPARE_RESULT`(renderer → main,经 preload 暴露为 `petApi.reportPrepareResult(requestId, ok, error?)`):`{ requestId: string; ok: boolean; error?: string }`
- `PET_COMMIT`(main → renderer):`{ requestId: string }`
- `PET_DISCARD`(main → renderer):`{ requestId: string }`

`switchPet(petId)` 新时序:

```
1. 校验目标宠物存在 + renderReady                              (不变)
2. next = createPetSession(petId, sessionDeps)                  (不变,先建后弃,不碰旧会话)
3. source = 解析新会话的 PetRenderSource(manifest + kibo-pet:// baseUrl / dataURL)
4. requestId = 随机 token;send(PET_PREPARE, { requestId, source })
5. 等待 ipcMain 收到匹配 requestId 的 PET_PREPARE_RESULT,带超时
   (映射 MODEL_LOAD_TIMEOUT;超时或渲染层报 ok:false 均视为失败)
6a. 成功:
    await session.dispose()          // 旧会话
    session = next
    session.startVoice()
    saveSettings({ ...settings, activePetId: petId })
    petWin.setBounds(footAnchorPreservingBounds(...))  // 见 §4/§5,与 PET_COMMIT 同一时刻
    send(PET_COMMIT, { requestId })                    // 渲染层 commitSwap() / 接入新 canvas
    dialog.pushUpdate(session.messages()); PET_SWITCHED 提示  (不变)
6b. 失败:
    await next.dispose()             // 丢弃已建好但未使用的新会话
    send(PET_DISCARD, { requestId }) // 渲染层 discardSwap() / 销毁半成品新实例
    原 ipcMain.handle 调用以结构化错误码 reject;旧会话/旧模型完全未被触碰
```

渲染层 `main.ts` 侧:`petApi.onPetPrepare` 触发 `controller.prepareReload(source)`,成功后立即 `petApi.reportPrepareResult(requestId, true)`,捕获异常后 `reportPrepareResult(requestId, false, err.message)`;`onPetCommit` 触发 `controller.commitReload()`,`onPetDiscard` 触发 `controller.discardReload()`(均见 §1)。

应用首次启动加载(没有"旧模型"要保护)不走这套协议,仍是现有的直接 `load()`。

## 4. 动态窗口尺寸

**尺寸来源**(纯函数,`src/shared/windowPlacement.ts`):

```ts
function clampLive2DViewport(viewport: Live2DViewport): { width: number; height: number } {
  const MIN = { width: 192, height: 256 }
  const MAX = { width: 800, height: 900 }
  return {
    width: clamp(viewport.width, MIN.width, MAX.width),
    height: clamp(viewport.height, MIN.height, MAX.height)
  }
}
```

`Live2DPetRenderer.load()`/`prepareSwap()` 里 `app.init()`/`app.renderer.resize()` 用的宽高,和主进程 `switchPet()`/首次加载时算窗口尺寸用的宽高,共享这同一个函数——不再是两处各自硬编码 `256×288`。精灵包窗口尺寸继续等于 `manifest.sheet.cellWidth × cellHeight`,读数据源而非常量,但不套用这个夹取函数。

**窗口本身怎么换尺寸**:`createPetWindow()` 创建时 `resizable: true`(不再是 `false`),且运行时从不调用 `setResizable()`。拖拽路径继续只用 `setPosition()`(不变,规避已知的 `isVisible()` 腐化坑)。尺寸变化只发生在首次加载宠物、以及 §3 `PET_COMMIT` 那一步,一次 `setBounds()` 同时完成移动+变形。

## 5. 脚底锚点保持

纯函数,`src/shared/windowPlacement.ts`,与 `fixedWindowBounds`/`clamp` 放在一起:

```ts
const FOOT_ANCHOR = { x: 0.5, y: 1.0 } // 固定约定,与现有 autoFit 的"贴底居中"惯例一致

function footAnchorPreservingBounds(
  oldBounds: Bounds,
  newSize: { width: number; height: number },
  workArea: Bounds
): Bounds {
  const anchorAbsX = oldBounds.x + FOOT_ANCHOR.x * oldBounds.width
  const anchorAbsY = oldBounds.y + FOOT_ANCHOR.y * oldBounds.height
  const x = clamp(anchorAbsX - FOOT_ANCHOR.x * newSize.width, workArea.x, workArea.x + workArea.width - newSize.width)
  const y = clamp(anchorAbsY - FOOT_ANCHOR.y * newSize.height, workArea.y, workArea.y + workArea.height - newSize.height)
  return { x, y, ...newSize }
}
```

只在尺寸真正变化(首次加载/热切换提交)时调用一次,不参与逐帧拖拽路径。仅对 Live2D 包生效(精灵包尺寸不变,不需要这个函数)。

## 6. 气泡锚点泛化

`bubblePlacement()`(`src/shared/bubblePlacement.ts`)新增第四个参数,默认值保持现状完全兼容:

```ts
function bubblePlacement(
  pet: Bounds,
  workArea: Bounds,
  bubble: { width: number; height: number },
  anchorFrac: { x: number; y: number } = { x: 0.5, y: 0 }
): BubblePlacement {
  const anchorX = pet.x + anchorFrac.x * pet.width
  const anchorY = pet.y + anchorFrac.y * pet.height
  // 后续水平/竖直摆位逻辑改用 anchorX/anchorY 替代原来写死的 petCenterX/pet.y,其余算法不变
}
```

精灵包不传第四参数,行为与现状字节对齐(默认值就是当前隐含行为:水平居中、贴窗口顶部)。Live2D 包调用方(`src/main/shell/index.ts` 里调用 `bubbleController.show/reposition` 的地方)传入当前会话 manifest 的 `render.transform.bubbleAnchorX/Y`。

## 7. 场景帧率策略

```ts
function fpsForState(state: PetVisualState): number {
  if (state === 'sleep') return 15
  if (state === 'idle') return 30
  return 60 // drag/walk-left/walk-right/talk/greet/thinking/happy/sad/cry/surprised/love
}
```

`Live2DPetRenderer.playState(state)` 内追加 `this.app.ticker.maxFPS = fpsForState(state)`。精灵模式不参与(2D canvas 绘制,不是 §10 表格针对的 WebGL 场景)。

`setVisible()` 的 `ticker.start()/stop()` 目前是死代码(Phase 3/4 定义了接口和实现,但从未被调用过)。本阶段接上真实信号:主进程新增对 `petWin.on('minimize'/'restore')` 和既有 `powerMonitor` 锁屏/解锁事件(情境感知模块 `idleWatcher.ts` 已经在用同一个 API,不是新依赖)的监听,通过新增单向 IPC(`WINDOW_VISIBILITY_CHANGED`,`{ visible: boolean }`)推给渲染层,`main.ts` 收到后调用 `controller.setVisible(visible)`。

## 8. 命中检测范围

`Live2DPetRenderer.hitTest()`(HitArea 优先、无 HitArea 退化包围盒)和 `SpriteRenderer.hitTest()`(像素 alpha 检测)在 Phase 4/既有实现里已经完成,本阶段不新增任何消费 `PetHitResult.area` 字段的交互逻辑。本阶段唯一相关工作是**回归验证**:窗口/canvas 尺寸变为动态之后,`toCanvasCoords()`(Live2D)和 `isPetPixel()`(精灵,含 `getBoundingClientRect()` 缩放换算)的坐标转换在新的可变 viewport 下依然正确——这是回归测试范畴,不是新功能。

## 9. 错误码

复用主设计文档 §12 已定义的错误码,本阶段实际触发的子集:

- `MODEL_LOAD_TIMEOUT`——`PET_PREPARE_RESULT` 超时未回。
- `MODEL_SWITCH_FAILED`——渲染层 `prepareSwap()`(同类型)或 `load()`(跨类型)抛出异常。

`switchPet()` 失败路径下,原 `ipcMain.handle` 调用以上述错误码之一 reject,由对话框侧现有错误提示通道展示;旧宠物的会话与画面全程不受影响,不引入"部分切换"中间状态。

## 10. 测试策略

遵循项目现有惯例——纯逻辑 TDD,涉及真实 Pixi/WebGL/Electron 窗口的部分靠真机验收,不假装能自动化验证。

**纯函数单测(新增)**:
- `clampLive2DViewport`、`footAnchorPreservingBounds`、`fpsForState`
- `bubblePlacement` 新增的 `anchorFrac` 参数分支(含默认值向后兼容的回归用例)

**`PetController` 三入口分叉编排**:复用现有 `petController.test.ts` 已有的 fake `PetRenderer` 双,新增用例覆盖:同类型 `prepareReload`→`commitReload` 走 `prepareSwap`/`commitSwap`;跨类型 `prepareReload`→`commitReload` 走新实例+新 canvas;`prepareReload` 失败或显式 `discardReload()` 时,同类型走 `discardSwap()`、跨类型销毁暂存的新实例,且两种情况下旧渲染器/canvas 引用均未被替换。

**主进程 `switchPet()` 新三段式时序**:延续既有的 fake session / fake `webContents.send` 集成测试模式,覆盖:成功提交(会话/settings/setBounds 均在收到 ok 后才发生)、超时丢弃、渲染层报错丢弃三条路径,断言失败路径下 `activePetId`/`session` 引用完全未被修改。

**如实说明现有缺口**:`Live2DPetRenderer`/`SpriteRenderer` 本体涉及真实 `Application`/`Live2DModel`/`Ticker`/DOM canvas 的部分,项目至今没有建过 mock 引擎单测(设计文档 §15.3 是愿景,实际路线是"提取纯逻辑单测 + 真机肉眼验收",与 `live2dHitTestFallback`/`live2dStateMapResolver`/`live2dAutoSetup` 的先例一致)。以下只能真机验证,不在 CI 可验证范围:
- 热切换(同类型/跨类型各方向)是否真的零闪烁、旧模型是否全程可见到提交那一刻。
- 切换不同尺寸/比例的 Live2D 模型时,脚底锚点是否真的不跳动(需要真实购买模型,本仓库/CI 不分发测试模型)。
- 场景帧率是否真的按状态/可见性变化(需要真机用任务管理器或 DevTools Performance 面板观察)。
- 窗口 `resizable:true` 之后,无边框透明窗口边缘是否会意外出现可拖拽调整大小的鼠标热区,干扰现有点击穿透/拖拽体验。
- 无 HitArea 模型的包围盒回退命中,在动态窗口尺寸下的坐标换算是否仍然准确。
