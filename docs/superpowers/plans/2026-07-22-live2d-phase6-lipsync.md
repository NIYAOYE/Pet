# Live2D Phase 6 · TTS 口型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Live2D 宠物说话时嘴巴按实际语音音量开合(RMS 包络驱动 `setLipSync()`),不说话/停止/打断/切宠物时平滑归零。

**Architecture:** 新增一个纯函数模块(`lipSyncEnvelope.ts`)在解码 PCM 时预计算窗口化 RMS 包络;`pcmPlayer.ts` 记录每个正在播放的音频块的 `{startAt, durationS, envelope}`,暴露 `getCurrentLevel()` 按 `AudioContext.currentTime` 查表;渲染进程新增一个独立的 `requestAnimationFrame` 循环,每帧读当前包络值、过 attack/release 平滑器、经 `PetController.setLipSync()` 转发给 `Live2DPetRenderer.setLipSync()`(Phase 4 已有实现,无需改)。

**Tech Stack:** TypeScript, Vitest, Web Audio API (`AudioContext`/`AudioBufferSourceNode`,已在用)。

## Global Constraints

- 不新增依赖;不修改 `package.json`。
- `pnpm typecheck`/`pnpm test` 全程保持通过;涉及渲染进程改动后必须 `pnpm dev` 或 `pnpm preview` 配合真实语音播放真机验证(自动化检查过不代表能跑,音量/开合手感这类真机验收无法自动化)。
- 纯逻辑(`lipSyncEnvelope.ts`)必须先写失败的 Vitest 再实现(TDD)。
- 不要给 `package.json` 加 `"type": "module"`。
- 每个任务结束后提交一次(conventional commit,中文描述)。
- 设计依据:`docs/superpowers/specs/2026-07-22-live2d-phase6-mouse-lipsync-preview-design.md` §3。

---

### Task 1: 口型包络纯函数模块 `lipSyncEnvelope.ts`

**Files:**
- Create: `src/renderer/voice/lipSyncEnvelope.ts`
- Test: `src/renderer/voice/lipSyncEnvelope.test.ts`

**Interfaces:**
- Produces:
  - `computeEnvelope(pcm: Float32Array, sampleRate: number, windowMs: number, gain?: number): number[]`
  - `createLipSyncSmoother(attackMs: number, releaseMs: number): LipSyncSmoother`,其中 `interface LipSyncSmoother { step(target: number, dtMs: number): number }`
  - `export const LIP_SYNC_WINDOW_MS = 20`
  - `export const DEFAULT_LIP_SYNC_ATTACK_MS = 60`
  - `export const DEFAULT_LIP_SYNC_RELEASE_MS = 150`
- Consumes: 无(纯函数,不依赖其他任务)。

- [ ] **Step 1: 写失败的测试**

创建 `src/renderer/voice/lipSyncEnvelope.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeEnvelope, createLipSyncSmoother } from './lipSyncEnvelope'

describe('computeEnvelope', () => {
  it('全静音(全 0)数组 → 包络全 0', () => {
    const pcm = new Float32Array(2000) // 全 0
    const envelope = computeEnvelope(pcm, 16000, 20) // 16000Hz, 20ms/窗 = 320 采样/窗
    expect(envelope.every((v) => v === 0)).toBe(true)
  })

  it('窗口数量按采样数/每窗采样数向上取整', () => {
    const pcm = new Float32Array(321) // 320 采样/窗(16000Hz*20ms/1000),多 1 个采样落入第 2 窗
    const envelope = computeEnvelope(pcm, 16000, 20)
    expect(envelope.length).toBe(2)
  })

  it('恒定振幅 1.0 的信号,RMS*gain 被 clamp 到 1', () => {
    const pcm = new Float32Array(320).fill(1)
    const envelope = computeEnvelope(pcm, 16000, 20, 4) // gain=4,rms=1 → 1*4 clamp 到 1
    expect(envelope[0]).toBe(1)
  })

  it('低振幅信号:RMS*gain 未超过 1 时不 clamp,按比例反映音量', () => {
    const pcm = new Float32Array(320).fill(0.1)
    const envelope = computeEnvelope(pcm, 16000, 20, 4) // rms=0.1, *4 = 0.4
    expect(envelope[0]).toBeCloseTo(0.4, 5)
  })
})

describe('createLipSyncSmoother', () => {
  it('目标从 0 跳到 1:多次 step 后单调上升且不超过 1', () => {
    const s = createLipSyncSmoother(60, 150)
    let prev = 0
    let level = 0
    for (let i = 0; i < 20; i++) {
      level = s.step(1, 16)
      expect(level).toBeGreaterThanOrEqual(prev)
      expect(level).toBeLessThanOrEqual(1)
      prev = level
    }
    expect(level).toBeGreaterThan(0.9) // 足够多次迭代后应接近目标
  })

  it('目标从 1 跳到 0:多次 step 后单调下降且不低于 0', () => {
    const s = createLipSyncSmoother(60, 150)
    for (let i = 0; i < 50; i++) s.step(1, 16) // 先升到接近 1
    let prev = 1
    let level = 1
    for (let i = 0; i < 30; i++) {
      level = s.step(0, 16)
      expect(level).toBeLessThanOrEqual(prev)
      expect(level).toBeGreaterThanOrEqual(0)
      prev = level
    }
    expect(level).toBeLessThan(0.1)
  })

  it('attackMs 越小,同样 dt 下向上追目标的速度越快(alpha 越大)', () => {
    const fast = createLipSyncSmoother(10, 150)
    const slow = createLipSyncSmoother(300, 150)
    const fastLevel = fast.step(1, 16)
    const slowLevel = slow.step(1, 16)
    expect(fastLevel).toBeGreaterThan(slowLevel)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/renderer/voice/lipSyncEnvelope.test.ts`
