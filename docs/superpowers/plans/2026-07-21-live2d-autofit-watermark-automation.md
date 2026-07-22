# Live2D 首次自动对齐 + 水印自动破冰 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把真机联调时靠 DevTools Console 手动完成的两件事——Live2D 模型首次加载时的缩放/位置对齐、水印告示卡死的表情破冰——自动化,让"导入宠物包"之后不需要打开控制台。

**Architecture:** 在 `pet.json` 的 `Live2DManifest.render` 里新增两个持久化标记字段(`transform.autoFitted` / `possibleWatermark`)。导入阶段(`petCatalog.importLive2DPet`)在检测到"原始模型没有声明任何动作/表情"时把 `possibleWatermark` 写回 staging 里的 `pet.json`。运行时(`Live2DPetRenderer.load()`)在模型加入 stage、第一帧渲染之前:①若 `autoFitted` 不是 `true`,同步跑已有的 `autoFit()` 算法算出并应用 scale/位置,再通过既有的 `IPC.UPDATE_LIVE2D_TRANSFORM` 通道写回、标记 `autoFitted:true`;②若 `possibleWatermark` 为 `true` 且 `stateMap.idle` 没有显式声明 `expression`,自动挑一个模型自带的表情调用一次尝试破冰。两处判断逻辑抽成独立的纯函数模块以便单测,渲染器主体只负责编排调用。原有的 `window.__kiboLive2D` DevTools 调试挂钩保留,重新定位为自动机制之外的高级故障排查手段。

**Tech Stack:** TypeScript, Electron (main/preload/renderer), Vitest, `untitled-pixi-live2d-engine` (Live2D Cubism 3/4/5 引擎), pixi.js。

## Global Constraints

