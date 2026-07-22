# Live2D Phase 6 · 设置页导入预览 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置页导入 Live2D 宠物包时,先在一个预览面板里真实渲染出模型让用户确认,用户点"确认导入"才真正落地到 `userData/pets/<id>/`;点"取消"则整块丢弃,不留痕迹。精灵包导入行为不变(仍然一步提交)。

**Architecture:** `petCatalog.ts` 现有的"先复制到 `.staging` 再原子 `renameSync`"两阶段拆开,中间插入一个等待用户确认的间隙:`stageImportPet()` 只做校验+复制,`commitStagedPet()`/`discardStagedPet()` 分别做"确认"和"取消"。主进程用 `kiboPetProtocol.ts` 现成的多 token 注册表给 staging 目录单独开一个预览 token(与当前激活宠物的 token 完全独立)。设置窗口是独立的 `BrowserWindow`(独立 JS 全局),直接复用 Phase 4 的 `Live2DPetRenderer` 类渲染预览,不新写渲染逻辑。

**Tech Stack:** TypeScript, Electron (`ipcMain`/`ipcRenderer`, 自定义 protocol), Vitest, PixiJS(通过既有 `Live2DPetRenderer`,不直接接触)。

## Global Constraints

- 不新增依赖;不修改 `package.json`。
- `pnpm typecheck`/`pnpm test` 全程保持通过;涉及 main/preload/renderer(包括设置窗口)改动后必须 `pnpm dev` 或 `pnpm preview` 真机验证——预览渲染、确认/取消两条路径都要实际点一遍。
- 纯逻辑(`petCatalog.ts` 的校验/staging/commit/discard)必须先写失败的 Vitest 再实现(TDD)。
- 不要给 `package.json` 加 `"type": "module"`。
- 精灵(`sprite`)包的导入体验不变:仍然选完文件夹立即提交,不经过预览面板。
- 预览面板只看不改:不提供实时调整 scale/offset/镜像、不提供 Motion Group 映射向导(已与用户确认的范围边界,留给以后的阶段)。
- 每个任务结束后提交一次(conventional commit,中文描述)。
- 设计依据:`docs/superpowers/specs/2026-07-22-live2d-phase6-mouse-lipsync-preview-design.md` §4。
- 本计划与鼠标追踪/口型两份计划改动的文件集合不重叠(`petCatalog.ts`/`kiboPetProtocol.ts`/`settings.html`/`settings.ts`/`settingsWindow.ts` 相关代码路径 vs `petController.ts`/`live2dRenderer.ts`/`pcmPlayer.ts`/`shell/index.ts` 的轮询循环),没有执行顺序依赖,可以在另外两份之前、之后或之间执行。

---

### Task 1: `petCatalog.ts` 拆分 staging/commit/discard

**Files:**
- Modify: `src/main/pets/petCatalog.ts`
- Modify: `src/main/pets/petCatalog.test.ts`

**Interfaces:**
- Produces:
  - `export type StageImportResult = { ok: true; committed: true; pet: PetSummary; warnings?: string[] } | { ok: true; committed: false; stagingId: string; manifest: Live2DManifest; warnings: string[] } | { ok: false; reason: ImportReason; message: string }`
  - `export function stageImportPet(srcDir: string, dirs: { bundledPetsDir: string; userPetsDir: string }): StageImportResult`
  - `export function commitStagedPet(stagingId: string, manifestId: string, dirs: { bundledPetsDir: string; userPetsDir: string }): { ok: true; pet: PetSummary } | { ok: false; message: string }`
  - `export function discardStagedPet(stagingId: string, userPetsDir: string): void`
  - 移除:`export function importPetFolder(...)`(被 `stageImportPet` 取代)。
  - Task 2(IPC 层)会调用这三个函数。

`src/main/pets/petCatalog.ts` 当前第 1-16 行:

```ts
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { parsePetManifest, parseLive2DManifest, isLive2DManifestRaw } from '@shared/petPackage'
import type { PetSummary, ImportResult } from '@shared/ipc'
import { scanImportSource, isPathSafe } from './importSecurity'
import { readTextureInfos, evaluateTextureBudget } from './live2dTextureBudget'
import {
  listModelFilesRecursive,
  scanAndPatchOrphanResources,
  detectPossibleWatermarkProtection,
  type Model3Json
} from './live2dOrphanResources'

export const STAGING_DIR_NAME = '.staging'
```

`src/main/pets/petCatalog.ts` 第 69-71 行(`newStagingDir` 辅助函数)当前是:

```ts
function newStagingDir(userPetsDir: string): string {
  return join(userPetsDir, STAGING_DIR_NAME, randomBytes(8).toString('hex'))
}
```

`src/main/pets/petCatalog.ts` 第 117-254 行(`importLive2DPet`)当前是(全文见"当前完整代码"部分,下方给出改后版本前先给出关键改动点):第 233-253 行的提交尾段当前是:

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

  return {
    ok: true,
    pet: { id: manifest.id, displayName: manifest.displayName, description: manifest.description, renderType: 'live2d', renderReady: true },
    ...(warnings.length > 0 ? { warnings } : {})
  }
}
```

`src/main/pets/petCatalog.ts` 第 256-289 行(`importPetFolder` + `cleanupStaleStaging`)当前是:

```ts
/**
 * 校验外部宠物文件夹并导入到 userData/pets/<id>。统一 staging + 安全校验 + 原子移动:
 * 两种包共用路径安全校验和 staging/提交流程,live2d 专属校验(引用完整性/纹理预算/
 * 游离资源找回/水印提示)只在 render.type===live2d 时跑。任一环节失败都清理 staging 残留,
 * 不触碰最终目录;冲突(id 已存在)一律拒绝,绝不覆盖。
 */
