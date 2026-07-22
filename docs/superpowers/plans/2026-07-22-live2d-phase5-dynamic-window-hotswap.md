# Live2D Phase 5:动态窗口/锚点/命中/无闪烁热切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Live2D 宠物包的窗口尺寸从硬编码 `256×288` 改为按 `pet.json` 动态夹取,热切换(同类型/跨类型)从"必定可见闪烁+主进程先切会话"改造为无闪烁的准备-提交协议,并接上此前定义但从未真正驱动的场景帧率节流。

**Architecture:** `PetRenderer` 接口新增 `prepareSwap/commitSwap/discardSwap` 三段式;`PetController` 按渲染器类型分叉调用(同类型走三段式,跨类型走"新建 detached canvas+渲染器实例、成功后再挂 DOM");主进程 `switchPet()` 改造为"先让渲染层准备好、确认成功后才提交会话切换"的握手协议(新增 `PET_PREPARE/PET_PREPARE_RESULT/PET_COMMIT/PET_DISCARD` 四个 IPC 通道)。窗口尺寸夹取、脚底锚点保持、气泡锚点泛化均为纯函数,可独立单测;涉及真实 Pixi/WebGL/Electron 窗口的部分(两个具体渲染器的 `prepareSwap/commitSwap`、`main.ts` 的 canvas 编排、`index.ts` 的 `switchPet()`)沿用项目既有惯例——不写 mock 引擎单测,靠 `pnpm dev`/`preview` 真机验证。

**Tech Stack:** TypeScript(strict)、Electron(CJS 主进程/preload)、pixi.js@8 + untitled-pixi-live2d-engine、Vitest。

## Global Constraints

- 不加 `"type": "module"` 到 `package.json`(会让 Electron 主进程崩)。
- 每个任务改完,该任务自己新增/修改的 `pnpm vitest run` 用例必须全部通过。`pnpm typecheck` 只要求**到 Task 14 完成时**整仓库全绿——Task 5 到 Task 13 是一条跨文件的强耦合接口迁移链(IPC 通道改名/`PetRenderer` 接口新增方法/两个具体渲染器/`PetController`/`main.ts`/`petWindow.ts`/`switchPet()`),这段范围内单个任务提交后 `pnpm typecheck` 报错是**预期行为**,每个任务的步骤里已经写明"预期报错,下一个任务会修"的具体位置——这不是任务未完成,是接口先行、消费方逐个跟进的刻意分段,任务审查时按这条判断,不要把"整仓库编译不过"当成这些任务本身的缺陷。
- 涉及主进程/preload/渲染层/窗口的改动,在"真机验收"步骤里明确写出需要 `pnpm dev`/`pnpm preview` 肉眼确认的点,不谎称已用自动化验证。
- 提交粒度:每个任务一次提交,conventional commit(`feat(scope): ...`/`refactor(scope): ...`),commit message 用中文。
- 精灵包(sprite)窗口尺寸继续等于 `manifest.sheet.cellWidth × cellHeight`,不参与本阶段新增的夹取/脚底锚点体系(仅气泡锚点的默认值来自精灵包隐含行为,行为不变)。
- 本阶段依据的设计文档:`docs/superpowers/specs/2026-07-21-live2d-phase5-dynamic-window-hotswap-design.md`。

---

## Task 1: 窗口尺寸夹取 + 脚底锚点保持 + 尺寸来源统一(纯函数)

**Files:**
- Modify: `src/shared/windowPlacement.ts`
- Test: `src/shared/windowPlacement.test.ts`(新建)

**Interfaces:**
- Consumes: `Bounds`(`@shared/petBrain`,已存在:`{x,y,width,height}`)、`Live2DViewport`(`@shared/petPackage`,已存在:`{width,height,resolutionCap}`)、`PetRenderSource`(`@shared/petPackage`,已存在的判别联合)。
- Produces:`clampLive2DViewport(viewport: Live2DViewport): {width:number; height:number}`、`footAnchorPreservingBounds(oldBounds: Bounds, newSize: {width:number;height:number}, workArea: Bounds): Bounds`、`windowSizeForSource(source: PetRenderSource): {width:number; height:number}` —— 后续任务(Task 8 的 `Live2DPetRenderer`、Task 13/14 的 `index.ts`)都会 `import { clampLive2DViewport, footAnchorPreservingBounds, windowSizeForSource, clamp, fixedWindowBounds, isZeroMove } from '@shared/windowPlacement'`。

- [ ] **Step 1: 写失败的测试**

创建 `src/shared/windowPlacement.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { clamp, fixedWindowBounds, isZeroMove, clampLive2DViewport, footAnchorPreservingBounds, windowSizeForSource } from './windowPlacement'
import type { PetRenderSource } from './petPackage'

describe('clampLive2DViewport', () => {
  it('落在范围内的尺寸原样返回', () => {
    expect(clampLive2DViewport({ width: 360, height: 480, resolutionCap: 1.5 })).toEqual({ width: 360, height: 480 })
  })
  it('小于最小值时夹到最小 192x256', () => {
    expect(clampLive2DViewport({ width: 100, height: 100, resolutionCap: 1.5 })).toEqual({ width: 192, height: 256 })
  })
  it('大于最大值时夹到最大 800x900', () => {
    expect(clampLive2DViewport({ width: 2000, height: 2000, resolutionCap: 1.5 })).toEqual({ width: 800, height: 900 })
  })
  it('宽高各自独立夹取,不保持原始宽高比', () => {
    expect(clampLive2DViewport({ width: 100, height: 480, resolutionCap: 1.5 })).toEqual({ width: 192, height: 480 })
  })
})

describe('footAnchorPreservingBounds', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 }

  it('尺寸不变时脚底中心点(水平中心/底边)绝对坐标不变', () => {
    const oldBounds = { x: 100, y: 100, width: 360, height: 480 }
    const result = footAnchorPreservingBounds(oldBounds, { width: 360, height: 480 }, workArea)
    expect(result).toEqual(oldBounds)
  })

  it('切到更高的模型时,脚底(底边中心)绝对坐标保持不变,窗口向上扩展', () => {
    const oldBounds = { x: 100, y: 500, width: 360, height: 480 } // 脚底中心 = (280, 980)
    const result = footAnchorPreservingBounds(oldBounds, { width: 360, height: 700 }, workArea)
    // 新脚底中心 = (result.x + 180, result.y + 700) 应仍等于 (280, 980)
    expect(result.x + 180).toBe(280)
    expect(result.y + 700).toBe(980)
    expect(result.width).toBe(360)
    expect(result.height).toBe(700)
  })

  it('结果始终被夹进 workArea 内(超出工作区时夹取,不越界)', () => {
    const oldBounds = { x: 10, y: 10, width: 360, height: 480 } // 脚底中心 y = 490,顶部很靠近工作区上边缘
    const result = footAnchorPreservingBounds(oldBounds, { width: 360, height: 900 }, workArea)
    expect(result.y).toBeGreaterThanOrEqual(workArea.y)
    expect(result.x).toBeGreaterThanOrEqual(workArea.x)
    expect(result.x + result.width).toBeLessThanOrEqual(workArea.x + workArea.width)
    expect(result.y + result.height).toBeLessThanOrEqual(workArea.y + workArea.height)
  })
})

describe('windowSizeForSource', () => {
  it('sprite 包:窗口尺寸 = sheet 格子尺寸,不夹取', () => {
    const source: PetRenderSource = {
      type: 'sprite',
      manifest: { id: 'x', displayName: 'x', description: '', spritesheetPath: 'x', sheet: { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 }, animations: { idle: { row: 0, frames: 1, fps: 1, loop: true } } },
      spritesheetDataUrl: 'data:x'
    }
    expect(windowSizeForSource(source)).toEqual({ width: 192, height: 208 })
  })

  it('live2d 包:窗口尺寸 = 夹取后的 render.viewport', () => {
    const source: PetRenderSource = {
      type: 'live2d',
      manifest: {
        schemaVersion: 2, id: 'x', displayName: 'x', description: '',
        render: {
          type: 'live2d', model: 'model/x.model3.json',
          viewport: { width: 2000, height: 480, resolutionCap: 1.5 },
          transform: { scale: 1, offsetX: 0, offsetY: 0, anchorX: 0.5, anchorY: 1, bubbleAnchorX: 0.5, bubbleAnchorY: 0 },
          interaction: { mirrorOnWalk: true, mouseTracking: true, lipSyncParameter: 'ParamMouthOpenY' },
          stateMap: {}
        }
      },
      resourceBaseUrl: 'kibo-pet://tok/'
    }
    expect(windowSizeForSource(source)).toEqual({ width: 800, height: 480 })
  })
})

describe('fixedWindowBounds / isZeroMove / clamp(既有,回归)', () => {
  it('fixedWindowBounds 仍然四舍五入 x/y、透传 size', () => {
    expect(fixedWindowBounds(1.6, 2.4, { width: 100, height: 200 })).toEqual({ x: 2, y: 2, width: 100, height: 200 })
  })
  it('isZeroMove 仍然按 dx/dy 判断', () => {
    expect(isZeroMove({ dx: 0, dy: 0 })).toBe(true)
    expect(isZeroMove({ dx: 1, dy: 0 })).toBe(false)
  })
  it('clamp 仍然夹在 [min,max]', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-5, 0, 10)).toBe(0)
    expect(clamp(50, 0, 10)).toBe(10)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/shared/windowPlacement.test.ts`
Expected: FAIL,报 `clampLive2DViewport`/`footAnchorPreservingBounds`/`windowSizeForSource` 不存在。

- [ ] **Step 3: 实现**

把 `src/shared/windowPlacement.ts` 改成:

```ts
import type { Bounds } from './petBrain'
import type { Live2DViewport, PetRenderSource } from './petPackage'

export interface FixedSize {
  width: number
  height: number
}

export function fixedWindowBounds(x: number, y: number, size: FixedSize): Bounds {
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: size.width,
    height: size.height
  }
}

export function isZeroMove(delta: { dx: number; dy: number }): boolean {
  return delta.dx === 0 && delta.dy === 0
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

const LIVE2D_VIEWPORT_MIN = { width: 192, height: 256 }
const LIVE2D_VIEWPORT_MAX = { width: 800, height: 900 }

/** Live2D 包窗口尺寸的夹取范围,见主设计文档 §9。宽高各自独立夹取,不保持原始宽高比——
 *  夹取的目的是避免窗口过小/过大,不是等比缩放。 */
export function clampLive2DViewport(viewport: Live2DViewport): FixedSize {
  return {
    width: clamp(viewport.width, LIVE2D_VIEWPORT_MIN.width, LIVE2D_VIEWPORT_MAX.width),
    height: clamp(viewport.height, LIVE2D_VIEWPORT_MIN.height, LIVE2D_VIEWPORT_MAX.height)
  }
}

const FOOT_ANCHOR = { x: 0.5, y: 1.0 } // 窗口内容区的水平中心、底部边缘,与 autoFit 的"贴底居中"惯例一致

/** 窗口尺寸变化(热切换/首次加载)时保持脚底锚点在屏幕上的绝对位置不跳动,再夹进当前
 *  显示器工作区。只在尺寸真正变化时调用一次,不参与逐帧拖拽路径(拖拽路径继续只用
 *  setPosition,见 Phase 5 设计文档 §4)。仅对 Live2D 包生效。 */
export function footAnchorPreservingBounds(oldBounds: Bounds, newSize: FixedSize, workArea: Bounds): Bounds {
  const anchorAbsX = oldBounds.x + FOOT_ANCHOR.x * oldBounds.width
  const anchorAbsY = oldBounds.y + FOOT_ANCHOR.y * oldBounds.height
  const rawX = anchorAbsX - FOOT_ANCHOR.x * newSize.width
  const rawY = anchorAbsY - FOOT_ANCHOR.y * newSize.height
  const x = clamp(rawX, workArea.x, workArea.x + workArea.width - newSize.width)
  const y = clamp(rawY, workArea.y, workArea.y + workArea.height - newSize.height)
  return { x, y, ...newSize }
}

/** 宠物窗口尺寸的单一数据源:sprite 包 = sheet 格子尺寸(不夹取,行为与现状字节对齐);
 *  live2d 包 = 夹取后的 render.viewport。取代此前主进程/渲染层各自硬编码的 256×288。 */
export function windowSizeForSource(source: PetRenderSource): FixedSize {
  if (source.type === 'sprite') {
    return { width: source.manifest.sheet.cellWidth, height: source.manifest.sheet.cellHeight }
  }
  return clampLive2DViewport(source.manifest.render.viewport)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/shared/windowPlacement.test.ts`