Expected: FAIL(`Cannot find module './lipSyncEnvelope'` 或类似,因为文件还不存在)

- [ ] **Step 3: 实现 `lipSyncEnvelope.ts`**

创建 `src/renderer/voice/lipSyncEnvelope.ts`:

```ts
export const LIP_SYNC_WINDOW_MS = 20
export const DEFAULT_LIP_SYNC_ATTACK_MS = 60
export const DEFAULT_LIP_SYNC_RELEASE_MS = 150

/** 把一段 PCM 按固定时长窗口切片,每窗算 RMS 后乘 gain 并 clamp 到 [0,1]，
 *  产出与嘴部开合大致对应的数值序列。纯函数：不依赖 AudioContext，可直接喂数组测试。 */
export function computeEnvelope(pcm: Float32Array, sampleRate: number, windowMs: number, gain = 4): number[] {
  const samplesPerWindow = Math.max(1, Math.round((sampleRate * windowMs) / 1000))
  const windowCount = Math.ceil(pcm.length / samplesPerWindow)
  const envelope: number[] = []
  for (let w = 0; w < windowCount; w++) {
    const start = w * samplesPerWindow
    const end = Math.min(start + samplesPerWindow, pcm.length)
    let sumSquares = 0
    for (let i = start; i < end; i++) sumSquares += pcm[i] * pcm[i]
    const rms = Math.sqrt(sumSquares / (end - start))
    envelope.push(Math.min(1, rms * gain))
  }
  return envelope
}

export interface LipSyncSmoother {
  /** 把当前值向 target 推进一步,dtMs 是距上次调用的时间差。attack(target 更大时)和
   *  release(target 更小时)用不同的时间常数,分别对应嘴巴张开更快、闭合更慢的手感。 */
  step(target: number, dtMs: number): number
}

/** 指数逼近平滑器:每步按 `1 - e^(-dt/tau)` 的比例向目标靠近,tau 越小追得越快。
 *  attackMs 控制"目标增大"时的追赶速度,releaseMs 控制"目标减小"时的追赶速度。 */
export function createLipSyncSmoother(attackMs: number, releaseMs: number): LipSyncSmoother {
  let level = 0
  return {
    step(target: number, dtMs: number): number {
      const tau = target > level ? attackMs : releaseMs
      const alpha = tau <= 0 ? 1 : 1 - Math.exp(-dtMs / tau)
      level += (target - level) * alpha
      return level
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/renderer/voice/lipSyncEnvelope.test.ts`
Expected: PASS(7 个测试全绿)

- [ ] **Step 5: 提交**

```bash
git add src/renderer/voice/lipSyncEnvelope.ts src/renderer/voice/lipSyncEnvelope.test.ts
git commit -m "feat(live2d): 新增口型 RMS 包络与 attack/release 平滑纯函数模块"
```

---

### Task 2: `pcmPlayer.ts` 记录播放中的包络块,暴露 `getCurrentLevel()`