- **不加 `"type": "module"`** 到 `package.json`(Electron main/preload 必须是 CommonJS)。
- **自动对齐必须在第一帧渲染前同步完成**,不能出现"先显示错误比例再纠正"的闪烁——`autoFit()` 内部的 `scale.set`/`position.set` 已经是同步调用,只需确保调用时机在 `app.init()`/模型入栈之后、`load()` 返回之前。
- **`model.expression()`/`model.motion()` 的返回值不可靠**,不要用返回值判断成功与否(真机联调已验证的教训,引擎自身的待机动作选择机制会跟显式调用产生优先级竞争)。
- **`patchLive2DTransform` 只覆盖 `render.transform` 里的 `scale`/`offsetX`/`offsetY`/`autoFitted` 四个字段**,`anchorX`/`anchorY`/`bubbleAnchorX`/`bubbleAnchorY` 等宠物包作者自定的锚点语义原样保留。
- **`importLive2DPet` 只在检测到水印时才多写一次 `pet.json`**,非水印模型的 `pet.json` 保持 `cpSync` 原样,不引入无意义的字段变化。
- **调试工具 `window.__kiboLive2D` 不删除**,只更新注释说明它是高级故障排查手段。
- **`docs/making-a-pet.md` 的"另一种做法:导入 Live2D 模型"一节要跟这次改造一起更新**。
- 真机验证素材:`tu`(茕兔,`D:\LProject\claude_Project\live2dModel\tu\` / `%APPDATA%\kibo-pet\pets\tu\`,游离资源找回成功、可验证表情破冰真的有效)、`bai`(白,`D:\LProject\claude_Project\live2dModel\bai\` / `%APPDATA%\kibo-pet\pets\bai\`,没有任何真实表情可找回,用来验证"无解情况下不报错/不死循环")。

---

### Task 1: `pet.json` 类型 + 校验新增 `autoFitted`/`possibleWatermark`

**Files:**
- Modify: `src/shared/petPackage.ts:70-99`(`Live2DTransform`/`Live2DRender` 接口 + `parseLive2DManifest`)
- Test: `src/shared/petPackage.test.ts:125-195`

**Interfaces:**
- Consumes: 无(纯类型/校验层,不依赖其他任务)
- Produces:
  - `Live2DTransform.autoFitted?: boolean`(Task 2/3/4 会读写这个字段)
  - `Live2DRender.possibleWatermark?: boolean`(Task 3/4/5 会读写这个字段)
  - `parseLive2DManifest(raw): Live2DManifest` 在两个字段存在但类型错误时抛错,不存在时正常通过

- [ ] **Step 1: 写失败的测试**

在 `src/shared/petPackage.test.ts` 的 `describe('parseLive2DManifest', ...)` 块(约第 158-195 行)末尾,`it('accepts optional thumbnail string', ...)` 之后新增:

```ts
  it('accepts optional transform.autoFitted boolean', () => {
    const m = parseLive2DManifest({
      ...validLive2D,
      render: { ...validLive2D.render, transform: { ...validLive2D.render.transform, autoFitted: true } }
    })
    expect(m.render.transform.autoFitted).toBe(true)
  })
  it('rejects non-boolean transform.autoFitted', () => {
    const bad = {
      ...validLive2D,
      render: { ...validLive2D.render, transform: { ...validLive2D.render.transform, autoFitted: 'yes' } }
    }
    expect(() => parseLive2DManifest(bad)).toThrow(/autoFitted/)
  })
  it('accepts optional render.possibleWatermark boolean', () => {
    const m = parseLive2DManifest({ ...validLive2D, render: { ...validLive2D.render, possibleWatermark: true } })
    expect(m.render.possibleWatermark).toBe(true)
  })
  it('rejects non-boolean render.possibleWatermark', () => {
    const bad = { ...validLive2D, render: { ...validLive2D.render, possibleWatermark: 'yes' } }
    expect(() => parseLive2DManifest(bad)).toThrow(/possibleWatermark/)
  })
  it('both fields absent from a legacy manifest still parse fine', () => {
    const m = parseLive2DManifest(validLive2D)
    expect(m.render.transform.autoFitted).toBeUndefined()
    expect(m.render.possibleWatermark).toBeUndefined()
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/shared/petPackage.test.ts -t "autoFitted|possibleWatermark"`
Expected: 新增的用例里,"accepts" 两条因为 TS 类型还没加 `autoFitted`/`possibleWatermark` 会在 `expect(m.render...)` 处报 `undefined` 不等于预期值而 FAIL;"rejects" 两条因为校验逻辑还没加,不会抛错,`toThrow` 断言 FAIL。

- [ ] **Step 3: 实现类型 + 校验**

在 `src/shared/petPackage.ts` 里,把:

```ts
export interface Live2DTransform {
  scale: number; offsetX: number; offsetY: number
  anchorX: number; anchorY: number
  bubbleAnchorX: number; bubbleAnchorY: number
}
```

改成:

```ts
export interface Live2DTransform {
  scale: number; offsetX: number; offsetY: number
  anchorX: number; anchorY: number
  bubbleAnchorX: number; bubbleAnchorY: number
  /** true 表示已经跑过一次自动测算(或被人工核对/覆盖过),Live2DPetRenderer.load() 不需要重新计算。 */
  autoFitted?: boolean
}
```

把:

```ts
export interface Live2DRender {
  type: 'live2d'
  model: string
  viewport: Live2DViewport
  transform: Live2DTransform
  interaction: Live2DInteraction
  stateMap: Record<string, Live2DStateMapEntry>
}
```

改成:

```ts
export interface Live2DRender {
  type: 'live2d'
  model: string
  viewport: Live2DViewport
  transform: Live2DTransform
  interaction: Live2DInteraction
  stateMap: Record<string, Live2DStateMapEntry>
  /** 导入时检测到模型原始没有声明任何动作/表情(见 live2dOrphanResources.detectPossibleWatermarkProtection),
   *  运行时据此尝试自动破冰(见 Live2DPetRenderer.load())。 */
  possibleWatermark?: boolean
}
```

在 `parseLive2DManifest` 里,把:

```ts
  const tr = r.transform
  assert(tr && typeof tr === 'object', 'manifest.render.transform is required')
  for (const k of ['scale', 'offsetX', 'offsetY', 'anchorX', 'anchorY', 'bubbleAnchorX', 'bubbleAnchorY']) {
    assert(typeof tr[k] === 'number', `manifest.render.transform.${k} must be a number`)
  }
```

改成:

```ts
  const tr = r.transform
  assert(tr && typeof tr === 'object', 'manifest.render.transform is required')
  for (const k of ['scale', 'offsetX', 'offsetY', 'anchorX', 'anchorY', 'bubbleAnchorX', 'bubbleAnchorY']) {
    assert(typeof tr[k] === 'number', `manifest.render.transform.${k} must be a number`)
  }
  if (tr.autoFitted !== undefined) {
    assert(typeof tr.autoFitted === 'boolean', 'manifest.render.transform.autoFitted must be a boolean when present')
  }
```

并在紧接着的 `it`(即 `assert(typeof r.model === 'string' ...)`)那一行之后加一行:

```ts
  assert(typeof r.model === 'string' && r.model.length > 0, 'manifest.render.model must be a non-empty string')
  if (r.possibleWatermark !== undefined) {
    assert(typeof r.possibleWatermark === 'boolean', 'manifest.render.possibleWatermark must be a boolean when present')
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/shared/petPackage.test.ts`
Expected: 全部 PASS(含新增 5 条 + 原有用例)

- [ ] **Step 5: Commit**

```bash
git add src/shared/petPackage.ts src/shared/petPackage.test.ts
git commit -m "feat(petPackage): Live2DManifest 新增 autoFitted/possibleWatermark 可选字段"
```

---

### Task 2: IPC 契约 + `patchLive2DTransform` 支持 `autoFitted`

**Files:**
- Modify: `src/shared/ipc.ts:143-153`(`PetApi.updateLive2DTransform` 注释 + `Live2DTransformPatch` 接口)
- Modify: `src/main/pets/live2dTransformPatch.ts`
- Test: `src/main/pets/live2dTransformPatch.test.ts`

**Interfaces:**
- Consumes: 无新依赖(`Live2DTransformPatch` 是独立类型,不依赖 Task 1 的 `Live2DTransform`)
- Produces:
  - `Live2DTransformPatch { scale: number; offsetX: number; offsetY: number; autoFitted: boolean }`(Task 4 的渲染器代码 + 现有调试挂钩都要传这个字段)
  - `patchLive2DTransform(raw, patch): PatchResult` 写回的 `render.transform` 含 `autoFitted`

- [ ] **Step 1: 写失败的测试**

用下面内容整体替换 `src/main/pets/live2dTransformPatch.test.ts`(在原有用例基础上,所有 patch 参数补上 `autoFitted`,并新增 3 条 `autoFitted` 专属用例):

```ts
import { describe, it, expect } from 'vitest'
import { patchLive2DTransform } from './live2dTransformPatch'

function makeLive2DManifest(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'tu',
    displayName: '茕兔',
    description: '茕兔桌面宠物',
    render: {
      type: 'live2d',
      model: '茕兔/茕兔.model3.json',
      viewport: { width: 360, height: 480, resolutionCap: 1.5 },
      transform: { scale: 1, offsetX: 0, offsetY: 0, anchorX: 0.5, anchorY: 1, bubbleAnchorX: 0.5, bubbleAnchorY: 0 },
      interaction: { mirrorOnWalk: true, mouseTracking: true, lipSyncParameter: 'ParamMouthOpenY' },
      stateMap: { idle: { motionGroup: 'Recovered', selection: 'random', loop: true, expression: 'sy' } }
    }
  }
}

describe('patchLive2DTransform', () => {
  it('只覆盖 scale/offsetX/offsetY/autoFitted,其余 transform 字段和整份 manifest 不变', () => {
    const raw = makeLive2DManifest()
    const result = patchLive2DTransform(raw, { scale: 0.0267, offsetX: 0, offsetY: 136, autoFitted: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const render = (result.raw as any).render
    expect(render.transform).toEqual({
      scale: 0.0267, offsetX: 0, offsetY: 136, anchorX: 0.5, anchorY: 1, bubbleAnchorX: 0.5, bubbleAnchorY: 0, autoFitted: true
    })
    // stateMap/其余字段原样保留
    expect((result.raw as any).render.stateMap).toEqual(raw.render && (raw.render as any).stateMap)
    expect((result.raw as any).id).toBe('tu')
  })

  it('不修改传入的原始对象(返回一份新对象)', () => {
    const raw = makeLive2DManifest()
    const originalTransform = { ...(raw.render as any).transform }
    patchLive2DTransform(raw, { scale: 5, offsetX: 1, offsetY: 2, autoFitted: true })
    expect((raw.render as any).transform).toEqual(originalTransform)
  })

  it('raw 不是对象时返回 ok:false', () => {
    expect(patchLive2DTransform(null, { scale: 1, offsetX: 0, offsetY: 0, autoFitted: true })).toMatchObject({ ok: false })
    expect(patchLive2DTransform('x', { scale: 1, offsetX: 0, offsetY: 0, autoFitted: true })).toMatchObject({ ok: false })
  })

  it('render.type 不是 live2d 时返回 ok:false(sprite 包不允许走这个通道)', () => {
    const raw = { render: { type: 'sprite' } }
    const result = patchLive2DTransform(raw, { scale: 1, offsetX: 0, offsetY: 0, autoFitted: true })
    expect(result).toMatchObject({ ok: false })
  })

  it('render.transform 缺失时返回 ok:false', () => {
    const raw = { render: { type: 'live2d' } }
    const result = patchLive2DTransform(raw, { scale: 1, offsetX: 0, offsetY: 0, autoFitted: true })
    expect(result).toMatchObject({ ok: false })
  })

  it('scale/offsetX/offsetY 必须是有限数字,否则返回 ok:false', () => {
    const raw = makeLive2DManifest()
    expect(patchLive2DTransform(raw, { scale: NaN, offsetX: 0, offsetY: 0, autoFitted: true })).toMatchObject({ ok: false })
    expect(patchLive2DTransform(raw, { scale: Infinity, offsetX: 0, offsetY: 0, autoFitted: true })).toMatchObject({ ok: false })
    expect(patchLive2DTransform(raw, { scale: 1, offsetX: 0, offsetY: 0, autoFitted: true })).toMatchObject({ ok: true })
  })

  it('autoFitted 必须是 boolean,否则返回 ok:false', () => {
    const raw = makeLive2DManifest()
    expect(patchLive2DTransform(raw, { scale: 1, offsetX: 0, offsetY: 0, autoFitted: 'yes' as any })).toMatchObject({ ok: false })
    expect(patchLive2DTransform(raw, { scale: 1, offsetX: 0, offsetY: 0 } as any)).toMatchObject({ ok: false })
  })

  it('autoFitted:false 也是合法输入(比如未来允许手动标记回退)', () => {
    const raw = makeLive2DManifest()
    const result = patchLive2DTransform(raw, { scale: 1, offsetX: 0, offsetY: 0, autoFitted: false })
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.raw as any).render.transform.autoFitted).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/pets/live2dTransformPatch.test.ts`
Expected: FAIL——新增的 `autoFitted` 相关断言会失败(`Live2DTransformPatch` 类型还没有这个字段,`patchLive2DTransform` 还不写回它;现有的数字校验循环遇到 `autoFitted` 这个非数字字段会被误判成"必须是有限数字"导致原本应该 `ok:true` 的用例变成 `ok:false`)。

- [ ] **Step 3: 实现**

在 `src/shared/ipc.ts` 里,把:

```ts
export interface Live2DTransformPatch {
  scale: number
  offsetX: number
  offsetY: number
}
```

改成:

```ts
export interface Live2DTransformPatch {
  scale: number
  offsetX: number
  offsetY: number
  /** true=这次写入代表最终对齐值(自动测算完成,或人工核对后通过调试挂钩确认),
   *  Live2DPetRenderer.load() 之后不会再重新计算。 */
  autoFitted: boolean
}
```

同时把 `PetApi.updateLive2DTransform` 上方的注释(现文案:"调试用:把 Live2DPetRenderer.autoFit() 算出来的 scale/offsetX/offsetY 写回当前宠物的 pet.json(只覆盖这三个字段,anchorX/anchorY/bubbleAnchorX/bubbleAnchorY 不变)。只有当前宠物是 live2d 包时才会成功。")改成:

```ts
  /** 把 scale/offsetX/offsetY/autoFitted 写回当前宠物的 pet.json(只覆盖这四个字段,
   *  anchorX/anchorY/bubbleAnchorX/bubbleAnchorY 不变)。两个调用方:Live2DPetRenderer.load()
   *  首次加载时的自动对齐,以及 window.__kiboLive2D 调试挂钩的人工核对/覆盖。
   *  只有当前宠物是 live2d 包时才会成功。 */
  updateLive2DTransform(patch: Live2DTransformPatch): Promise<{ ok: boolean; message?: string }>
```

在 `src/main/pets/live2dTransformPatch.ts` 里,把:

```ts
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, reason: `${key} 必须是有限数字` }
    }
  }
  return {
    ok: true,
    raw: {
      ...m,
      render: {
        ...render,
        transform: { ...transform, scale: patch.scale, offsetX: patch.offsetX, offsetY: patch.offsetY }
      }
    }
  }
```

改成:

```ts
  for (const key of ['scale', 'offsetX', 'offsetY'] as const) {
    const value = patch[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, reason: `${key} 必须是有限数字` }
    }
  }
  if (typeof patch.autoFitted !== 'boolean') {
    return { ok: false, reason: 'autoFitted 必须是 boolean' }
  }
  return {
    ok: true,
    raw: {
      ...m,
      render: {
        ...render,
        transform: { ...transform, scale: patch.scale, offsetX: patch.offsetX, offsetY: patch.offsetY, autoFitted: patch.autoFitted }
      }
    }
  }
```

也更新该文件顶部的函数注释,把"只覆盖 pet.json 的 render.transform.{scale,offsetX,offsetY} 三个字段"改成"...{scale,offsetX,offsetY,autoFitted} 四个字段"。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/pets/live2dTransformPatch.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 全量跑一次受影响的测试,确认没有破坏其他引用方**

Run: `pnpm vitest run src/main/pets src/shared`
Expected: 全部 PASS(`live2dTransformPatch` 目前只被 `src/main/shell/index.ts` 的 handler 调用,handler 是直接透传 `patch`,不需要改动;但仍需确认没有其他隐藏引用受影响)

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc.ts src/main/pets/live2dTransformPatch.ts src/main/pets/live2dTransformPatch.test.ts
git commit -m "feat(ipc): Live2DTransformPatch 新增必填 autoFitted 字段"
```

---

### Task 3: 抽取可测的纯判断逻辑 — `live2dAutoSetup.ts`

**Files:**
- Create: `src/renderer/live2dAutoSetup.ts`
- Test: `src/renderer/live2dAutoSetup.test.ts`

**Interfaces:**
- Consumes: `Live2DManifest`/`Live2DTransform` 类型(来自 Task 1 的 `src/shared/petPackage.ts`)
- Produces(Task 4 会在 `live2dRenderer.ts` 里 import 并调用这两个函数):
  - `needsAutoFit(transform: Live2DTransform): boolean`
  - `pickWatermarkBreakExpressionName(manifest: Live2DManifest, definitions: { Name: string }[] | undefined): string | undefined`

**背景:** `Live2DPetRenderer` 主体依赖真实 WebGL/Live2D 引擎,没法在 Vitest(jsdom/node 环境)里整体跑起来单测。参照现有 `live2dStateMapResolver.ts`(纯函数 + 独立测试文件,被 `live2dRenderer.ts` import 调用)的既有模式,把"要不要自动对齐"、"要不要破冰以及挑哪个表情名字"这两处判断逻辑抽成不依赖引擎实例的纯函数,渲染器主体只负责按判断结果调用引擎 API。

- [ ] **Step 1: 写失败的测试**

创建 `src/renderer/live2dAutoSetup.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { needsAutoFit, pickWatermarkBreakExpressionName } from './live2dAutoSetup'
import type { Live2DManifest, Live2DTransform } from '@shared/petPackage'

function makeTransform(overrides: Partial<Live2DTransform> = {}): Live2DTransform {
  return { scale: 1, offsetX: 0, offsetY: 0, anchorX: 0.5, anchorY: 1, bubbleAnchorX: 0.5, bubbleAnchorY: 0, ...overrides }
}

function makeManifest(overrides: { possibleWatermark?: boolean; idleExpression?: string } = {}): Live2DManifest {
  return {
    schemaVersion: 2,
    id: 'tu', displayName: '茕兔', description: 'x',
    render: {
      type: 'live2d',
      model: 'model/character.model3.json',
      viewport: { width: 360, height: 480, resolutionCap: 1.5 },
      transform: makeTransform(),
      interaction: { mirrorOnWalk: true, mouseTracking: true, lipSyncParameter: 'ParamMouthOpenY' },
      stateMap: overrides.idleExpression
        ? { idle: { motionGroup: 'Recovered', selection: 'random', loop: true, expression: overrides.idleExpression } }
        : { idle: { motionGroup: 'Recovered', selection: 'random', loop: true } },
      ...(overrides.possibleWatermark !== undefined ? { possibleWatermark: overrides.possibleWatermark } : {})
    }
  }
}

describe('needsAutoFit', () => {
  it('autoFitted 未设置时需要自动对齐', () => {
    expect(needsAutoFit(makeTransform())).toBe(true)
  })
  it('autoFitted:false 时仍需要自动对齐', () => {
    expect(needsAutoFit(makeTransform({ autoFitted: false }))).toBe(true)
  })
  it('autoFitted:true 时不需要', () => {
    expect(needsAutoFit(makeTransform({ autoFitted: true }))).toBe(false)
  })
})

describe('pickWatermarkBreakExpressionName', () => {
  it('possibleWatermark 不是 true 时返回 undefined(即便有可用表情)', () => {
    const manifest = makeManifest({ possibleWatermark: false })
    expect(pickWatermarkBreakExpressionName(manifest, [{ Name: 'happy' }])).toBeUndefined()
  })
  it('possibleWatermark 缺失(未声明字段)时返回 undefined', () => {
    const manifest = makeManifest()
    expect(pickWatermarkBreakExpressionName(manifest, [{ Name: 'happy' }])).toBeUndefined()
  })
  it('stateMap.idle 已显式声明 expression 时返回 undefined,不覆盖作者配置', () => {
    const manifest = makeManifest({ possibleWatermark: true, idleExpression: 'sy' })
    expect(pickWatermarkBreakExpressionName(manifest, [{ Name: 'happy' }])).toBeUndefined()
  })
  it('definitions 为 undefined 或空数组时安全返回 undefined,不抛错', () => {
    const manifest = makeManifest({ possibleWatermark: true })
    expect(pickWatermarkBreakExpressionName(manifest, undefined)).toBeUndefined()
    expect(pickWatermarkBreakExpressionName(manifest, [])).toBeUndefined()
  })
  it('满足条件时返回第一个可用表情的名字', () => {
    const manifest = makeManifest({ possibleWatermark: true })
    expect(pickWatermarkBreakExpressionName(manifest, [{ Name: 'happy' }, { Name: 'sad' }])).toBe('happy')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/renderer/live2dAutoSetup.test.ts`
Expected: FAIL,报 `Cannot find module './live2dAutoSetup'`(文件还不存在)

- [ ] **Step 3: 实现**

创建 `src/renderer/live2dAutoSetup.ts`:

```ts
import type { Live2DManifest, Live2DTransform } from '@shared/petPackage'

/** transform.autoFitted 不是 true(缺失或显式 false)时都需要跑一次自动测算——只有明确
 *  标记过 true 的包才代表"已经算过/人工调过,不要再猜"。 */
export function needsAutoFit(transform: Live2DTransform): boolean {
  return transform.autoFitted !== true
}

export interface ExpressionDefinition {
  Name: string
}

/** 判断是否需要用一个表情尝试破冰、以及挑哪一个:只有 possibleWatermark===true
 *  (导入时检测到原始模型没有声明任何动作/表情)且 stateMap.idle 没有显式声明
 *  expression(尊重宠物包作者的显式配置,不覆盖)时才触发,取模型自带的第一个可用表情。
 *  引擎侧的 expressionManager 不存在或没有表情时 definitions 会是 undefined/空数组,
 *  这里安全返回 undefined,调用方据此跳过,不报错、不重试。 */
export function pickWatermarkBreakExpressionName(
  manifest: Live2DManifest,
  definitions: ExpressionDefinition[] | undefined
): string | undefined {
  if (manifest.render.possibleWatermark !== true) return undefined
  if (manifest.render.stateMap.idle?.expression) return undefined
  return definitions?.[0]?.Name
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/renderer/live2dAutoSetup.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/live2dAutoSetup.ts src/renderer/live2dAutoSetup.test.ts
git commit -m "feat(renderer): 抽取 Live2D 自动对齐/破冰判断逻辑为可测纯函数"
```

---

### Task 4: 渲染器接线 — 首次自动对齐 + 自动破冰 + 调试工具重新定位

**Files:**
- Modify: `src/renderer/live2dRenderer.ts`

**Interfaces:**
- Consumes:
  - `needsAutoFit(transform)`/`pickWatermarkBreakExpressionName(manifest, definitions)`(Task 3)
  - `Live2DTransformPatch { scale, offsetX, offsetY, autoFitted }`(Task 2)
- Produces: 无新导出——这是最终的行为接线点,后续任务(Task 6 文档)引用的是这里产生的用户可见行为,不是代码接口。

**背景:** `Live2DPetRenderer` 依赖真实 WebGL/Live2D 引擎,这个任务没有专门的自动化单测(判断逻辑已经在 Task 3 里单测过了);验证方式是 `pnpm typecheck` + 全量 `pnpm vitest run` 不回归,以及本任务结束后请用户用 `tu`/`bai` 两个已导入模型做一次真机验证(不阻塞任务完成,原因见 CLAUDE.md"自动化检查通过不代表应用能跑"这条约定)。

- [ ] **Step 1: 在 `load()` 里接入自动对齐 + 自动破冰**

把 `src/renderer/live2dRenderer.ts` 顶部的 import 块(第 7-11 行):

```ts
import type { PetRenderSource, Live2DManifest } from '@shared/petPackage'
import type { PetRenderer, PetVisualState, PetHitResult, PetViewport } from './petRenderer'
import { resolveStateMotion, nextSequentialIndex, type ResolvedMotion } from './live2dStateMapResolver'
import { pointInBounds, toCanvasCoords } from './live2dHitTestFallback'
import { applyCubismCoreCompatPatch } from './live2dCubismCoreCompat'
```

改成:

```ts
import type { PetRenderSource, Live2DManifest } from '@shared/petPackage'
import type { PetRenderer, PetVisualState, PetHitResult, PetViewport } from './petRenderer'
import { resolveStateMotion, nextSequentialIndex, type ResolvedMotion } from './live2dStateMapResolver'
import { pointInBounds, toCanvasCoords } from './live2dHitTestFallback'
import { applyCubismCoreCompatPatch } from './live2dCubismCoreCompat'
import { needsAutoFit, pickWatermarkBreakExpressionName, type ExpressionDefinition } from './live2dAutoSetup'
```

把 `load()` 里的这一段(现第 61-67 行):

```ts
    const t = source.manifest.render.transform
    model.anchor.set(t.anchorX, t.anchorY)
    this.baseScale = t.scale
    model.scale.set(this.baseScale)
    model.position.set(app.screen.width / 2 + t.offsetX, app.screen.height / 2 + t.offsetY)
    app.stage.addChild(model)
    this.model = model
```

改成:

```ts
    const t = source.manifest.render.transform
    model.anchor.set(t.anchorX, t.anchorY)
    this.baseScale = t.scale
    model.scale.set(this.baseScale)
    model.position.set(app.screen.width / 2 + t.offsetX, app.screen.height / 2 + t.offsetY)
    app.stage.addChild(model)
    this.model = model

    // 首次自动对齐:autoFit() 内部的 scale.set/position.set 是同步调用,发生在这一帧
    // 渲染之前,不会出现"先显示错误比例再纠正"的闪烁。写回 pet.json 是 fire-and-forget——
    // 失败顶多下次启动重新算一遍,不影响这次的显示效果。
    if (needsAutoFit(t)) {
      const fit = this.autoFit()
      if (fit) void window.petApi.updateLive2DTransform({ ...fit, autoFitted: true })
    }

    // 水印/游离资源找回后仍卡在初始姿势的通用兜底:参见 live2dAutoSetup.ts 的判断逻辑注释。
    const expressionManager = model.internalModel.motionManager.expressionManager as
      | { definitions?: ExpressionDefinition[] }
      | undefined
    const watermarkExpression = pickWatermarkBreakExpressionName(source.manifest, expressionManager?.definitions)
    if (watermarkExpression) void model.expression(watermarkExpression)
```

- [ ] **Step 2: 调试挂钩重新定位 — 更新注释 + `saveFit()` 补上 `autoFitted:true`**

把现第 69-86 行:

```ts
    // 临时调试用:把 app/model 挂到 window 上,方便真机在 DevTools Console 里直接读写
    // scale/position/visible 等属性做实时诊断,不用每次改完都重新 build + 重启。
    // autoFit()/saveFit() 是给这个宠物包定 scale/offsetY 数值用的一次性工具,不是长期
    // 保留的正式 API——真机验证跑通、确定好每个宠物包的 transform 数值之后要删掉这一段。
    let lastFit: { scale: number; offsetX: number; offsetY: number } | null = null
    ;(window as unknown as { __kiboLive2D?: unknown }).__kiboLive2D = {
      app,
      model,
      canvas: this.canvas,
      autoFit: (marginPx?: number) => {
        lastFit = this.autoFit(marginPx)
        return lastFit
      },
      saveFit: async () => {
        if (!lastFit) return { ok: false, message: '还没调用过 autoFit(),没有可保存的数值' }
        return window.petApi.updateLive2DTransform(lastFit)
      }
    }
```

改成:

```ts
    // 高级故障排查用:把 app/model 挂到 window 上,方便在 DevTools Console 里直接读写
    // scale/position/visible 等属性做实时诊断。正常情况下导入后会自动完成对齐(见上面
    // needsAutoFit 分支),这个挂钩只在需要人工核对细节或覆盖自动计算结果(比如某个疑难
    // 模型自动算出来的比例仍不满意)时才用得上,不是主流程的一部分。
    let lastFit: { scale: number; offsetX: number; offsetY: number } | null = null
    ;(window as unknown as { __kiboLive2D?: unknown }).__kiboLive2D = {
      app,
      model,
      canvas: this.canvas,
      autoFit: (marginPx?: number) => {
        lastFit = this.autoFit(marginPx)
        return lastFit
      },
      saveFit: async () => {
        if (!lastFit) return { ok: false, message: '还没调用过 autoFit(),没有可保存的数值' }
        return window.petApi.updateLive2DTransform({ ...lastFit, autoFitted: true })
      }
    }
```

- [ ] **Step 3: 更新 `autoFit()` 私有方法的注释,去掉"调试用"措辞**

把现第 89-92 行的注释:

```ts
  /** 调试用:测量模型在当前 scale 下的真实渲染尺寸,算出一个能让模型完整显示在固定
   *  256x288 画布里(留 marginPx 边距)的 scale,连同"脚底贴着画布底部"的 offsetX/offsetY
   *  一起现场应用并返回——只覆盖这三个字段,不碰 anchorX/anchorY 等宠物包作者自定的锚点语义。
   *  返回值交给调用方(调试挂钩的 saveFit())决定要不要真的写回 pet.json。 */
```

改成:

```ts
  /** 测量模型在当前 scale 下的真实渲染尺寸,算出一个能让模型完整显示在固定 256x288 画布里
   *  (留 marginPx 边距)的 scale,连同"脚底贴着画布底部"的 offsetX/offsetY 一起现场应用并
   *  返回——只覆盖这三个字段,不碰 anchorX/anchorY 等宠物包作者自定的锚点语义。两个调用方:
   *  load() 首次加载时的自动对齐,以及 window.__kiboLive2D 调试挂钩的人工核对/覆盖。 */
```

- [ ] **Step 4: typecheck**

Run: `pnpm typecheck`
Expected: 无报错(留意 `expressionManager?.definitions` 的类型断言与 Task 3 的 `ExpressionDefinition` 是否对齐)

- [ ] **Step 5: 跑全量测试确认不回归**

Run: `pnpm vitest run`
Expected: 全部 PASS(这个任务本身不新增自动化测试,靠这一步确认没有破坏别处)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/live2dRenderer.ts
git commit -m "feat(renderer): Live2D 首次自动对齐 + 水印自动破冰接线,调试挂钩重新定位为高级排查手段"
```

- [ ] **Step 7: 记录真机验证清单(供用户执行,不阻塞本任务完成)**

在任务完成汇报里明确写出以下待用户验证的项(与 spec 的"测试策略"一致),不需要现在执行:
- `tu`:首次 `pnpm preview` 加载后 scale/位置自动写回 `%APPDATA%\kibo-pet\pets\tu\pet.json` 且 `autoFitted:true`;二次启动不再重新计算;`possibleWatermark:true` 且首次加载后自动脱离初始告示画面。
- `bai`:导入/加载不因"无解"而报错或死循环;`possibleWatermark:true` 但没有真实表情可用,自动破冰不生效属预期,画面仍停留在水印图。

---

### Task 5: 导入时持久化水印检测结果

**Files:**
- Modify: `src/main/pets/petCatalog.ts:214-241`(`importLive2DPet()`)
- Test: `src/main/pets/petCatalog.test.ts`

**Interfaces:**
- Consumes: `Live2DRender.possibleWatermark?: boolean`(Task 1)、既有的 `detectPossibleWatermarkProtection(patchedModel3Json): boolean`(`live2dOrphanResources.ts`,未改动)
- Produces: 导入落地后的 `pet.json` 在水印检测为真时含 `render.possibleWatermark: true`(Task 4 的运行时破冰逻辑消费这个字段)

- [ ] **Step 1: 写失败的测试**

在 `src/main/pets/petCatalog.test.ts` 的 `describe('importPetFolder — 统一 staging 流程', ...)` 块里,把现有这条用例(约第 280-286 行):

```ts
  it('live2d 包:补丁后仍无动作/表情 → warnings 含水印提示,但仍然导入成功', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'watermarked', '水印')
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.warnings?.some((w) => w.includes('未声明任何动作'))).toBe(true)
  })