Expected: PASS,全部用例通过。

- [ ] **Step 5: typecheck**

Run: `pnpm typecheck`
Expected: 无新增错误(此文件目前被 `src/main/shell/index.ts` 引用 `fixedWindowBounds`/`isZeroMove`/`clamp`,签名未变,不应破坏现有调用方)。

- [ ] **Step 6: Commit**

```bash
git add src/shared/windowPlacement.ts src/shared/windowPlacement.test.ts
git commit -m "feat(shared): 新增 Live2D 窗口尺寸夹取/脚底锚点保持/统一尺寸来源纯函数"
```

---

## Task 2: 气泡锚点泛化(`bubblePlacement` 新增 `anchorFrac` 参数)

**Files:**
- Modify: `src/shared/bubblePlacement.ts`
- Test: `src/shared/bubblePlacement.test.ts`(新建 —— 目前不存在,需要新建覆盖既有行为 + 新参数)

**Interfaces:**
- Consumes: 无新依赖。
- Produces:`bubblePlacement(pet: Bounds, workArea: Bounds, bubble: {width,height}, anchorFrac?: {x:number;y:number}): BubblePlacement` —— Task 13 的 `index.ts` 会在调用 `bubbleController.show/reposition` 前算好 `anchorFrac` 并往下传(通过 `bubbleWindow.ts` 的 `BubbleController` 方法签名,若需要一并调整,见 Task 13 说明)。

- [ ] **Step 1: 写失败的测试**

创建 `src/shared/bubblePlacement.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { bubblePlacement } from './bubblePlacement'

const workArea = { x: 0, y: 0, width: 1000, height: 800 }
const bubble = { width: 200, height: 60 }

describe('bubblePlacement 默认 anchorFrac(不传第四参数)', () => {
  it('行为与此前硬编码"水平居中+贴窗口顶部"完全一致(回归)', () => {
    const pet = { x: 400, y: 300, width: 256, height: 288 }
    const result = bubblePlacement(pet, workArea, bubble)
    const expected = bubblePlacement(pet, workArea, bubble, { x: 0.5, y: 0 })
    expect(result).toEqual(expected)
    expect(result.y).toBe(pet.y - bubble.height - 8) // GAP=8,头顶放得下时贴顶部
  })
})

describe('bubblePlacement 自定义 anchorFrac(Live2D 包 bubbleAnchorX/Y)', () => {
  it('锚点从窗口顶部中心变成窗口顶部靠左时,气泡水平位置随之偏移', () => {
    const pet = { x: 400, y: 300, width: 360, height: 480 }
    const centerResult = bubblePlacement(pet, workArea, bubble, { x: 0.5, y: 0 })
    const leftResult = bubblePlacement(pet, workArea, bubble, { x: 0.2, y: 0 })
    expect(leftResult.x).toBeLessThan(centerResult.x)
  })

  it('anchorY=1(锚点在窗口底部,例如脚底)时,气泡摆在锚点上方,而不是原来假设的窗口顶部上方', () => {
    const pet = { x: 400, y: 300, width: 360, height: 480 }
    const footAnchor = bubblePlacement(pet, workArea, bubble, { x: 0.5, y: 1 })
    const topAnchor = bubblePlacement(pet, workArea, bubble, { x: 0.5, y: 0 })
    // 锚点在底部时,气泡应该比"锚点在顶部"时更靠下(y 更大),因为参照点本身更靠下
    expect(footAnchor.y).toBeGreaterThan(topAnchor.y)
  })

  it('结果 x/y 始终落在 workArea 内(既有夹取行为不受新参数影响)', () => {
    const pet = { x: -50, y: -50, width: 360, height: 480 } // 宠物被拖出工作区外
    const result = bubblePlacement(pet, workArea, bubble, { x: 0.5, y: 0 })
    expect(result.x).toBeGreaterThanOrEqual(workArea.x)
    expect(result.y).toBeGreaterThanOrEqual(workArea.y)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/shared/bubblePlacement.test.ts`
Expected: FAIL(`anchorFrac` 参数不存在,前两个"回归"用例可能碰巧因默认硬编码行为而通过,但后面几个自定义锚点用例必然 FAIL)。

- [ ] **Step 3: 实现**

把 `src/shared/bubblePlacement.ts` 改成(只替换 `petCenterX`/`pet.y` 的计算方式为通用锚点,其余摆位算法不变):

```ts
import type { Bounds } from './petBrain'

export interface BubblePlacement {
  x: number
  y: number
  tailSide: 'top' | 'bottom'
  tailOffsetX: number
}

const GAP = 8          // 气泡与宠物之间的竖直间隙
const TAIL_MARGIN = 16 // 尾巴中心离气泡左右缘的最小距离

/**
 * 计算气泡伴随窗的左上角坐标与尾巴指向。
 * `anchorFrac` 是宠物窗口内的锚点相对坐标(0..1),默认 {x:0.5,y:0}(水平居中、贴窗口顶部,
 * 与精灵包此前的隐含行为完全一致)。Live2D 包传入 render.transform.bubbleAnchorX/Y。
 * 默认放锚点头顶、水平以锚点对齐;越界时:
 *  - 头顶放不下 → 翻到锚点下方(尾巴改朝上);
 *  - 左右放不下 → 水平夹进工作区,尾巴水平偏移单独算以持续指向锚点;
 *  - 上下都放不下 → 夹进工作区(可见性优先)。
 * 输出的 x/y 始终完全落在 workArea 内。
 */
export function bubblePlacement(
  pet: Bounds,
  workArea: Bounds,
  bubble: { width: number; height: number },
  anchorFrac: { x: number; y: number } = { x: 0.5, y: 0 }
): BubblePlacement {
  const anchorX = pet.x + anchorFrac.x * pet.width
  const anchorY = pet.y + anchorFrac.y * pet.height

  // 水平:以锚点对齐,再夹进工作区
  let x = Math.round(anchorX - bubble.width / 2)
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - bubble.width))

  // 竖直:优先锚点上方,不够翻下方,再不够夹进工作区
  const aboveY = anchorY - bubble.height - GAP
  const belowY = anchorY + GAP
  let y: number
  let tailSide: 'top' | 'bottom'
  if (aboveY >= workArea.y) {
    y = aboveY
    tailSide = 'bottom'
  } else if (belowY + bubble.height <= workArea.y + workArea.height) {
    y = belowY
    tailSide = 'top'
  } else {
    y = aboveY
    tailSide = 'bottom'
  }
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - bubble.height))

  // 尾巴水平偏移:指向锚点(相对气泡左缘),夹到内边距范围内
  let tailOffsetX = Math.round(anchorX - x)
  tailOffsetX = Math.max(TAIL_MARGIN, Math.min(tailOffsetX, bubble.width - TAIL_MARGIN))

  return { x, y, tailSide, tailOffsetX }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/shared/bubblePlacement.test.ts`
Expected: PASS,全部用例通过。

- [ ] **Step 5: 确认现有调用方不受影响**

Run: `pnpm typecheck`
Expected: `src/main/shell/bubbleWindow.ts` 的 `bubblePlacement(pet, workArea, size)`(3 个参数调用)仍能编译通过(第四参数是可选的)。

- [ ] **Step 6: Commit**

```bash
git add src/shared/bubblePlacement.ts src/shared/bubblePlacement.test.ts
git commit -m "feat(shared): bubblePlacement 新增可选 anchorFrac 参数,泛化气泡锚点计算"
```

---

## Task 3: 场景帧率映射(`fpsForState`)

**Files:**
- Create: `src/renderer/live2dFps.ts`
- Test: `src/renderer/live2dFps.test.ts`

**Interfaces:**
- Consumes: `PetVisualState`(`./petRenderer`,已存在,`= string`)。
- Produces:`fpsForState(state: PetVisualState): number` —— Task 8 的 `Live2DPetRenderer.playState()` 会 `import { fpsForState } from './live2dFps'`。

- [ ] **Step 1: 写失败的测试**

创建 `src/renderer/live2dFps.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { fpsForState } from './live2dFps'

describe('fpsForState', () => {
  it('sleep → 15', () => {
    expect(fpsForState('sleep')).toBe(15)
  })
  it('idle → 30', () => {
    expect(fpsForState('idle')).toBe(30)
  })
  it('拖拽/行走/说话/动作类状态 → 60', () => {
    for (const s of ['drag', 'walk-left', 'walk-right', 'talk', 'greet', 'thinking', 'happy', 'sad', 'cry', 'surprised', 'love']) {
      expect(fpsForState(s)).toBe(60)
    }
  })
  it('未知状态默认 60(不认识的状态按"活跃"处理,不静默拖累帧率)', () => {
    expect(fpsForState('some_future_state')).toBe(60)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/renderer/live2dFps.test.ts`
Expected: FAIL,模块不存在。

- [ ] **Step 3: 实现**

创建 `src/renderer/live2dFps.ts`:

```ts
import type { PetVisualState } from './petRenderer'

/** 场景相关的 Live2D 渲染帧率策略,见主设计文档 §10。只作用于 Live2D(WebGL);
 *  精灵模式是 2D canvas 绘制,不参与。 */
export function fpsForState(state: PetVisualState): number {
  if (state === 'sleep') return 15
  if (state === 'idle') return 30
  return 60 // drag/walk-left/walk-right/talk/greet/thinking/happy/sad/cry/surprised/love,以及任何未识别的新状态
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/renderer/live2dFps.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/live2dFps.ts src/renderer/live2dFps.test.ts
git commit -m "feat(renderer): 新增场景帧率映射纯函数 fpsForState"
```

---

## Task 4: 待处理请求跟踪器(`pendingPrepareRequests`)

**Files:**
- Create: `src/main/shell/pendingPrepareRequests.ts`
- Test: `src/main/shell/pendingPrepareRequests.test.ts`

