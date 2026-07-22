# Live2D Phase 7 · GPU Context Lost 恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live2D 宠物窗口运行中途真实丢失 WebGL 上下文(驱动崩溃、显示器休眠/锁屏恢复等)时,不再永久白屏/黑屏——短暂显示轻量文字占位,浏览器恢复上下文后自动重新加载当前模型一次;若恢复重载本身失败,或恢复完成前又再次丢失,则停止自动重试并给出永久性引导文案。全程不触碰 Agent、托盘、设置、聊天、`activePetId` 或任何主进程会话状态。

**Architecture:** 不新建任何渲染器生命周期代码——GPU 恢复就是"自触发一次 Phase 5 热切换协议,目标宠物是当前宠物自己":`PetController.prepareReload(currentSource)` 对同类型 source 已经会路由到 `Live2DPetRenderer.prepareSwap()`,在现有的 `this.app`/canvas 上重新 `Live2DModel.from()`,这正是浏览器恢复 `webglcontextlost` 之后需要的"重新上传 Cubism 引擎自己持有的 GL 纹理/缓冲区"的动作。新代码只有:一个纯状态机(`healthy`/`recovering`/`given-up`,不依赖任何 DOM/WebGL)+ 一个把状态机接到真实 canvas 事件、`reload()`、错误占位的薄封装工厂(依赖全部通过参数注入,可在 Vitest node 环境下用假 canvas/假 reload 测试)+ `main.ts` 里的少量接线。

**Tech Stack:** TypeScript, Vitest(`environment: 'node'`,无 jsdom——所有新的可测代码必须不依赖真实 DOM/WebGL 全局对象), Electron `webglcontextlost`/`webglcontextrestored`(浏览器标准 WebGL 事件,不依赖 pixi.js 内部 API)。

## Global Constraints

- 不新增依赖;不修改 `package.json`。`vitest.config.ts` 的 `environment` 是 `'node'`,新模块的 Vitest 测试不能依赖 `document`/`HTMLElement` 等浏览器全局对象——需要真实 DOM 的一律留给最后的真机验证任务,不写 jsdom 测试凑数。
- 纯逻辑(状态机、guard 工厂)必须先写失败的 Vitest 再实现(TDD)。`main.ts` 的接线部分是既有的 Electron/DOM 胶水代码惯例——本仓库一贯不对 `main.ts` 这类文件写 jsdom 测试(现状:`main.ts` 至今没有对应 `.test.ts`),这部分改动改完后必须 `pnpm dev` 或 `pnpm preview` 真实运行验证,不额外造一套 jsdom mock 凑测试。
- 不要给 `package.json` 加 `"type": "module"`。
- 不改动 `PetController` 的公开接口、`createRenderer` 工厂签名、`kibo-pet://` 协议、任何主进程 IPC 或 Agent/记忆/语音会话逻辑。
- 只作用于 `render.type === 'live2d'` 的宠物;`SpriteRenderer` 用 2D canvas,不触发 `webglcontextlost`,不需要 guard(`type !== 'live2d'` 时不创建 guard 实例)。
- 每个任务结束后提交一次(conventional commit,中文描述)。项目仓库有 `SquashCommitConstraint`——整个 Phase 7(含另外两条线)全部完成后再统一 squash,这份计划自己按任务正常提交即可,不用在这里做 squash。
- 设计依据:`docs/superpowers/specs/2026-07-22-live2d-phase7-gpu-context-recovery-design.md`。

---

### Task 1: 纯状态机 `live2dContextRecovery.ts`

**Files:**
- Create: `src/renderer/live2dContextRecovery.ts`
- Create: `src/renderer/live2dContextRecovery.test.ts`

**Interfaces:**
- Produces:
  - `export type ContextRecoveryState = 'healthy' | 'recovering' | 'given-up'`
  - `export type ContextRecoveryEvent = 'contextlost' | 'restore-succeeded' | 'restore-failed'`
  - `export function nextContextRecoveryState(current: ContextRecoveryState, event: ContextRecoveryEvent): ContextRecoveryState`
  - Task 2 的 guard 工厂会 import 这两个类型和这个函数。

- [ ] **Step 1: 写失败的测试(状态机的 3×3 转移表全覆盖)**