```

改成(补上对落地 `pet.json` 的断言):

```ts
  it('live2d 包:补丁后仍无动作/表情 → warnings 含水印提示,pet.json 打上 possibleWatermark:true,仍然导入成功', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'watermarked', '水印')
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.warnings?.some((w) => w.includes('未声明任何动作'))).toBe(true)
    const written = JSON.parse(readFileSync(join(user, 'watermarked', 'pet.json'), 'utf-8'))
    expect(written.render.possibleWatermark).toBe(true)
  })

  it('live2d 包:游离资源找回后有真实表情/动作 → pet.json 不含 possibleWatermark 字段', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'orphaned2', '游离2')
    writeFileSync(join(petSrc, 'model', 'happy.exp3.json'), '{}')
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    const written = JSON.parse(readFileSync(join(user, 'orphaned2', 'pet.json'), 'utf-8'))
    expect(written.render.possibleWatermark).toBeUndefined()
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/pets/petCatalog.test.ts -t "possibleWatermark"`
Expected: 第一条 FAIL(`written.render.possibleWatermark` 是 `undefined`,不等于 `true`);第二条 PASS(现状本来就没有这个字段,先确认这条是"新增断言但当前实现已经满足"的基线,不影响后续实现)

- [ ] **Step 3: 实现**

在 `src/main/pets/petCatalog.ts` 的 `importLive2DPet()` 里,把:

```ts
  const allModelFiles = listModelFilesRecursive(modelDir)
  const { patchedModel3Json, recoveredExpressionCount, recoveredMotionCount } = scanAndPatchOrphanResources(model3Json, allModelFiles)
  const warnings = [...budget.softWarnings]
  if (recoveredExpressionCount > 0 || recoveredMotionCount > 0) {
    warnings.push(`已自动找回 ${recoveredExpressionCount} 个表情文件、${recoveredMotionCount} 个动作文件`)
  }
  if (detectPossibleWatermarkProtection(patchedModel3Json)) {
    warnings.push('该模型未声明任何动作/表情,可能需要额外处理才能正常显示角色')
  }