**Interfaces:**
- Consumes: 无新依赖(用注入的 `setTimeout`/`clearTimeout` 以便用假计时器测试)。
- Produces:`createPendingPrepareRequests(setTimeoutFn?, clearTimeoutFn?): PendingPrepareRequests`,其中 `interface PendingPrepareRequests { wait(requestId: string, timeoutMs: number): Promise<PrepareResult>; resolve(requestId: string, result: PrepareResult): void }`,`interface PrepareResult { ok: boolean; error?: string }` —— Task 13 的 `switchPet()` 会用它替代原来打算直接手写的 `Map`+`setTimeout` 逻辑。

**背景**:`src/main/shell/index.ts` 里的 `switchPet()` 目前没有任何自动化测试覆盖(`index.test.ts` 只测纯函数 `resolveVoiceBackend`),把"等待渲染层确认+超时兜底"这段逻辑抽成一个不依赖 Electron 的独立小模块,是这段新增逻辑里唯一能低成本获得真实单测覆盖的部分——其余 `switchPet()` 的改动仍然靠 `pnpm dev`/`preview` 真机验证(与现状一致,不是新引入的缺口)。

- [ ] **Step 1: 写失败的测试**

创建 `src/main/shell/pendingPrepareRequests.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createPendingPrepareRequests } from './pendingPrepareRequests'

describe('createPendingPrepareRequests', () => {
  it('resolve() 在超时前调用:wait() 以该结果完成,不触发超时', async () => {
    vi.useFakeTimers()
    const registry = createPendingPrepareRequests()
    const promise = registry.wait('req-1', 5000)
    registry.resolve('req-1', { ok: true })
    const result = await promise
    expect(result).toEqual({ ok: true })
    vi.useRealTimers()
  })

  it('超时未 resolve:wait() 以 MODEL_LOAD_TIMEOUT 失败结果完成', async () => {
    vi.useFakeTimers()
    const registry = createPendingPrepareRequests()
    const promise = registry.wait('req-2', 5000)
    vi.advanceTimersByTime(5000)
    const result = await promise
    expect(result).toEqual({ ok: false, error: 'MODEL_LOAD_TIMEOUT' })
    vi.useRealTimers()
  })

  it('超时之后才 resolve() 是安静的 no-op,不影响已经完成的 wait()', async () => {
    vi.useFakeTimers()
    const registry = createPendingPrepareRequests()
    const promise = registry.wait('req-3', 1000)
    vi.advanceTimersByTime(1000)
    const result = await promise
    expect(result.ok).toBe(false)
    expect(() => registry.resolve('req-3', { ok: true })).not.toThrow()
    vi.useRealTimers()
  })

  it('对不存在/未知的 requestId 调用 resolve() 是安静的 no-op', () => {
    const registry = createPendingPrepareRequests()
    expect(() => registry.resolve('never-registered', { ok: true })).not.toThrow()
  })

  it('两个并发请求互不干扰', async () => {
    vi.useFakeTimers()
    const registry = createPendingPrepareRequests()
    const p1 = registry.wait('a', 5000)
    const p2 = registry.wait('b', 5000)
    registry.resolve('b', { ok: true })
    registry.resolve('a', { ok: false, error: 'MODEL_SWITCH_FAILED' })
    expect(await p1).toEqual({ ok: false, error: 'MODEL_SWITCH_FAILED' })
    expect(await p2).toEqual({ ok: true })
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/shell/pendingPrepareRequests.test.ts`
Expected: FAIL,模块不存在。

- [ ] **Step 3: 实现**

创建 `src/main/shell/pendingPrepareRequests.ts`:

```ts
export interface PrepareResult {
  ok: boolean
  error?: string
}

export interface PendingPrepareRequests {
  /** 登记一个等待中的请求;超时后自动以 { ok:false, error:'MODEL_LOAD_TIMEOUT' } 完成。 */
  wait(requestId: string, timeoutMs: number): Promise<PrepareResult>
  /** 渲染层回报结果时调用;requestId 未知(已超时/从未注册)时安静忽略。 */
  resolve(requestId: string, result: PrepareResult): void
}

/** switchPet() 的"等渲染层确认新模型准备好"计时器薄封装,与 Electron 解耦以便注入假计时器测试。 */
export function createPendingPrepareRequests(
  setTimeoutFn: typeof setTimeout = setTimeout,
  clearTimeoutFn: typeof clearTimeout = clearTimeout
): PendingPrepareRequests {
  const resolvers = new Map<string, (r: PrepareResult) => void>()

  return {
    wait(requestId, timeoutMs) {
      return new Promise((resolvePromise) => {
        const timer = setTimeoutFn(() => {
          resolvers.delete(requestId)
          resolvePromise({ ok: false, error: 'MODEL_LOAD_TIMEOUT' })
        }, timeoutMs)
        resolvers.set(requestId, (r) => {
          clearTimeoutFn(timer)
          resolvePromise(r)
        })
      })
    },
    resolve(requestId, result) {
      const fn = resolvers.get(requestId)
      if (!fn) return
      resolvers.delete(requestId)
      fn(result)
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/shell/pendingPrepareRequests.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/shell/pendingPrepareRequests.ts src/main/shell/pendingPrepareRequests.test.ts
git commit -m "feat(main): 新增 switchPet 准备-提交握手用的待处理请求跟踪器"
```

---

## Task 5: IPC 通道/类型 + payload 校验

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/shared/ipcValidation.ts`
- Test: `src/shared/ipcValidation.test.ts`(若不存在则新建;若已存在则在其中追加)

**Interfaces:**
- Consumes:`PetRenderSource`(已从 `./petPackage` 导入到 `ipc.ts`)。
- Produces:
  - `IPC` 新增 4 个常量,移除 1 个:`PET_PREPARE`、`PET_PREPARE_RESULT`、`PET_COMMIT`、`PET_DISCARD` 新增;`PET_CHANGED` 移除(全仓库仅 3 处引用,均在本计划后续任务里改掉,见 Task 10/11/13)。另新增 `WINDOW_VISIBILITY_CHANGED`(Task 14/9 用)。
  - 新类型:`PetPreparePayload { requestId: string; source: PetRenderSource }`、`PetPrepareResultPayload { requestId: string; ok: boolean; error?: string }`、`PetCommitPayload { requestId: string }`、`PetDiscardPayload { requestId: string }`、`WindowVisibilityPayload { visible: boolean }`。
  - `PetApi` 接口:移除 `onPetChanged(cb: () => void): void`;新增 `onPetPrepare(cb: (payload: PetPreparePayload) => void): void`、`reportPrepareResult(requestId: string, ok: boolean, error?: string): void`、`onPetCommit(cb: (payload: PetCommitPayload) => void): void`、`onPetDiscard(cb: (payload: PetDiscardPayload) => void): void`、`onWindowVisibilityChanged(cb: (payload: WindowVisibilityPayload) => void): void`。
  - `src/shared/ipcValidation.ts` 新增 `validatePrepareResult(v: unknown): { requestId: string; ok: boolean; error?: string } | null`。
- Task 6(preload)、Task 9(main.ts)、Task 13/14(index.ts)都依赖这里定义的常量/类型名。

首先检查现有文件当前内容再动手(不要凭记忆改,行号可能已随其他改动漂移):

- [ ] **Step 1: 读取 `src/shared/ipc.ts` 和 `src/shared/ipcValidation.ts` 当前内容,确认 `IPC` 对象、`PetApi` 接口、文件顶部 import 的准确位置**

- [ ] **Step 2: 写失败的测试(先写 `validatePrepareResult` 的测试)**

若 `src/shared/ipcValidation.test.ts` 不存在则新建;若存在则在文件末尾追加:

```ts
import { validatePrepareResult } from './ipcValidation' // 与文件已有的 import 合并,不要重复 import 语句
```
```ts
describe('validatePrepareResult', () => {
  it('接受合法的成功结果', () => {
    expect(validatePrepareResult({ requestId: 'abc', ok: true })).toEqual({ requestId: 'abc', ok: true })
  })
  it('接受合法的失败结果(带 error)', () => {
    expect(validatePrepareResult({ requestId: 'abc', ok: false, error: 'MODEL_SWITCH_FAILED' })).toEqual({
      requestId: 'abc', ok: false, error: 'MODEL_SWITCH_FAILED'
    })
  })
  it('拒绝非对象', () => {
    expect(validatePrepareResult('nope')).toBeNull()
    expect(validatePrepareResult(null)).toBeNull()
  })
  it('拒绝缺失/非字符串 requestId', () => {
    expect(validatePrepareResult({ ok: true })).toBeNull()
    expect(validatePrepareResult({ requestId: 123, ok: true })).toBeNull()
  })
  it('拒绝非布尔 ok', () => {
    expect(validatePrepareResult({ requestId: 'abc', ok: 'yes' })).toBeNull()
  })
  it('拒绝非字符串 error(若提供)', () => {
    expect(validatePrepareResult({ requestId: 'abc', ok: false, error: 123 })).toBeNull()
  })
})
```

(若该测试文件本来不存在,顶部按 `ipcValidation.ts` 里其它测试文件的既有风格加 `import { describe, it, expect } from 'vitest'`。)

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run src/shared/ipcValidation.test.ts`
Expected: FAIL,`validatePrepareResult` 不存在。

- [ ] **Step 4: 实现 —— `src/shared/ipcValidation.ts` 追加**

```ts
export function validatePrepareResult(v: unknown): { requestId: string; ok: boolean; error?: string } | null {
  if (!isObject(v)) return null
  if (typeof v.requestId !== 'string' || v.requestId.length === 0) return null
  if (typeof v.ok !== 'boolean') return null
  if (v.error !== undefined && typeof v.error !== 'string') return null
  return { requestId: v.requestId, ok: v.ok, error: v.error as string | undefined }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run src/shared/ipcValidation.test.ts`
Expected: PASS。

- [ ] **Step 6: 实现 —— `src/shared/ipc.ts` 改动**

在文件顶部确认 `import type { PetVoice, PetRenderSource } from './petPackage'` 已存在(不用改)。在 `IPC` 常量对象里,把:

```ts
  PET_CHANGED: 'pet:changed'
```

改成:

```ts
  PET_PREPARE: 'pet:prepare',
  PET_PREPARE_RESULT: 'pet:prepare-result',
  PET_COMMIT: 'pet:commit',
  PET_DISCARD: 'pet:discard',
  WINDOW_VISIBILITY_CHANGED: 'window:visibility-changed'
```

(即整体替换掉原来那一行 `PET_CHANGED`,加上 5 个新常量;这是对象字面量的最后几行,注意补上/去掉逗号使其仍是合法语法。)

在 `PetApi` 接口定义之前(或任意顶层位置,和其它 payload 类型放在一起,例如挨着 `PetSwitchedPayload` 的定义处)新增:

```ts
export interface PetPreparePayload { requestId: string; source: PetRenderSource }
export interface PetPrepareResultPayload { requestId: string; ok: boolean; error?: string }
export interface PetCommitPayload { requestId: string }
export interface PetDiscardPayload { requestId: string }
export interface WindowVisibilityPayload { visible: boolean }
```

在 `PetApi` 接口内,把:

