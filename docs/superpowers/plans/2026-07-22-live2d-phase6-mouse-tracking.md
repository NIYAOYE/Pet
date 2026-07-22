# Live2D Phase 6 · 鼠标追踪 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Execution order note:** 本计划 Task 2 会在 `src/renderer/petController.ts`/`petController.test.ts`/`src/renderer/petRenderer.ts` 上继续叠加改动,假设 **`docs/superpowers/plans/2026-07-22-live2d-phase6-lipsync.md` 已经先执行完**(petController.test.ts 的 fake renderer 已经有 `lipSyncLevels` 字段、`PetController` 已经有 `setLipSync()` 方法)。如果这份计划先执行,Task 2 的"当前文件"代码块会和实际不符,需要先去把口型计划跑完。

**Goal:** Live2D 宠物在全桌面范围内让眼睛/头部有限度朝向鼠标,离开范围/拖拽/睡眠时平滑回正;设置页可以关闭这个功能。

**Architecture:** 主进程一个 30Hz 轮询循环读全局光标位置,结合窗口矩形、拖拽状态、宠物能力声明(`manifest.render.interaction.mouseTracking`)和用户设置算出一个 `[-1,1]` 目标方向,通过新的 `MOUSE_FOCUS` 推送 IPC 发给渲染进程;渲染进程的 `PetController` 叠加"是否在睡眠"这一渲染进程独有的状态知识后转发给 `Live2DPetRenderer.setLookTarget()`,内部调用引擎自带的 `Live2DModel.focus(x, y)`——平滑插值、参数缺失兜底、Motion 优先级共存全部由引擎处理,不需要自己实现。

**Tech Stack:** TypeScript, Electron (`screen.getCursorScreenPoint`, `ipcMain`/`ipcRenderer`), Vitest。

## Global Constraints

- 不新增依赖;不修改 `package.json`。
- `pnpm typecheck`/`pnpm test` 全程保持通过;涉及 main/preload/renderer 改动后必须 `pnpm dev` 或 `pnpm preview` 真机验证视线跟随手感(自动化检查过不代表能跑)。
- 纯逻辑必须先写失败的 Vitest 再实现(TDD)。
- 不要给 `package.json` 加 `"type": "module"`。
- 追踪半径是常量,不做成设置项(已与用户确认,YAGNI)。
- 每个任务结束后提交一次(conventional commit,中文描述)。
- 设计依据:`docs/superpowers/specs/2026-07-22-live2d-phase6-mouse-lipsync-preview-design.md` §1、§2。

---

### Task 1: 鼠标追踪目标计算的纯函数模块 `mouseFocus.ts`

**Files:**
- Create: `src/shared/mouseFocus.ts`
- Test: `src/shared/mouseFocus.test.ts`

**Interfaces:**
- Consumes: `Bounds` 类型,来自 `src/shared/petBrain.ts`(已存在:`export interface Bounds { x: number; y: number; width: number; height: number }`)。
- Produces:
  - `DEFAULT_MOUSE_TRACK_RADIUS_PX = 900`
  - `computeMouseFocusTarget(cursor: { x: number; y: number }, windowBounds: Bounds, radiusPx: number): { x: number; y: number }`
  - `computeMouseFocusTick(input: MouseFocusTickInput): { x: number; y: number } | null`,其中:
    ```ts
    export interface MouseFocusTickInput {
      cursor: { x: number; y: number }
      windowBounds: Bounds
      dragging: boolean
      windowVisible: boolean
      trackingCapable: boolean
      trackingSettingEnabled: boolean
      radiusPx: number
    }
    ```
    Task 6(主进程轮询循环)会调用这个函数。

- [ ] **Step 1: 写失败的测试**