export function importPetFolder(
  srcDir: string,
  dirs: { bundledPetsDir: string; userPetsDir: string }
): ImportResult {
  const manifestPath = join(srcDir, 'pet.json')
  if (!existsSync(manifestPath)) {
    return { ok: false, reason: 'no-manifest', message: '所选文件夹里没有 pet.json' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  } catch (e) {
    return { ok: false, reason: 'invalid-manifest', message: `pet.json 不是合法 JSON:${(e as Error).message}` }
  }

  const violation = scanImportSource(srcDir)
  if (violation) return { ok: false, reason: violation.reason, message: violation.message }

  const stagingDir = newStagingDir(dirs.userPetsDir)
  const result = isLive2DManifestRaw(raw)
    ? importLive2DPet(raw, srcDir, stagingDir, dirs)
    : importSpritePet(raw, srcDir, stagingDir, dirs)

  if (!result.ok) {
    rmSync(stagingDir, { recursive: true, force: true })
  }
  return result
}

/** 应用启动时调用:清掉上次崩溃/中断导入残留的 .staging 子目录(未完整提交的导入不会"复活")。 */
export function cleanupStaleStaging(userPetsDir: string): void {
  const stagingRoot = join(userPetsDir, STAGING_DIR_NAME)
  if (!existsSync(stagingRoot)) return
  for (const name of readdirSync(stagingRoot)) {
    rmSync(join(stagingRoot, name), { recursive: true, force: true })
  }
}
```

- [ ] **Step 1: 写失败的测试(先只加新测试,不改旧的)**

在 `src/main/pets/petCatalog.test.ts` 第 5 行,把:

```ts
import { isValidPetId, listPets, importPetFolder, cleanupStaleStaging } from './petCatalog'
```

改成:

```ts
import { isValidPetId, listPets, stageImportPet, commitStagedPet, discardStagedPet, cleanupStaleStaging } from './petCatalog'
```

（这一步会让文件里所有还没改名的 `importPetFolder(` 调用点报编译错误——这是预期的,后面 Step 2 会统一改名,不需要在这一步就全部改完。）

在文件末尾追加新的 `describe` 块:

```ts
describe('stageImportPet — live2d 预览暂存(不立即提交)', () => {
  it('合法 live2d 包 → committed:false,staging 目录有文件,最终目录还不存在', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'chitose', '千岁')
    writeFileSync(join(petSrc, 'model', 'tex_00.png'), fakePngBytes(512, 512))
    const r = stageImportPet(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    if (!r.ok || r.committed) throw new Error('expected committed:false')
    expect(r.manifest.id).toBe('chitose')
    expect(existsSync(join(user, '.staging', r.stagingId, 'model', 'character.model3.json'))).toBe(true)
    expect(existsSync(join(user, 'chitose'))).toBe(false)
  })

  it('sprite 包 → 仍然是 committed:true,一步提交(行为不变)', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makePet(src, 'newpet', '新宠物')
    const r = stageImportPet(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    if (!r.ok || !r.committed) throw new Error('expected committed:true')
    expect(r.pet.id).toBe('newpet')
    expect(existsSync(join(user, 'newpet', 'pet.json'))).toBe(true)
  })

  it('live2d 包水印检测的 warnings 通过返回值直接拿到,不需要重新读盘', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'watermarked', '水印')
    const r = stageImportPet(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    if (!r.ok || r.committed) throw new Error('expected committed:false')
    expect(r.warnings.some((w) => w.includes('未声明任何动作'))).toBe(true)
    expect(r.manifest.render.possibleWatermark).toBe(true)
  })
})