```ts
  /** 主进程通知宠物已换,渲染层重载精灵(重新 getPet + renderer.load()) */
  onPetChanged(cb: () => void): void
```

替换成:

```ts
  /** 主进程要求渲染层后台准备一个新宠物(不影响当前画面);渲染层准备完成/失败后必须调用
   *  reportPrepareResult()。见 Phase 5 设计文档 §3。 */
  onPetPrepare(cb: (payload: PetPreparePayload) => void): void
  /** 渲染层向主进程回报 onPetPrepare 的准备结果 */
  reportPrepareResult(requestId: string, ok: boolean, error?: string): void
  /** 主进程确认可以提交:渲染层原子切到已准备好的新宠物 */
  onPetCommit(cb: (payload: PetCommitPayload) => void): void
  /** 主进程确认要丢弃:渲染层销毁已准备但未提交的半成品,当前画面不受影响 */
  onPetDiscard(cb: (payload: PetDiscardPayload) => void): void
  /** 主进程窗口可见性变化(最小化/恢复/锁屏/解锁)推送,驱动 Live2D 场景帧率节流 */
  onWindowVisibilityChanged(cb: (payload: WindowVisibilityPayload) => void): void
```

- [ ] **Step 7: typecheck(预期会在 preload/main/renderer 里报错——这是正常的,后续任务会修)**

Run: `pnpm typecheck`
Expected: 在 `src/preload/index.ts`(用了 `IPC.PET_CHANGED`/实现了 `onPetChanged`)、`src/main/shell/index.ts`(用了 `IPC.PET_CHANGED`)、`src/renderer/main.ts`(用了 `window.petApi.onPetChanged`)报编译错误——这些会在 Task 6/9/13 里逐一修掉,本任务先只改 `ipc.ts`/`ipcValidation.ts` 这两个源头文件。

- [ ] **Step 8: Commit**

```bash
git add src/shared/ipc.ts src/shared/ipcValidation.ts src/shared/ipcValidation.test.ts
git commit -m "feat(shared): 新增 PET_PREPARE/COMMIT/DISCARD 等 IPC 通道与校验,移除 PET_CHANGED"
```

(此提交后 `pnpm typecheck` 会报错是预期状态,不是本任务的失败——下一个任务立刻修。)

---

## Task 6: preload 接线

**Files:**
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: Task 5 产出的 `IPC.PET_PREPARE/PET_PREPARE_RESULT/PET_COMMIT/PET_DISCARD/WINDOW_VISIBILITY_CHANGED`、`PetPreparePayload/PetCommitPayload/PetDiscardPayload/WindowVisibilityPayload` 类型、`validatePrepareResult`(注意:preload 侧发送数据不需要校验,校验发生在主进程收到时;preload 只是转发)。
- Produces: `window.petApi` 上的 `onPetPrepare/reportPrepareResult/onPetCommit/onPetDiscard/onWindowVisibilityChanged`,替代已删除的 `onPetChanged` —— Task 9 的 `main.ts` 依赖这些方法名。

- [ ] **Step 1: 读取 `src/preload/index.ts` 当前内容,定位 `petApi` 对象字面量里 `onPetChanged` 的准确位置和写法**

- [ ] **Step 2: 实现 —— 替换 `onPetChanged` 实现,新增四个方法**

把 `petApi` 对象里的:

```ts
  onPetChanged: (cb: () => void): void => {
    ipcRenderer.removeAllListeners(IPC.PET_CHANGED)
    ipcRenderer.on(IPC.PET_CHANGED, () => cb())
  },
```

替换成:

```ts
  onPetPrepare: (cb: (payload: PetPreparePayload) => void): void => {
    ipcRenderer.removeAllListeners(IPC.PET_PREPARE)
    ipcRenderer.on(IPC.PET_PREPARE, (_e, payload: PetPreparePayload) => cb(payload))
  },
  reportPrepareResult: (requestId: string, ok: boolean, error?: string): void =>
    ipcRenderer.send(IPC.PET_PREPARE_RESULT, { requestId, ok, error }),
  onPetCommit: (cb: (payload: PetCommitPayload) => void): void => {
    ipcRenderer.removeAllListeners(IPC.PET_COMMIT)
    ipcRenderer.on(IPC.PET_COMMIT, (_e, payload: PetCommitPayload) => cb(payload))
  },
  onPetDiscard: (cb: (payload: PetDiscardPayload) => void): void => {
    ipcRenderer.removeAllListeners(IPC.PET_DISCARD)
    ipcRenderer.on(IPC.PET_DISCARD, (_e, payload: PetDiscardPayload) => cb(payload))
  },
  onWindowVisibilityChanged: (cb: (payload: WindowVisibilityPayload) => void): void => {
    ipcRenderer.removeAllListeners(IPC.WINDOW_VISIBILITY_CHANGED)
    ipcRenderer.on(IPC.WINDOW_VISIBILITY_CHANGED, (_e, payload: WindowVisibilityPayload) => cb(payload))
  },
```

在文件顶部 `import { IPC, ... } from '@shared/ipc'` 那一行的类型导入列表里,追加 `PetPreparePayload, PetCommitPayload, PetDiscardPayload, WindowVisibilityPayload`(与已有的 `type PetRenderSource` 等其它 `import type` 合并到同一处,遵循文件既有的 import 分组风格)。

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: `src/preload/index.ts` 不再报错;`src/main/shell/index.ts` 和 `src/renderer/main.ts` 仍会报错(留给 Task 9/13)。

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(preload): 接线 onPetPrepare/reportPrepareResult/onPetCommit/onPetDiscard/onWindowVisibilityChanged"
```

---

## Task 7: `PetRenderer` 接口新增三段式方法

**Files:**
- Modify: `src/renderer/petRenderer.ts`

**Interfaces:**
- Produces: `prepareSwap(source: PetRenderSource): Promise<void>`、`commitSwap(): void`、`discardSwap(): void` 加进 `PetRenderer` 接口 —— Task 8(`SpriteRenderer`/`Live2DPetRenderer`)必须实现它们,Task 11(`petController.test.ts` 的 fake renderer)必须跟着补全,否则两处都会编译失败。

- [ ] **Step 1: 实现**

在 `src/renderer/petRenderer.ts` 的 `PetRenderer` 接口里,`load` 之后、`playState` 之前插入:

```ts
  /** 后台准备下一个模型/精灵表,不改变当前可见画面。只在"新旧渲染器类型相同"的热切换
   *  路径下被调用(跨类型切换走全新实例的 load(),不经过这三个方法,见 PetController)。
   *  见 Phase 5 设计文档 §1/§2。 */
  prepareSwap(source: PetRenderSource): Promise<void>
  /** 原子提交 prepareSwap() 准备好的模型/精灵表;没有成功的 prepareSwap() 时调用应抛错。 */
  commitSwap(): void
  /** 丢弃 prepareSwap() 准备好但未提交的半成品,不影响当前可见模型。 */
  discardSwap(): void
```

- [ ] **Step 2: typecheck(预期报错——这是正常的,Task 8 会修)**

Run: `pnpm typecheck`
Expected: `src/renderer/spriteRenderer.ts`(class 未实现新方法)、`src/renderer/live2dRenderer.ts`(同上)、`src/renderer/petController.test.ts`(fake renderer 未实现新方法)报错。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/petRenderer.ts
git commit -m "feat(renderer): PetRenderer 接口新增 prepareSwap/commitSwap/discardSwap"
```

---

## Task 8: `SpriteRenderer` 实现三段式方法

**Files:**
- Modify: `src/renderer/spriteRenderer.ts`

**Interfaces:**
- Consumes: Task 7 的接口新增。
- Produces: `SpriteRenderer` 完整实现 `PetRenderer`。

**说明**:精灵渲染器用 2D canvas,没有 WebGL context 复用问题,这套三段式主要是为了和 Live2D 接口对称,不是规避某个具体 bug。本任务是纯 glue 代码,和现有 `load()`/`draw()`/`isPetPixel()` 一样不写 DOM/Image 相关的单测(项目既有惯例——这类方法从未有过 vitest 覆盖,只有 `nextFrameIndex` 这个纯函数有测试),靠 Task 12 的 `pnpm typecheck` + 真机验收覆盖。

- [ ] **Step 1: 读取 `src/renderer/spriteRenderer.ts` 当前内容确认字段名/`load()`写法未变**

- [ ] **Step 2: 实现**

在 `SpriteRenderer` class 里新增两个私有字段(紧挨着已有的 `private manifest: PetManifest | null = null` 之后):

```ts
  private pendingSheet: HTMLImageElement | null = null
  private pendingManifest: PetManifest | null = null
```

在 `async load(...)` 方法之后插入三个新方法:

```ts
  async prepareSwap(source: PetRenderSource): Promise<void> {
    if (source.type !== 'sprite') throw new Error('SpriteRenderer.prepareSwap() 只能准备 type:"sprite" 的 PetRenderSource')
    const img = new Image()
    img.src = source.spritesheetDataUrl
    await img.decode()
    this.pendingSheet = img
    this.pendingManifest = source.manifest
  }

  commitSwap(): void {
    if (!this.pendingSheet || !this.pendingManifest) throw new Error('commitSwap() 前必须先成功调用 prepareSwap()')
    this.stop()
    this.sheet = this.pendingSheet
    this.manifest = this.pendingManifest
    this.frame = 0
    this.state = ''
    this.pendingSheet = null
    this.pendingManifest = null
  }

  discardSwap(): void {
    this.pendingSheet = null
    this.pendingManifest = null
  }
```

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: `src/renderer/spriteRenderer.ts` 不再报错(仍会在 `live2dRenderer.ts`/`petController.test.ts` 报错,留给 Task 9/11)。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/spriteRenderer.ts
git commit -m "feat(renderer): SpriteRenderer 实现 prepareSwap/commitSwap/discardSwap"
```

---

## Task 9: `Live2DPetRenderer` 实现三段式方法 + 真正的 `resize()` + 场景帧率 + resolutionCap

**Files:**
- Modify: `src/renderer/live2dRenderer.ts`
- Modify: `src/renderer/live2dHitTestFallback.test.ts`(补一个非默认尺寸的回归用例)

**Interfaces:**
- Consumes: Task 1 的 `clampLive2DViewport`(`@shared/windowPlacement`)、Task 3 的 `fpsForState`(`./live2dFps`)、Task 7 的接口新增。
- Produces: `Live2DPetRenderer` 完整实现 `PetRenderer`;`resize(viewport)` 从 no-op 变成真正调用 `app.renderer.resize()`。

**说明**:同 Task 8,这是触碰真实 pixi.js `Application`/`Live2DModel` 的 glue 代码,项目里这一层至今没有 mock 引擎单测(`live2dRenderer.ts` 本身没有 `.test.ts`),本任务不新增违背既有惯例的假单测,只保证 `pnpm typecheck` 通过,真实行为交给 Task 12 的真机验收。`toCanvasCoords()` 的回归测试例外——它是纯函数、本来就有单测,补一个非 256×288 尺寸的用例成本很低,值得顺手做。

- [ ] **Step 1: 读取 `src/renderer/live2dRenderer.ts` 当前完整内容,确认 `load()`/`autoFit()`/字段名的准确写法(前面 Explore 已经读过一次,但改动前务必用 Read 工具重新确认,避免行号/写法漂移)**

- [ ] **Step 2: 提取 `setupModel` 私有辅助方法(DRY:`load()` 和 `prepareSwap()` 都需要"挂 anchor/scale/position + 自动对齐 + 水印破冰"这套逻辑,不能复制两份)**

把现有 `load()` 里,从 `applyCubismCoreCompatPatch(model.internalModel.coreModel)` 开始、到水印破冰 `if (watermarkExpression) void model.expression(watermarkExpression)` 结束的这一段(现有 live2dRenderer.ts:60-83 附近,具体行号以本步骤 Step 1 重新读取的为准),抽成一个新的私有方法:

```ts
  /** load()/prepareSwap() 共用的模型初始化:挂 anchor/scale/position、首次自动对齐、
   *  水印破冰兜底。不区分调用方是"首次加载"还是"热切换准备",只依赖传入的 model/manifest/viewport。 */
  private async setupModel(
    model: Live2DModel,
    manifest: Live2DManifest,
    viewport: { width: number; height: number }
  ): Promise<void> {
    applyCubismCoreCompatPatch(model.internalModel.coreModel)

    const t = manifest.render.transform
    model.anchor.set(t.anchorX, t.anchorY)
    this.baseScale = t.scale
    model.scale.set(this.baseScale)
    model.position.set(viewport.width / 2 + t.offsetX, viewport.height / 2 + t.offsetY)

    if (needsAutoFit(t)) {
      const fit = this.autoFit(model, viewport)
      if (fit) void window.petApi.updateLive2DTransform({ ...fit, autoFitted: true })
    }

    const expressionManager = model.internalModel.motionManager.expressionManager as
      | { definitions?: ExpressionDefinition[] }
      | undefined
    const watermarkExpression = pickWatermarkBreakExpressionName(manifest, expressionManager?.definitions)
    if (watermarkExpression) void model.expression(watermarkExpression)
  }