创建 `src/shared/mouseFocus.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeMouseFocusTarget, computeMouseFocusTick } from './mouseFocus'

const windowBounds = { x: 100, y: 100, width: 200, height: 200 } // 中心 (200, 200)

describe('computeMouseFocusTarget', () => {
  it('光标在窗口中心 → (0, 0)', () => {
    expect(computeMouseFocusTarget({ x: 200, y: 200 }, windowBounds, 900)).toEqual({ x: 0, y: 0 })
  })

  it('光标在中心正右方 → 正 x,y 为 0', () => {
    const t = computeMouseFocusTarget({ x: 650, y: 200 }, windowBounds, 900) // dx=450, radius=900 → x=0.5
    expect(t.x).toBeCloseTo(0.5, 5)
    expect(t.y).toBeCloseTo(0, 5)
  })

  it('光标在中心正上方(屏幕 y 更小)→ 正 y(向上看是正值,与屏幕坐标方向相反)', () => {
    const t = computeMouseFocusTarget({ x: 200, y: -250 }, windowBounds, 900) // dy=-450 → y=+0.5
    expect(t.x).toBeCloseTo(0, 5)
    expect(t.y).toBeCloseTo(0.5, 5)
  })

  it('光标在中心正下方(屏幕 y 更大)→ 负 y', () => {
    const t = computeMouseFocusTarget({ x: 200, y: 650 }, windowBounds, 900) // dy=+450 → y=-0.5
    expect(t.y).toBeCloseTo(-0.5, 5)
  })

  it('超出半径 → (0, 0)', () => {
    expect(computeMouseFocusTarget({ x: 200 + 901, y: 200 }, windowBounds, 900)).toEqual({ x: 0, y: 0 })
  })

  it('刚好在半径边界(沿单轴)→ 分量为 ±1', () => {
    const t = computeMouseFocusTarget({ x: 200 + 900, y: 200 }, windowBounds, 900)
    expect(t.x).toBeCloseTo(1, 5)
  })
})

describe('computeMouseFocusTick', () => {
  const base = {
    cursor: { x: 200, y: 200 },
    windowBounds,
    dragging: false,
    windowVisible: true,
    trackingCapable: true,
    trackingSettingEnabled: true,
    radiusPx: 900
  }

  it('模型不支持鼠标追踪 → null(不发)', () => {
    expect(computeMouseFocusTick({ ...base, trackingCapable: false })).toBeNull()
  })

  it('用户在设置里关闭 → null(不发)', () => {
    expect(computeMouseFocusTick({ ...base, trackingSettingEnabled: false })).toBeNull()
  })

  it('窗口不可见(最小化/锁屏)→ null(不发)', () => {
    expect(computeMouseFocusTick({ ...base, windowVisible: false })).toBeNull()
  })

  it('拖拽中 → 显式发 (0, 0)(不是 null,要主动回正)', () => {
    expect(computeMouseFocusTick({ ...base, dragging: true, cursor: { x: 650, y: 200 } })).toEqual({ x: 0, y: 0 })
  })

  it('正常情况 → 委托给 computeMouseFocusTarget', () => {
    const result = computeMouseFocusTick({ ...base, cursor: { x: 650, y: 200 } })
    expect(result?.x).toBeCloseTo(0.5, 5)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/shared/mouseFocus.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `mouseFocus.ts`**

创建 `src/shared/mouseFocus.ts`:

```ts
import type { Bounds } from './petBrain'

/** 光标离宠物窗口中心多远以内才追踪,屏幕像素,常量不做成设置项(YAGNI,已与用户确认)。 */
export const DEFAULT_MOUSE_TRACK_RADIUS_PX = 900

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** 光标屏幕坐标相对宠物窗口中心的偏移,归一化到 [-1,1] 喂给 Live2DModel.focus()。
 *  垂直方向取反:屏幕坐标 y 向下增大,但 Cubism 的 ParamAngleY/EyeBallY 约定正值=向上看。
 *  超出 radiusPx → (0,0)(不追踪,回正)。 */
export function computeMouseFocusTarget(
  cursor: { x: number; y: number },
  windowBounds: Bounds,
  radiusPx: number
): { x: number; y: number } {
  const cx = windowBounds.x + windowBounds.width / 2
  const cy = windowBounds.y + windowBounds.height / 2
  const dx = cursor.x - cx
  const dy = cursor.y - cy
  if (Math.hypot(dx, dy) > radiusPx) return { x: 0, y: 0 }
  return { x: clamp(dx / radiusPx, -1, 1), y: clamp(-dy / radiusPx, -1, 1) }
}

export interface MouseFocusTickInput {
  cursor: { x: number; y: number }
  windowBounds: Bounds
  dragging: boolean
  windowVisible: boolean
  trackingCapable: boolean
  trackingSettingEnabled: boolean
  radiusPx: number
}

/** 主进程轮询循环每 tick 调一次,决定这次要不要往渲染进程推 MOUSE_FOCUS。
 *  返回 null = 这次什么都不发(功能关闭/模型不支持/窗口不可见);
 *  返回非 null 时必须发出去,哪怕是 (0,0)——那是"主动回正"的目标,不是"不用发"的信号。 */