```

改成:

```ts
  const allModelFiles = listModelFilesRecursive(modelDir)
  const { patchedModel3Json, recoveredExpressionCount, recoveredMotionCount } = scanAndPatchOrphanResources(model3Json, allModelFiles)
  const possibleWatermark = detectPossibleWatermarkProtection(patchedModel3Json)
  const warnings = [...budget.softWarnings]
  if (recoveredExpressionCount > 0 || recoveredMotionCount > 0) {
    warnings.push(`已自动找回 ${recoveredExpressionCount} 个表情文件、${recoveredMotionCount} 个动作文件`)
  }
  if (possibleWatermark) {
    warnings.push('该模型未声明任何动作/表情,可能需要额外处理才能正常显示角色')
  }
```

再把:

```ts
  try {
    cpSync(srcDir, stagingDir, { recursive: true })
    const modelJsonStagingPath = join(stagingDir, manifest.render.model)
    writeFileSync(modelJsonStagingPath, JSON.stringify(patchedModel3Json, null, 2), 'utf-8')
    const finalDir = join(dirs.userPetsDir, manifest.id)
    renameSync(stagingDir, finalDir)
  } catch (e) {
    rmSync(stagingDir, { recursive: true, force: true })
    return { ok: false, reason: 'copy-failed', message: `导入失败:${(e as Error).message}` }
  }