```

把现有的 `private autoFit(marginPx = 8)` 方法签名改成接受显式的 `model`/`viewport` 参数(不再读 `this.model`/`this.app.screen`),内部逻辑不变(只是把 `this.model` 替换成参数 `model`、把 `this.app.screen.width/height` 替换成参数 `viewport.width/height`):

```ts
  private autoFit(
    model: Live2DModel,
    viewport: { width: number; height: number },
    marginPx = 8
  ): { scale: number; offsetX: number; offsetY: number } | null {
    const currentScale = model.scale.x || 1
    const naturalWidth = model.width / currentScale
    const naturalHeight = model.height / currentScale
    const targetWidth = viewport.width - marginPx * 2
    const targetHeight = viewport.height - marginPx * 2
    const scale = Math.min(targetWidth / naturalWidth, targetHeight / naturalHeight)
    if (!Number.isFinite(scale)) return null
    this.baseScale = scale
    model.scale.set(scale)
    const positionX = viewport.width / 2
    const positionY = viewport.height - marginPx
    model.position.set(positionX, positionY)
    return {
      scale,
      offsetX: positionX - viewport.width / 2,
      offsetY: positionY - viewport.height / 2
    }
  }
```

`window.__kiboLive2D.autoFit`/`saveFit` 调试挂钩里对 `this.autoFit(marginPx)` 的调用,同步改成 `this.autoFit(this.model!, { width: this.app!.screen.width, height: this.app!.screen.height }, marginPx)`(调试挂钩本来就假定 `this.model`/`this.app` 已存在)。

- [ ] **Step 3: 把 `load()` 改成使用 `clampLive2DViewport` + 新的 `setupModel`**

`load()` 里原来的:

```ts
      await app.init({ canvas: this.canvas, width: 256, height: 288, preference: 'webgl', autoDensity: true, resolution: window.devicePixelRatio, backgroundAlpha: 0 })
```

改成:

```ts
      const viewport = clampLive2DViewport(source.manifest.render.viewport)
      const resolution = Math.min(window.devicePixelRatio, source.manifest.render.viewport.resolutionCap)
      await app.init({ canvas: this.canvas, width: viewport.width, height: viewport.height, preference: 'webgl', autoDensity: true, resolution, backgroundAlpha: 0 })
```

`load()` 里原来从 `const t = source.manifest.render.transform` 到水印破冰结束的那一整段——**注意这段中间原本夹着 `app.stage.addChild(model); this.model = model` 两行**,这两行不属于抽出去的 `setupModel`(`setupModel` 只负责"配置模型属性",刻意不碰 stage——`prepareSwap()` 需要在模型还没挂上 stage 之前就完成同一套配置)。整段替换成:

```ts
    await this.setupModel(model, source.manifest, viewport)
    app.stage.addChild(model)
    this.model = model
```

即:`setupModel()` 调用挪到 `app.stage.addChild(model)` 之前(比原来的相对顺序提前了一步——原代码是先 `addChild` 再跑自动对齐/水印破冰)。这个顺序调整依据是 Pixi 的 `model.width`/`model.height`/`model.anchor`/`model.scale`/`model.position` 是模型自身的本地属性,不依赖是否已经挂在某个 `stage` 上;但这只是基于 Pixi 一般行为的判断,不是这个具体引擎版本已经验证过的事实——**这是本任务里为数不多需要靠真机验证的行为假设**:Task 16 真机走查时,除了清单里列的项目,额外确认一次新宠物首次加载(`load()` 路径)的自动对齐效果和 Phase 4 已验收过的效果一致(模型比例/位置没有变化),如果不一致,大概率就是这个顺序调整导致 `autoFit()` 测出来的 `model.width/height` 在未挂 stage 时不准确,需要回来给 `setupModel` 加一个"是否已在 stage 上"的参数分支。

文件顶部 import 列表追加:

```ts
import { clampLive2DViewport } from '@shared/windowPlacement'
import { fpsForState } from './live2dFps'
```

- [ ] **Step 4: 新增字段 + 三段式方法 + 真正的 `resize()`**

在 class 字段区(`private baseScale = 1` 之后)新增:

```ts
  private pendingModel: Live2DModel | null = null
  private pendingManifest: Live2DManifest | null = null
  private pendingViewport: { width: number; height: number } | null = null
```

在 `destroy()` 之前插入:

```ts
  async prepareSwap(source: PetRenderSource): Promise<void> {
    if (source.type !== 'live2d') throw new Error('Live2DPetRenderer.prepareSwap() 只能准备 type:"live2d" 的 PetRenderSource')
    if (!this.app) throw new Error('prepareSwap() 前必须先成功调用过一次 load()')
    const viewport = clampLive2DViewport(source.manifest.render.viewport)
    const modelUrl = `${source.resourceBaseUrl}${source.manifest.render.model}`
    const model = await Live2DModel.from(modelUrl)
    await this.setupModel(model, source.manifest, viewport)
    this.pendingModel = model
    this.pendingManifest = source.manifest
    this.pendingViewport = viewport
  }

  commitSwap(): void {
    if (!this.pendingModel || !this.pendingManifest || !this.pendingViewport || !this.app) {
      throw new Error('commitSwap() 前必须先成功调用 prepareSwap()')
    }
    this.model?.destroy()
    this.resize(this.pendingViewport)
    this.app.stage.addChild(this.pendingModel)
    this.model = this.pendingModel
    this.manifest = this.pendingManifest
    this.sequentialIndexByGroup.clear()
    this.pendingModel = null
    this.pendingManifest = null
    this.pendingViewport = null
  }

  discardSwap(): void {
    this.pendingModel?.destroy()
    this.pendingModel = null
    this.pendingManifest = null
    this.pendingViewport = null
  }
```

把现有的:

```ts
  resize(_viewport: PetViewport): void {
    // no-op:与 SpriteRenderer 对齐,Phase 5 才会真正驱动动态窗口尺寸。
  }
```

改成:

```ts
  resize(viewport: PetViewport): void {
    if (!this.app) return
    this.app.renderer.resize(viewport.width, viewport.height)
  }
```

- [ ] **Step 5: 场景帧率接线**

在 `playState(state: PetVisualState)` 方法体最前面(`if (!this.manifest || !this.model) return` 之后)插入:

```ts
    if (this.app) this.app.ticker.maxFPS = fpsForState(state)
```

- [ ] **Step 6: typecheck**

Run: `pnpm typecheck`
Expected: `src/renderer/live2dRenderer.ts` 不再报错(`petController.test.ts` 仍会报错,留给 Task 11)。

- [ ] **Step 7: 补一个 `toCanvasCoords` 非默认尺寸的回归测试**

在 `src/renderer/live2dHitTestFallback.test.ts` 的 `describe('toCanvasCoords', ...)` 里追加一个用例:

```ts
  it('对非默认(非 256x288)窗口尺寸的 canvas 同样只做 CSS 偏移换算——动态窗口尺寸下这条数学不需要变', () => {
    const fakeCanvas = {
      width: 1200, height: 1350, // 物理分辨率,假设是 800x900 逻辑尺寸 * 1.5 resolutionCap
      getBoundingClientRect: () => ({
        left: 5, top: 8, width: 800, height: 900, right: 805, bottom: 908, x: 5, y: 8, toJSON: () => ({})
      })
    } as unknown as HTMLCanvasElement

    expect(toCanvasCoords(fakeCanvas, 105, 208)).toEqual({ x: 100, y: 200 })
  })
```

Run: `pnpm vitest run src/renderer/live2dHitTestFallback.test.ts`
Expected: PASS(这条数学本来就不依赖 canvas 尺寸,新增用例只是把"任意尺寸下都成立"这个性质写成显式回归)。

- [ ] **Step 8: Commit**

```bash
git add src/renderer/live2dRenderer.ts src/renderer/live2dHitTestFallback.test.ts
git commit -m "feat(renderer): Live2DPetRenderer 实现 prepareSwap/commitSwap/discardSwap,resize()/resolutionCap/场景帧率真正生效"
```

---

## Task 10: `PetController` 三入口改造(`prepareReload`/`commitReload`/`discardReload`)

**Files:**
- Modify: `src/renderer/petController.ts`
- Modify: `src/renderer/petController.test.ts`

**Interfaces:**
- Consumes: Task 7 的接口新增。
- Produces:`PetController` 构造函数签名变为 `constructor(initialRenderer: PetRenderer, initialType: PetRenderSource['type'], createRenderer: (source: PetRenderSource) => { renderer: PetRenderer; attach: () => void })`;新方法 `prepareReload(source: PetRenderSource): Promise<void>`、`commitReload(): void`、`discardReload(): void`、`setVisible(visible: boolean): void`(转发给当前渲染器)。移除旧的无参 `reload(): Promise<void>`。—— Task 11 的 `main.ts` 依赖这个新构造函数签名和三个新方法名。

- [ ] **Step 1: 读取 `src/renderer/petController.ts`/`petController.test.ts` 当前完整内容**

- [ ] **Step 2: 改写测试(替换掉整个 `describe('PetController.reload() 热切换', ...)` 块)**

把 `src/renderer/petController.test.ts` 里 `makeFakeRenderer()` 函数改成同时实现三个新方法(否则 `PetRenderer` 类型不满足会编译失败):

```ts
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