export function computeMouseFocusTick(input: MouseFocusTickInput): { x: number; y: number } | null {
  if (!input.trackingCapable || !input.trackingSettingEnabled || !input.windowVisible) return null
  if (input.dragging) return { x: 0, y: 0 }
  return computeMouseFocusTarget(input.cursor, input.windowBounds, input.radiusPx)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/shared/mouseFocus.test.ts`
Expected: PASS(11 个测试全绿)

- [ ] **Step 5: 提交**

```bash
git add src/shared/mouseFocus.ts src/shared/mouseFocus.test.ts
git commit -m "feat(live2d): 新增鼠标追踪目标计算纯函数模块"
```

---

### Task 2: `PetRenderer.setLookTarget` 接口 + `PetController.setMouseFocus`(睡眠门控)

**Files:**
- Modify: `src/renderer/petRenderer.ts`
- Modify: `src/renderer/spriteRenderer.ts`
- Modify: `src/renderer/live2dRenderer.ts`
- Modify: `src/renderer/petController.ts`
- Modify: `src/renderer/petController.test.ts`

**Interfaces:**
- Consumes: 无(不依赖 Task 1)。
- Produces: `PetController.setMouseFocus(x: number, y: number): void`——main.ts 的 `onMouseFocus` 接收回调(Task 5)调用这个方法。

**前提:** 本任务假设口型计划的 Task 3 已经执行完——`petController.test.ts` 的 `makeFakeRenderer()` 已经有 `lipSyncLevels: number[]` 字段和会记录调用的 `setLipSync(level: number) { this.lipSyncLevels.push(level) }`,`petController.ts` 已经有:

```ts
  setLipSync(level: number): void {
    this.renderer.setLipSync(level)
  }
```

紧跟在 `hitTest()` 方法之后。

- [ ] **Step 1: `PetRenderer` 接口新增方法**

`src/renderer/petRenderer.ts` 当前第 22-40 行:

```ts
export interface PetRenderer {
  load(source: PetRenderSource): Promise<void>
  /** 后台准备下一个模型/精灵表,不改变当前可见画面。只在"新旧渲染器类型相同"的热切换
   *  路径下被调用(跨类型切换走全新实例的 load(),不经过这三个方法,见 PetController)。
   *  见 Phase 5 设计文档 §1/§2。 */
  prepareSwap(source: PetRenderSource): Promise<void>
  /** 原子提交 prepareSwap() 准备好的模型/精灵表;没有成功的 prepareSwap() 时调用应抛错。 */
  commitSwap(): void
  /** 丢弃 prepareSwap() 准备好但未提交的半成品,不影响当前可见模型。 */
  discardSwap(): void
  playState(state: PetVisualState): void
  /** live2d 用的镜像朝向;sprite 渲染器上是 no-op(朝向由 playState 的 walk-left/walk-right 决定)。 */
  setFacing(direction: 'left' | 'right'): void
  setLipSync(level: number): void
  hitTest(x: number, y: number): PetHitResult
  resize(viewport: PetViewport): void
  setVisible(visible: boolean): void
  destroy(): Promise<void>
}
```

在 `setLipSync(level: number): void` 那一行后面加一行:

```ts
  /** 视线/头部跟随目标,x/y 是 [-1,1] 的方向,(0,0) 表示回正。sprite 渲染器上是 no-op。 */
  setLookTarget(x: number, y: number): void
```

- [ ] **Step 2: `SpriteRenderer` 补 no-op 实现**

`src/renderer/spriteRenderer.ts` 第 71-78 行当前是:

```ts
  setFacing(_direction: 'left' | 'right'): void {
    // no-op
  }

  setLipSync(_level: number): void {
    // no-op
  }
```

改成:

```ts
  setFacing(_direction: 'left' | 'right'): void {
    // no-op
  }

  setLipSync(_level: number): void {
    // no-op
  }

  setLookTarget(_x: number, _y: number): void {
    // no-op
  }
```

- [ ] **Step 3: `Live2DPetRenderer` 实现:调用引擎自带的 `focus()`**

`src/renderer/live2dRenderer.ts` 第 211-226 行(`setLipSync` 方法)后面加一个新方法:

```ts
  setLookTarget(x: number, y: number): void {
    this.model?.focus(x, y)
  }
```

- [ ] **Step 4: `PetController.setMouseFocus()`——先写失败的测试**

**为什么只测非睡眠分支:** `vitest.config.ts` 把测试环境设成 `environment: 'node'`(没有 `window` 全局),而 `PetController.start()`/私有 `tick()` 都要用到 `window.setInterval`/`window.petApi`——现有测试文件里所有既有测试都只调 `prepareReload`/`commitReload`/`discardReload`/`hitTest`,从来不调 `start()`,就是因为这个环境限制。行为状态机切到 `sleep` 只能靠 `tick()` 里 `idleAccumMs` 累积到 `sleepAfterIdleMs` 触发,`tick()` 是私有方法、也没有别的公开入口能把 `this.behavior` 拨到 `sleep`——所以"睡眠时强制回正"这条门控这里不写单元测试,留给 Task 6 的真机验证清单(已经列了"宠物进入睡眠状态后,视线保持居中"这一项)。

给 `makeFakeRenderer()`(口型计划 Task 3 执行完之后的状态,见本任务开头"前提")加 `lookTargets` 字段。当前状态:

```ts
function makeFakeRenderer(): PetRenderer & {
  destroyed: boolean
  loadedWith: PetRenderSource[]
  prepareSwapWith: PetRenderSource[]
  commitSwapCalled: boolean
  discardSwapCalled: boolean
  shouldFailPrepare?: boolean
  lipSyncLevels: number[]
} {
  const loadedWith: PetRenderSource[] = []
  const prepareSwapWith: PetRenderSource[] = []
  const lipSyncLevels: number[] = []
  return {
    destroyed: false,
    loadedWith,
    prepareSwapWith,
    commitSwapCalled: false,
    discardSwapCalled: false,
    lipSyncLevels,
    async load(source) { loadedWith.push(source) },
    async prepareSwap(source) {
      if (this.shouldFailPrepare) throw new Error('prepare failed')
      prepareSwapWith.push(source)
    },
    commitSwap() { this.commitSwapCalled = true },
    discardSwap() { this.discardSwapCalled = true },
    playState() {},
    setFacing() {},
    setLipSync(level: number) { this.lipSyncLevels.push(level) },
    hitTest(): PetHitResult { return { hit: false } },
    resize() {},
    setVisible() {},
    async destroy() { this.destroyed = true }
  }
}
```

替换成:

```ts
function makeFakeRenderer(): PetRenderer & {
  destroyed: boolean
  loadedWith: PetRenderSource[]
  prepareSwapWith: PetRenderSource[]
  commitSwapCalled: boolean
  discardSwapCalled: boolean
  shouldFailPrepare?: boolean
  lipSyncLevels: number[]
  lookTargets: { x: number; y: number }[]
} {
  const loadedWith: PetRenderSource[] = []
  const prepareSwapWith: PetRenderSource[] = []
  const lipSyncLevels: number[] = []
  const lookTargets: { x: number; y: number }[] = []
  return {
    destroyed: false,
    loadedWith,
    prepareSwapWith,
    commitSwapCalled: false,
    discardSwapCalled: false,
    lipSyncLevels,
    lookTargets,
    async load(source) { loadedWith.push(source) },
    async prepareSwap(source) {
      if (this.shouldFailPrepare) throw new Error('prepare failed')
      prepareSwapWith.push(source)
    },
    commitSwap() { this.commitSwapCalled = true },
    discardSwap() { this.discardSwapCalled = true },
    playState() {},
    setFacing() {},
    setLipSync(level: number) { this.lipSyncLevels.push(level) },
    setLookTarget(x: number, y: number) { this.lookTargets.push({ x, y }) },
    hitTest(): PetHitResult { return { hit: false } },
    resize() {},
    setVisible() {},
    async destroy() { this.destroyed = true }
  }
}
```

在文件末尾(紧跟口型计划加的 `describe('PetController.setLipSync', ...)` 块之后)追加:

```ts
describe('PetController.setMouseFocus', () => {
  it('非睡眠状态(初始状态就是 idle,不是 sleep):原样转发给 renderer.setLookTarget()', () => {
    const renderer = makeFakeRenderer()
    const controller = new PetController(renderer, 'live2d', vi.fn())
    controller.setMouseFocus(0.4, -0.2)
    expect(renderer.lookTargets).toEqual([{ x: 0.4, y: -0.2 }])
  })
})
```

- [ ] **Step 5: 运行测试确认失败**

Run: `pnpm vitest run src/renderer/petController.test.ts`
Expected: FAIL(`controller.setMouseFocus is not a function`)

- [ ] **Step 6: 实现 `PetController.setMouseFocus()`**

在 `src/renderer/petController.ts` 里,紧跟 `setLipSync()` 方法(口型计划加的)后面加:

```ts
  /** 主进程推来的鼠标追踪目标:非睡眠状态原样转发;睡眠时强制回正,不使用传入目标——
   *  是否在睡眠这件事只有渲染进程的行为状态机知道,主进程算不出来。 */
  setMouseFocus(x: number, y: number): void {
    if (this.behavior.kind === 'live2d' && this.behavior.ctx.state === 'sleep') {
      this.renderer.setLookTarget(0, 0)
      return
    }
    this.renderer.setLookTarget(x, y)
  }
```

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm vitest run src/renderer/petController.test.ts`
Expected: PASS(全部既有测试 + 新增测试都通过)

- [ ] **Step 8: 类型检查**

Run: `pnpm typecheck`
Expected: 通过(确认 `SpriteRenderer`/`Live2DPetRenderer` 都实现了新接口方法,没有漏改的地方报 "缺少属性" 错误)

- [ ] **Step 9: 提交**

```bash
git add src/renderer/petRenderer.ts src/renderer/spriteRenderer.ts src/renderer/live2dRenderer.ts src/renderer/petController.ts src/renderer/petController.test.ts
git commit -m "feat(live2d): PetRenderer 新增 setLookTarget,PetController 按睡眠状态门控转发"
```

---

### Task 3: 设置项 `live2d.mouseTrackingEnabled`

**Files:**
- Modify: `src/shared/llm.ts`
- Modify: `src/main/config/settings.ts`
- Modify: `src/main/config/settings.test.ts`

**Interfaces:**
- Produces: `AppSettings.live2d.mouseTrackingEnabled: boolean`(默认 `true`)——Task 4(设置 UI)和 Task 6(主进程轮询循环)都读这个字段。

- [ ] **Step 1: `llm.ts` 加类型和默认值**

`src/shared/llm.ts` 第 112-114 行当前是:

```ts
export const SETTINGS_SCHEMA_VERSION = 14

export interface AppSettings { schemaVersion: number; activePetId: string; provider: ProviderSettings; search: SearchSettings; memory: MemorySettings; textTools: TextToolsSettings; firecrawl: FirecrawlSettings; desktopControl: DesktopControlSettings; browserControl: BrowserControlSettings; appFocusLlmOpener: AppFocusLlmOpenerSettings; gpuAcceleration: GpuAccelerationSettings; tts: TtsSettings; ttsGenie: GenieTtsSettings }
```

改成:

```ts
export const SETTINGS_SCHEMA_VERSION = 15

export interface Live2DSettings { mouseTrackingEnabled: boolean }

export interface AppSettings { schemaVersion: number; activePetId: string; provider: ProviderSettings; search: SearchSettings; memory: MemorySettings; textTools: TextToolsSettings; firecrawl: FirecrawlSettings; desktopControl: DesktopControlSettings; browserControl: BrowserControlSettings; appFocusLlmOpener: AppFocusLlmOpenerSettings; gpuAcceleration: GpuAccelerationSettings; tts: TtsSettings; ttsGenie: GenieTtsSettings; live2d: Live2DSettings }
```

`src/shared/llm.ts` 第 116-130 行当前是:

```ts
export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  activePetId: 'luluka',
  provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
  search: { backend: 'duckduckgo' },
  memory: { embedding: null },
  textTools: { autoCopyResult: false },
  firecrawl: { enabled: false },
  desktopControl: { enabled: false },
  browserControl: { enabled: false, mode: 'isolated' },
  appFocusLlmOpener: { enabled: false },
  gpuAcceleration: { experimental: false },
  tts: DEFAULT_TTS_SETTINGS,
  ttsGenie: DEFAULT_GENIE_TTS_SETTINGS
}
```

改成:

```ts
export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  activePetId: 'luluka',
  provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
  search: { backend: 'duckduckgo' },
  memory: { embedding: null },
  textTools: { autoCopyResult: false },
  firecrawl: { enabled: false },
  desktopControl: { enabled: false },
  browserControl: { enabled: false, mode: 'isolated' },
  appFocusLlmOpener: { enabled: false },
  gpuAcceleration: { experimental: false },
  tts: DEFAULT_TTS_SETTINGS,
  ttsGenie: DEFAULT_GENIE_TTS_SETTINGS,
  live2d: { mouseTrackingEnabled: true }
}
```

- [ ] **Step 2: `normalizeSettings()` 加归一化逻辑**

`src/main/config/settings.ts` 第 80-99 行当前是:

```ts
  const tg = (r.ttsGenie ?? {}) as Record<string, unknown>
  const ttsGenie: GenieTtsSettings = {
    runtimeInstallPath: typeof tg.runtimeInstallPath === 'string' ? tg.runtimeInstallPath : DEFAULT_SETTINGS.ttsGenie.runtimeInstallPath
  }
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    activePetId: normalizePetId(r.activePetId),
    provider: { kind, model, baseURL },
    search: { backend },
    memory: { embedding },
    textTools: { autoCopyResult },
    firecrawl,
    desktopControl,
    browserControl,
    appFocusLlmOpener,
    gpuAcceleration,
    tts,
    ttsGenie
  }
}
```

改成:

```ts
  const tg = (r.ttsGenie ?? {}) as Record<string, unknown>
  const ttsGenie: GenieTtsSettings = {
    runtimeInstallPath: typeof tg.runtimeInstallPath === 'string' ? tg.runtimeInstallPath : DEFAULT_SETTINGS.ttsGenie.runtimeInstallPath
  }
  const l2d = (r.live2d ?? {}) as Record<string, unknown>
  const live2d = { mouseTrackingEnabled: l2d.mouseTrackingEnabled === undefined ? DEFAULT_SETTINGS.live2d.mouseTrackingEnabled : l2d.mouseTrackingEnabled === true }
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    activePetId: normalizePetId(r.activePetId),
    provider: { kind, model, baseURL },
    search: { backend },
    memory: { embedding },
    textTools: { autoCopyResult },
    firecrawl,
    desktopControl,
    browserControl,
    appFocusLlmOpener,
    gpuAcceleration,
    tts,
    ttsGenie,
    live2d
  }
}
```

同时把该文件顶部的 `import { ..., type GenieTtsSettings } from '@shared/llm'`(第 3 行)加上 `type Live2DSettings`:

第 3 行当前:

```ts
import { AppSettings, DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, ProviderKind, SearchBackendKind, type MemorySettings, type TtsDevice, type TtsTargetLanguage, type TtsPlaybackTrigger, type TtsSynthesisChunking, type TtsTextSplit, type TtsBackend, type GenieTtsSettings } from '@shared/llm'
```

改成:

```ts
import { AppSettings, DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, ProviderKind, SearchBackendKind, type MemorySettings, type TtsDevice, type TtsTargetLanguage, type TtsPlaybackTrigger, type TtsSynthesisChunking, type TtsTextSplit, type TtsBackend, type GenieTtsSettings, type Live2DSettings } from '@shared/llm'
```

（`live2d` 变量的类型标注 `{ mouseTrackingEnabled: boolean }` 结构上兼容 `Live2DSettings`,这里显式 import 类型是为了后续如果要在这个文件里标注变量类型时可用——如果 TypeScript 提示这个 import 未使用,把变量声明改成 `const live2d: Live2DSettings = { ... }` 即可消费掉。）

- [ ] **Step 3: 更新现有的往返测试**

`src/main/config/settings.test.ts` 第 26 行(`'round-trips save then load'` 测试)当前构造的 `s` 对象没有 `live2d` 字段,会导致 `loadSettings` 读回来的对象比 `s` 多一个字段而断言失败。改成:

```ts
  it('round-trips save then load', () => {
    const file = join(tmp(), 'settings.json')
    const s = { schemaVersion: SETTINGS_SCHEMA_VERSION, activePetId: 'luluka', provider: { kind: 'openai-compat' as const, baseURL: 'http://x/v1', model: 'gpt-4o-mini' }, search: { backend: 'duckduckgo' as const }, memory: { embedding: null }, textTools: { autoCopyResult: false }, firecrawl: { enabled: false }, desktopControl: { enabled: false }, browserControl: { enabled: false, mode: 'isolated' as const }, appFocusLlmOpener: { enabled: false }, gpuAcceleration: { experimental: false }, tts: DEFAULT_SETTINGS.tts, ttsGenie: DEFAULT_SETTINGS.ttsGenie, live2d: { mouseTrackingEnabled: true } }
    saveSettings(file, s)
    expect(loadSettings(file)).toEqual(s)
  })
```

再在文件末尾(`describe('activePetId', ...)` 块之后)追加一个新 `describe`:

```ts
describe('live2d.mouseTrackingEnabled', () => {
  it('缺省时默认 true', () => {
    const f = tmpSettingsFile({ schemaVersion: 1 })
    expect(loadSettings(f).live2d.mouseTrackingEnabled).toBe(true)
  })

  it('显式 false 时保留 false', () => {
    const f = tmpSettingsFile({ schemaVersion: 1, live2d: { mouseTrackingEnabled: false } })
    expect(loadSettings(f).live2d.mouseTrackingEnabled).toBe(false)
  })

  it('非法值(非 boolean)时回落默认 true', () => {
    const f = tmpSettingsFile({ schemaVersion: 1, live2d: { mouseTrackingEnabled: 'yes' } })
    expect(loadSettings(f).live2d.mouseTrackingEnabled).toBe(true)
  })
})
```

- [ ] **Step 4: 运行测试确认全部通过**

Run: `pnpm vitest run src/main/config/settings.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查**

Run: `pnpm typecheck`
Expected: 通过

- [ ] **Step 6: 提交**

```bash
git add src/shared/llm.ts src/main/config/settings.ts src/main/config/settings.test.ts
git commit -m "feat(live2d): 新增 live2d.mouseTrackingEnabled 设置项,默认开启"
```

---

### Task 4: 设置页开关 UI

**Files:**
- Modify: `src/renderer/settings.html`
- Modify: `src/renderer/settings.ts`

**Interfaces:**
- Consumes: Task 3 的 `AppSettings.live2d.mouseTrackingEnabled`。
- Produces: 无(UI 末端)。

- [ ] **Step 1: `settings.html` 加复选框**

`src/renderer/settings.html` 第 110-113 行(`gpuAccelerationExperimental` 那个 `<label>`)当前是:

```html
            <label style="display:flex;align-items:center;gap:8px;flex-direction:row">
              <input id="gpuAccelerationExperimental" type="checkbox" style="width:auto" />
              <span>尝试启用硬件加速渲染(实验性,重启后生效)</span>
            </label>
          </section>
```

改成(新增一个复选框,不需要重启):

```html
            <label style="display:flex;align-items:center;gap:8px;flex-direction:row">
              <input id="gpuAccelerationExperimental" type="checkbox" style="width:auto" />
              <span>尝试启用硬件加速渲染(实验性,重启后生效)</span>
            </label>
            <label style="display:flex;align-items:center;gap:8px;flex-direction:row">
              <input id="live2dMouseTrackingEnabled" type="checkbox" style="width:auto" />
              <span>启用鼠标追踪(Live2D 宠物的眼睛/头部看向鼠标,关闭后保持居中)</span>
            </label>
          </section>
```

- [ ] **Step 2: `settings.ts` 接线**

`src/renderer/settings.ts` 第 24 行(`gpuAccelerationExperimental` 的 DOM 引用)后面加一行:

```ts
const live2dMouseTrackingEnabled = $<HTMLInputElement>('live2dMouseTrackingEnabled')
```

`save` 按钮处理里(第 437-438 行,`gpuAcceleration` 那一行)当前是:

```ts
      appFocusLlmOpener: { enabled: appFocusLlmOpenerEnabled.checked },
      gpuAcceleration: { experimental: gpuAccelerationExperimental.checked },
      tts: currentTts(),
      ttsGenie: currentTtsGenie()
    })