```

改成:

```ts
  try {
    cpSync(srcDir, stagingDir, { recursive: true })
    const modelJsonStagingPath = join(stagingDir, manifest.render.model)
    writeFileSync(modelJsonStagingPath, JSON.stringify(patchedModel3Json, null, 2), 'utf-8')
    if (possibleWatermark) {
      const petJsonStagingPath = join(stagingDir, 'pet.json')
      const patchedManifest = { ...manifest, render: { ...manifest.render, possibleWatermark: true } }
      writeFileSync(petJsonStagingPath, JSON.stringify(patchedManifest, null, 2), 'utf-8')
    }
    const finalDir = join(dirs.userPetsDir, manifest.id)
    renameSync(stagingDir, finalDir)
  } catch (e) {
    rmSync(stagingDir, { recursive: true, force: true })
    return { ok: false, reason: 'copy-failed', message: `导入失败:${(e as Error).message}` }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/pets/petCatalog.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/pets/petCatalog.ts src/main/pets/petCatalog.test.ts
git commit -m "feat(petCatalog): 导入时把水印检测结果持久化到 pet.json 的 render.possibleWatermark"
```

---

### Task 6: 文档更新 — `docs/making-a-pet.md`

**Files:**
- Modify: `docs/making-a-pet.md:112-154`("另一种做法:导入 Live2D 模型"一节的第 4/6 步)

**Interfaces:**
- Consumes: Task 1-5 落地后的实际行为(自动对齐、自动破冰、调试工具的新定位)
- Produces: 无代码接口——这是给宠物包作者看的使用文档

**背景:** 这一步不涉及代码,不需要跑测试;完成后建议本地过一遍 Markdown 渲染(或直接读 diff)确认没有格式错误。

- [ ] **Step 1: 改写第 4 步"自动测出合适的缩放/位置"**

把现第 112-128 行:

```markdown
### 4. 自动测出合适的缩放/位置

启动 `pnpm preview`,鼠标点在宠物窗口区域上按 **Ctrl+Shift+I**(或 F12)打开开发者工具,切到 Console,跑:

```js
window.__kiboLive2D.autoFit()   // 自动测量模型真实尺寸,算出能让它完整居中显示的 scale/位置并现场应用
```

桌面上会立刻看到效果(默认留 8px 边距;想要不同留白可以传参数,比如 `autoFit(20)`)。看着满意之后:

```js
window.__kiboLive2D.saveFit()   // 把上一步算出来的数值直接写回当前宠物的 pet.json,不用手动改文件
```

这一步会自动找到当前宠物**实际在用**的那份 `pet.json`(导入后应用读的是复制到 `%APPDATA%\kibo-pet\pets\<id>\pet.json` 的那一份,不是原始素材文件夹里的),只覆盖 `scale`/`offsetX`/`offsetY` 三个字段,`anchorX`/`anchorY`/`bubbleAnchorX`/`bubbleAnchorY` 这些锚点语义不会被动。写回后如果想让原始素材文件夹也保持同步(方便以后重新导入),把 `pets/<pet-id>/pet.json` 里的这三个字段手动抄一份过去即可。

如果想自己动手核对细节而不是完全依赖自动计算,也可以直接读写 `window.__kiboLive2D.model`/`.app`(比如 `model.width`、`model.scale.set(...)`、`model.position.y = ...`),`autoFit()`/`saveFit()` 内部做的就是这些事,没有什么额外魔法。
```

改成:

```markdown
### 4. 自动测出合适的缩放/位置

导入后第一次启动 `pnpm preview` 加载这个宠物时,渲染器会自动测量模型真实尺寸,算出能让它完整居中显示(默认留 8px 边距)、"脚底贴底部"的 scale/位置,现场应用后立即写回 `%APPDATA%\kibo-pet\pets\<id>\pet.json`(打上 `render.transform.autoFitted: true`)。以后每次启动都直接读这份写好的数值,不会重复计算——**通常不需要任何手动操作**。

如果对自动算出来的效果不满意,想自己动手核对或覆盖,见第 7 步"高级:手动核对/覆盖对齐结果"。
```

- [ ] **Step 2: 改写第 6 步"水印告示卡住"**

把现第 140-154 行:

```markdown
### 6. 遇到"请勿多人使用/联系客服"之类的告示画面卡住不动

这是购买模型常见的防盗版水印保护——模型本身没有声明任何真实动作/表情时会一直停在卖家的版权告示图上。**只声明 `motionGroup` 往往不够**,实测下来真正让画面切到角色本体的是**应用一个真实表情(`expression`)**,不是播放动作。在第 5 步查到的表情名字里挑一个(先在 Console 里试一下效果,确认不是哭脸/夸张表情之类不适合当日常待机状态的):

```js
model.expression('某个表情名').then(ok => console.log('结果:', ok))
```

确认某个表情能让画面切走且长相正常之后,把它写进 `stateMap.idle`:

```json
"idle": { "motionGroup": "Recovered", "selection": "random", "loop": true, "expression": "某个表情名" }
```

`model.motion(...)`/`model.expression(...)` 调用返回 `false` 不一定代表真的失败——引擎自己内部有一套待机动作自动选择机制,有时会跟显式调用产生优先级竞争,返回值不完全可靠,以桌面上肉眼看到的实际效果为准。
```

改成:

```markdown
### 6. 遇到"请勿多人使用/联系客服"之类的告示画面卡住不动

这是购买模型常见的防盗版水印保护——模型本身没有声明任何真实动作/表情时会一直停在卖家的版权告示图上。导入时如果检测到这种情况(第 3 步会看到"该模型未声明任何动作/表情,可能需要额外处理才能正常显示角色"提示),`pet.json` 会被打上 `render.possibleWatermark: true` 标记;运行时只要 `stateMap.idle` 没有显式声明 `expression`,就会自动挑一个模型自带的表情调用一次尝试破冰(**只声明 `motionGroup` 往往不够**,真正让画面切到角色本体的是应用一个真实表情,不是播放动作)——**大多数情况不需要手动操作**。

如果自动破冰没有生效(比如模型确实没有任何可用表情,纯告示图水印包,或者自动挑中的表情长相不合适),仍可以按以下步骤手动核对/回填:在第 5 步查到的表情名字里挑一个(先在 Console 里试一下效果,确认不是哭脸/夸张表情之类不适合当日常待机状态的):

```js
model.expression('某个表情名').then(ok => console.log('结果:', ok))
```

确认某个表情能让画面切走且长相正常之后,把它写进 `stateMap.idle`(显式声明后自动破冰不会再触发,尊重这里的手动配置):

```json
"idle": { "motionGroup": "Recovered", "selection": "random", "loop": true, "expression": "某个表情名" }
```

`model.motion(...)`/`model.expression(...)` 调用返回 `false` 不一定代表真的失败——引擎自己内部有一套待机动作自动选择机制,有时会跟显式调用产生优先级竞争,返回值不完全可靠,以桌面上肉眼看到的实际效果为准。
```

- [ ] **Step 3: 新增第 7 步"高级:手动核对/覆盖对齐结果"**

在改写后的第 6 步末尾、`## 第二步:写人设` 标题之前,插入:

```markdown
### 7. 高级:手动核对/覆盖对齐结果

正常情况下第 4 步的自动对齐就够用了。如果遇到疑难模型(比如自动算出来的比例仍不满意),可以打开 DevTools Console(鼠标点在宠物窗口区域上按 **Ctrl+Shift+I** 或 F12)手动核对/覆盖:

```js
window.__kiboLive2D.autoFit()   // 重新测量并现场应用,想要不同留白可以传参数,比如 autoFit(20)
window.__kiboLive2D.saveFit()   // 把上一步算出来的数值直接写回当前宠物的 pet.json(自动标记 autoFitted:true)
```

这一步会自动找到当前宠物**实际在用**的那份 `pet.json`(导入后应用读的是复制到 `%APPDATA%\kibo-pet\pets\<id>\pet.json` 的那一份,不是原始素材文件夹里的),只覆盖 `scale`/`offsetX`/`offsetY`/`autoFitted` 四个字段,`anchorX`/`anchorY`/`bubbleAnchorX`/`bubbleAnchorY` 这些锚点语义不会被动。写回后如果想让原始素材文件夹也保持同步(方便以后重新导入),把 `pets/<pet-id>/pet.json` 里的这几个字段手动抄一份过去即可。

如果想自己动手核对细节而不是完全依赖自动计算,也可以直接读写 `window.__kiboLive2D.model`/`.app`(比如 `model.width`、`model.scale.set(...)`、`model.position.y = ...`),`autoFit()`/`saveFit()` 内部做的就是这些事,没有什么额外魔法。
```

- [ ] **Step 4: 确认无格式问题**

Run: `grep -n "^###" docs/making-a-pet.md`
Expected: 能看到 0-7 共 8 个小节标题按顺序排列,没有重复编号(用普通 grep/Select-String 走读一遍即可,不需要额外工具)

- [ ] **Step 5: Commit**

```bash
git add docs/making-a-pet.md
git commit -m "docs(making-a-pet): 同步自动对齐/自动破冰行为,调试工具改列为高级排查手段"
```

---

## Self-Review 记录

- **Spec 覆盖:** 类型变更(Task 1)、IPC 契约(Task 2)、渲染器自动对齐+自动破冰+调试工具重新定位(Task 3+4)、导入时持久化(Task 5)、文档(Task 6)——spec 的 7 个改动点全部有对应任务覆盖。
- **占位符扫描:** 无 TBD/TODO,所有步骤含完整代码。
- **类型一致性:** `Live2DTransformPatch.autoFitted`(Task 2)与 `live2dRenderer.ts` 里 `{ ...fit, autoFitted: true }`(Task 4)、`{ ...lastFit, autoFitted: true }`(Task 4)字段名一致;`pickWatermarkBreakExpressionName`/`needsAutoFit`(Task 3)与 Task 4 的 import/调用签名一致;`ExpressionDefinition`(Task 3 导出)与 Task 4 里的类型断言一致。