把整个 `describe('PetController.reload() 热切换', ...)` 块替换成:

```ts
describe('PetController 准备-提交热切换', () => {
  it('同类型(sprite→sprite):prepareReload 调用 renderer.prepareSwap,不销毁旧实例;commitReload 才调用 commitSwap', async () => {
    const renderer = makeFakeRenderer()
    const factory = vi.fn()
    const controller = new PetController(renderer, 'sprite', factory)

    await controller.prepareReload(spriteSource)
    expect(renderer.prepareSwapWith).toEqual([spriteSource])
    expect(renderer.commitSwapCalled).toBe(false)
    expect(renderer.destroyed).toBe(false)
    expect(factory).not.toHaveBeenCalled()

    controller.commitReload()
    expect(renderer.commitSwapCalled).toBe(true)
  })

  it('同类型(live2d→live2d):同上,走 prepareSwap/commitSwap,不新建实例', async () => {
    const renderer = makeFakeRenderer()
    const factory = vi.fn()
    const controller = new PetController(renderer, 'live2d', factory)

    await controller.prepareReload(live2dSource)
    controller.commitReload()

    expect(renderer.prepareSwapWith).toEqual([live2dSource])
    expect(renderer.commitSwapCalled).toBe(true)
    expect(factory).not.toHaveBeenCalled()
  })

  it('同类型 prepareReload 失败时,调用方可以 discardReload,旧渲染器不受影响', async () => {
    const renderer = makeFakeRenderer()
    renderer.shouldFailPrepare = true
    const controller = new PetController(renderer, 'sprite', vi.fn())

    await expect(controller.prepareReload(spriteSource)).rejects.toThrow('prepare failed')
    controller.discardReload()

    expect(renderer.discardSwapCalled).toBe(true)
    expect(renderer.destroyed).toBe(false)
  })

  it('跨类型(sprite→live2d):prepareReload 用工厂新建实例并 load(),不销毁/替换旧实例;commitReload 才销毁旧实例、切到新实例', async () => {
    const oldRenderer = makeFakeRenderer()
    const newRenderer = makeFakeRenderer()
    const attach = vi.fn()
    const factory = vi.fn(() => ({ renderer: newRenderer, attach }))
    const controller = new PetController(oldRenderer, 'sprite', factory)

    await controller.prepareReload(live2dSource)
    expect(factory).toHaveBeenCalledWith(live2dSource)
    expect(newRenderer.loadedWith).toEqual([live2dSource])
    expect(attach).not.toHaveBeenCalled()
    expect(oldRenderer.destroyed).toBe(false)

    controller.commitReload()
    expect(attach).toHaveBeenCalledOnce()
    expect(oldRenderer.destroyed).toBe(true)

    // hitTest 现在应该转发到新实例
    newRenderer.hitTest = () => ({ hit: true, area: 'Head' })
    expect(controller.hitTest(1, 2)).toEqual({ hit: true, area: 'Head' })
  })

  it('跨类型 load() 失败时,新实例被销毁,旧实例/attach 均未被触碰', async () => {
    const oldRenderer = makeFakeRenderer()
    const newRenderer = makeFakeRenderer()
    newRenderer.load = async () => { throw new Error('load failed') }
    const attach = vi.fn()
    const factory = vi.fn(() => ({ renderer: newRenderer, attach }))
    const controller = new PetController(oldRenderer, 'sprite', factory)

    await expect(controller.prepareReload(live2dSource)).rejects.toThrow('load failed')
    expect(newRenderer.destroyed).toBe(true)
    expect(attach).not.toHaveBeenCalled()
    expect(oldRenderer.destroyed).toBe(false)

    controller.discardReload() // 没有已准备好的跨类型实例时应是安静的 no-op
    expect(oldRenderer.destroyed).toBe(false)
  })

  it('setVisible() 转发给当前渲染器', () => {
    const renderer = makeFakeRenderer()
    let receivedVisible: boolean | undefined
    renderer.setVisible = (v) => { receivedVisible = v }
    const controller = new PetController(renderer, 'sprite', vi.fn())
    controller.setVisible(false)
    expect(receivedVisible).toBe(false)
  })
})
```

保留原文件里已有的 `hitTest() 转发到当前渲染器实例` 那条测试,但把它的构造方式改成新的三参数构造函数(`new PetController(initial, 'live2d', () => ({ renderer: replacement, attach: () => {} }))`)并把 `await controller.reload()` 改成 `await controller.prepareReload(live2dSource); controller.commitReload()`。

因为 `prepareReload()`/`commitReload()` 不再自己调用 `window.petApi.getPet()`(main process 通过 `PET_PREPARE` 的 payload 直接把 `source` 传下来了),原来 `beforeEach` 里 mock `window.petApi.getPet` 的部分可以删掉(`prepareReload` 不再依赖它)。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run src/renderer/petController.test.ts`
Expected: FAIL(新方法/新构造签名还不存在)。

- [ ] **Step 4: 实现 —— `src/renderer/petController.ts`**

构造函数和相关字段改成:

```ts
export class PetController {
  private ctx: PetBrainCtx = initBrain()
  private lastTs = 0
  private timer: number | null = null
  private pending: PetEvent[] = []
  private workArea: Bounds = { x: 0, y: 0, width: 1920, height: 1080 }
  private windowX = 0
  private windowWidth = 256
  private windowY = 0
  private windowHeight = 288
  private currentAnim = ''
  private reactionCtx: ReactionCtx = initReaction()
  private pendingReaction: ReactionTrigger | null = null
  private pendingContextSignal: ContextSignalKind | null = null
  private renderer: PetRenderer
  private rendererType: PetRenderSource['type']
  private pendingRenderer: PetRenderer | null = null
  private pendingRendererType: PetRenderSource['type'] | null = null
  private pendingAttach: (() => void) | null = null

  constructor(
    initialRenderer: PetRenderer,
    initialType: PetRenderSource['type'],
    private readonly createRenderer: (source: PetRenderSource) => { renderer: PetRenderer; attach: () => void }
  ) {
    this.renderer = initialRenderer
    this.rendererType = initialType
  }
```

（其余字段/`start()`/`stop()`/`send()`/`poke()`/`receiveContextSignal()`/`syncBounds()`/`tick()` 全部保持不变，只删掉旧的 `reload()` 方法，用下面三个方法替代，插在 `hitTest()` 之前）：

```ts
  /** 热切换准备阶段:同类型走 renderer.prepareSwap(),旧模型/canvas 全程不受影响;
   *  跨类型新建一个 detached 的渲染器实例(canvas 尚未接入 DOM)并 load(),失败则立即
   *  销毁新实例。两种情况下都不修改 this.renderer/this.rendererType,真正切换发生在
   *  commitReload()。见 Phase 5 设计文档 §1。 */
  async prepareReload(source: PetRenderSource): Promise<void> {
    if (source.type === this.rendererType) {
      await this.renderer.prepareSwap(source)
      return
    }
    const { renderer, attach } = this.createRenderer(source)
    try {
      await renderer.load(source)
    } catch (err) {
      await renderer.destroy()
      throw err
    }
    this.pendingRenderer = renderer
    this.pendingRendererType = source.type
    this.pendingAttach = attach
  }

  /** 原子提交 prepareReload() 准备好的内容。跨类型时把 pendingRenderer 接入 DOM、销毁旧实例;
   *  同类型时转发给 renderer.commitSwap()。 */
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
      this.ctx = initBrain()
      this.currentAnim = ''
      return
    }
    this.renderer.commitSwap()
    this.ctx = initBrain()
    this.currentAnim = ''
  }

  /** 丢弃 prepareReload() 准备好但未提交的半成品,当前可见渲染器/画面不受影响。 */
  discardReload(): void {
    if (this.pendingRenderer) {
      void this.pendingRenderer.destroy()
      this.pendingRenderer = null
      this.pendingRendererType = null
      this.pendingAttach = null
      return
    }
    this.renderer.discardSwap()
  }

  setVisible(visible: boolean): void {
    this.renderer.setVisible(visible)
  }
```

删掉文件顶部不再需要的东西:无(`PetRenderSource` 类型仍需要,`import type { PetRenderer, PetHitResult } from './petRenderer'` 也不变)。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run src/renderer/petController.test.ts`
Expected: PASS,全部用例通过。

- [ ] **Step 6: typecheck**

Run: `pnpm typecheck`
Expected: `src/renderer/petController.ts`/`petController.test.ts` 不再报错;`src/renderer/main.ts` 仍会报错(构造函数签名变了、`onPetChanged`/`controller.reload()` 都不存在了,留给 Task 11)。

- [ ] **Step 7: Commit**

```bash
git add src/renderer/petController.ts src/renderer/petController.test.ts
git commit -m "refactor(renderer): PetController 拆分 prepareReload/commitReload/discardReload,按渲染器类型分叉热切换"
```

---

## Task 11: `main.ts` 渲染层编排改造

**Files:**
- Modify: `src/renderer/main.ts`

**Interfaces:**
- Consumes: Task 6 的新 `petApi` 方法、Task 10 的新 `PetController` 构造签名/方法。
- Produces: `boot()` 里的 `createRenderer` 工厂改造为 `{renderer, attach}` 形状;`PET_PREPARE`/`PET_COMMIT`/`PET_DISCARD`/`WINDOW_VISIBILITY_CHANGED` 的渲染层消费逻辑。

- [ ] **Step 1: 读取 `src/renderer/main.ts` 当前完整内容(前面 Explore 已读过一次,改动前重新确认行号/写法)**

- [ ] **Step 2: 实现**

把:

```ts
function replacePetCanvas(current: HTMLCanvasElement): HTMLCanvasElement {
  const fresh = document.createElement('canvas')
  fresh.id = current.id
  current.replaceWith(fresh)
  return fresh
}

function createRenderer(canvas: HTMLCanvasElement, source: PetRenderSource): PetRenderer {
  if (source.type === 'sprite') return new SpriteRenderer(canvas)
  return new Live2DPetRenderer(canvas)
}
```

改成:

```ts
function createRendererForCanvas(canvas: HTMLCanvasElement, source: PetRenderSource): PetRenderer {
  if (source.type === 'sprite') return new SpriteRenderer(canvas)
  return new Live2DPetRenderer(canvas)
}
```

（只是改名,行为不变；`replacePetCanvas` 整个删掉，它"创建就立刻 replaceWith"的即时替换语义被下面 `boot()` 里的新工厂拆成"先建 detached canvas → 成功后才 attach"两步。）

`boot()` 内部，把:

```ts
  const renderer = createRenderer(canvas, source)
  await renderer.load(source)
  const controller = new PetController(renderer, (s) => {
    canvas = replacePetCanvas(canvas)
    canvas.addEventListener('mousedown', onCanvasMouseDown)
    return createRenderer(canvas, s)
  })
  await controller.start()
```

改成:

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

把:

```ts
  window.petApi.onPetChanged(() => {
    void controller.reload().catch((err) => console.warn('pet reload failed', err))
  })
```

改成:

```ts
  window.petApi.onPetPrepare((payload) => {
    controller.prepareReload(payload.source).then(
      () => window.petApi.reportPrepareResult(payload.requestId, true),
      (err) => window.petApi.reportPrepareResult(payload.requestId, false, err instanceof Error ? err.message : String(err))
    )
  })
  window.petApi.onPetCommit(() => controller.commitReload())
  window.petApi.onPetDiscard(() => controller.discardReload())
  window.petApi.onWindowVisibilityChanged((payload) => controller.setVisible(payload.visible))
```

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: 整个仓库 `pnpm typecheck` 通过(此时 Task 5-11 涉及的所有文件应该已经互相对齐;若还有报错,大概率是 `src/main/shell/index.ts` 里对 `IPC.PET_CHANGED` 的引用——那是 Task 13 的范围,本任务只需确认 renderer 侧不再报错)。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/main.ts
git commit -m "refactor(renderer): main.ts 改造 canvas 工厂为 prepare/attach 两段式,接线新 PET_PREPARE/COMMIT/DISCARD IPC"
```

---

## Task 12: `petWindow.ts` —— `resizable:true` + 可配置初始尺寸

**Files:**
- Modify: `src/main/shell/petWindow.ts`

**Interfaces:**
- Produces:`createPetWindow(opts: { preload: string; url: string | undefined; indexHtml: string; initialSize: {width:number; height:number} }): BrowserWindow` —— `PET_WINDOW_SIZE` 常量整体移除(尺寸现在完全由调用方传入)。Task 14 是唯一调用方,会传入 `windowSizeForSource(初始宠物的 source)`。

- [ ] **Step 1: 实现**

把 `src/main/shell/petWindow.ts` 整个改成:

```ts
import { BrowserWindow } from 'electron'