```

改成:

```ts
      appFocusLlmOpener: { enabled: appFocusLlmOpenerEnabled.checked },
      gpuAcceleration: { experimental: gpuAccelerationExperimental.checked },
      tts: currentTts(),
      ttsGenie: currentTtsGenie(),
      live2d: { mouseTrackingEnabled: live2dMouseTrackingEnabled.checked }
    })
```

初始化回填(第 482 行,`gpuAccelerationExperimental.checked = ...` 那一行)后面加一行:

```ts
  gpuAccelerationExperimental.checked = snap.settings.gpuAcceleration.experimental
  live2dMouseTrackingEnabled.checked = snap.settings.live2d.mouseTrackingEnabled
```

- [ ] **Step 3: 类型检查**

Run: `pnpm typecheck`
Expected: 通过

- [ ] **Step 4: 真机验证**

```bash
pnpm preview
```

打开设置页"宠物"分页,确认能看到"启用鼠标追踪"复选框,勾选状态与刚保存的设置一致;取消勾选并保存,后面 Task 6 完成后可以验证宠物确实不再追踪鼠标。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/settings.html src/renderer/settings.ts
git commit -m "feat(live2d): 设置页新增鼠标追踪开关"
```

---

### Task 5: `MOUSE_FOCUS` 推送 IPC(main→renderer)

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/main.ts`

**Interfaces:**
- Consumes: Task 2 的 `PetController.setMouseFocus(x, y)`。
- Produces: 无(渲染进程末端)。main.ts 的接收回调是 Task 6(主进程发送方)的下游消费者。

- [ ] **Step 1: `ipc.ts` 加常量和 `PetApi` 方法签名**

`src/shared/ipc.ts` 第 89 行(`WINDOW_VISIBILITY_CHANGED: 'window:visibility-changed'`)后面加一行(注意补上前一行末尾的逗号):

```ts
  WINDOW_VISIBILITY_CHANGED: 'window:visibility-changed',
  MOUSE_FOCUS: 'pet:mouse-focus'
} as const
```

`PetApi` 接口(第 131-170 行)的 `onWindowVisibilityChanged` 方法后面加:

```ts
  /** 主进程推送的鼠标追踪目标([-1,1] 方向;(0,0) 表示回正),仅当当前宠物是 live2d 且
   *  设置里开启追踪时才会收到非空推送——见 §2 主进程轮询循环。 */
  onMouseFocus(cb: (payload: { x: number; y: number }) => void): void