describe('commitStagedPet', () => {
  it('把 staging 目录移到最终目录,返回 pet summary', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'chitose', '千岁')
    const staged = stageImportPet(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    if (!staged.ok || staged.committed) throw new Error('expected committed:false')
    const r = commitStagedPet(staged.stagingId, staged.manifest.id, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r).toMatchObject({ ok: true, pet: { id: 'chitose', renderType: 'live2d' } })
    expect(existsSync(join(user, 'chitose', 'pet.json'))).toBe(true)
    expect(existsSync(join(user, '.staging', staged.stagingId))).toBe(false)
  })

  it('未知/已清理的 stagingId → 失败,不抛异常', () => {
    const user = scratch()
    const r = commitStagedPet('0123456789abcdef', 'whatever', { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(false)
  })

  it('非法 stagingId(含路径分隔符)→ 直接拒绝,不触碰文件系统', () => {
    const user = scratch()
    const r = commitStagedPet('../../evil', 'whatever', { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(false)
  })

  it('提交时目标 id 已被占用(commit 之间冲突)→ 失败并清理 staging', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'chitose', '千岁')
    const staged = stageImportPet(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    if (!staged.ok || staged.committed) throw new Error('expected committed:false')
    makePet(user, 'chitose', 'halfway 冲突的同名精灵包') // 模拟预览等待期间被别的流程占用了这个 id
    const r = commitStagedPet(staged.stagingId, staged.manifest.id, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(false)
    expect(existsSync(join(user, '.staging', staged.stagingId))).toBe(false)
  })
})

describe('discardStagedPet', () => {
  it('删除 staging 目录', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'chitose', '千岁')
    const staged = stageImportPet(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    if (!staged.ok || staged.committed) throw new Error('expected committed:false')
    discardStagedPet(staged.stagingId, user)
    expect(existsSync(join(user, '.staging', staged.stagingId))).toBe(false)
  })

  it('非法 stagingId → 静默不做任何事,不抛异常', () => {
    const user = scratch()
    expect(() => discardStagedPet('../../evil', user)).not.toThrow()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/pets/petCatalog.test.ts`
Expected: FAIL(`stageImportPet`/`commitStagedPet`/`discardStagedPet` 不存在,以及第 5 行改名后遗留的 `importPetFolder` 调用点全部编译错误)

- [ ] **Step 3: 把文件里其余 `importPetFolder(` 调用点改名为 `stageImportPet(`**

`src/main/pets/petCatalog.test.ts` 里除了 Step 1 新加的那些测试外,还有以下调用点,函数名原样改成 `stageImportPet`,参数和断言不变(这些测试测的都是"校验通过/失败"和"sprite 包一步提交"的行为,在新设计里语义不变):

- 第 109 行:`const r = importPetFolder(petSrc, ...)` → `const r = stageImportPet(petSrc, ...)`
- 第 120 行:同上改名
- 第 128 行:同上改名
- 第 141 行:同上改名
- 第 155 行:同上改名
- 第 164 行:同上改名
- 第 176 行:同上改名
- 第 243 行(`describe('importPetFolder — 统一 staging 流程', ...)` 块里 sprite 测试):同上改名
- 第 252 行:同上改名
- 第 335、339 行(`forbidden-file-type` 用例,用的是 `makePet` 精灵 fixture):同上改名
- 第 362、368 行(`中途校验失败不留 .staging 残留` 用例,live2d 失败路径,失败返回值形状不变):同上改名

第 262-334 行、344-361 行这几处 **live2d 成功/失败路径断言需要一起改**,见下一步。

- [ ] **Step 4: 重写 live2d 相关的断言(staging 阶段不再落到最终目录)**

`src/main/pets/petCatalog.test.ts` 第 258-298 行当前是:

```ts
  it('live2d 包:合法输入 → 成功导入,renderType=live2d/renderReady=true', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'chitose', '千岁')
    writeFileSync(join(petSrc, 'model', 'tex_00.png'), fakePngBytes(512, 512))
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.pet).toMatchObject({ id: 'chitose', renderType: 'live2d', renderReady: true })
    expect(existsSync(join(user, 'chitose', 'model', 'character.model3.json'))).toBe(true)
  })

  it('live2d 包:游离表情/动作文件自动找回,warnings 里报告数量', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'orphaned', '游离')
    writeFileSync(join(petSrc, 'model', 'happy.exp3.json'), '{}')
    writeFileSync(join(petSrc, 'model', 'Scene1.motion3.json'), '{}')
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.warnings?.some((w) => w.includes('找回'))).toBe(true)
    const written = JSON.parse(readFileSync(join(user, 'orphaned', 'model', 'character.model3.json'), 'utf-8'))
    expect(written.FileReferences.Expressions).toHaveLength(1)
  })

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

改成(用返回的 `stagingId`/`manifest` 直接断言,不再假设已经落到最终目录):

```ts
  it('live2d 包:合法输入 → 成功 staging,renderType=live2d,staging 目录有 model 文件', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'chitose', '千岁')
    writeFileSync(join(petSrc, 'model', 'tex_00.png'), fakePngBytes(512, 512))
    const r = stageImportPet(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    if (!r.ok || r.committed) throw new Error('expected committed:false')
    expect(r.manifest.id).toBe('chitose')
    expect(existsSync(join(user, '.staging', r.stagingId, 'model', 'character.model3.json'))).toBe(true)
  })

  it('live2d 包:游离表情/动作文件自动找回,warnings 里报告数量', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'orphaned', '游离')
    writeFileSync(join(petSrc, 'model', 'happy.exp3.json'), '{}')
    writeFileSync(join(petSrc, 'model', 'Scene1.motion3.json'), '{}')
    const r = stageImportPet(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    if (!r.ok || r.committed) throw new Error('expected committed:false')
    expect(r.warnings.some((w) => w.includes('找回'))).toBe(true)
    const written = JSON.parse(readFileSync(join(user, '.staging', r.stagingId, 'model', 'character.model3.json'), 'utf-8'))
    expect(written.FileReferences.Expressions).toHaveLength(1)
  })

  it('live2d 包:补丁后仍无动作/表情 → warnings 含水印提示,返回的 manifest 带 possibleWatermark:true', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'watermarked', '水印')
    const r = stageImportPet(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    if (!r.ok || r.committed) throw new Error('expected committed:false')
    expect(r.warnings.some((w) => w.includes('未声明任何动作'))).toBe(true)
    expect(r.manifest.render.possibleWatermark).toBe(true)
  })

  it('live2d 包:游离资源找回后有真实表情/动作 → manifest 不含 possibleWatermark 字段', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'orphaned2', '游离2')
    writeFileSync(join(petSrc, 'model', 'happy.exp3.json'), '{}')
    const r = stageImportPet(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    if (!r.ok || r.committed) throw new Error('expected committed:false')
    expect(r.manifest.render.possibleWatermark).toBeUndefined()
  })
```

- [ ] **Step 5: 修改 `petCatalog.ts` 的 import 区和辅助函数**

把第 1-16 行改成:

```ts
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { parsePetManifest, parseLive2DManifest, isLive2DManifestRaw, type Live2DManifest } from '@shared/petPackage'
import type { PetSummary, ImportResult, ImportReason } from '@shared/ipc'
import { scanImportSource, isPathSafe } from './importSecurity'
import { readTextureInfos, evaluateTextureBudget } from './live2dTextureBudget'
import {
  listModelFilesRecursive,
  scanAndPatchOrphanResources,
  detectPossibleWatermarkProtection,
  type Model3Json
} from './live2dOrphanResources'

export const STAGING_DIR_NAME = '.staging'
const STAGING_ID_PATTERN = /^[0-9a-f]{16}$/
```

删除第 69-71 行的 `newStagingDir` 函数(不再需要,`stageImportPet` 会直接内联生成 `stagingId`):

```ts
function newStagingDir(userPetsDir: string): string {
  return join(userPetsDir, STAGING_DIR_NAME, randomBytes(8).toString('hex'))
}
```

- [ ] **Step 6: 改 `importLive2DPet` 的返回类型和提交尾段(停在 staging,不再 rename)**

把 `importLive2DPet` 的函数签名(第 117-122 行)从:

```ts
function importLive2DPet(
  raw: unknown,
  srcDir: string,
  stagingDir: string,
  dirs: { bundledPetsDir: string; userPetsDir: string }
): ImportResult {
```

改成:

```ts
function importLive2DPet(
  raw: unknown,
  srcDir: string,
  stagingDir: string,
  dirs: { bundledPetsDir: string; userPetsDir: string }
): { ok: true; manifest: Live2DManifest; warnings: string[] } | { ok: false; reason: ImportReason; message: string } {
```

把提交尾段(第 233-254 行)从:

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

  return {
    ok: true,
    pet: { id: manifest.id, displayName: manifest.displayName, description: manifest.description, renderType: 'live2d', renderReady: true },
    ...(warnings.length > 0 ? { warnings } : {})
  }
}
```

改成:

```ts
  let finalManifest: Live2DManifest = manifest
  try {
    cpSync(srcDir, stagingDir, { recursive: true })
    const modelJsonStagingPath = join(stagingDir, manifest.render.model)
    writeFileSync(modelJsonStagingPath, JSON.stringify(patchedModel3Json, null, 2), 'utf-8')
    if (possibleWatermark) {
      finalManifest = { ...manifest, render: { ...manifest.render, possibleWatermark: true } }
      writeFileSync(join(stagingDir, 'pet.json'), JSON.stringify(finalManifest, null, 2), 'utf-8')
    }
  } catch (e) {
    rmSync(stagingDir, { recursive: true, force: true })
    return { ok: false, reason: 'copy-failed', message: `导入失败:${(e as Error).message}` }
  }

  return { ok: true, manifest: finalManifest, warnings }
}
```

（`dirs` 参数在这个函数里现在只用于前面的 `id-exists` 预检查,不再用于算 `finalDir`——保持参数不变,只是用途少了一处,不需要改函数签名。）

- [ ] **Step 7: 用 `stageImportPet`/`commitStagedPet`/`discardStagedPet` 取代 `importPetFolder`**

把第 256-289 行(`importPetFolder` + `cleanupStaleStaging`)整段改成:

```ts
export type StageImportResult =
  | { ok: true; committed: true; pet: PetSummary; warnings?: string[] }
  | { ok: true; committed: false; stagingId: string; manifest: Live2DManifest; warnings: string[] }
  | { ok: false; reason: ImportReason; message: string }