```ts
// src/renderer/live2dContextRecovery.test.ts
import { describe, it, expect } from 'vitest'
import { nextContextRecoveryState } from './live2dContextRecovery'

describe('nextContextRecoveryState', () => {
  it('healthy + contextlost -> recovering', () => {
    expect(nextContextRecoveryState('healthy', 'contextlost')).toBe('recovering')
  })
  it('healthy + restore-succeeded -> healthy(防御性 no-op,不应该发生但不能抛错)', () => {
    expect(nextContextRecoveryState('healthy', 'restore-succeeded')).toBe('healthy')
  })
  it('healthy + restore-failed -> healthy(同上)', () => {
    expect(nextContextRecoveryState('healthy', 'restore-failed')).toBe('healthy')
  })
  it('recovering + contextlost -> given-up(还没恢复完成又丢了一次)', () => {
    expect(nextContextRecoveryState('recovering', 'contextlost')).toBe('given-up')
  })
  it('recovering + restore-succeeded -> healthy', () => {
    expect(nextContextRecoveryState('recovering', 'restore-succeeded')).toBe('healthy')
  })
  it('recovering + restore-failed -> given-up', () => {
    expect(nextContextRecoveryState('recovering', 'restore-failed')).toBe('given-up')
  })
  it('given-up + contextlost -> given-up(终态,忽略后续事件)', () => {
    expect(nextContextRecoveryState('given-up', 'contextlost')).toBe('given-up')
  })
  it('given-up + restore-succeeded -> given-up', () => {
    expect(nextContextRecoveryState('given-up', 'restore-succeeded')).toBe('given-up')
  })
  it('given-up + restore-failed -> given-up', () => {
    expect(nextContextRecoveryState('given-up', 'restore-failed')).toBe('given-up')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/renderer/live2dContextRecovery.test.ts`
Expected: FAIL(`live2dContextRecovery` 模块不存在/`nextContextRecoveryState` 未定义)

- [ ] **Step 3: 实现状态机**

```ts
// src/renderer/live2dContextRecovery.ts
export type ContextRecoveryState = 'healthy' | 'recovering' | 'given-up'
export type ContextRecoveryEvent = 'contextlost' | 'restore-succeeded' | 'restore-failed'

/** 见 docs/superpowers/specs/2026-07-22-live2d-phase7-gpu-context-recovery-design.md §2。
 *  given-up 是终态,进入后忽略一切后续事件,只能靠调用方(真实换宠物提交新 source 时)
 *  显式重新初始化,不属于这个状态机的事件集合。 */
export function nextContextRecoveryState(current: ContextRecoveryState, event: ContextRecoveryEvent): ContextRecoveryState {
  if (current === 'given-up') return 'given-up'
  if (current === 'healthy') {
    return event === 'contextlost' ? 'recovering' : 'healthy'
  }
  // current === 'recovering'
  if (event === 'contextlost') return 'given-up'
  if (event === 'restore-succeeded') return 'healthy'
  return 'given-up' // restore-failed
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/renderer/live2dContextRecovery.test.ts`
Expected: PASS(9 个用例全绿)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/live2dContextRecovery.ts src/renderer/live2dContextRecovery.test.ts
git commit -m "feat(live2d): GPU Context Lost 恢复状态机"
```

---

### Task 2: guard 工厂 `live2dContextRecoveryGuard.ts`

**Files:**
- Create: `src/renderer/live2dContextRecoveryGuard.ts`
- Create: `src/renderer/live2dContextRecoveryGuard.test.ts`

**Interfaces:**
- Consumes:`nextContextRecoveryState`、`ContextRecoveryState`(Task 1)。
- Produces:
  - `export const CONTEXT_RECOVERY_MESSAGE: string`
  - `export const CONTEXT_GIVEN_UP_MESSAGE: string`
  - `export interface ContextRecoveryCanvasLike { addEventListener(type: 'webglcontextlost' | 'webglcontextrestored', listener: (event: Event) => void): void }`
  - `export interface ContextRecoveryGuardDeps { canvas: ContextRecoveryCanvasLike; reload: () => Promise<void>; showOverlay: (text: string) => void; hideOverlay: () => void; onStateChange: (state: ContextRecoveryState) => void }`
  - `export interface ContextRecoveryGuard { reset(): void; currentState(): ContextRecoveryState }`
  - `export function createLive2DContextRecoveryGuard(deps: ContextRecoveryGuardDeps): ContextRecoveryGuard`
  - Task 3(`main.ts` 接线)会调用 `createLive2DContextRecoveryGuard()`,并使用 `ContextRecoveryGuard`/`ContextRecoveryGuardDeps` 类型。

- [ ] **Step 1: 写失败的测试**

```ts
// src/renderer/live2dContextRecoveryGuard.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createLive2DContextRecoveryGuard, CONTEXT_RECOVERY_MESSAGE, CONTEXT_GIVEN_UP_MESSAGE } from './live2dContextRecoveryGuard'