export function createPetWindow(opts: {
  preload: string
  url: string | undefined
  indexHtml: string
  initialSize: { width: number; height: number }
}): BrowserWindow {
  const win = new BrowserWindow({
    width: opts.initialSize.width,
    height: opts.initialSize.height,
    transparent: true,
    frame: false,
    resizable: true, // 尺寸变化只在 setBounds() 时一次性发生(首次加载/热切换提交),不运行时切换 setResizable
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  if (opts.url) win.loadURL(opts.url)
  else win.loadFile(opts.indexHtml)
  return win
}
```

- [ ] **Step 2: typecheck(预期报错——Task 14 会修)**

Run: `pnpm typecheck`
Expected: `src/main/shell/index.ts` 报错(`createPetWindow()` 调用缺 `initialSize`,`PET_WINDOW_SIZE` 已不存在但仍被 `MOVE_WINDOW` 等 handler 引用)。

- [ ] **Step 3: Commit**

```bash
git add src/main/shell/petWindow.ts
git commit -m "feat(main): 宠物窗口改为 resizable:true + 初始尺寸由调用方传入,移除固定 PET_WINDOW_SIZE"
```

---

## Task 13: `switchPet()` 准备-提交协议重写

**Files:**
- Modify: `src/main/shell/index.ts`

**Interfaces:**
- Consumes: Task 4 的 `createPendingPrepareRequests`、Task 5 的 `IPC.PET_PREPARE/PET_PREPARE_RESULT/PET_COMMIT/PET_DISCARD`、`validatePrepareResult`、Task 1 的 `footAnchorPreservingBounds`/`windowSizeForSource`。
- Produces: 新的 `switchPet()` 实现;新增 `ipcMain.on(IPC.PET_PREPARE_RESULT, ...)` handler。

**说明**:这是本计划里最大的一块 glue 改动,`index.ts` 目前对任何 `ipcMain` handler 都没有自动化测试(`index.test.ts` 只测 `resolveVoiceBackend` 这个纯函数),本任务不假装能补出这类测试——`switchPet()` 本身继续靠 `pnpm dev`/`preview` 真机验证(见 Task 15 的验收清单),`pnpm typecheck` 是本任务唯一的自动化关卡。

- [ ] **Step 1: 读取 `src/main/shell/index.ts` 当前完整的 `switchPet()` 函数(lines ~497-536,前面 Explore 已读过一次，改动前重新用 Read 工具确认准确行号——本文件很大，改动前的其它任务可能已经移动了周围代码）以及顶部 import 列表**

- [ ] **Step 2: 顶部 import 追加**

```ts
import { createPendingPrepareRequests } from './pendingPrepareRequests'
import { validatePrepareResult } from '@shared/ipcValidation' // 与已有的 ipcValidation 导入合并,不要重复 import 语句
import { footAnchorPreservingBounds, windowSizeForSource } from '@shared/windowPlacement' // 与已有的 windowPlacement 导入合并(该文件已 import fixedWindowBounds, isZeroMove)
import { randomUUID } from 'node:crypto'
```

- [ ] **Step 3: 在 `let session = createPetSession(...)` 附近新增一个模块级(startShell 函数作用域内)的请求跟踪器实例**

紧挨着 `let session = createPetSession(effectivePetId, sessionDeps)` 那一行之后新增:

```ts
  const pendingPrepare = createPendingPrepareRequests()
  ipcMain.on(IPC.PET_PREPARE_RESULT, (_e, raw) => {
    const payload = validatePrepareResult(raw)
    if (!payload) return
    pendingPrepare.resolve(payload.requestId, { ok: payload.ok, error: payload.error })
  })
```

- [ ] **Step 4: 重写 `switchPet()`**

把现有的 `async function switchPet(petId: string): Promise<boolean> { ... }` 整个函数体替换成:

```ts
async function switchPet(petId: string): Promise<boolean> {
  if (petId === session.petId) return false
  const target = listPets(petCatalogDirs).find((p) => p.id === petId)
  if (!target) {
    dialog.window()?.webContents.send(IPC.CHAT_ERROR, '找不到这只宠物')
    return false
  }
  if (!target.renderReady) {
    dialog.window()?.webContents.send(IPC.CHAT_ERROR, '这只宠物的渲染引擎还没就绪,暂时无法切换')
    return false
  }
  // 先建后弃:新会话构建成功才 dispose 旧的,失败则旧会话原封不动
  let next: PetSession
  try {
    next = createPetSession(petId, sessionDeps)
  } catch (e) {
    console.warn('[switchPet] 新会话构建失败,保留当前宠物', e)
    dialog.window()?.webContents.send(IPC.CHAT_ERROR, '切换失败,已保留当前宠物')
    return false
  }

  const rawSource = await loadPet(next.petDir).catch(() => null)
  if (!rawSource) {
    await next.dispose()
    dialog.window()?.webContents.send(IPC.CHAT_ERROR, '切换失败,读取宠物包出错')
    return false
  }
  const source: PetRenderSource = rawSource.type === 'live2d'
    ? { ...rawSource, resourceBaseUrl: `kibo-pet://${next.resourceToken}/` }
    : rawSource

  // 准备阶段:渲染层在旧模型仍显示时后台加载新模型,不动会话/settings/窗口
  const requestId = randomUUID()
  petWin.webContents.send(IPC.PET_PREPARE, { requestId, source })
  const result = await pendingPrepare.wait(requestId, 8000)

  if (!result.ok) {
    await next.dispose()
    petWin.webContents.send(IPC.PET_DISCARD, { requestId })
    dialog.window()?.webContents.send(IPC.CHAT_ERROR, `切换失败:${result.error ?? 'MODEL_SWITCH_FAILED'}`)
    return false
  }

  // 提交阶段:渲染层确认新模型首帧就绪,主进程才真正切会话/settings/窗口尺寸
  await session.dispose()          // 停旧语音(释放端口)、停 appFocus、取消在途
  session = next
  session.startVoice()             // 端口已释放,启新宠物语音(未配置则静默不启)
  saveSettings(settingsFile, { ...loadSettings(settingsFile), activePetId: petId })

  const newSize = windowSizeForSource(source)
  petWin.setBounds(footAnchorPreservingBounds(petBoundsFull(), newSize, petWorkArea()))

  petWin.webContents.send(IPC.PET_COMMIT, { requestId }) // 渲染层原子切到已准备好的新模型
  dialog.pushUpdate(session.messages())                  // 右栏历史热切换
  const loaded = await loadPet(session.petDir).catch(() => null)
  dialog.window()?.webContents.send(IPC.PET_SWITCHED, {
    petId, displayName: loaded?.manifest.displayName ?? petId
  })
  // 清跨宠物残留气泡
  clearAmbientLine(); bubbleHasContent = false; bubble.clear(); bubble.hide()
  return true
}
```

（`ipcMain.handle(IPC.SWITCH_PET, ...)` 那部分调用方不用改。）

- [ ] **Step 5: typecheck**

Run: `pnpm typecheck`
Expected: 与 `switchPet()` 相关的错误消失(仍可能剩下 `MOVE_WINDOW`/`GET_WINDOW_BOUNDS`/`createPetWindow()` 调用/初始 `PET_WINDOW_SIZE` 引用相关的错误,留给 Task 14)。

- [ ] **Step 6: Commit**

```bash
git add src/main/shell/index.ts
git commit -m "refactor(main): switchPet() 改为准备-提交协议,渲染层确认新模型就绪后才提交会话切换"
```

---

## Task 14: 初始窗口尺寸 + `MOVE_WINDOW`/`GET_WINDOW_BOUNDS` 去硬编码 + 气泡锚点接线

**Files:**
- Modify: `src/main/shell/index.ts`

**Interfaces:**
- Consumes: Task 12 的 `createPetWindow` 新签名、Task 1 的 `windowSizeForSource`。
- Produces:`startShell` 改为 `async function startShell(): Promise<void>`;`petWin` 创建时用真实初始宠物的尺寸;`MOVE_WINDOW` 不再假设 `PET_WINDOW_SIZE`,改用 `petWin.getSize()` 的当前真实尺寸;气泡相关调用传入当前宠物的 `bubbleAnchorX/Y`。

- [ ] **Step 1: 读取 `src/main/shell/index.ts` 当前 `export function startShell(): void { ... }` 开头到 `const petWin = createPetWindow(...)` 之间的部分,以及 `MOVE_WINDOW` 完整 handler、`petBoundsFull`/`petWorkArea`/`showAmbientLine`/`refreshBubble` 定义(前面 Explore 已读过,改动前重新确认——本文件此时已被 Task 13 改过,行号会漂移）**

- [ ] **Step 2: `startShell` 改为 async,创建窗口前先算好初始尺寸**

把:

```ts
export function startShell(): void {
```

改成:

```ts
export async function startShell(): Promise<void> {
```

把:

```ts
  const petWin = createPetWindow({ preload, url: rendererUrl, indexHtml: petHtml })
```

改成:

```ts
  const initialSource = await loadPet(join(resolved.petHome.petHome))
  const petWin = createPetWindow({
    preload, url: rendererUrl, indexHtml: petHtml,
    initialSize: windowSizeForSource(initialSource)
  })
```

（`resolved.petHome.petHome` 就是 `effectivePetId` 对应的宠物家目录,前面 `basename(resolved.petHome.petHome)` 已经这么用过一次;这里直接读一次 manifest 只是为了拿尺寸,不影响后面 `createPetSession(effectivePetId, sessionDeps)` 内部自己再走一遍 `ensurePetHome`——两者是独立的两次读,不需要合并,保持每个函数职责单一。）

- [ ] **Step 3: 确认 `main/index.ts` 里的调用方不受影响**

Run: 打开 `src/main/index.ts:95` 附近确认 `.then(() => startShell())` 这一行——`startShell()` 现在返回 `Promise<void>`,`.then()` 会自动等待它,原有的 `.catch((e) => { logDiag('startShell threw', e) })` 逻辑不需要改動,异步内部抛出的错误会正常被这个 `.catch` 捕获。此步骤只是确认,不需要改代码。

- [ ] **Step 4: `MOVE_WINDOW` handler 去掉对 `PET_WINDOW_SIZE` 常量的依赖,改读窗口当前真实尺寸**

把整个 `MOVE_WINDOW` handler 里所有 `PET_WINDOW_SIZE.width`/`PET_WINDOW_SIZE.height`/`PET_WINDOW_SIZE`(共 6 处:autonomous walk 分支的 `getDisplayMatching`/`finalX`/`finalY` 三处夹取、`dragAnchor` 分支的 `getDisplayMatching`、fallback 分支的 `getDisplayMatching`、末尾 `petWin.setBounds(fixedWindowBounds(finalX, finalY, PET_WINDOW_SIZE))` 和返回值里的 `width: PET_WINDOW_SIZE.width, height: PET_WINDOW_SIZE.height`),替换成 handler 开头已经取到的当前真实尺寸:

在 handler 最前面(`const [x, y] = petWin.getPosition()` 那一行之后)已经有:

```ts
  const [width, height] = petWin.getSize()
```

后续所有原本写 `PET_WINDOW_SIZE.width`/`PET_WINDOW_SIZE.height` 的地方,全部改成这里已经取到的局部变量 `width`/`height`;所有原本写 `PET_WINDOW_SIZE`(作为整个 `{width,height}` 对象传参,如 `fixedWindowBounds(finalX, finalY, PET_WINDOW_SIZE)`)的地方,改成 `fixedWindowBounds(finalX, finalY, { width, height })`。这样窗口拖拽/自主游走的边界夹取,始终针对"这只宠物实际的窗口尺寸"而不是一个全局常量——因为不同宠物窗口尺寸不同(Task 1 的 `windowSizeForSource`),继续用固定常量夹取会对高个子/矮个子模型算错边界。

移除文件顶部 `import { createPetWindow, PET_WINDOW_SIZE } from './petWindow'` 里的 `PET_WINDOW_SIZE`(只留 `createPetWindow`),因为 `petWindow.ts` 已经不再导出它(Task 12)。

- [ ] **Step 5: 气泡锚点 —— 确认本任务范围止于 Task 2 交付的能力,不在 `index.ts` 接线每宠物 manifest 值**

`bubblePlacement()`(Task 2)已经支持可选的 `anchorFrac` 参数,不传时默认 `{x:0.5,y:0}`。本任务**不**修改 `showAmbientLine()`/`refreshBubble()`/`MOVE_WINDOW` handler/`BUBBLE_RESIZE` handler 里现有的 `bubble.show(petBoundsFull(), petWorkArea())` 等调用——它们继续三参数调用,`bubblePlacement()` 内部用默认锚点,精灵包和当前唯一验证过的行为路径完全不变。

原因:要把"当前宠物的 `bubbleAnchorX/Y`"真正接进这些调用点,需要在这些同步函数里同步拿到当前宠物 manifest 的这两个字段;但 `loadPet()` 是异步的,而现有 `PetSession` 接口(`petSession.ts:97-111`)也没有缓存/暴露 manifest 本身——要做全需要先扩大 `PetSession` 接口 + `createPetSession()` 内部逻辑,这是一处比"锚点计算能力"更大的改动面,超出本任务范围。**决定**:本计划到此为止只交付"能力"本身(Task 2 的 `bubblePlacement()` 可选参数),真正"每只宠物都用自己的气泡锚点"留到有真实需求时(某个 Live2D 宠物包因为头顶不在默认位置导致气泡明显对不上)再单独接线——这是范围内的合理裁剪,不是遗漏,写在这里供以后的会话/审查参考。

- [ ] **Step 6: 自查:确认与设计文档的差异是有意为之**

重新读一遍设计文档 §6("气泡锚点泛化")——它写的是"`bubblePlacement()` 新增第四个参数...Live2D 包调用方...传入当前会话 manifest 的 `render.transform.bubbleAnchorX/Y`"。这句话描述的能力已经在 Task 2 交付;Step 5 记录的裁剪只是"暂不在 `index.ts` 接线真实值",接口本身向后兼容、随时可以在后续任务里补上,不影响本阶段任何验收标准。

- [ ] **Step 7: typecheck**

Run: `pnpm typecheck`
Expected: 通过,不再有 `PET_WINDOW_SIZE` 相关报错。

- [ ] **Step 8: 全量测试**

Run: `pnpm test`
Expected: 全部通过。

- [ ] **Step 9: Commit**

```bash
git add src/main/shell/index.ts
git commit -m "feat(main): 初始宠物窗口尺寸按 pet.json 动态计算,MOVE_WINDOW 改用真实窗口尺寸而非固定常量"
```

---

## Task 15: 场景可见性信号(最小化/恢复/锁屏/解锁 → `WINDOW_VISIBILITY_CHANGED`)

**Files:**
- Modify: `src/main/shell/index.ts`

**Interfaces:**
- Consumes: Task 5 的 `IPC.WINDOW_VISIBILITY_CHANGED`。
- Produces: 主进程在 `petWin`/`powerMonitor` 相关事件上推送 `WINDOW_VISIBILITY_CHANGED`,驱动 Task 9 已经实现的 `Live2DPetRenderer.setVisible()` 场景节流(隐藏/最小化/锁屏 → 0 FPS)。

- [ ] **Step 1: 读取 `src/main/shell/index.ts` 里 `startIdleWatcher(petWin)` 调用附近的代码(`idleWatcher` 挂载点),以及顶部 `import { powerMonitor, ... } from 'electron'` 当前的具体导入项**

- [ ] **Step 2: 实现**

在文件顶部 `import { app, ipcMain, safeStorage, screen, shell as electronShell, dialog as electronDialog, clipboard, Notification, BrowserWindow, type Tray } from 'electron'` 这一行,追加 `powerMonitor`:

```ts
import { app, ipcMain, safeStorage, screen, shell as electronShell, dialog as electronDialog, clipboard, Notification, BrowserWindow, powerMonitor, type Tray } from 'electron'
```

紧挨着 `const idleWatcher = startIdleWatcher(petWin)` 之后新增:

```ts
  function sendWindowVisibility(visible: boolean): void {
    petWin.webContents.send(IPC.WINDOW_VISIBILITY_CHANGED, { visible })
  }
  petWin.on('minimize', () => sendWindowVisibility(false))
  petWin.on('restore', () => sendWindowVisibility(true))
  powerMonitor.on('lock-screen', () => sendWindowVisibility(false))
  powerMonitor.on('unlock-screen', () => sendWindowVisibility(true))
```

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 4: 全量测试**

Run: `pnpm test`
Expected: 通过(本任务不新增自动化测试——`petWin.on(...)`/`powerMonitor.on(...)` 是 Electron 事件订阅,和 `idleWatcher.ts` 里已有的 `powerMonitor.getSystemIdleTime()` 轮询一样,项目里从未对这类真实系统事件写过 mock 单测,真机验收见 Task 16)。

- [ ] **Step 5: Commit**

```bash
git add src/main/shell/index.ts
git commit -m "feat(main): 最小化/恢复/锁屏/解锁事件推送 WINDOW_VISIBILITY_CHANGED,驱动 Live2D 场景帧率节流"
```

---

## Task 16: 全量回归 + 真机验收

**Files:** 无代码改动,纯验证任务。

- [ ] **Step 1: 全量自动化回归**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: 全部通过,`pnpm build` 产出三个 bundle 无报错。

- [ ] **Step 2: 真机走查(需要真实 Windows 桌面环境,写清楚每一条具体检查什么)**

`pnpm build && pnpm preview`(比 `pnpm dev` 更接近打包版,启动更稳),用现有的精灵宠物包(如 `luluka`)+ 至少一个真实 Live2D 宠物包(本仓库/CI 不分发,需要用户本地已有的授权模型,若没有则至少完成精灵包相关的第 1-4 项):

1. 冷启动:宠物窗口尺寸是否等于该宠物 `pet.json` 算出来的尺寸(精灵包应该和之前视觉上一致;Live2D 包应该不再是固定 256×288);同时确认 Live2D 模型的自动对齐比例/位置和 Phase 4 验收过的效果一致(Task 9 把 `setupModel()`/`autoFit()` 调用挪到了 `app.stage.addChild(model)` 之前,若比例/位置跑偏,大概率是这处顺序调整导致的,需要回头看 Task 9 的相关说明)。
2. 拖拽宠物到桌面各个角落,确认拖拽手感与之前一致(`resizable:true` 是否意外让窗口边缘出现可拖拽调整大小的鼠标热区,干扰点击穿透/正常拖拽——这是本阶段最需要肉眼确认的风险点)。
3. 通过对话框头像点击热切换到另一个宠物(同类型,如两个精灵包之间切换):确认切换瞬间旧宠物画面持续显示到最后一刻、没有黑屏/白屏。
4. 如果本地有两个 Live2D 宠物包:互相热切换,确认同样无黑屏/白屏(这是验证"同类型走 prepareSwap/commitSwap、不重建 Application"是否真的生效的关键场景)。
5. 精灵包 ↔ Live2D 包之间热切换:确认体验与 Phase 4 一致(允许有一次切换过程中的短暂空白,这是设计文档非目标里明确写的"跨类型必须换 canvas",不是回归)。
6. 切换到窗口尺寸明显不同的两个 Live2D 模型(如果本地有):确认宠物"脚底"位置在屏幕上视觉上没有跳动或明显偏移。
7. 切到另一只宠物后,确认对话框左栏历史/头像高亮、气泡内容都正确刷新,没有串到旧宠物的内容。
8. 故意制造一次切换失败(例如:把目标宠物的 `model3.json` 临时改名/损坏后再切换过去):确认报错提示出现、旧宠物完全没受影响(画面/会话都还是旧的)、可以正常再切回来或切到其它宠物。
9. 最小化宠物窗口所在的桌面(如果可行)/锁屏一段时间再解锁:用任务管理器或 DevTools 观察 Live2D 宠物在隐藏期间是否停止渲染(CPU/GPU 占用下降),恢复后动画正常继续。
10. 宠物在待机(idle)/拖拽/睡眠三种状态下,用 DevTools Performance 面板或 `window.__kiboLive2D.app.ticker.FPS` 粗略确认帧率大致符合 idle≈30、拖拽≈60、睡眠≈15 的量级(不要求精确对齐)。
11. 无 `HitArea` 的 Live2D 模型:确认点击穿透(鼠标移到模型透明区域外能穿透到下层窗口)在新的动态窗口尺寸下依然准确。

- [ ] **Step 3: 记录真机验收结果**

在 `PROGRESS.md` 里追加本阶段完成状态和上面清单里哪些项已经真机确认、哪些仍待用户验收(遵循项目一贯的 PROGRESS.md 记录风格)。这一步等 Task 1-15 全部完成、且执行者至少完成 Step 1 的自动化回归后再做。