```

- [ ] **Step 2: `preload/index.ts` 实现 expose**

`src/preload/index.ts` 里 `petApi` 对象(第 16-54 行)的 `onWindowVisibilityChanged` 实现后面加:

```ts
  onMouseFocus: (cb: (payload: { x: number; y: number }) => void): void => {
    ipcRenderer.removeAllListeners(IPC.MOUSE_FOCUS)
    ipcRenderer.on(IPC.MOUSE_FOCUS, (_e, payload: { x: number; y: number }) => cb(payload))
  },
```

（放在 `onWindowVisibilityChanged: ... },` 那一行之后,`updateLive2DTransform: ...` 那一行之前。）

- [ ] **Step 3: `main.ts` 接收并转发给 controller**

`src/renderer/main.ts` 第 84 行(`window.petApi.onWindowVisibilityChanged((payload) => controller.setVisible(payload.visible))`)后面加一行:

```ts
  window.petApi.onWindowVisibilityChanged((payload) => controller.setVisible(payload.visible))
  window.petApi.onMouseFocus((payload) => controller.setMouseFocus(payload.x, payload.y))
```

- [ ] **Step 4: 类型检查**

Run: `pnpm typecheck`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add src/shared/ipc.ts src/preload/index.ts src/renderer/main.ts
git commit -m "feat(live2d): 新增 MOUSE_FOCUS 推送 IPC,渲染进程接线到 PetController"
```