/**
 * 校验外部宠物文件夹并复制到 `.staging`。sprite 包不经过预览,校验通过后立即原子提交到
 * userData/pets/<id>(`committed:true`);live2d 包停在 staging,等待调用方(设置页预览面板)
 * 调 commitStagedPet()/discardStagedPet() 决定去留(`committed:false`)。任一校验环节失败都
 * 清理 staging 残留,不触碰最终目录。
 */
export function stageImportPet(
  srcDir: string,
  dirs: { bundledPetsDir: string; userPetsDir: string }
): StageImportResult {
  const manifestPath = join(srcDir, 'pet.json')
  if (!existsSync(manifestPath)) {
    return { ok: false, reason: 'no-manifest', message: '所选文件夹里没有 pet.json' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  } catch (e) {
    return { ok: false, reason: 'invalid-manifest', message: `pet.json 不是合法 JSON:${(e as Error).message}` }
  }

  const violation = scanImportSource(srcDir)
  if (violation) return { ok: false, reason: violation.reason, message: violation.message }

  const stagingId = randomBytes(8).toString('hex')
  const stagingDir = join(dirs.userPetsDir, STAGING_DIR_NAME, stagingId)

  if (isLive2DManifestRaw(raw)) {
    const result = importLive2DPet(raw, srcDir, stagingDir, dirs)
    if (!result.ok) {
      rmSync(stagingDir, { recursive: true, force: true })
      return result
    }
    return { ok: true, committed: false, stagingId, manifest: result.manifest, warnings: result.warnings }
  }

  const result: ImportResult = importSpritePet(raw, srcDir, stagingDir, dirs)
  if (!result.ok) {
    rmSync(stagingDir, { recursive: true, force: true })
    return result
  }
  return { ok: true, committed: true, pet: result.pet, warnings: result.warnings }
}

/** 用户在预览面板点"确认导入":把 staging 目录原子移到最终目录。stagingId 必须是
 *  stageImportPet() 返回过的十六进制串(16 个字符),不接受任意路径——防止渲染进程
 *  (信任边界较低的一侧)喂一个精心构造的字符串跑出 .staging 目录之外。 */
export function commitStagedPet(
  stagingId: string,
  manifestId: string,
  dirs: { bundledPetsDir: string; userPetsDir: string }
): { ok: true; pet: PetSummary } | { ok: false; message: string } {
  if (!STAGING_ID_PATTERN.test(stagingId)) return { ok: false, message: '非法的 stagingId' }
  const stagingDir = join(dirs.userPetsDir, STAGING_DIR_NAME, stagingId)
  if (!existsSync(stagingDir)) return { ok: false, message: '预览已过期或已被清理,请重新导入' }
  if (!isValidPetId(manifestId)) {
    rmSync(stagingDir, { recursive: true, force: true })
    return { ok: false, message: `非法的宠物 id:${manifestId}` }
  }
  const finalDir = join(dirs.userPetsDir, manifestId)
  if (existsSync(join(dirs.bundledPetsDir, manifestId)) || existsSync(finalDir)) {
    rmSync(stagingDir, { recursive: true, force: true })
    return { ok: false, message: `id「${manifestId}」已存在,请修改宠物包 pet.json 的 id 后重试` }
  }
  try {
    renameSync(stagingDir, finalDir)
  } catch (e) {
    return { ok: false, message: `导入失败:${(e as Error).message}` }
  }
  const pet = readSummary(finalDir)
  if (!pet) return { ok: false, message: '提交后读取宠物包失败' }
  return { ok: true, pet }
}

/** 用户在预览面板点"取消":删掉 staging 目录,不留痕迹。stagingId 校验同 commitStagedPet()。 */
export function discardStagedPet(stagingId: string, userPetsDir: string): void {
  if (!STAGING_ID_PATTERN.test(stagingId)) return
  rmSync(join(userPetsDir, STAGING_DIR_NAME, stagingId), { recursive: true, force: true })
}

/** 应用启动时调用:清掉上次崩溃/中断导入残留的 .staging 子目录(未完整提交的导入不会"复活")。 */
export function cleanupStaleStaging(userPetsDir: string): void {
  const stagingRoot = join(userPetsDir, STAGING_DIR_NAME)
  if (!existsSync(stagingRoot)) return
  for (const name of readdirSync(stagingRoot)) {
    rmSync(join(stagingRoot, name), { recursive: true, force: true })
  }
}
```

- [ ] **Step 8: 运行测试确认全部通过**

Run: `pnpm vitest run src/main/pets/petCatalog.test.ts`
Expected: PASS(全部既有测试改名后 + 新增测试都通过)

- [ ] **Step 9: 类型检查**

Run: `pnpm typecheck`
Expected: 报错——`src/main/shell/index.ts` 里还在用旧的 `importPetFolder`(Task 2 会修)。这一步先确认 `petCatalog.ts` 自身和它的测试文件没有类型错误;`shell/index.ts` 的错误留给 Task 2 处理,本任务先只提交 `petCatalog.ts`/`petCatalog.test.ts`。

- [ ] **Step 10: 提交**

```bash
git add src/main/pets/petCatalog.ts src/main/pets/petCatalog.test.ts
git commit -m "refactor(live2d): petCatalog 拆分 stageImportPet/commitStagedPet/discardStagedPet,live2d 导入不再立即提交"
```

---

### Task 2: IPC 契约 + 主进程接线(两处 `IMPORT_PET` 注册点)

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/shell/index.ts`

**Interfaces:**
- Consumes: Task 1 的 `stageImportPet`/`commitStagedPet`/`discardStagedPet`;`kiboPetProtocol.ts` 现成的 `registry.registerToken(rootDir)`/`registry.revokeToken(token)`(Phase 2/4 已有,不改)。
- Produces: `window.settingsApi.stageImportPet()`/`commitStagedImport()`/`discardStagedImport()`——Task 3(设置页 UI)调用这三个方法。

**背景:** `IPC.IMPORT_PET` 目前在 `src/main/shell/index.ts` 里注册了两处——第 145-149 行在 `startOnboarding()`(全新安装、还没导入任何宠物包时的引导流程,只有托盘+设置窗口,没有 `petWin`/`session`)里;第 953-957 行在正常的 `startShell()` 主流程(有完整 `petWin`/`session`)里。两处都要改,且两处都能访问到同一个 `kiboPetRegistry`(在 `startShell()` 函数最开头、分流到 onboarding 之前就创建好了,第 174-175 行)。

- [ ] **Step 1: `ipc.ts` 替换 `IMPORT_PET` 常量和 `SettingsApi`/`ImportResult` 类型**

`src/shared/ipc.ts` 第 46 行:

```ts
  IMPORT_PET: 'pets:import',
```

改成:

```ts
  STAGE_IMPORT_PET: 'pets:stage-import',
  COMMIT_STAGED_IMPORT: 'pets:commit-staged-import',
  DISCARD_STAGED_IMPORT: 'pets:discard-staged-import',
```

第 202-209 行(`ImportReason`/`ImportResult` 定义)后面加一个新的判别式类型(不改 `ImportReason`/`ImportResult` 本身——sprite 包一步提交的返回形状原样复用):

```ts
export type ImportReason =
  | 'no-manifest' | 'invalid-manifest' | 'missing-spritesheet' | 'bad-id' | 'id-exists' | 'copy-failed'
  | 'path-traversal' | 'symlink-rejected' | 'forbidden-file-type'
  | 'dir-too-large' | 'too-many-files' | 'json-too-large'
  | 'texture-too-large' | 'too-many-textures' | 'missing-model-refs'
export type ImportResult =
  | { ok: true; pet: PetSummary; warnings?: string[] }
  | { ok: false; reason: ImportReason; message: string }

/** STAGE_IMPORT_PET 的返回形状:sprite 包一步提交(committed:true,与 ImportResult 的成功分支
 *  同形);live2d 包停在预览阶段(committed:false),附带渲染预览要用的 previewSource——
 *  复用现有 PetRenderSource,设置窗口拿到后可以直接喂给 Live2DPetRenderer.load()。 */
export type StageImportOutcome =
  | { ok: true; committed: true; pet: PetSummary; warnings?: string[] }
  | { ok: true; committed: false; stagingId: string; manifestId: string; displayName: string; warnings: string[]; previewSource: PetRenderSource }
  | { ok: false; reason: ImportReason; message: string }

export type CommitStagedImportResult = { ok: true; pet: PetSummary } | { ok: false; message: string }
```

`SettingsApi` 接口(第 229-244 行)里的:

```ts
  listPets(): Promise<PetSummary[]>
  importPet(): Promise<ImportResult | null>
  relaunch(): void
```

改成:

```ts
  listPets(): Promise<PetSummary[]>
  /** 弹文件夹选择器 → 校验 → 复制到 .staging。sprite 包在这一步内部就直接提交完了
   *  (committed:true);live2d 包停在预览阶段(committed:false),需要接着调
   *  commitStagedImport()/discardStagedImport() 决定去留。用户取消选择返回 null。 */
  stageImportPet(): Promise<StageImportOutcome | null>
  commitStagedImport(stagingId: string, manifestId: string): Promise<CommitStagedImportResult>
  discardStagedImport(stagingId: string): Promise<void>
  relaunch(): void
```

- [ ] **Step 2: `preload/index.ts` 接线**

第 104 行:

```ts
  importPet: () => ipcRenderer.invoke(IPC.IMPORT_PET),
```

改成:

```ts
  stageImportPet: () => ipcRenderer.invoke(IPC.STAGE_IMPORT_PET),
  commitStagedImport: (stagingId: string, manifestId: string) => ipcRenderer.invoke(IPC.COMMIT_STAGED_IMPORT, { stagingId, manifestId }),
  discardStagedImport: (stagingId: string) => ipcRenderer.invoke(IPC.DISCARD_STAGED_IMPORT, { stagingId }),
```

- [ ] **Step 3: `shell/index.ts`——`startOnboarding()` 里的注册点**

`src/main/shell/index.ts` 里 `startOnboarding()` 函数签名(第 90-99 行)当前是:

```ts
function startOnboarding(opts: {
  appRoot: string
  preload: string
  rendererUrl: string | undefined
  dirname: string
  userData: string
  settingsFile: string
  petCatalogDirs: { bundledPetsDir: string; userPetsDir: string }
}): void {
  const { appRoot, preload, rendererUrl, dirname, userData, settingsFile, petCatalogDirs } = opts
```

改成(新增 `kiboPetRegistry` 参数,`startShell()` 顶部已经创建好的那一份):

```ts
function startOnboarding(opts: {
  appRoot: string
  preload: string
  rendererUrl: string | undefined
  dirname: string
  userData: string
  settingsFile: string
  petCatalogDirs: { bundledPetsDir: string; userPetsDir: string }
  kiboPetRegistry: ReturnType<typeof createKiboPetProtocolRegistry>
}): void {
  const { appRoot, preload, rendererUrl, dirname, userData, settingsFile, petCatalogDirs, kiboPetRegistry } = opts
```

第 145-149 行:

```ts
  ipcMain.handle(IPC.IMPORT_PET, async () => {
    const r = await electronDialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || r.filePaths.length === 0) return null
    return importPetFolder(r.filePaths[0], petCatalogDirs)
  })
```

改成:

```ts
  ipcMain.handle(IPC.STAGE_IMPORT_PET, async (): Promise<StageImportOutcome | null> => {
    const r = await electronDialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || r.filePaths.length === 0) return null
    return toStageImportOutcome(stageImportPet(r.filePaths[0], petCatalogDirs), petCatalogDirs.userPetsDir, kiboPetRegistry)
  })
  ipcMain.handle(IPC.COMMIT_STAGED_IMPORT, async (_e, raw): Promise<CommitStagedImportResult> => {
    const { stagingId, manifestId } = validateStagedImportArg(raw)
    kiboPetRegistry.revokeToken(stagingId)
    return commitStagedPet(stagingId, manifestId, petCatalogDirs)
  })
  ipcMain.handle(IPC.DISCARD_STAGED_IMPORT, async (_e, raw): Promise<void> => {
    const { stagingId } = validateStagedImportArg(raw)
    kiboPetRegistry.revokeToken(stagingId)
    discardStagedPet(stagingId, petCatalogDirs.userPetsDir)
  })
```

`startOnboarding()` 的调用点(`startShell()` 里,第 211 行)当前是:

```ts
    startOnboarding({ appRoot, preload, rendererUrl, dirname, userData, settingsFile, petCatalogDirs })
```

改成:

```ts
    startOnboarding({ appRoot, preload, rendererUrl, dirname, userData, settingsFile, petCatalogDirs, kiboPetRegistry })
```

（`kiboPetRegistry` 在 `startShell()` 顶部第 174 行已经创建:`const kiboPetRegistry = createKiboPetProtocolRegistry()`,分流到 onboarding 之前,原样可用。）

- [ ] **Step 4: `shell/index.ts`——正常流程里的注册点**

第 952-957 行:

```ts
  ipcMain.handle(IPC.LIST_PETS, async () => listPets(petCatalogDirs))
  ipcMain.handle(IPC.IMPORT_PET, async () => {
    const r = await electronDialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || r.filePaths.length === 0) return null
    return importPetFolder(r.filePaths[0], petCatalogDirs)
  })
```

改成:

```ts
  ipcMain.handle(IPC.LIST_PETS, async () => listPets(petCatalogDirs))
  ipcMain.handle(IPC.STAGE_IMPORT_PET, async (): Promise<StageImportOutcome | null> => {
    const r = await electronDialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || r.filePaths.length === 0) return null
    return toStageImportOutcome(stageImportPet(r.filePaths[0], petCatalogDirs), petCatalogDirs.userPetsDir, kiboPetRegistry)
  })
  ipcMain.handle(IPC.COMMIT_STAGED_IMPORT, async (_e, raw): Promise<CommitStagedImportResult> => {
    const { stagingId, manifestId } = validateStagedImportArg(raw)
    kiboPetRegistry.revokeToken(stagingId)
    return commitStagedPet(stagingId, manifestId, petCatalogDirs)
  })
  ipcMain.handle(IPC.DISCARD_STAGED_IMPORT, async (_e, raw): Promise<void> => {
    const { stagingId } = validateStagedImportArg(raw)
    kiboPetRegistry.revokeToken(stagingId)
    discardStagedPet(stagingId, petCatalogDirs.userPetsDir)
  })
```

- [ ] **Step 5: 共用的转换/校验函数**

两处注册点都用到 `toStageImportOutcome()` 和 `validateStagedImportArg()`,加在 `startOnboarding()` 函数定义之前(文件顶部,`startOnboarding` 之前的空白处即可):

```ts
/** COMMIT_STAGED_IMPORT/DISCARD_STAGED_IMPORT 的入参校验:两个字段都必须是字符串,manifestId
 *  额外要求非空(commitStagedPet 内部会再校验一次 isValidPetId,这里只挡明显不是字符串的输入,
 *  避免 undefined 一路传到 kiboPetRegistry.revokeToken() 出现难查的行为)。 */
function validateStagedImportArg(raw: unknown): { stagingId: string; manifestId: string } {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    stagingId: typeof r.stagingId === 'string' ? r.stagingId : '',
    manifestId: typeof r.manifestId === 'string' ? r.manifestId : ''
  }
}

/** petCatalog.stageImportPet() 的结果不知道 kiboPetRegistry(main-only 的运行时状态,
 *  petCatalog.ts 是纯磁盘/校验逻辑,不该知道 token 这个概念),live2d 预览分支需要在这里
 *  补上 previewSource——给 staging 目录单开一个 token,与当前激活宠物的 token 完全独立,
 *  commit/discard 时会各自 revoke。 */
function toStageImportOutcome(
  result: StageImportResult,
  userPetsDir: string,
  kiboPetRegistry: ReturnType<typeof createKiboPetProtocolRegistry>
): StageImportOutcome {
  if (!result.ok) return result
  if (result.committed) return result
  const stagingDir = join(userPetsDir, STAGING_DIR_NAME, result.stagingId)
  const token = kiboPetRegistry.registerToken(stagingDir)
  return {
    ok: true,
    committed: false,
    stagingId: result.stagingId,
    manifestId: result.manifest.id,
    displayName: result.manifest.displayName,
    warnings: result.warnings,
    previewSource: { type: 'live2d', manifest: result.manifest, resourceBaseUrl: `kibo-pet://${token}/` }
  }
}
```

- [ ] **Step 6: 更新 import 区**

`src/main/shell/index.ts` 第 57 行:

```ts
import { listPets, importPetFolder, cleanupStaleStaging } from '../pets/petCatalog'
```

改成:

```ts
import { listPets, stageImportPet, commitStagedPet, discardStagedPet, cleanupStaleStaging, STAGING_DIR_NAME, type StageImportResult } from '../pets/petCatalog'
```

第 25-35 行的 `@shared/ipc` 具名 import 里加上新用到的类型(在现有 `type Live2DTransformPatch` 后面加逗号加新类型):

```ts
import {
  IPC,
  type WindowBounds,
  type SettingsSnapshot,
  type TestResult,
  type VoiceRuntimeState,
  type VoiceArchiveResult,
  type GenieRuntimeState,
  type PetChatListItem,
  type Live2DTransformPatch,
  type StageImportOutcome,
  type CommitStagedImportResult
} from '@shared/ipc'
```

- [ ] **Step 7: 类型检查**

Run: `pnpm typecheck`
Expected: 通过

- [ ] **Step 8: 提交**

```bash
git add src/shared/ipc.ts src/preload/index.ts src/main/shell/index.ts
git commit -m "feat(live2d): STAGE_IMPORT_PET/COMMIT_STAGED_IMPORT/DISCARD_STAGED_IMPORT 取代 IMPORT_PET"
```

---

### Task 3: 设置页预览面板

**Files:**
- Modify: `src/renderer/settings.html`
- Modify: `src/renderer/settings.ts`

**Interfaces:**
- Consumes: Task 2 的 `window.settingsApi.stageImportPet()`/`commitStagedImport()`/`discardStagedImport()`;既有的 `Live2DPetRenderer`(`src/renderer/live2dRenderer.ts`,Phase 4 产物,不改)。
- Produces: 无(UI 末端)。

- [ ] **Step 1: `settings.html` 补 CSP、加预览面板标记**

第 5 行当前是:

```html
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'" />
```

改成(补上宠物窗口 `index.html` 已经在用的同一套 `kibo-pet:` 豁免,Live2DPetRenderer 需要通过这个协议加载模型资源和使用 WebGL worker):

```html
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: kibo-pet:; connect-src 'self' data: kibo-pet:; media-src 'self' kibo-pet:; worker-src 'self' blob:" />
```

第 105-113 行(`importPet`/`importDetail` 一带)当前是:

```html
            <div class="row">
              <button id="importPet" class="secondary">导入宠物包…</button>
              <button id="relaunch" class="secondary" style="display:none">立即重启</button>
            </div>
            <div id="importDetail" class="hint" style="display:none;border:1px solid var(--border);border-radius:var(--radius-control);padding:8px 10px"></div>