**Files:**
- Modify: `src/renderer/voice/pcmPlayer.ts`(现有全文见下方"当前实现"）

**Interfaces:**
- Consumes: Task 1 的 `computeEnvelope`、`LIP_SYNC_WINDOW_MS`。
- Produces: `PcmPlayer.getCurrentLevel(): number`——main.ts 的 rAF 驱动循环(Task 4)会调用这个方法。

当前 `src/renderer/voice/pcmPlayer.ts` 全文:

```ts
import { createPlaybackScheduler } from './playbackScheduler'

export interface PcmPlayer {
  /** 解码一段 base64 float32 PCM 并排队播放,与之前的块无缝衔接。 */
  play(audioBase64: string, sampleRate: number): void
  /** 立即停止所有已排队/正在播放的音频。 */
  stop(): void
}

export function createPcmPlayer(): PcmPlayer {
  const ctx = new AudioContext()
  const scheduler = createPlaybackScheduler()
  let sources: AudioBufferSourceNode[] = []

  function decode(audioBase64: string, sampleRate: number): AudioBuffer {
    const raw = atob(audioBase64)
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    const floats = new Float32Array(bytes.buffer)
    const buffer = ctx.createBuffer(1, floats.length, sampleRate)
    buffer.copyToChannel(floats, 0)
    return buffer
  }

  return {
    play(audioBase64: string, sampleRate: number): void {
      const buffer = decode(audioBase64, sampleRate)
      const startAt = scheduler.scheduleNext(ctx.currentTime, buffer.duration)
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.connect(ctx.destination)
      src.start(startAt)
      sources.push(src)
      src.onended = () => { sources = sources.filter((s) => s !== src) }
    },
    stop(): void {
      for (const s of sources) { try { s.stop() } catch { /* 已经播完的节点 stop() 会抛,忽略 */ } }
      sources = []
    }
  }
}
```

（因为这个文件依赖真实 `AudioContext`,项目里一直没有给它写 Vitest——沿用这个既有先例,本任务不新增 `pcmPlayer.test.ts`，靠 Task 1 已经测过的纯函数 + Task 5 的真机验收兜底。）

- [ ] **Step 1: 修改 `decode()` 返回值同时带出 Float32Array(算包络要用原始 PCM,不能从 `AudioBuffer` 反查)**

```ts
import { createPlaybackScheduler } from './playbackScheduler'
import { computeEnvelope, LIP_SYNC_WINDOW_MS } from './lipSyncEnvelope'

export interface PcmPlayer {
  /** 解码一段 base64 float32 PCM 并排队播放,与之前的块无缝衔接。 */
  play(audioBase64: string, sampleRate: number): void
  /** 立即停止所有已排队/正在播放的音频。 */
  stop(): void
  /** 当前播放时刻(AudioContext.currentTime)对应的音量包络值,0~1；没有任何块覆盖
   *  当前时刻(未播放/已播完/已 stop)时返回 0。 */
  getCurrentLevel(): number
}

interface ActiveChunk { startAt: number; durationS: number; envelope: number[] }

export function createPcmPlayer(): PcmPlayer {
  const ctx = new AudioContext()
  const scheduler = createPlaybackScheduler()
  let sources: AudioBufferSourceNode[] = []
  let activeChunks: ActiveChunk[] = []

  function decode(audioBase64: string, sampleRate: number): { buffer: AudioBuffer; floats: Float32Array } {
    const raw = atob(audioBase64)
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    const floats = new Float32Array(bytes.buffer)
    const buffer = ctx.createBuffer(1, floats.length, sampleRate)
    buffer.copyToChannel(floats, 0)
    return { buffer, floats }
  }

  return {
    play(audioBase64: string, sampleRate: number): void {
      const { buffer, floats } = decode(audioBase64, sampleRate)
      const startAt = scheduler.scheduleNext(ctx.currentTime, buffer.duration)
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.connect(ctx.destination)
      src.start(startAt)
      sources.push(src)
      const chunk: ActiveChunk = { startAt, durationS: buffer.duration, envelope: computeEnvelope(floats, sampleRate, LIP_SYNC_WINDOW_MS) }
      activeChunks.push(chunk)
      src.onended = () => {
        sources = sources.filter((s) => s !== src)
        activeChunks = activeChunks.filter((c) => c !== chunk)
      }
    },
    stop(): void {
      for (const s of sources) { try { s.stop() } catch { /* 已经播完的节点 stop() 会抛,忽略 */ } }
      sources = []
      activeChunks = []
    },
    getCurrentLevel(): number {
      const now = ctx.currentTime
      const chunk = activeChunks.find((c) => now >= c.startAt && now < c.startAt + c.durationS)
      if (!chunk) return 0
      const windowSec = LIP_SYNC_WINDOW_MS / 1000
      const index = Math.min(Math.floor((now - chunk.startAt) / windowSec), chunk.envelope.length - 1)
      return chunk.envelope[index]
    }
  }
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 通过,无新增类型错误

- [ ] **Step 3: 提交**

```bash
git add src/renderer/voice/pcmPlayer.ts
git commit -m "feat(live2d): pcmPlayer 记录播放块的口型包络,新增 getCurrentLevel()"
```

---

### Task 3: `PetController.setLipSync()` 代理方法

**Files:**
- Modify: `src/renderer/petController.ts`
- Modify: `src/renderer/petController.test.ts`

**Interfaces:**
- Consumes: `PetRenderer.setLipSync(level: number): void`(Phase 4 已有,接口不变)。
- Produces: `PetController.setLipSync(level: number): void`——main.ts 的 rAF 循环(Task 4)调用这个方法,不直接持有 renderer 引用。

- [ ] **Step 1: 在 `petController.test.ts` 里给 fake renderer 加一个可观察的 `setLipSync`,并写失败的测试**

`src/renderer/petController.test.ts` 第 1-37 行当前是:

```ts
import { describe, it, expect, vi } from 'vitest'
import { PetController } from './petController'
import type { PetRenderer, PetHitResult } from './petRenderer'
import type { PetRenderSource } from '@shared/petPackage'

function makeFakeRenderer(): PetRenderer & {
  destroyed: boolean
  loadedWith: PetRenderSource[]
  prepareSwapWith: PetRenderSource[]
  commitSwapCalled: boolean
  discardSwapCalled: boolean
  shouldFailPrepare?: boolean
} {
  const loadedWith: PetRenderSource[] = []
  const prepareSwapWith: PetRenderSource[] = []
  return {
    destroyed: false,
    loadedWith,
    prepareSwapWith,
    commitSwapCalled: false,
    discardSwapCalled: false,
    async load(source) { loadedWith.push(source) },
    async prepareSwap(source) {
      if (this.shouldFailPrepare) throw new Error('prepare failed')
      prepareSwapWith.push(source)
    },
    commitSwap() { this.commitSwapCalled = true },
    discardSwap() { this.discardSwapCalled = true },
    playState() {},
    setFacing() {},
    setLipSync() {},
    hitTest(): PetHitResult { return { hit: false } },
    resize() {},
    setVisible() {},
    async destroy() { this.destroyed = true }
  }
}
```

替换成(新增 `lipSyncLevels` 字段记录调用参数,供断言用):

```ts
import { describe, it, expect, vi } from 'vitest'
import { PetController } from './petController'
import type { PetRenderer, PetHitResult } from './petRenderer'
import type { PetRenderSource } from '@shared/petPackage'

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

在文件末尾追加新的 `describe` 块:

```ts
describe('PetController.setLipSync', () => {
  it('直接转发给当前 renderer.setLipSync()', () => {
    const renderer = makeFakeRenderer()
    const controller = new PetController(renderer, 'live2d', vi.fn())
    controller.setLipSync(0.7)
    expect(renderer.lipSyncLevels).toEqual([0.7])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/renderer/petController.test.ts`
Expected: FAIL(`controller.setLipSync is not a function`)

- [ ] **Step 3: 实现 `PetController.setLipSync()`**

在 `src/renderer/petController.ts` 的 `hitTest()` 方法(第 120-124 行)后面加一个新方法:

```ts
  setLipSync(level: number): void {
    this.renderer.setLipSync(level)
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/renderer/petController.test.ts`
Expected: PASS(全部既有测试 + 新增的一个测试都通过)

- [ ] **Step 5: 提交**

```bash
git add src/renderer/petController.ts src/renderer/petController.test.ts
git commit -m "feat(live2d): PetController 新增 setLipSync 代理方法"
```

---

### Task 4: `main.ts` 接入 rAF 驱动循环

**Files:**
- Modify: `src/renderer/main.ts`

**Interfaces:**
- Consumes: Task 1 的 `createLipSyncSmoother`、`DEFAULT_LIP_SYNC_ATTACK_MS`、`DEFAULT_LIP_SYNC_RELEASE_MS`;Task 2 的 `pcmPlayer.getCurrentLevel()`;Task 3 的 `controller.setLipSync()`。
- Produces: 无(这是最终接线,没有下游任务消费它)。

当前 `src/renderer/main.ts` 第 1-9 行(import 区)和第 60-88 行(`boot()` 里创建 `pcmPlayer` 及后续 IPC 接线)：

```ts
import { SpriteRenderer } from './spriteRenderer'
import { Live2DPetRenderer } from './live2dRenderer'
import { PetController } from './petController'
import { createPcmPlayer } from './voice/pcmPlayer'
import type { PetRenderer } from './petRenderer'
import type { PetRenderSource } from '@shared/petPackage'
```

```ts
  await controller.start()
  const pcmPlayer = createPcmPlayer()
  window.petApi.onPetEvent((event) => {
    controller.send(event)
    // 新消息发送即打断正在朗读的语音(参照 opts.emitPetEvent('messageSent') 的既有约定)。
    if (event === 'messageSent') pcmPlayer.stop()
  })
  window.petApi.onContextSignal((kind) => controller.receiveContextSignal(kind))
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
  window.voiceApi.onAudioChunk((c) => pcmPlayer.play(c.audioBase64, c.sampleRate))
  window.voiceApi.onAudioError((message) => console.warn('[voice]', message))
  window.voiceApi.onPlaybackStop(() => pcmPlayer.stop())
```

- [ ] **Step 1: 加 import**

在第 4 行 `import { createPcmPlayer } from './voice/pcmPlayer'` 后面加一行:

```ts
import { createLipSyncSmoother, DEFAULT_LIP_SYNC_ATTACK_MS, DEFAULT_LIP_SYNC_RELEASE_MS } from './voice/lipSyncEnvelope'
```

- [ ] **Step 2: 在 `window.voiceApi.onPlaybackStop(() => pcmPlayer.stop())` 这行之后加驱动循环**

```ts
  window.voiceApi.onPlaybackStop(() => pcmPlayer.stop())

  // 口型驱动循环:与 PetController 的 33ms 业务 tick 解耦,用 rAF 跟渲染帧率对齐。
  // 没有语音播放时 pcmPlayer.getCurrentLevel() 恒返回 0,smoother 很快收敛到 0 不再变化,
  // 常驻运行的代价可以忽略——不需要在 TTS 开关/播放状态变化时单独启停这个循环。
  const lipSyncSmoother = createLipSyncSmoother(DEFAULT_LIP_SYNC_ATTACK_MS, DEFAULT_LIP_SYNC_RELEASE_MS)
  let lastLipSyncTickMs = performance.now()
  function tickLipSync(): void {
    const now = performance.now()
    const dtMs = now - lastLipSyncTickMs
    lastLipSyncTickMs = now
    const level = lipSyncSmoother.step(pcmPlayer.getCurrentLevel(), dtMs)
    controller.setLipSync(level)
    requestAnimationFrame(tickLipSync)
  }
  requestAnimationFrame(tickLipSync)
```

- [ ] **Step 3: 类型检查**

Run: `pnpm typecheck`
Expected: 通过

- [ ] **Step 4: 真机验证(自动化检查不能替代)**

```bash
pnpm preview
```

用一只已配置好语音(TTS 已启用、`voice/` 就位)的 Live2D 宠物,让它说一段话,目视确认:

- 说话时嘴巴随音量开合,不是恒定张着或恒定闭着。
- 停止说话(播放正常结束)后嘴巴平滑合上,不是瞬间跳变。
- 发新消息打断正在说话时(`messageSent` 触发 `pcmPlayer.stop()`),嘴巴也平滑合上。
- 没有配置口型参数(`interaction.lipSyncParameter` 在模型里找不到对应参数)的宠物:说话时不报错,嘴巴不动,Talk 动作正常播放(验证"没有口型参数时只播放 Talk Motion"这条设计要求)。
- 未开启 TTS 的宠物:全程不出现随机张嘴(验证"TTS 未启用时不生成随机假口型")。

如果嘴巴开合幅度太小/太大,回到 Task 1 调整 `computeEnvelope()` 的默认 `gain`(当前 4)重新验证,不需要改接口。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/main.ts
git commit -m "feat(live2d): main.ts 接入 rAF 口型驱动循环"
```

---

## 完成后

四个任务全部完成、真机验证通过后,这份计划的工作就结束了。三份 Phase 6 计划(本计划 + 鼠标追踪 + 导入预览)在同一个开发分支里一次性跑完,不在中间合并——完成本计划后继续下一份计划的任务,不要在这里执行 `finishing-a-development-branch`。