---

### Task 6: 主进程轮询循环

**Files:**
- Modify: `src/main/shell/index.ts`

**Interfaces:**
- Consumes: Task 1 的 `computeMouseFocusTick`、`DEFAULT_MOUSE_TRACK_RADIUS_PX`;Task 3 的 `AppSettings.live2d.mouseTrackingEnabled`;Task 5 的 `IPC.MOUSE_FOCUS`。
- Produces: 无(整条链路的发送端,是最终接线)。

- [ ] **Step 1: 加 import**

`src/main/shell/index.ts` 第 74 行(`import { fixedWindowBounds, ... } from '@shared/windowPlacement'`)后面加一行:

```ts
import { computeMouseFocusTick, DEFAULT_MOUSE_TRACK_RADIUS_PX } from '@shared/mouseFocus'
```

- [ ] **Step 2: 缓存"当前宠物是否支持鼠标追踪"**

`src/main/shell/index.ts` 第 227-234 行当前是:

```ts
  const initialSizeSource: PetRenderSource = initialSource.type === 'live2d'
    ? { ...initialSource, resourceBaseUrl: '' }
    : initialSource
  // 宠物窗口尺寸的唯一权威来源:只在这里初始化、只在 switchPet() 提交阶段更新,绝不能从
  // petWin.getSize() 实时读回再喂回 setBounds()——那样会让 OS 级四舍五入误差在拖拽/自主
  // 游走这类高频调用里逐帧累积增长,本项目已经在宠物窗口位置累积器(walkPreciseX/Y)和
  // 气泡窗尺寸(bubbleWindow.ts 的 place())上踩过两次几乎同款的坑。
  let currentPetSize = windowSizeForSource(initialSizeSource)
```