```

改成(新增预览面板,默认隐藏):

```html
            <div class="row">
              <button id="importPet" class="secondary">导入宠物包…</button>
              <button id="relaunch" class="secondary" style="display:none">立即重启</button>
            </div>
            <div id="importDetail" class="hint" style="display:none;border:1px solid var(--border);border-radius:var(--radius-control);padding:8px 10px"></div>
            <div id="importPreview" style="display:none;border:1px solid var(--border);border-radius:var(--radius-control);padding:10px;margin-top:8px">
              <canvas id="importPreviewCanvas" width="240" height="300" style="display:block;margin:0 auto;background:transparent"></canvas>
              <div id="importPreviewName" style="text-align:center;font-weight:600;margin-top:6px"></div>
              <div id="importPreviewWarnings" class="hint"></div>
              <div class="row" style="margin-top:8px;justify-content:center">
                <button id="importPreviewConfirm" class="secondary" type="button">确认导入</button>
                <button id="importPreviewCancel" class="secondary" type="button">取消</button>
              </div>
            </div>
```

- [ ] **Step 2: `settings.ts` 加 import 和 DOM 引用**

第 1-2 行当前是:

```ts
import { PRESETS, SETTINGS_SCHEMA_VERSION, resolvePresetId, type ProviderSettings, type ProviderKind, type SearchBackendKind, type TtsSettings, type TtsDevice, type TtsTargetLanguage, type TtsPlaybackTrigger, type TtsSynthesisChunking, type TtsTextSplit, type TtsBackend } from '@shared/llm'
import type { VoiceRuntimeState } from '@shared/ipc'
```

改成:

```ts
import { PRESETS, SETTINGS_SCHEMA_VERSION, resolvePresetId, type ProviderSettings, type ProviderKind, type SearchBackendKind, type TtsSettings, type TtsDevice, type TtsTargetLanguage, type TtsPlaybackTrigger, type TtsSynthesisChunking, type TtsTextSplit, type TtsBackend } from '@shared/llm'
import type { VoiceRuntimeState, StageImportOutcome } from '@shared/ipc'
import { Live2DPetRenderer } from './live2dRenderer'
```

第 26-27 行(`importPetBtn`/`importDetail` 的 DOM 引用)后面加:

```ts
const importPetBtn = $<HTMLButtonElement>('importPet')
const importDetail = $<HTMLElement>('importDetail')
const importPreview = $<HTMLElement>('importPreview')
const importPreviewCanvas = $<HTMLCanvasElement>('importPreviewCanvas')
const importPreviewName = $<HTMLElement>('importPreviewName')
const importPreviewWarnings = $<HTMLElement>('importPreviewWarnings')
const importPreviewConfirm = $<HTMLButtonElement>('importPreviewConfirm')
const importPreviewCancel = $<HTMLButtonElement>('importPreviewCancel')
```

在这些 DOM 引用后面(文件顶部区域,`closeBtn.addEventListener(...)` 那一行之前或之后都可以,建议紧跟在上面这组新引用之后)加:

```ts
// 设置窗口是独立的 BrowserWindow(独立 JS 全局),这里覆盖 window.petApi.updateLive2DTransform
// 只影响本窗口——不会影响宠物窗口里真实的 window.petApi。Live2DPetRenderer.load() 首次
// 自动对齐模型尺寸时会无条件调用这个方法持久化结果;预览的是尚未提交的 staging 包,
// 绝不能借这个调用误写当前激活宠物的 pet.json,所以在本窗口里整体 stub 掉。
window.petApi.updateLive2DTransform = async () => ({ ok: true })

