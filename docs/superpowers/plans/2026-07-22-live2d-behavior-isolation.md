# Live2D 行为隔离(拆分自主游走) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Live2D pets their own behavior state machine (`idle/drag/sleep/greet/thinking/talk`, no autonomous walk) so `PetController` no longer forces sprite-only walk semantics onto Live2D, while leaving the sprite pet's `petBrain.ts` completely untouched.

**Architecture:** New standalone pure module `src/shared/live2dPetBrain.ts` mirrors `petBrain.ts`'s event/state shape minus everything walk-related (no `Direction`, no `moveX`/`moveY`, no `dwellMs`). `PetController` gains a discriminated-union field `behavior: {kind:'sprite';ctx:PetBrainCtx} | {kind:'live2d';ctx:Live2DBrainCtx}` and picks which `step`/`stepLive2D` function to call in `tick()` based on `this.rendererType`; everything downstream of that branch (animation-change detection → `renderer.playState()` → reaction planner feed) stays one shared code path.

**Tech Stack:** TypeScript, Vitest (unit tests for pure logic), pnpm.

## Global Constraints

- `src/shared/petBrain.ts` and `src/shared/petBrain.test.ts` must not be modified — zero-diff, verified by `git diff` showing no changes to these two files at the end.
- `src/shared/reactionPlanner.ts` must not be modified — `stepReaction()`'s input/output contract is unchanged; only the values fed into `pausedByDialog`/`sleeping` change their source (from `this.behavior.ctx` instead of `this.ctx`).
- `live2dPetBrain.ts` imports `PetEvent` from `./petBrain` (reuse, don't redefine) — same for any other cross-cutting primitive type the spec calls out as shared.
- `Live2DBrainCtx`/`Live2DStepEffects` must not contain `moveX`/`moveY`/`dir`/`dirY`/`dwellMs`/`walkRemainingPx` fields — this is a compile-time constraint, not a runtime check.
- Package manager is pnpm; run tests via `pnpm vitest run <path>`; run `pnpm typecheck` before the final task's commit.
- Follow TDD: write the failing test before the implementation, for every step below.

---

## File Structure

- Create: `src/shared/live2dPetBrain.ts` — pure Live2D behavior state machine (states, config, `initLive2DBrain`, `stepLive2D`).
- Create: `src/shared/live2dPetBrain.test.ts` — unit tests for the above, structured like `petBrain.test.ts`.
- Modify: `src/renderer/petController.ts` — replace the single `PetBrainCtx` field with a `BehaviorState` discriminated union; branch `tick()`'s `step()` call by `rendererType`.
- Modify: `src/renderer/petController.test.ts` — add two cases verifying the right behavior module drives `sprite` vs `live2d` controllers.

---

### Task 1: `live2dPetBrain.ts` — Live2D behavior state machine

**Files:**
- Create: `src/shared/live2dPetBrain.ts`
- Test: `src/shared/live2dPetBrain.test.ts`

**Interfaces:**
- Consumes: `PetEvent` from `src/shared/petBrain.ts` (reused, not redefined).
- Produces (for Task 2): `Live2DPetState`, `Live2DBrainConfig`, `DEFAULT_LIVE2D_BRAIN_CONFIG`, `Live2DBrainCtx { state: Live2DPetState; stateElapsedMs: number; idleAccumMs: number; paused: boolean; config: Live2DBrainConfig }`, `Live2DStepInput { dtMs: number; event?: PetEvent; rng: () => number }`, `Live2DStepEffects { animation: string }`, `initLive2DBrain(config?: Partial<Live2DBrainConfig>): Live2DBrainCtx`, `stepLive2D(ctx: Live2DBrainCtx, input: Live2DStepInput): { ctx: Live2DBrainCtx; effects: Live2DStepEffects }`.

- [ ] **Step 1: Write the failing test file**

Create `src/shared/live2dPetBrain.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { initLive2DBrain, stepLive2D, DEFAULT_LIVE2D_BRAIN_CONFIG, type Live2DStepInput } from './live2dPetBrain'

function input(partial: Partial<Live2DStepInput> = {}): Live2DStepInput {
  return {
    dtMs: 100,
    rng: () => 0,
    ...partial
  }
}

describe('live2dPetBrain autonomous', () => {
  it('starts in idle', () => {
    expect(initLive2DBrain().state).toBe('idle')
  })

  it('falls asleep after prolonged idle without interaction', () => {
    let res = { ctx: initLive2DBrain(), effects: { animation: 'idle' } }
    let total = 0
    while (total < DEFAULT_LIVE2D_BRAIN_CONFIG.sleepAfterIdleMs) {
      res = stepLive2D(res.ctx, input({ dtMs: 5000 }))
      total += 5000
    }
    expect(res.ctx.state).toBe('sleep')
  })

  it('stays idle (no walk option exists) until the sleep threshold is hit', () => {
    const res = stepLive2D(initLive2DBrain(), input({ dtMs: DEFAULT_LIVE2D_BRAIN_CONFIG.sleepAfterIdleMs - 100 }))
    expect(res.ctx.state).toBe('idle')
    expect(res.effects.animation).toBe('idle')
  })
})

describe('live2dPetBrain events', () => {
  it('pickup → drag, drop → idle', () => {
    let res = stepLive2D(initLive2DBrain(), input({ event: 'pickup' }))
    expect(res.ctx.state).toBe('drag')
    expect(res.ctx.idleAccumMs).toBe(0)
    res = stepLive2D(res.ctx, input({ dtMs: 1000 })) // drag persists without an event
    expect(res.ctx.state).toBe('drag')
    res = stepLive2D(res.ctx, input({ event: 'drop' }))
    expect(res.ctx.state).toBe('idle')
    expect(res.ctx.idleAccumMs).toBe(0)
  })

  it('messageSent → thinking (persists), replyDone → talk → idle after talkMs', () => {
    let res = stepLive2D(initLive2DBrain(), input({ event: 'messageSent' }))
    expect(res.ctx.state).toBe('thinking')
    expect(res.ctx.idleAccumMs).toBe(0)
    res = stepLive2D(res.ctx, input({ dtMs: 5000 })) // persists without event
    expect(res.ctx.state).toBe('thinking')
    res = stepLive2D(res.ctx, input({ event: 'replyDone' }))
    expect(res.ctx.state).toBe('talk')
    expect(res.ctx.idleAccumMs).toBe(0)
    res = stepLive2D(res.ctx, input({ dtMs: DEFAULT_LIVE2D_BRAIN_CONFIG.talkMs + 10 }))
    expect(res.ctx.state).toBe('idle')
  })

  it('dialogOpen → greet → idle after greetMs', () => {
    let res = stepLive2D(initLive2DBrain(), input({ event: 'dialogOpen' }))
    expect(res.ctx.state).toBe('greet')
    expect(res.ctx.idleAccumMs).toBe(0)
    res = stepLive2D(res.ctx, input({ dtMs: DEFAULT_LIVE2D_BRAIN_CONFIG.greetMs + 10 }))
    expect(res.ctx.state).toBe('idle')
  })

  it('wake from sleep returns to idle and resets the sleep timer', () => {
    const sleeping = { ...initLive2DBrain(), state: 'sleep' as const, idleAccumMs: 99999 }
    const res = stepLive2D(sleeping, input({ event: 'wake' }))
    expect(res.ctx.state).toBe('idle')
    expect(res.ctx.idleAccumMs).toBe(0)
  })

  it('any interaction resets the sleep timer (pickup)', () => {
    const almost = { ...initLive2DBrain(), idleAccumMs: 40000 }
    const res = stepLive2D(almost, input({ event: 'pickup' }))
    expect(res.ctx.idleAccumMs).toBe(0)
  })

  it("'remind' 使宠物进入 greet(复用打招呼动画)", () => {
    const res = stepLive2D(initLive2DBrain(), input({ dtMs: 0, event: 'remind' }))
    expect(res.ctx.state).toBe('greet')
  })
})

describe('live2dPetBrain pause (dialog open)', () => {
  it('dialogOpen pauses: no sleep while paused, even past the sleep threshold', () => {
    let res = stepLive2D(initLive2DBrain(), input({ event: 'dialogOpen' }))
    expect(res.ctx.state).toBe('greet')
    expect(res.ctx.paused).toBe(true)
    res = stepLive2D(res.ctx, input({ dtMs: DEFAULT_LIVE2D_BRAIN_CONFIG.greetMs + 10 }))
    expect(res.ctx.state).toBe('idle')
    expect(res.ctx.paused).toBe(true)
    res = stepLive2D(res.ctx, input({ dtMs: DEFAULT_LIVE2D_BRAIN_CONFIG.sleepAfterIdleMs + 10000 }))
    expect(res.ctx.state).toBe('idle') // still idle, not asleep — paused suppresses the sleep drift
  })

  it('dialogClose unpauses and idle resumes counting toward sleep', () => {
    let res = stepLive2D(initLive2DBrain(), input({ event: 'dialogOpen' }))
    res = stepLive2D(res.ctx, input({ dtMs: DEFAULT_LIVE2D_BRAIN_CONFIG.greetMs + 10 }))
    expect(res.ctx.paused).toBe(true)
    res = stepLive2D(res.ctx, input({ event: 'dialogClose' }))
    expect(res.ctx.paused).toBe(false)
    expect(res.ctx.state).toBe('idle')
    res = stepLive2D(res.ctx, input({ dtMs: DEFAULT_LIVE2D_BRAIN_CONFIG.sleepAfterIdleMs + 10 }))
    expect(res.ctx.state).toBe('sleep')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/shared/live2dPetBrain.test.ts`
Expected: FAIL — `Cannot find module './live2dPetBrain'` (file doesn't exist yet).

- [ ] **Step 3: Implement `live2dPetBrain.ts`**

Create `src/shared/live2dPetBrain.ts`:

```ts
import type { PetEvent } from './petBrain'

export type Live2DPetState = 'idle' | 'drag' | 'sleep' | 'greet' | 'thinking' | 'talk'

export interface Live2DBrainConfig {
  sleepAfterIdleMs: number
  greetMs: number
  talkMs: number
}

export const DEFAULT_LIVE2D_BRAIN_CONFIG: Live2DBrainConfig = {
  sleepAfterIdleMs: 45000,
  greetMs: 900,
  talkMs: 1200
}

export interface Live2DBrainCtx {
  state: Live2DPetState
  stateElapsedMs: number
  idleAccumMs: number
  paused: boolean
  config: Live2DBrainConfig
}

export interface Live2DStepInput {
  dtMs: number
  event?: PetEvent
  rng: () => number
}

/** 与 petBrain.ts 的 StepEffects 刻意不同:没有 moveX/moveY——Live2D 宠物结构上
 *  不可能产出自主位移,这条约束在类型层面强制,不是运行时判断出来的。 */
export interface Live2DStepEffects { animation: string }

export function initLive2DBrain(config: Partial<Live2DBrainConfig> = {}): Live2DBrainCtx {
  const cfg = { ...DEFAULT_LIVE2D_BRAIN_CONFIG, ...config }
  return {
    state: 'idle',
    stateElapsedMs: 0,
    idleAccumMs: 0,
    paused: false,
    config: cfg
  }
}

function enterState(ctx: Live2DBrainCtx, state: Live2DPetState): Live2DBrainCtx {
  return { ...ctx, state, stateElapsedMs: 0 }
}

function applyEvent(ctx: Live2DBrainCtx, event: PetEvent): Live2DBrainCtx {
  switch (event) {
    case 'pickup': return { ...enterState(ctx, 'drag'), idleAccumMs: 0 }
    case 'drop': return { ...enterState(ctx, 'idle'), idleAccumMs: 0 }
    case 'wake': return { ...enterState(ctx, 'idle'), idleAccumMs: 0 }
    case 'dialogOpen': return { ...enterState(ctx, 'greet'), idleAccumMs: 0, paused: true }
    case 'dialogClose': return { ...enterState(ctx, 'idle'), idleAccumMs: 0, paused: false }
    case 'messageSent': return { ...enterState(ctx, 'thinking'), idleAccumMs: 0 }
    case 'replyDone': return { ...enterState(ctx, 'talk'), idleAccumMs: 0 }
    case 'remind': return { ...enterState(ctx, 'greet'), idleAccumMs: 0 }
    default: return ctx
  }
}

export function stepLive2D(ctx: Live2DBrainCtx, input: Live2DStepInput): { ctx: Live2DBrainCtx; effects: Live2DStepEffects } {
  const cfg = ctx.config
  let next: Live2DBrainCtx = {
    ...ctx,
    stateElapsedMs: ctx.stateElapsedMs + input.dtMs,
    idleAccumMs: ctx.idleAccumMs + input.dtMs
  }

  if (input.event) next = applyEvent(next, input.event)

  switch (next.state) {
    case 'idle': {
      // While paused (dialog open) the pet stays put — no autonomous sleep drift.
      if (next.paused) break
      if (next.idleAccumMs >= cfg.sleepAfterIdleMs) next = enterState(next, 'sleep')
      break
    }
    case 'greet': {
      if (next.stateElapsedMs >= cfg.greetMs) next = enterState(next, 'idle')
      break
    }
    case 'talk': {
      if (next.stateElapsedMs >= cfg.talkMs) next = enterState(next, 'idle')
      break
    }
    // 'drag' / 'thinking' / 'sleep' 持续,直到相应事件触发切换
  }

  return { ctx: next, effects: { animation: next.state } }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/shared/live2dPetBrain.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/live2dPetBrain.ts src/shared/live2dPetBrain.test.ts
git commit -m "feat(live2d): 新增 Live2D 独立行为状态机(不含自主游走)"
```

---

### Task 2: `PetController` — select behavior module by `rendererType`

**Files:**
- Modify: `src/renderer/petController.ts`
- Modify: `src/renderer/petController.test.ts`

**Interfaces:**
- Consumes: `initLive2DBrain`, `stepLive2D`, `Live2DBrainCtx` from `src/shared/live2dPetBrain.ts` (Task 1); existing `initBrain`, `step`, `PetBrainCtx`, `PetEvent`, `Bounds` from `src/shared/petBrain.ts` (unchanged).
- Produces: `PetController` now exposes the same public API as before (`start`, `stop`, `prepareReload`, `commitReload`, `discardReload`, `setVisible`, `hitTest`, `send`, `poke`, `receiveContextSignal`, `syncBounds`) — signatures unchanged, only the private `behavior` field replaces the private `ctx` field.

- [ ] **Step 1: Write the failing test cases**

Add to `src/renderer/petController.test.ts`, as a new `describe` block appended at the end of the file. These assert on `behavior.kind`/`behavior.ctx` shape directly (via `as any`, matching this file's existing pattern of reaching into private state through the fake-renderer harness) rather than driving real `setInterval` ticks, so they stay deterministic:

```ts
describe('PetController 行为模块按 rendererType 选择', () => {
  it('构造时 rendererType=sprite → 内部使用 petBrain(idle 初始状态,walk 相关 effects 字段存在)', () => {
    const renderer = makeFakeRenderer()
    const controller = new PetController(renderer, 'sprite', vi.fn()) as any
    expect(controller.behavior.kind).toBe('sprite')
    expect(controller.behavior.ctx.state).toBe('idle')
    expect(controller.behavior.ctx.dir).toBe('right') // sprite-only field — proves petBrain.initBrain() ran
  })

  it('构造时 rendererType=live2d → 内部使用 live2dPetBrain(idle 初始状态,不含 dir/dwellMs 等 walk 字段)', () => {
    const renderer = makeFakeRenderer()
    const controller = new PetController(renderer, 'live2d', vi.fn()) as any
    expect(controller.behavior.kind).toBe('live2d')
    expect(controller.behavior.ctx.state).toBe('idle')
    expect(controller.behavior.ctx.dir).toBeUndefined() // live2dPetBrain.initLive2DBrain() has no dir field
    expect(controller.behavior.ctx.dwellMs).toBeUndefined()
  })

  it('跨类型热切换(sprite→live2d)commitReload 后 behavior 切到 live2d;反向切换切回 sprite', async () => {
    const oldRenderer = makeFakeRenderer()
    const newRenderer = makeFakeRenderer()
    const factory = vi.fn(() => ({ renderer: newRenderer, attach: vi.fn() }))
    const controller = new PetController(oldRenderer, 'sprite', factory) as any
    expect(controller.behavior.kind).toBe('sprite')

    await controller.prepareReload(live2dSource)
    controller.commitReload()
    expect(controller.behavior.kind).toBe('live2d')
    expect(controller.behavior.ctx.state).toBe('idle')

    const backFactory = vi.fn(() => ({ renderer: oldRenderer, attach: vi.fn() }))
    const controller2 = new PetController(newRenderer, 'live2d', backFactory) as any
    await controller2.prepareReload(spriteSource)
    controller2.commitReload()
    expect(controller2.behavior.kind).toBe('sprite')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/renderer/petController.test.ts`
Expected: FAIL — `controller.behavior` is `undefined` (private field is still named `ctx`, and accessing `.kind` on `undefined` throws, or the assertions on `dir`/`dwellMs` mismatch since `ctx` still has sprite shape unconditionally).

- [ ] **Step 3: Implement the `PetController` changes**

In `src/renderer/petController.ts`, replace the imports block (lines 1-6) with:

```ts
import type { PetRenderer, PetHitResult } from './petRenderer'
import type { PetRenderSource } from '@shared/petPackage'
import { initBrain, step, type PetBrainCtx, type PetEvent, type Bounds } from '@shared/petBrain'
import { initLive2DBrain, stepLive2D, type Live2DBrainCtx } from '@shared/live2dPetBrain'
import { initReaction, stepReaction, type ReactionCtx, type ReactionTrigger } from '@shared/reactionPlanner'
import type { ContextSignalKind } from '@shared/ipc'

const TICK_MS = 33

type BehaviorState =
  | { kind: 'sprite'; ctx: PetBrainCtx }
  | { kind: 'live2d'; ctx: Live2DBrainCtx }

function initBehaviorFor(type: PetRenderSource['type']): BehaviorState {
  return type === 'live2d' ? { kind: 'live2d', ctx: initLive2DBrain() } : { kind: 'sprite', ctx: initBrain() }
}
```

Replace the field `private ctx: PetBrainCtx = initBrain()` with:

```ts
  private behavior: BehaviorState
```

Replace the constructor body:

```ts
  constructor(
    initialRenderer: PetRenderer,
    initialType: PetRenderSource['type'],
    private readonly createRenderer: (source: PetRenderSource) => { renderer: PetRenderer; attach: () => void }
  ) {
    this.renderer = initialRenderer
    this.rendererType = initialType
    this.behavior = initBehaviorFor(initialType)
  }
```

In `commitReload()`, replace both `this.ctx = initBrain()` occurrences:

```ts
  commitReload(): void {
    if (this.pendingRenderer && this.pendingAttach && this.pendingRendererType) {
      const oldRenderer = this.renderer
      this.pendingAttach()
      void oldRenderer.destroy()
      this.renderer = this.pendingRenderer
      this.rendererType = this.pendingRendererType
      this.pendingRenderer = null
      this.pendingRendererType = null
      this.pendingAttach = null
      this.behavior = initBehaviorFor(this.rendererType)
      this.currentAnim = ''
      return
    }
    this.renderer.commitSwap()
    this.behavior = initBehaviorFor(this.rendererType)
    this.currentAnim = ''
  }
```

Replace the body of `private tick(): void` (everything from `const contextSignal = ...` through the end of the method) with:

```ts
  private tick(): void {
    const now = performance.now()
    const dtMs = now - this.lastTs
    this.lastTs = now

    const contextSignal = this.pendingContextSignal
    this.pendingContextSignal = null

    let event = this.pending.shift()
    if (event === 'pickup') this.pendingReaction = 'drag' // 拖起 → drag 台词
    // 久坐提醒/应用焦点感知命中且宠物在睡：同一 tick 内强制叫醒，避免下一 tick 的
    // wokeUp 派生把更具体的台词覆盖成通用 wake 台词（见设计文档 §7 时序陷阱）。
    if ((contextSignal === 'break_reminder' || contextSignal === 'app_focus') && this.behavior.ctx.state === 'sleep') event = 'wake'

    const prevState = this.behavior.ctx.state
    let animation: string
    let moveX = 0
    let moveY = 0
    if (this.behavior.kind === 'sprite') {
      const { ctx, effects } = step(this.behavior.ctx, {
        dtMs,
        event,
        bounds: this.workArea,
        windowX: this.windowX,
        windowWidth: this.windowWidth,
        windowY: this.windowY,
        windowHeight: this.windowHeight,
        rng: Math.random
      })
      this.behavior = { kind: 'sprite', ctx }
      animation = effects.animation
      moveX = effects.moveX
      moveY = effects.moveY
    } else {
      const { ctx, effects } = stepLive2D(this.behavior.ctx, { dtMs, event, rng: Math.random })
      this.behavior = { kind: 'live2d', ctx }
      animation = effects.animation
    }

    if (animation !== this.currentAnim) {
      // Re-sync the predicted windowX from the true OS position at each walk
      // start, so drift accumulated over the session doesn't skew edge-clamping.
      const startedWalking = animation.startsWith('walk') && !this.currentAnim.startsWith('walk')
      this.renderer.playState(animation)
      this.currentAnim = animation
      if (startedWalking) void this.syncBounds().catch((err) => console.warn('syncBounds failed', err))
    }
    if (moveX !== 0 || moveY !== 0) {
      // clamp:true — autonomous walk stays on-screen (main enforces the edge).
      this.windowX += moveX // optimistic; corrected below once main replies
      this.windowY += moveY
      void window.petApi.moveWindow({ dx: moveX, dy: moveY, clamp: true }).then((result) => {
        if (!result) return
        // Main is authoritative (it clamps against the live, per-tick display
        // work area). Re-sync every tick — not just at walk-start — so a
        // boundary the renderer didn't know about (e.g. a neighboring monitor
        // with a different work area) is caught within one tick instead of
        // silently drifting for the rest of the walk.
        this.windowX = result.window.x
        this.windowY = result.window.y
        this.workArea = result.workArea
        this.windowWidth = result.window.width
        this.windowHeight = result.window.height
      })
    }

    // 反应规划器:每 tick 一个触发。优先级:主进程情境信号 > 睡→醒(wake)派生 > 手势触发(poke/drag)。
    const wokeUp = prevState === 'sleep' && this.behavior.ctx.state !== 'sleep'
    const trigger: ReactionTrigger | undefined =
      contextSignal ?? (wokeUp ? 'wake' : (this.pendingReaction ?? undefined))
    this.pendingReaction = null
    const sleeping = this.behavior.ctx.state === 'sleep'
    const r = stepReaction(this.reactionCtx, {
      dtMs,
      trigger,
      pausedByDialog: this.behavior.ctx.paused,
      sleeping,
      nowMs: Date.now(),
      rng: Math.random
    })
    this.reactionCtx = r.ctx
    if (r.output.speak) window.petApi.petSpeak(r.output.speak)
  }
```

No other methods change — `start`, `stop`, `prepareReload`, `discardReload`, `setVisible`, `hitTest`, `send`, `poke`, `receiveContextSignal`, `syncBounds` are untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/renderer/petController.test.ts`
Expected: PASS — all cases green, including the pre-existing hot-swap suite (unaffected by this change).

- [ ] **Step 5: Run the full test suite**

Run: `pnpm test`
Expected: PASS — no regressions in `petBrain.test.ts`, `live2dPetBrain.test.ts`, or any other suite.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors. In particular, confirm `Live2DBrainCtx` genuinely has no `dir`/`dwellMs`/`moveX`/`moveY` — if TypeScript ever needs a cast or `as any` anywhere in `petController.ts` to make the union work, that's a design smell to flag, not silently paper over.

- [ ] **Step 7: Confirm `petBrain.ts`/`petBrain.test.ts` are unchanged**

Run: `git diff --stat src/shared/petBrain.ts src/shared/petBrain.test.ts`
Expected: empty output (no changes).

- [ ] **Step 8: Commit**

```bash
git add src/renderer/petController.ts src/renderer/petController.test.ts
git commit -m "feat(live2d): PetController 按 rendererType 选择 sprite/live2d 行为模块"
```

---

## Self-Review Notes (for the plan author, not a task step)

- Spec §1 (state/field design) → Task 1. Spec §2 (`PetController` changes) → Task 2. Spec §3 (test strategy) → covered by both tasks' test steps; the "petBrain.ts 不改动" requirement is enforced by Task 2 Step 7's explicit `git diff` check plus the Global Constraints line.
- `reactionPlanner.ts`'s `stepReaction()` signature (`pausedByDialog`, `sleeping`) is unchanged — Task 2 only changes what expression is passed in, not the function itself, satisfying the non-goal.