改成(新增一个模块级缓存,避免鼠标追踪轮询循环每 tick 都重新读盘解析 pet.json):

```ts
  const initialSizeSource: PetRenderSource = initialSource.type === 'live2d'
    ? { ...initialSource, resourceBaseUrl: '' }
    : initialSource
  // 宠物窗口尺寸的唯一权威来源:只在这里初始化、只在 switchPet() 提交阶段更新,绝不能从
  // petWin.getSize() 实时读回再喂回 setBounds()——那样会让 OS 级四舍五入误差在拖拽/自主
  // 游走这类高频调用里逐帧累积增长,本项目已经在宠物窗口位置累积器(walkPreciseX/Y)和
  // 气泡窗尺寸(bubbleWindow.ts 的 place())上踩过两次几乎同款的坑。
  let currentPetSize = windowSizeForSource(initialSizeSource)
  // 鼠标追踪轮询循环(下方 MOUSE_FOCUS 定时器)用的缓存:只在初始加载和 switchPet() 提交时
  // 更新,避免 30Hz 轮询每 tick 都重新读盘解析 pet.json。
  let activeLive2DTrackingCapable: boolean =
    initialSource.type === 'live2d' && initialSource.manifest.render.interaction.mouseTracking
```

- [ ] **Step 3: `switchPet()` 提交阶段更新缓存**

`src/main/shell/index.ts` 第 587-591 行当前是:

```ts
      // 提交阶段:渲染层确认新模型首帧就绪,主进程才真正切会话/settings/窗口尺寸
      await session.dispose()          // 停旧语音(释放端口)、停 appFocus、取消在途
      session = next
      session.startVoice()             // 端口已释放,启新宠物语音(未配置则静默不启)
      saveSettings(settingsFile, { ...loadSettings(settingsFile), activePetId: petId })
```

改成:

```ts
      // 提交阶段:渲染层确认新模型首帧就绪,主进程才真正切会话/settings/窗口尺寸
      await session.dispose()          // 停旧语音(释放端口)、停 appFocus、取消在途
      session = next
      session.startVoice()             // 端口已释放,启新宠物语音(未配置则静默不启)
      saveSettings(settingsFile, { ...loadSettings(settingsFile), activePetId: petId })
      activeLive2DTrackingCapable = source.type === 'live2d' && source.manifest.render.interaction.mouseTracking
```

- [ ] **Step 4: 轮询循环**

`src/main/shell/index.ts` 第 244-247 行(`petWin.on('minimize', ...)` 那几行)后面加:

```ts
  petWin.on('minimize', () => sendWindowVisibility(false))
  petWin.on('restore', () => sendWindowVisibility(true))
  powerMonitor.on('lock-screen', () => sendWindowVisibility(false))
  powerMonitor.on('unlock-screen', () => sendWindowVisibility(true))

  // 鼠标追踪:30Hz 轮询全局光标位置,算出 [-1,1] 目标方向推给渲染进程。持续运行(不按
  // 开关/可见性单独启停这个 setInterval)——computeMouseFocusTick() 在条件不满足时早退,
  // 代价是几次布尔判断,不做 screen.getCursorScreenPoint() 之外的开销。
  const MOUSE_TRACK_TICK_MS = 33
  setInterval(() => {
    const target = computeMouseFocusTick({
      cursor: screen.getCursorScreenPoint(),
      windowBounds: petBoundsFull(),
      dragging: dragAnchor !== null,
      windowVisible: petWin.isVisible(),
      trackingCapable: activeLive2DTrackingCapable,
      trackingSettingEnabled: loadSettings(settingsFile).live2d.mouseTrackingEnabled,
      radiusPx: DEFAULT_MOUSE_TRACK_RADIUS_PX
    })
    if (target) petWin.webContents.send(IPC.MOUSE_FOCUS, target)
  }, MOUSE_TRACK_TICK_MS)
```

**注意:** 这段引用了 `petBoundsFull()`(第 274 行定义)和 `dragAnchor`(第 686 行定义),两者定义位置都在这段插入点**之后**。JavaScript 的函数声明(`function petBoundsFull()`)和 `let` 变量在同一个函数作用域内可以先使用后定义(函数声明会被提升;`dragAnchor` 只要 `setInterval` 的回调是异步执行的,在它第一次真正触发时 `dragAnchor` 已经被声明赋值过了,不会报 `ReferenceError`)——但为了代码可读性、避免"读到声明之前的变量"这类眼熟的 bug 模式,**把这段 `setInterval` 挪到整个 `startShell()` 函数最后,`return` 语句之前**(或者紧跟在 `dragAnchor` 声明之后的任意位置,只要在 `petBoundsFull`/`dragAnchor`/`session` 相关代码都已经声明完之后)。落地时把上面这段代码贴到文件里 `dragAnchor` 声明(第 686 行)之后即可,不要贴在 `petWin.on('minimize', ...)` 后面——上面写在那里只是为了在计划里比较容易定位插入点,**实际落地位置是 `let dragAnchor: ... = null` 那一行之后**。

- [ ] **Step 5: 类型检查**

Run: `pnpm typecheck`
Expected: 通过

- [ ] **Step 6: 真机验证(自动化检查不能替代)**

```bash
pnpm preview
```

用一只 `manifest.render.interaction.mouseTracking: true` 且模型有 `ParamAngleX/Y`/`ParamEyeBallX/Y` 之类参数的 Live2D 宠物,目视确认:

- 鼠标在宠物附近移动时,眼睛/头部有限度朝向鼠标。
- 鼠标移出追踪半径后,视线平滑回正,不是瞬间跳回。
- 拖拽宠物窗口期间,视线不跟着鼠标乱转(暂停);松手后平滑恢复正常追踪。
- 宠物进入睡眠状态(长时间空闲)后,视线保持居中,不再跟随鼠标。
- 设置页关掉"启用鼠标追踪"并保存后(这个设置不需要重启,轮询循环每 tick 都重新读),宠物立刻停止追踪。
- 换一只 `mouseTracking: false` 的宠物包,或者一个没有 `ParamAngleX` 之类参数的模型,确认不报错、不出现诡异的姿势——`Live2DModel.focus()` 底层对不存在的参数安全跳过,这条应该是自动满足的,但仍需目测确认没有意外。

- [ ] **Step 7: 提交**

```bash
git add src/main/shell/index.ts
git commit -m "feat(live2d): 主进程新增鼠标追踪轮询循环,30Hz 推送 MOUSE_FOCUS"
```

---

## 完成后

六个任务全部完成、真机验证通过后,这份计划的工作就结束了。三份 Phase 6 计划在同一个开发分支里一次性跑完,不在中间合并——完成本计划后继续导入预览计划的任务,不要在这里执行 `finishing-a-development-branch`。