let pendingStaging: { stagingId: string; manifestId: string } | null = null
let previewRenderer: Live2DPetRenderer | null = null

function appendWarnings(target: HTMLElement, warnings: string[] | undefined): void {
  if (!warnings || warnings.length === 0) return
  target.style.display = 'block'
  for (const w of warnings) {
    const line = document.createElement('div')
    line.textContent = `· ${w}`
    target.appendChild(line)
  }
}

async function closeImportPreview(): Promise<void> {
  if (previewRenderer) {
    await previewRenderer.destroy()
    previewRenderer = null
  }
  importPreview.style.display = 'none'
  importPreviewWarnings.innerHTML = ''
  importPreviewWarnings.style.display = 'none'
  importPreviewName.textContent = ''
  pendingStaging = null
}
```

- [ ] **Step 3: 重写 `importPetBtn` 点击处理**

第 351-375 行当前是:

```ts
importPetBtn.addEventListener('click', async () => {
  importDetail.style.display = 'none'
  importDetail.innerHTML = ''
  try {
    const res = await window.settingsApi.importPet()
    if (!res) return // 用户取消,静默
    if (res.ok) {
      await refreshPets(res.pet.id)
      noPetBanner.style.display = 'none'
      status.textContent = `✓ 已导入:${res.pet.displayName}(选它并保存后重启生效)`
      if (res.warnings && res.warnings.length > 0) {
        importDetail.style.display = 'block'
        for (const w of res.warnings) {
          const line = document.createElement('div')
          line.textContent = `· ${w}`
          importDetail.appendChild(line)
        }
      }
    } else {
      status.textContent = `✗ ${res.message}`
    }
  } catch (err) {
    status.textContent = `✗ ${(err as Error)?.message ?? '出错了'}`
  }
})
```

改成:

```ts
importPetBtn.addEventListener('click', async () => {
  importDetail.style.display = 'none'
  importDetail.innerHTML = ''
  await closeImportPreview()
  try {
    const res: StageImportOutcome | null = await window.settingsApi.stageImportPet()
    if (!res) return // 用户取消,静默
    if (!res.ok) {
      status.textContent = `✗ ${res.message}`
      return
    }
    if (res.committed) {
      await refreshPets(res.pet.id)
      noPetBanner.style.display = 'none'
      status.textContent = `✓ 已导入:${res.pet.displayName}(选它并保存后重启生效)`
      appendWarnings(importDetail, res.warnings)
      return
    }
    pendingStaging = { stagingId: res.stagingId, manifestId: res.manifestId }
    importPreviewName.textContent = res.displayName
    appendWarnings(importPreviewWarnings, res.warnings)
    importPreview.style.display = 'block'
    previewRenderer = new Live2DPetRenderer(importPreviewCanvas)
    await previewRenderer.load(res.previewSource)
  } catch (err) {
    status.textContent = `✗ ${(err as Error)?.message ?? '出错了'}`
  }
})