function createFakeCanvas() {
  const listeners: Record<string, Array<(e: Event) => void>> = {}
  return {
    addEventListener(type: string, cb: (e: Event) => void): void {
      (listeners[type] ??= []).push(cb)
    },
    fire(type: string, event: Partial<Event> = {}): void {
      const full = { preventDefault: () => {}, ...event } as Event
      for (const cb of listeners[type] ?? []) cb(full)
    }
  }
}

const flush = (): Promise<void> => Promise.resolve().then(() => Promise.resolve())

describe('createLive2DContextRecoveryGuard', () => {
  it('healthy 状态下丢失 context:preventDefault + 显示恢复中占位 + 上报 recovering', () => {
    const canvas = createFakeCanvas()
    const preventDefault = vi.fn()
    const showOverlay = vi.fn()
    const hideOverlay = vi.fn()
    const onStateChange = vi.fn()
    const guard = createLive2DContextRecoveryGuard({ canvas, reload: vi.fn(), showOverlay, hideOverlay, onStateChange })

    canvas.fire('webglcontextlost', { preventDefault })

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(showOverlay).toHaveBeenCalledWith(CONTEXT_RECOVERY_MESSAGE)
    expect(onStateChange).toHaveBeenCalledWith('recovering')
    expect(guard.currentState()).toBe('recovering')
  })

  it('丢失后恢复:重载成功则回到 healthy 并隐藏占位', async () => {
    const canvas = createFakeCanvas()
    const reload = vi.fn().mockResolvedValue(undefined)
    const showOverlay = vi.fn()
    const hideOverlay = vi.fn()
    const onStateChange = vi.fn()
    const guard = createLive2DContextRecoveryGuard({ canvas, reload, showOverlay, hideOverlay, onStateChange })

    canvas.fire('webglcontextlost')
    canvas.fire('webglcontextrestored')
    await flush()

    expect(reload).toHaveBeenCalledOnce()
    expect(guard.currentState()).toBe('healthy')
    expect(hideOverlay).toHaveBeenCalledOnce()
    expect(onStateChange).toHaveBeenLastCalledWith('healthy')
  })

  it('丢失后恢复:重载失败则进入 given-up 并显示永久提示', async () => {
    const canvas = createFakeCanvas()
    const reload = vi.fn().mockRejectedValue(new Error('load failed'))
    const showOverlay = vi.fn()
    const hideOverlay = vi.fn()
    const onStateChange = vi.fn()
    const guard = createLive2DContextRecoveryGuard({ canvas, reload, showOverlay, hideOverlay, onStateChange })

    canvas.fire('webglcontextlost')
    canvas.fire('webglcontextrestored')
    await flush()

    expect(guard.currentState()).toBe('given-up')
    expect(showOverlay).toHaveBeenCalledWith(CONTEXT_GIVEN_UP_MESSAGE)
    expect(hideOverlay).not.toHaveBeenCalled()
  })

  it('recovering 期间(还没等到 restored)又丢失一次:直接 given-up,不再等待/重载', () => {
    const canvas = createFakeCanvas()
    const reload = vi.fn()
    const showOverlay = vi.fn()
    const onStateChange = vi.fn()
    const guard = createLive2DContextRecoveryGuard({ canvas, reload, showOverlay, hideOverlay: vi.fn(), onStateChange })

    canvas.fire('webglcontextlost')
    canvas.fire('webglcontextlost')

    expect(guard.currentState()).toBe('given-up')
    expect(showOverlay).toHaveBeenLastCalledWith(CONTEXT_GIVEN_UP_MESSAGE)
    expect(reload).not.toHaveBeenCalled()
  })

  it('given-up 之后的 context 事件一律忽略', () => {
    const canvas = createFakeCanvas()
    const onStateChange = vi.fn()
    const guard = createLive2DContextRecoveryGuard({
      canvas, reload: vi.fn(), showOverlay: vi.fn(), hideOverlay: vi.fn(), onStateChange
    })
    canvas.fire('webglcontextlost')
    canvas.fire('webglcontextlost') // -> given-up
    onStateChange.mockClear()

    canvas.fire('webglcontextlost')
    canvas.fire('webglcontextrestored')

    expect(onStateChange).not.toHaveBeenCalled()
    expect(guard.currentState()).toBe('given-up')
  })

  it('恢复重载还没返回时又丢失一次 context:迟到的重载结果不能覆盖已经给定的 given-up', async () => {
    let resolveReload: (() => void) | null = null
    const reload = vi.fn(() => new Promise<void>((resolve) => { resolveReload = resolve }))
    const showOverlay = vi.fn()
    const hideOverlay = vi.fn()
    const canvas = createFakeCanvas()
    const guard = createLive2DContextRecoveryGuard({ canvas, reload, showOverlay, hideOverlay, onStateChange: vi.fn() })

    canvas.fire('webglcontextlost')
    canvas.fire('webglcontextrestored')
    expect(reload).toHaveBeenCalledOnce()
    canvas.fire('webglcontextlost') // 重载还没 resolve,又丢了一次
    expect(guard.currentState()).toBe('given-up')

    resolveReload!()
    await flush()

    expect(guard.currentState()).toBe('given-up')
    expect(hideOverlay).not.toHaveBeenCalled()
  })

  it('reset() 强制回到 healthy 并隐藏占位(真实换宠物提交新 source 时调用)', () => {
    const canvas = createFakeCanvas()
    const showOverlay = vi.fn()
    const hideOverlay = vi.fn()
    const onStateChange = vi.fn()
    const guard = createLive2DContextRecoveryGuard({ canvas, reload: vi.fn(), showOverlay, hideOverlay, onStateChange })

    canvas.fire('webglcontextlost')
    canvas.fire('webglcontextlost') // given-up
    guard.reset()

    expect(guard.currentState()).toBe('healthy')
    expect(hideOverlay).toHaveBeenCalled()
    expect(onStateChange).toHaveBeenLastCalledWith('healthy')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/renderer/live2dContextRecoveryGuard.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 guard 工厂**

```ts
// src/renderer/live2dContextRecoveryGuard.ts
import { nextContextRecoveryState, type ContextRecoveryState } from './live2dContextRecovery'

export const CONTEXT_RECOVERY_MESSAGE = '画面渲染出现问题,正在尝试恢复…'
export const CONTEXT_GIVEN_UP_MESSAGE = '渲染反复失败,已停止自动重试。请从托盘或设置中切换宠物/模型。'

export interface ContextRecoveryCanvasLike {
  addEventListener(type: 'webglcontextlost' | 'webglcontextrestored', listener: (event: Event) => void): void
}

export interface ContextRecoveryGuardDeps {
  canvas: ContextRecoveryCanvasLike
  /** 重新加载当前 source;由调用方(main.ts)绑定好"当前宠物的 currentSource",
   *  guard 本身不知道 source 是什么,只知道"重载一次"这个动作。 */
  reload: () => Promise<void>
  showOverlay: (text: string) => void
  hideOverlay: () => void
  onStateChange: (state: ContextRecoveryState) => void
}

export interface ContextRecoveryGuard {
  /** 真实换宠物提交新 source 时调用,强制回到 healthy——不属于状态机自身的事件,
   *  是外部对"这已经是一个全新的、还没经历过任何丢失的会话"这一事实的显式声明。 */
  reset(): void
  currentState(): ContextRecoveryState
}

/** 见 docs/superpowers/specs/2026-07-22-live2d-phase7-gpu-context-recovery-design.md §2。
 *  只在 canvas 上挂两个标准 WebGL 事件监听,不新建任何渲染器生命周期。 */
export function createLive2DContextRecoveryGuard(deps: ContextRecoveryGuardDeps): ContextRecoveryGuard {
  let state: ContextRecoveryState = 'healthy'

  function setState(next: ContextRecoveryState): void {
    state = next
    deps.onStateChange(state)
  }

  async function handleRestore(): Promise<void> {
    try {
      await deps.reload()
      // 重载这段时间里,如果 canvas 又并发丢失了一次 context(recovering->given-up 的第二条
      // 转移在下面的 webglcontextlost 监听里已经同步处理过),这次迟到的重载结果就不再代表
      // 当前状态——不能让一次"成功"把已经判定的 given-up 打回 healthy。
      if (state !== 'recovering') return
      setState(nextContextRecoveryState(state, 'restore-succeeded'))
      deps.hideOverlay()
    } catch (err) {
      console.warn('[live2dContextRecoveryGuard] 恢复重载失败', err)
      if (state !== 'recovering') return
      setState(nextContextRecoveryState(state, 'restore-failed'))
      deps.showOverlay(CONTEXT_GIVEN_UP_MESSAGE)
    }
  }

  deps.canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault()
    if (state === 'given-up') return
    const next = nextContextRecoveryState(state, 'contextlost')
    setState(next)
    if (next === 'recovering') deps.showOverlay(CONTEXT_RECOVERY_MESSAGE)
    else if (next === 'given-up') deps.showOverlay(CONTEXT_GIVEN_UP_MESSAGE)
  })

  deps.canvas.addEventListener('webglcontextrestored', () => {
    if (state !== 'recovering') return
    void handleRestore()
  })

  return {
    reset(): void {
      state = 'healthy'
      deps.hideOverlay()
      deps.onStateChange(state)
    },
    currentState(): ContextRecoveryState {
      return state
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/renderer/live2dContextRecoveryGuard.test.ts`
Expected: PASS(7 个用例全绿)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/live2dContextRecoveryGuard.ts src/renderer/live2dContextRecoveryGuard.test.ts
git commit -m "feat(live2d): GPU Context Lost 恢复 guard 工厂"
```

---

### Task 3: 接入 `main.ts`

**Files:**
- Modify: `src/renderer/main.ts`

**Interfaces:**
- Consumes:`createLive2DContextRecoveryGuard`、`ContextRecoveryGuard`(Task 2);既有的 `PetController.prepareReload`/`commitReload`、`controller.setVisible`、`window.petApi.onPetPrepare`/`onPetCommit`/`onPetDiscard`/`onWindowVisibilityChanged`、`window.petApi.getPet()`。
- Produces:无对外接口(`main.ts` 是应用入口,不被其他模块 import)。

这一步不写新的失败测试——`main.ts` 是纯 Electron/DOM 胶水代码,本仓库一贯的做法是靠
`pnpm dev`/`pnpm preview` 真实运行验证(见 Global Constraints),Task 4 会做这件事。这里
只需要改代码、跑 `pnpm typecheck`/`pnpm build` 确认类型和构建通过。

- [ ] **Step 1: 在文件顶部加 import,并在 `createRendererForCanvas` 后面加错误占位 helper**

当前 `src/renderer/main.ts` 第 1-20 行是:

```ts
import { SpriteRenderer } from './spriteRenderer'
import { Live2DPetRenderer } from './live2dRenderer'
import { PetController } from './petController'
import { createPcmPlayer } from './voice/pcmPlayer'
import { createLipSyncSmoother, DEFAULT_LIP_SYNC_ATTACK_MS, DEFAULT_LIP_SYNC_RELEASE_MS } from './voice/lipSyncEnvelope'
import type { PetRenderer } from './petRenderer'
import type { PetRenderSource } from '@shared/petPackage'

const DRAG_THRESHOLD = 4
const DBLCLICK_MS = 280

/** 一旦某个 canvas 元素被绑定过某种 context(2D 或 WebGL),规范上就再也不能换成另一种类型;
 *  而 pixi.js 的 Application.destroy() 还会无条件强制 lose 掉 WebGL context(GlContextSystem.
 *  destroy() 内部调用 loseContext(),没有选项能跳过),之后同一个 canvas 再 getContext('webgl')
 *  拿到的还是那个已经废弃的 context——所以每次(重新)构造渲染器都必须换一个全新的 canvas 元素,
 *  不能复用旧的,不管前后渲染器类型是否相同。 */
function createRendererForCanvas(canvas: HTMLCanvasElement, source: PetRenderSource): PetRenderer {
  if (source.type === 'sprite') return new SpriteRenderer(canvas)
  return new Live2DPetRenderer(canvas)
}
```

改成:

```ts
import { SpriteRenderer } from './spriteRenderer'
import { Live2DPetRenderer } from './live2dRenderer'
import { PetController } from './petController'
import { createPcmPlayer } from './voice/pcmPlayer'
import { createLipSyncSmoother, DEFAULT_LIP_SYNC_ATTACK_MS, DEFAULT_LIP_SYNC_RELEASE_MS } from './voice/lipSyncEnvelope'
import { createLive2DContextRecoveryGuard, type ContextRecoveryGuard } from './live2dContextRecoveryGuard'
import type { PetRenderer } from './petRenderer'
import type { PetRenderSource } from '@shared/petPackage'

const DRAG_THRESHOLD = 4
const DBLCLICK_MS = 280

/** 一旦某个 canvas 元素被绑定过某种 context(2D 或 WebGL),规范上就再也不能换成另一种类型;
 *  而 pixi.js 的 Application.destroy() 还会无条件强制 lose 掉 WebGL context(GlContextSystem.
 *  destroy() 内部调用 loseContext(),没有选项能跳过),之后同一个 canvas 再 getContext('webgl')
 *  拿到的还是那个已经废弃的 context——所以每次(重新)构造渲染器都必须换一个全新的 canvas 元素,
 *  不能复用旧的,不管前后渲染器类型是否相同。 */
function createRendererForCanvas(canvas: HTMLCanvasElement, source: PetRenderSource): PetRenderer {
  if (source.type === 'sprite') return new SpriteRenderer(canvas)
  return new Live2DPetRenderer(canvas)
}

// 与 showBootError() 共用的错误占位样式——GPU Context Lost 恢复提示和启动失败提示
// 视觉语言保持一致,不重复写 CSS 字符串。
const ERROR_OVERLAY_CSS =
  'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
  'padding:12px;box-sizing:border-box;font:12px/1.5 system-ui,sans-serif;color:#fff;' +
  'text-align:center;background:rgba(176,32,32,.92);border-radius:8px;-webkit-app-region:no-drag'

function createErrorOverlay(text: string): HTMLDivElement {
  const el = document.createElement('div')
  el.style.cssText = ERROR_OVERLAY_CSS
  el.textContent = text
  document.body.appendChild(el)
  return el
}
```

- [ ] **Step 2: 在 `boot()` 里加状态变量、`applyVisibility`/`setupGuard`,并在渲染器构造后挂上首次 guard**

当前 `src/renderer/main.ts` 第 53-65 行是:

```ts
  const renderer = createRendererForCanvas(canvas, source)
  await renderer.load(source)
  const controller = new PetController(renderer, source.type, (s) => {
    const fresh = document.createElement('canvas')
    fresh.id = canvas.id
    fresh.addEventListener('mousedown', onCanvasMouseDown)
    const nextRenderer = createRendererForCanvas(fresh, s)
    return {
      renderer: nextRenderer,
      attach: () => { canvas.replaceWith(fresh); canvas = fresh }
    }
  })
  await controller.start()
```

改成:

```ts
  let currentSource: PetRenderSource = source
  let pendingSource: PetRenderSource | null = null
  let windowVisible = true
  let guard: ContextRecoveryGuard | null = null
  let recoveryOverlayEl: HTMLDivElement | null = null

  const renderer = createRendererForCanvas(canvas, source)
  await renderer.load(source)
  const controller = new PetController(renderer, source.type, (s) => {
    const fresh = document.createElement('canvas')
    fresh.id = canvas.id
    fresh.addEventListener('mousedown', onCanvasMouseDown)
    const nextRenderer = createRendererForCanvas(fresh, s)
    return {
      renderer: nextRenderer,
      attach: () => { canvas.replaceWith(fresh); canvas = fresh; setupGuard(fresh, s.type) }
    }
  })

  // 只影响"是否渲染/是否跑 Ticker",与主进程窗口最小化/锁屏(windowVisible)和 GPU
  // 恢复占位期(guard 的 recovering/given-up)两个独立信号做合取,任一个说"现在不该画"
  // 就不画——见 docs/superpowers/specs/2026-07-22-live2d-phase7-gpu-context-recovery-design.md §2。
  function applyVisibility(): void {
    const state = guard?.currentState() ?? 'healthy'
    controller.setVisible(windowVisible && state === 'healthy')
  }

  // sprite 渲染器用 2D canvas,不会触发 webglcontextlost,不需要 guard。每次(重新)绑定
  // 一个新 canvas(首次 boot、跨类型热切换换上的 fresh canvas)都要重新建一份 guard——
  // 旧 canvas 上的监听器随节点一起被丢弃,语义与上面已有的 mousedown 重新挂载一致。
  function setupGuard(target: HTMLCanvasElement, type: PetRenderSource['type']): void {
    if (type !== 'live2d') {
      guard = null
      return
    }
    guard = createLive2DContextRecoveryGuard({
      canvas: target,
      // reload() 读的是外层 currentSource——即便这里绑定的时间点早于 currentSource 被更新
      // (跨类型 attach() 内部同步调用 setupGuard,晚于它的 onPetCommit 才更新 currentSource),
      // 箭头函数闭包捕获的是变量本身,真正调用 reload() 永远读到当时最新的值。
      reload: () => controller.prepareReload(currentSource).then(() => controller.commitReload()),
      showOverlay: (text) => {
        recoveryOverlayEl?.remove()
        recoveryOverlayEl = createErrorOverlay(text)
      },
      hideOverlay: () => {
        recoveryOverlayEl?.remove()
        recoveryOverlayEl = null
      },
      onStateChange: () => applyVisibility()
    })
  }
  setupGuard(canvas, source.type)

  await controller.start()
```

- [ ] **Step 3: 让 `onPetPrepare`/`onPetCommit`/`onPetDiscard`/`onWindowVisibilityChanged` 维护 `currentSource`/`pendingSource`/`windowVisible`,并在真实换宠物提交时 `guard.reset()`**

当前 `src/renderer/main.ts` 第 73-85 行是:

```ts
  window.petApi.onPetPrepare((payload) => {
    controller.prepareReload(payload.source).then(
      () => window.petApi.reportPrepareResult(payload.requestId, true),
      (err) => window.petApi.reportPrepareResult(payload.requestId, false, err instanceof Error ? err.message : String(err))
    )
  })
  window.petApi.onPetCommit(() => {
    try { controller.commitReload() } catch (err) { console.warn('commitReload failed', err) }
  })
  window.petApi.onPetDiscard(() => {
    try { controller.discardReload() } catch (err) { console.warn('discardReload failed', err) }
  })
  window.petApi.onWindowVisibilityChanged((payload) => controller.setVisible(payload.visible))
```

改成:

```ts
  window.petApi.onPetPrepare((payload) => {
    controller.prepareReload(payload.source).then(
      () => {
        pendingSource = payload.source
        window.petApi.reportPrepareResult(payload.requestId, true)
      },
      (err) => window.petApi.reportPrepareResult(payload.requestId, false, err instanceof Error ? err.message : String(err))
    )
  })
  window.petApi.onPetCommit(() => {
    try {
      controller.commitReload()
      if (pendingSource) { currentSource = pendingSource; pendingSource = null }
      // 真实换宠物提交成功——不管上一个宠物当时是不是卡在 given-up,这都是一个全新的、
      // 还没经历过任何 GPU 丢失的会话,强制回到 healthy。
      guard?.reset()
    } catch (err) { console.warn('commitReload failed', err) }
  })
  window.petApi.onPetDiscard(() => {
    pendingSource = null
    try { controller.discardReload() } catch (err) { console.warn('discardReload failed', err) }
  })
  window.petApi.onWindowVisibilityChanged((payload) => {
    windowVisible = payload.visible
    applyVisibility()
  })
```

- [ ] **Step 4: 把 `showBootError()` 也改成用共享的 `createErrorOverlay()`,避免重复 CSS 字符串**

当前 `src/renderer/main.ts` 第 148-159 行是:

```ts
function showBootError(err: unknown): void {
  console.error('boot failed', err)
  // 宠物包加载失败(最常见:fresh clone 缺 pets/luluka,该目录被 .gitignore)。
  // 透明窗默认会静默空白,这里显式给出可见提示,避免"启动没反应"无从排查。
  const el = document.createElement('div')
  el.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'padding:12px;box-sizing:border-box;font:12px/1.5 system-ui,sans-serif;color:#fff;' +
    'text-align:center;background:rgba(176,32,32,.92);border-radius:8px;-webkit-app-region:no-drag'
  el.textContent = '宠物包加载失败:请确认 pets/luluka 存在(该目录被 .gitignore,新克隆需自行放置)。'
  document.body.appendChild(el)
}
```

改成:

```ts
function showBootError(err: unknown): void {
  console.error('boot failed', err)
  // 宠物包加载失败(最常见:fresh clone 缺 pets/luluka,该目录被 .gitignore)。
  // 透明窗默认会静默空白,这里显式给出可见提示,避免"启动没反应"无从排查。
  createErrorOverlay('宠物包加载失败:请确认 pets/luluka 存在(该目录被 .gitignore,新克隆需自行放置)。')
}
```

- [ ] **Step 5: 类型检查 + 单元测试 + 构建全绿**

Run: `pnpm typecheck`
Expected: 无错误

Run: `pnpm test`
Expected: 全部通过(含 Task 1/2 新增的用例)

Run: `pnpm build`
Expected: 三个 bundle(main/preload/renderer)构建成功

- [ ] **Step 6: Commit**

```bash
git add src/renderer/main.ts
git commit -m "feat(live2d): 接入 GPU Context Lost 恢复 guard"
```

---

### Task 4: 真实 Electron 验证 + 收尾

**Files:**
- Modify: `PROGRESS.md`(记录本次验证结果)

不产出新代码;这一步的"deliverable"是一份可信的真机验证记录。

- [ ] **Step 1: `pnpm preview` 启动真实应用,确认无 `ELECTRON_RUN_AS_NODE` 残留**

```bash
unset ELECTRON_RUN_AS_NODE
pnpm build
pnpm preview
```

用一个本地已导入的、真实授权的 Live2D 宠物包(不是 sprite 包)确认应用正常显示、可拖动、
可点击弹对话框。

- [ ] **Step 2: 用 DevTools 强制模拟一次 context 丢失→恢复,验证 healthy→recovering→healthy**

打开宠物窗口的 DevTools(或通过 CDP 附加),在 Console 执行:

```js
const { app } = window.__kiboLive2D
const gl = app.renderer.gl // pixi.js GlContextSystem 把 gl 直接挂在 renderer 上(this._renderer.gl = gl),不是 renderer.context.gl
gl.getExtension('WEBGL_lose_context').loseContext()
```

预期:画面消失,出现红底文字"画面渲染出现问题,正在尝试恢复…";期间点击宠物区域仍能弹出/
收起对话框(不受影响)。约 0 秒后(`loseContext()` 是同步失效,浏览器通常很快派发
`webglcontextlost`)继续执行:

```js
gl.getExtension('WEBGL_lose_context').restoreContext()
```

预期:几百毫秒内占位消失,模型重新出现并正常播放待机动作,`window.__kiboLive2D.app` 是一个
新的模型实例(`prepareSwap`/`commitSwap` 内部重新 `Live2DModel.from()` 的结果)。

- [ ] **Step 3: 验证连续两次丢失走 given-up 路径**

重复 Step 2 的 `loseContext()`,但在浏览器还没来得及触发 `webglcontextrestored`(或触发后、
`reload()` 还没完成)之前就再调用一次 `loseContext()`(可以连续执行两行,不等待中间结果)。

预期:占位文案变成"渲染反复失败,已停止自动重试。请从托盘或设置中切换宠物/模型。",此后再执行
`restoreContext()` 不会让模型恢复(given-up 是终态)。改用托盘菜单/设置窗口切换到另一个宠物,
确认切换成功且新宠物运行正常(验证 `guard.reset()` 生效,新会话不受旧宠物 given-up 状态影响)。

- [ ] **Step 4: 更新 `PROGRESS.md`**

在文件顶部"更新时间"段落追加一条真机验证记录,注明:验证用的宠物包类型、Step 2/3 的实际
结果、是否有偏离预期的现象。如果真机验证发现偏离预期的行为,回到对应 Task 修复后重新走一遍
Step 1-3,不要在 `PROGRESS.md` 里记"预期通过"而没有实际跑过。

- [ ] **Step 5: Commit**

```bash
git add PROGRESS.md
git commit -m "docs: Live2D Phase 7 GPU Context Lost 恢复真机验证记录"
```