importPreviewConfirm.addEventListener('click', async () => {
  if (!pendingStaging) return
  const { stagingId, manifestId } = pendingStaging
  try {
    const res = await window.settingsApi.commitStagedImport(stagingId, manifestId)
    await closeImportPreview()
    if (res.ok) {
      await refreshPets(res.pet.id)
      noPetBanner.style.display = 'none'
      status.textContent = `✓ 已导入:${res.pet.displayName}(选它并保存后重启生效)`
    } else {
      status.textContent = `✗ ${res.message}`
    }
  } catch (err) {
    status.textContent = `✗ ${(err as Error)?.message ?? '出错了'}`
  }
})

importPreviewCancel.addEventListener('click', async () => {
  if (pendingStaging) await window.settingsApi.discardStagedImport(pendingStaging.stagingId)
  await closeImportPreview()
})
```

- [ ] **Step 4: 类型检查**

Run: `pnpm typecheck`
Expected: 通过

- [ ] **Step 5: 真机验证(自动化检查不能替代,这是本计划风险最高的一步)**

```bash
pnpm preview
```

打开设置页"宠物"分页:

- 点"导入宠物包…",选一个合法的 Live2D 宠物包源文件夹(`pet.json` 的 `render.type==='live2d'`):
  - 预览面板出现,`<canvas>` 里能看到真实渲染出的模型(不是空白/黑屏)。
  - 显示名称和(如果有)警告文本正确显示。
  - 点"取消":预览面板消失,`userData/pets/` 下**没有**新目录出现,设置页"当前宠物"下拉菜单里也没有这只宠物。
  - 再次导入同一个包,这次点"确认导入":预览面板消失,状态栏显示"已导入",宠物下拉菜单里出现这只新宠物,`userData/pets/<id>/` 下有完整文件。
  - 确认导入后,`.staging` 目录下没有残留。
- 点"导入宠物包…",选一个合法的**精灵(sprite)**包源文件夹:确认行为和改造前一样——没有预览面板,直接一步提交成功。
- 中途关掉设置窗口再重新打开(模拟"预览确认前退出"),确认下次启动 `cleanupStaleStaging()` 已经把残留 staging 清掉,不会在宠物列表里出现半成品。
- 用一个 `pet.json` 里 `render.type==='sprite'` 的字段错误/缺失文件的坏包试一次,确认失败信息正常显示在 `status` 里,不会白屏或抛出未捕获异常。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/settings.html src/renderer/settings.ts
git commit -m "feat(live2d): 设置页新增 Live2D 导入预览面板,确认后才真正落地"
```

---

## 完成后

三个任务全部完成、真机验证通过后,这份计划的工作就结束了。如果鼠标追踪/口型两份计划还没跑完,继续跑那两份——三份计划全部完成后才在这个分支上执行一次整支 opus 最终审查,真机验收通过后一次性合并 + squash(`CLAUDE.md` 的 SquashCommitConstraint),推送到 origin 前照例先问用户。
