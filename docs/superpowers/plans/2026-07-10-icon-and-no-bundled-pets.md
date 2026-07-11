# App Icon Replacement + No-Bundled-Pets Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pet-derived app icon with an original, code-drawn icon, and stop shipping any pet package in `pnpm dist` builds — guiding a fresh install with zero pets straight into the Settings window to import one, instead of crashing.

**Architecture:** (1) A standalone Python/PIL script draws a new `build/icon.ico` from primitive shapes (no pet/spritesheet dependency). (2) A new pure function `resolvePetHome` (TDD, real-fs-tested like its sibling `ensurePetHome`) replaces the inline try/catch in `startShell()` and reports `'ready'` or `'onboarding'`. (3) A new `startOnboarding()` function in `src/main/shell/index.ts` boots only a Tray + the existing Settings window with a minimal, self-contained IPC handler set when `resolvePetHome` reports `'onboarding'`. (4) `electron-builder.yml` stops copying real pet folders into packaged output.

**Tech Stack:** TypeScript/Electron (main process), Vitest, Python 3 + Pillow (icon script), electron-builder (`extraResources` filter).

## Global Constraints

- Package manager is pnpm; do not add `"type": "module"` to `package.json` (breaks Electron main/preload — see `CLAUDE.md`).
- TDD for pure logic; GUI/Electron wiring is verified by running the app (`pnpm dev` / `pnpm preview`), not asserted by tests.
- Never hardcode IPC channel strings — always go through the `IPC` constant in `src/shared/ipc.ts`.
- Commit style: conventional commits, Chinese commit messages (per `CLAUDE.md`'s "十荣十耻").
- The new icon must be **original** (drawn from primitive shapes in code) — not a reproduction of the reference image's pixels (copyright avoidance was the explicit reason for this approach).
- Packaged (`pnpm dist`) builds must ship **zero** pet folders under `resources/pets/` (only `.keep`); `pnpm dev`/`pnpm preview` must continue to see the full local `pets/` directory unaffected.
- A fresh install with no pets available anywhere (bundled or `userData`) must **never** show the raw `dialog.showErrorBox` crash dialog — it must open Settings with an import prompt instead.

---

### Task 1: Original app icon generator script

**Files:**
- Create: `tools/hatch-desktop-pet/scripts/make_app_icon_original.py`
- Modify: `build/icon.ico` (regenerated binary output, not hand-edited)

**Interfaces:**
- Consumes: nothing from other tasks (fully standalone).
- Produces: `build/icon.ico` (16/32/48/64/128/256px sizes) — consumed by `electron-builder.yml`'s existing `win.icon: build/icon.ico` (unchanged reference, no other task touches this).

- [ ] **Step 1: Write the icon-generation script**

Create `tools/hatch-desktop-pet/scripts/make_app_icon_original.py`:

```python
"""从零画一个原创应用图标 build/icon.ico(开发期一次性)。

不依赖任何宠物包(不同于同目录下已废弃的 make_app_icon.py,它是从 luluka
的精灵图裁出来的)。构图上致敬用户提供的参考图(圆角方形底+猫耳机器人头盔+
发光眼睛/天线的可爱机器人猫太空员),但全部用 PIL 基本图形从零绘制,不复用/
摹描参考图的任何像素,规避版权问题。

用法:
    conda run -n peticon python tools/hatch-desktop-pet/scripts/make_app_icon_original.py
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))

SIZE = 256
BG_TOP = (60, 40, 120, 255)      # 靠上的紫色
BG_BOTTOM = (40, 70, 190, 255)   # 靠下的蓝色
WHITE = (245, 245, 250, 255)
OUTLINE = (20, 18, 30, 255)
VISOR = (18, 16, 28, 255)
GLOW = (110, 235, 240, 255)


def rounded_square_gradient(size: int, radius: int) -> Image.Image:
    """圆角方形底,纵向紫→蓝渐变。"""
    grad = Image.new("RGBA", (size, size))
    for y in range(size):
        t = y / (size - 1)
        r = int(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t)
        g = int(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t)
        b = int(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)
        for x in range(size):
            grad.putpixel((x, y), (r, g, b, 255))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out


def draw_head(canvas: Image.Image) -> None:
    d = ImageDraw.Draw(canvas)
    cx, cy = SIZE // 2, SIZE // 2 + 10

    # 猫耳(两个三角形,画在头盔之前所以头盔边缘会盖住耳朵根部)
    ear_h = 46
    d.polygon([(cx - 78, cy - 58), (cx - 40, cy - 92), (cx - 26, cy - 46)], fill=WHITE, outline=OUTLINE, width=4)
    d.polygon([(cx + 78, cy - 58), (cx + 40, cy - 92), (cx + 26, cy - 46)], fill=WHITE, outline=OUTLINE, width=4)

    # 头盔:圆角方形白色轮廓
    helmet_box = [cx - 72, cy - 66, cx + 72, cy + 74]
    d.rounded_rectangle(helmet_box, radius=46, fill=WHITE, outline=OUTLINE, width=5)

    # 天线:两根细杆 + 发光小球
    d.line([(cx - 34, cy - 66), (cx - 34, cy - 96)], fill=OUTLINE, width=5)
    d.line([(cx + 34, cy - 66), (cx + 34, cy - 96)], fill=OUTLINE, width=5)
    for ax in (cx - 34, cx + 34):
        d.ellipse([ax - 11, cy - 107, ax + 11, cy - 85], fill=GLOW, outline=OUTLINE, width=3)

    # 面罩(深色visor,内缩于头盔)
    visor_box = [cx - 54, cy - 44, cx + 54, cy + 56]
    d.rounded_rectangle(visor_box, radius=34, fill=VISOR)

    # 发光弯眨眼睛(两段向上开口的弧线)
    eye_w, eye_h = 34, 26
    for ex in (cx - 26, cx + 26):
        d.arc([ex - eye_w // 2, cy - 6 - eye_h // 2, ex + eye_w // 2, cy - 6 + eye_h // 2],
              start=200, end=340, fill=GLOW, width=6)


def build() -> Image.Image:
    canvas = rounded_square_gradient(SIZE, radius=56)
    draw_head(canvas)
    return canvas


if __name__ == "__main__":
    canvas = build()
    out = os.path.join(ROOT, "build", "icon.ico")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    canvas.save(out, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote", out)
```

- [ ] **Step 2: Run the script and verify output**

Run (repo root):
```bash
conda run -n peticon python tools/hatch-desktop-pet/scripts/make_app_icon_original.py
```
If the `peticon` conda env is unavailable in the execution environment, plain `python` also works here since Pillow is already importable on this machine's base interpreter — verify first with `python -c "import PIL; print(PIL.__version__)"`, then run `python tools/hatch-desktop-pet/scripts/make_app_icon_original.py` instead.

Expected: prints `wrote <repo>\build\icon.ico`, and `build/icon.ico` is modified (check via `git status` / `git diff --stat build/icon.ico` showing a binary change).

- [ ] **Step 3: Visual sanity check**

Open `build/icon.ico` in an image viewer (e.g. `powershell -c "Invoke-Item build/icon.ico"` or drag it into a browser tab) and confirm: rounded gradient badge, white cat-eared helmet outline, two glowing antenna tips, two glowing curved eyes, no leftover transparency artifacts, no visible resemblance-by-copying to the reference photo (it should read as a distinct, simpler, code-drawn mark).

- [ ] **Step 4: Commit**

```bash
git add tools/hatch-desktop-pet/scripts/make_app_icon_original.py build/icon.ico
git commit -m "feat(icon): 用代码绘制原创应用图标,替换 luluka 精灵图衍生的旧图标"
```

---

### Task 2: `resolvePetHome` pure function (TDD)

**Files:**
- Create: `src/main/pets/resolvePetHome.ts`
- Test: `src/main/pets/resolvePetHome.test.ts`

**Interfaces:**
- Consumes: `ensurePetHome`, `type PetHomeResult` from `src/main/pets/petHome.ts` (existing, unchanged — see `src/main/pets/petHome.ts:25-45` for its exact signature/behavior).
- Produces: `resolvePetHome(opts: ResolvePetHomeOptions): ResolvePetHomeResult` and the `ResolvePetHomeOptions`/`ResolvePetHomeResult` types, both exported from `src/main/pets/resolvePetHome.ts`. `ResolvePetHomeResult` is `{ mode: 'ready'; petHome: PetHomeResult } | { mode: 'onboarding' }`. Task 4 imports and calls this.

- [ ] **Step 1: Write the failing tests**

Create `src/main/pets/resolvePetHome.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolvePetHome } from './resolvePetHome'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'resolvepethome-'))
}
function makeBundledPet(bundledRoot: string, id: string): void {
  const dir = join(bundledRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'pet.json'), JSON.stringify({ id }), 'utf-8')
}

describe('resolvePetHome', () => {
  it('配置的宠物包存在 → ready,用配置的 id', () => {
    const userDataDir = scratch()
    const bundledPetsDir = scratch()
    makeBundledPet(bundledPetsDir, 'alice')
    makeBundledPet(bundledPetsDir, 'luluka')
    const result = resolvePetHome({
      userDataDir,
      bundledPetsDir,
      configuredPetId: 'alice',
      defaultPetId: 'luluka',
      legacyMemoryDir: join(userDataDir, 'memory')
    })
    expect(result.mode).toBe('ready')
    if (result.mode === 'ready') {
      expect(existsSync(join(result.petHome.petHome, 'pet.json'))).toBe(true)
      expect(result.petHome.petHome).toBe(join(userDataDir, 'pets', 'alice'))
    }
  })

  it('配置的宠物包缺失,默认宠物包存在 → ready,回退默认 id 并迁移旧 memory', () => {
    const userDataDir = scratch()
    const bundledPetsDir = scratch()
    makeBundledPet(bundledPetsDir, 'luluka')
    const legacyMemoryDir = join(userDataDir, 'memory')
    mkdirSync(legacyMemoryDir, { recursive: true })
    writeFileSync(join(legacyMemoryDir, 'facts.json'), '[]', 'utf-8')
    const result = resolvePetHome({
      userDataDir,
      bundledPetsDir,
      configuredPetId: 'ghost',
      defaultPetId: 'luluka',
      legacyMemoryDir
    })
    expect(result.mode).toBe('ready')
    if (result.mode === 'ready') {
      expect(result.petHome.petHome).toBe(join(userDataDir, 'pets', 'luluka'))
      expect(existsSync(join(result.petHome.memoryDir, 'facts.json'))).toBe(true)
    }
  })

  it('配置的宠物包和默认宠物包都缺失 → onboarding', () => {
    const userDataDir = scratch()
    const bundledPetsDir = scratch()
    mkdirSync(bundledPetsDir, { recursive: true }) // 空目录,一个宠物都没有
    const result = resolvePetHome({
      userDataDir,
      bundledPetsDir,
      configuredPetId: 'ghost',
      defaultPetId: 'luluka',
      legacyMemoryDir: join(userDataDir, 'memory')
    })
    expect(result.mode).toBe('onboarding')
  })

  it('配置的 id 就是默认 id 且缺失 → 直接 onboarding(不重复尝试)', () => {
    const userDataDir = scratch()
    const bundledPetsDir = scratch()
    mkdirSync(bundledPetsDir, { recursive: true })
    const result = resolvePetHome({
      userDataDir,
      bundledPetsDir,
      configuredPetId: 'luluka',
      defaultPetId: 'luluka',
      legacyMemoryDir: join(userDataDir, 'memory')
    })
    expect(result.mode).toBe('onboarding')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/pets/resolvePetHome.test.ts`
Expected: FAIL — `Cannot find module './resolvePetHome'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/main/pets/resolvePetHome.ts`:

```typescript
import { ensurePetHome, type PetHomeResult } from './petHome'

export interface ResolvePetHomeOptions {
  userDataDir: string
  bundledPetsDir: string
  configuredPetId: string
  defaultPetId: string
  /** 旧全局 userData/memory;仅在最终落地的是默认宠物时才会被迁移,见 ensurePetHome 语义 */
  legacyMemoryDir: string
}

export type ResolvePetHomeResult =
  | { mode: 'ready'; petHome: PetHomeResult }
  | { mode: 'onboarding' }

/**
 * 解析活跃宠物家目录:先试 configuredPetId,失败则回退 defaultPetId;两者都没有
 * 对应的宠物包(内置或已导入到 userData)时返回 onboarding,交给调用方走引导导入
 * 流程,而不是抛错让 startShell 变成无窗口的启动失败。
 */
export function resolvePetHome(opts: ResolvePetHomeOptions): ResolvePetHomeResult {
  const { userDataDir, bundledPetsDir, configuredPetId, defaultPetId, legacyMemoryDir } = opts
  try {
    const petHome = ensurePetHome({
      userDataDir,
      bundledPetsDir,
      activePetId: configuredPetId,
      legacyMemoryDir: configuredPetId === defaultPetId ? legacyMemoryDir : undefined
    })
    return { mode: 'ready', petHome }
  } catch (err) {
    if (configuredPetId === defaultPetId) return { mode: 'onboarding' }
    console.warn(`[pet] activePetId "${configuredPetId}" 无对应宠物包,回退默认 "${defaultPetId}"`, err)
    try {
      const petHome = ensurePetHome({ userDataDir, bundledPetsDir, activePetId: defaultPetId, legacyMemoryDir })
      return { mode: 'ready', petHome }
    } catch (err2) {
      console.warn('[pet] 默认宠物包也不存在,进入引导导入模式', err2)
      return { mode: 'onboarding' }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/pets/resolvePetHome.test.ts`
Expected: PASS (4/4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/pets/resolvePetHome.ts src/main/pets/resolvePetHome.test.ts
git commit -m "feat(pet): 抽出 resolvePetHome 纯函数,零宠物包时报 onboarding 而非抛错"
```

---

### Task 3: `SettingsSnapshot.noPetInstalled` field

**Files:**
- Modify: `src/shared/ipc.ts:149`
- Modify: `src/main/shell/index.ts` (the existing `GET_SETTINGS` handler, currently at line 600-606)

**Interfaces:**
- Consumes: nothing new.
- Produces: `SettingsSnapshot` now has a required `noPetInstalled: boolean` field. Task 4's onboarding `GET_SETTINGS` handler and Task 6's renderer code both depend on this field existing.

- [ ] **Step 1: Add the field to the shared type**

In `src/shared/ipc.ts`, change line 149 from:
```typescript
export interface SettingsSnapshot { settings: AppSettings; hasKey: boolean; hasSearchKey: boolean; hasEmbeddingKey: boolean; hasFirecrawlKey: boolean }
```
to:
```typescript
export interface SettingsSnapshot { settings: AppSettings; hasKey: boolean; hasSearchKey: boolean; hasEmbeddingKey: boolean; hasFirecrawlKey: boolean; noPetInstalled: boolean }
```

- [ ] **Step 2: Update the normal-boot `GET_SETTINGS` handler**

In `src/main/shell/index.ts`, the handler currently at lines 600-606:
```typescript
  ipcMain.handle(IPC.GET_SETTINGS, async (): Promise<SettingsSnapshot> => ({
    settings: loadSettings(settingsFile),
    hasKey: secrets.hasKey(),
    hasSearchKey: searchSecrets.hasKey(),
    hasEmbeddingKey: embeddingSecrets.hasKey(),
    hasFirecrawlKey: firecrawlSecrets.hasKey()
  }))
```
becomes:
```typescript
  ipcMain.handle(IPC.GET_SETTINGS, async (): Promise<SettingsSnapshot> => ({
    settings: loadSettings(settingsFile),
    hasKey: secrets.hasKey(),
    hasSearchKey: searchSecrets.hasKey(),
    hasEmbeddingKey: embeddingSecrets.hasKey(),
    hasFirecrawlKey: firecrawlSecrets.hasKey(),
    noPetInstalled: false // 走到这个 handler 说明 startShell 已经解析出一个可用宠物家目录
  }))
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. (This will currently fail if any other `SettingsSnapshot` literal exists without the new field — there is only the one above plus the one Task 4 will add; Task 4 adds its own literal with the field already included, so after both tasks this passes. If run standalone right now it should still pass since this is the only existing construction site.)

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc.ts src/main/shell/index.ts
git commit -m "feat(settings): SettingsSnapshot 新增 noPetInstalled 字段"
```

---

### Task 4: `startOnboarding()` + wire `resolvePetHome` into `startShell()`

**Files:**
- Modify: `src/main/shell/index.ts`

**Interfaces:**
- Consumes: `resolvePetHome` from Task 2 (`src/main/pets/resolvePetHome.ts`), `SettingsSnapshot.noPetInstalled` from Task 3. All other symbols used (`createSecretStore`, `createSettingsWindow`, `createTray`, `loadSettings`, `saveSettings`, `normalizeSettings`, `listPets`, `importPetFolder`, `testConnection`, `validateKey`, `validateTestConnectionArg`, `IPC`, `TestResult`) are already imported in this file — no new imports needed for those.
- Produces: nothing new for later tasks (this is the integration point; Task 6 only touches renderer files).

- [ ] **Step 1: Replace the `ensurePetHome`/`PetHomeResult` import with `resolvePetHome`**

In `src/main/shell/index.ts:54`, change:
```typescript
import { ensurePetHome, type PetHomeResult } from '../pets/petHome'
```
to:
```typescript
import { resolvePetHome } from '../pets/resolvePetHome'
```

- [ ] **Step 2: Hoist `petCatalogDirs` and replace the pet-resolution block**

In `src/main/shell/index.ts`, the block currently at lines 84-108:
```typescript
  const userData = app.getPath('userData')
  const settingsFile = join(userData, 'settings.json')
  // 换宠物是"改 settings.json 的 activePetId 后重启"的既定流程,拼错/残留一个未随包分发的
  // id 会让 ensurePetHome 抛错;若不兜底,startShell 的异常会变成无窗口的静默启动失败。故:
  // 配置的宠物包缺失时回退到默认宠物(default 自身仍缺失才真正抛错)。
  const petHomeOpts = { userDataDir: userData, bundledPetsDir: petsDir(appRoot) }
  // MVP-05 的旧全局 userData/memory 是在默认宠物 luluka 下攒的,只在"激活的就是默认宠物"时
  // 一次性迁入,避免把 luluka 的记忆错误搬进另一只宠物的文件夹(spec §3.3:仅对默认宠物迁移)。
  const legacyMemoryDir = join(userData, 'memory')
  const configuredPetId = loadSettings(settingsFile).activePetId
  const defaultPetId = DEFAULT_SETTINGS.activePetId
  let petHomeResult: PetHomeResult
  try {
    petHomeResult = ensurePetHome({
      ...petHomeOpts,
      activePetId: configuredPetId,
      legacyMemoryDir: configuredPetId === defaultPetId ? legacyMemoryDir : undefined
    })
  } catch (err) {
    if (configuredPetId === defaultPetId) throw err
    console.warn(`[pet] activePetId "${configuredPetId}" 无对应宠物包,回退默认 "${defaultPetId}"`, err)
    // 回退到默认宠物 → 此时迁移旧全局记忆(luluka 的)是正确的
    petHomeResult = ensurePetHome({ ...petHomeOpts, activePetId: defaultPetId, legacyMemoryDir })
  }
  const { petHome, memoryDir } = petHomeResult
```

becomes:
```typescript
  const userData = app.getPath('userData')
  const settingsFile = join(userData, 'settings.json')
  const petCatalogDirs = { bundledPetsDir: petsDir(appRoot), userPetsDir: join(userData, 'pets') }
  // MVP-05 的旧全局 userData/memory 是在默认宠物 luluka 下攒的,只在"激活的就是默认宠物"时
  // 一次性迁入,避免把 luluka 的记忆错误搬进另一只宠物的文件夹(spec §3.3:仅对默认宠物迁移)。
  const legacyMemoryDir = join(userData, 'memory')
  const configuredPetId = loadSettings(settingsFile).activePetId
  const defaultPetId = DEFAULT_SETTINGS.activePetId
  // 换宠物是"改 settings.json 的 activePetId 后重启"的既定流程,拼错/残留一个未随包分发的
  // id、或(自 Part 2 起)全新安装还没导入过任何宠物包,都会让 resolvePetHome 报 onboarding
  // 而不是抛错——此时不继续往下建正常的宠物精灵窗等重家伙,转去引导导入。
  const resolved = resolvePetHome({
    userDataDir: userData,
    bundledPetsDir: petCatalogDirs.bundledPetsDir,
    configuredPetId,
    defaultPetId,
    legacyMemoryDir
  })
  if (resolved.mode === 'onboarding') {
    startOnboarding({ appRoot, preload, rendererUrl, dirname, userData, settingsFile, petCatalogDirs })
    return
  }
  const { petHome, memoryDir } = resolved.petHome
```

- [ ] **Step 3: Remove the now-duplicate `petCatalogDirs` declaration further down**

In `src/main/shell/index.ts`, the existing line (originally line 676, exact line number may have shifted slightly after Step 2's edit — search for it):
```typescript
  const petCatalogDirs = { bundledPetsDir: petsDir(appRoot), userPetsDir: join(userData, 'pets') }
  ipcMain.handle(IPC.LIST_PETS, async () => listPets(petCatalogDirs))
```
Delete only the first line (the duplicate declaration) — keep the `ipcMain.handle(IPC.LIST_PETS, ...)` line as-is, since `petCatalogDirs` is now the hoisted `const` from Step 2 and is already in scope here.

- [ ] **Step 4: Add the `startOnboarding` function**

In `src/main/shell/index.ts`, add this new function directly above `export function startShell(): void {` (i.e. before the existing line that currently reads `export function startShell(): void {`):

```typescript
/**
 * 全新安装、且用户还没导入任何宠物包时的降级启动路径:既没有打包内置的宠物包
 * (Part 2 起打包不再带真实宠物包),也没有 userData 里已导入的。只拉起托盘 +
 * 设置窗口,引导用户导入宠物包后重启;不建任何依赖宠物家目录的窗口/服务
 * (宠物精灵窗、对话框、气泡、待办、记忆、agent providers、语音、自动化等)。
 * 用户导入宠物包并点"立即重启"后,下次 startShell() 会通过 resolvePetHome 正常
 * 走 'ready' 分支。
 */
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

  const secrets = createSecretStore(join(userData, 'secrets.bin'), safeStorage)
  const searchSecrets = createSecretStore(join(userData, 'secrets-tavily.bin'), safeStorage)
  const embeddingSecrets = createSecretStore(join(userData, 'secrets-embedding.bin'), safeStorage)
  const firecrawlSecrets = createSecretStore(join(userData, 'secrets-firecrawl.bin'), safeStorage)

  const settings = createSettingsWindow({
    preload,
    url: rendererUrl ? `${rendererUrl}/settings.html` : undefined,
    settingsHtml: join(dirname, '../renderer/settings.html')
  })

  ipcMain.handle(IPC.GET_SETTINGS, async (): Promise<SettingsSnapshot> => ({
    settings: loadSettings(settingsFile),
    hasKey: secrets.hasKey(),
    hasSearchKey: searchSecrets.hasKey(),
    hasEmbeddingKey: embeddingSecrets.hasKey(),
    hasFirecrawlKey: firecrawlSecrets.hasKey(),
    noPetInstalled: listPets(petCatalogDirs).length === 0
  }))
  ipcMain.handle(IPC.SET_SETTINGS, async (_e, raw) => {
    saveSettings(settingsFile, normalizeSettings(raw))
    // 注:正常启动路径下的 SET_SETTINGS 还会在关闭 browserControl.enabled 时调用
    // browserControl.close() —— 这个模式下 browserControl 压根没建过(没有宠物就
    // 没有任何自动化功能可用),不存在"正在运行、需要关掉"的场景,故省略。
  })
  ipcMain.handle(IPC.SET_API_KEY, async (_e, raw): Promise<boolean> => {
    const key = validateKey(raw); return key === null ? false : secrets.setKey(key)
  })
  ipcMain.handle(IPC.SET_SEARCH_KEY, async (_e, raw): Promise<boolean> => {
    const key = validateKey(raw); return key === null ? false : searchSecrets.setKey(key)
  })
  ipcMain.handle(IPC.SET_EMBEDDING_KEY, async (_e, raw): Promise<boolean> => {
    const key = validateKey(raw); return key === null ? false : embeddingSecrets.setKey(key)
  })
  ipcMain.handle(IPC.SET_FIRECRAWL_KEY, async (_e, raw): Promise<boolean> => {
    const key = validateKey(raw); return key === null ? false : firecrawlSecrets.setKey(key)
  })
  ipcMain.handle(IPC.TEST_CONNECTION, async (_e, raw): Promise<TestResult> => {
    const arg = validateTestConnectionArg(raw)
    if (!arg) return { ok: false, error: 'invalid request' }
    return testConnection(arg.provider, arg.key)
  })
  ipcMain.handle(IPC.LIST_PETS, async () => listPets(petCatalogDirs))
  ipcMain.handle(IPC.IMPORT_PET, async () => {
    const r = await electronDialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || r.filePaths.length === 0) return null
    return importPetFolder(r.filePaths[0], petCatalogDirs)
  })
  ipcMain.on(IPC.RELAUNCH_APP, () => { app.relaunch(); app.quit() })
  ipcMain.on(IPC.OPEN_SETTINGS, () => settings.open())

  tray = createTray(join(appRoot, 'resources/tray.png'), {
    onSettings: () => settings.open(),
    onQuickAction: () => settings.open(),
    onTodos: () => settings.open()
  })

  settings.open()
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. Watch for: unused-import errors on `ensurePetHome`/`PetHomeResult` (should be gone after Step 1), and confirm `SettingsSnapshot`, `TestResult`, `ipcMain`, `safeStorage`, `electronDialog`, `createSecretStore`, `createSettingsWindow`, `createTray`, `loadSettings`, `saveSettings`, `normalizeSettings`, `listPets`, `importPetFolder`, `testConnection`, `validateKey`, `validateTestConnectionArg` are all already imported at the top of `src/main/shell/index.ts` (they are, per the existing import block — this task adds no new imports).

- [ ] **Step 6: Run the full test suite**

Run: `pnpm vitest run`
Expected: PASS, same count as before this task plus the 4 new tests from Task 2 (no existing test should be affected — this task only touches `src/main/shell/index.ts`, which has no test file).

- [ ] **Step 7: Manual verification — onboarding path actually boots**

This is Electron GUI wiring; verify by running the app, per this repo's convention (`CLAUDE.md`: "Automated checks passing ≠ the app runs").

1. Temporarily rename the repo's `pets/` directory aside (e.g. `pets` → `pets-backup`) and create an empty `pets/` with just a `.keep` file, so the dev run sees zero bundled pets (matches what a fresh packaged install would see).
2. Also ensure no leftover `userData/pets/` from a previous run: find the app's userData path (Windows: `%APPDATA%/pet-agent/`) and temporarily rename `pets` there aside if present, so `userData/pets/` is empty too.
3. Run `pnpm preview` (or `pnpm dev`).
4. Expected: no error dialog; the Settings window opens automatically, landed on some page, with the "宠物" tab reachable; tray icon is present with "设置"/"退出" entries.
5. Click "导入宠物包…", pick one of the folders from `pets-backup/` (e.g. `pets-backup/luluka`), confirm the import succeeds and the relaunch button appears.
6. Click "立即重启" — confirm the app restarts and now shows the normal pet sprite window (full boot, not onboarding).
7. Restore `pets/` (move `pets-backup` back to `pets`, remove the temporary empty one) and restore `userData/pets` if you renamed it aside.

If you don't have a real display available in this session, state that explicitly and defer this step to the user rather than looping on it.

- [ ] **Step 8: Commit**

```bash
git add src/main/shell/index.ts
git commit -m "feat(pet): 零宠物包时拉起设置窗口引导导入,而不是抛错崩溃"
```

---

### Task 5: Stop bundling pet packages in `pnpm dist`

**Files:**
- Modify: `electron-builder.yml`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing consumed by other tasks (packaging config, verified independently).

- [ ] **Step 1: Change the `pets` extraResources filter**

In `electron-builder.yml`, change:
```yaml
extraResources:
  - from: pets
    to: pets
    # 防御:即便开发机的 pets/<id>/ 里意外攒了运行时记忆,也不打进公开安装包(记忆属用户数据)。
    filter:
      - '!**/memory/**'
  - from: skills
    to: skills
  - from: resources
    to: resources
```
to:
```yaml
extraResources:
  # 不再默认打包任何真实宠物包(见 docs/superpowers/specs/2026-07-10-icon-and-no-bundled-pets-design.md):
  # 只保留 pets/.keep 让目录存在,首次启动零宠物包时 startShell 会拉起设置窗口引导用户导入。
  - from: pets
    to: pets
    filter:
      - '!**/*'
      - '.keep'
  - from: skills
    to: skills
  - from: resources
    to: resources
```

- [ ] **Step 2: Update the stale comment above `extraResources`**

In `electron-builder.yml`, the comment block currently reads:
```yaml
# 运行时资源:主进程用 process.resourcesPath/<name> 读取。
# - pets: 全部磁盘宠物(luluka/youka...),activePetId 可选任意一只,首启播种到 userData。
# - skills: 产品运行时技能(全局只读)。
# - resources: 托盘图标 tray.png(shell 从 process.resourcesPath/resources/tray.png 读)。
```
Change the `pets` line to:
```yaml
# - pets: 不带任何真实宠物包(仅 .keep 占位),用户需在设置里手动导入,导入后播种到 userData。
```

- [ ] **Step 3: Verify via a packaged build**

Run: `pnpm dist`
Expected: succeeds (this runs `pnpm build && electron-builder --win`; allow several minutes). Then inspect the unpacked output:

```bash
ls dist/win-unpacked/resources/pets
```
Expected: only `.keep` is listed — no `luluka`/`youka`/`alice`/etc. directories.

If `pnpm dist` isn't practical to run in this session (slow, needs Windows code-signing tooling, etc.), state that explicitly and defer this verification step to the user rather than looping on it — the `filter` syntax itself (`'!**/*'` then re-include `'.keep'`) is a standard electron-builder ignore-pattern idiom also usable to sanity-check by reading `dist/win-unpacked/resources/pets` after any successful prior packaging run.

- [ ] **Step 4: Commit**

```bash
git add electron-builder.yml
git commit -m "build: pnpm dist 不再默认打包任何宠物包,只保留 pets/.keep"
```

---

### Task 6: Settings UI — "no pet installed" banner

**Files:**
- Modify: `src/renderer/settings.html`
- Modify: `src/renderer/settings.ts`

**Interfaces:**
- Consumes: `SettingsSnapshot.noPetInstalled` (Task 3) via the existing `window.settingsApi.getSettings()` call already made in `settings.ts`'s init IIFE (`src/renderer/settings.ts:336-366`).
- Produces: nothing consumed by other tasks (leaf UI change).

- [ ] **Step 1: Add the banner markup and a warning style**

In `src/renderer/settings.html`, add a new CSS rule inside the existing `<style>` block (after the `.hint` rule at line 22):
```css
.banner-warn { background: rgba(230,160,60,0.18); border: 1px solid rgba(230,160,60,0.6); border-radius: 8px; padding: 8px 10px; line-height: 1.5; }
```

Then change the "宠物" page section (currently lines 68-77):
```html
          <section class="page" data-page="pet">
            <h2>宠物</h2>
            <label>当前宠物(重启后生效)
              <select id="petSelect"></select>
            </label>
            <div class="row">
              <button id="importPet" class="secondary">导入宠物包…</button>
              <button id="relaunch" class="secondary" style="display:none">立即重启</button>
            </div>
          </section>
```
to:
```html
          <section class="page" data-page="pet">
            <h2>宠物</h2>
            <div id="noPetBanner" class="banner-warn" style="display:none">未检测到宠物包,请先导入一个宠物包,然后点击"立即重启"。</div>
            <label>当前宠物(重启后生效)
              <select id="petSelect"></select>
            </label>
            <div class="row">
              <button id="importPet" class="secondary">导入宠物包…</button>
              <button id="relaunch" class="secondary" style="display:none">立即重启</button>
            </div>
          </section>
```

- [ ] **Step 2: Show the banner and land on the "宠物" page when there's no pet**

In `src/renderer/settings.ts`, add the element lookup near the other `$<...>` declarations at the top (right after the `importPetBtn`/`relaunchBtn` declarations around line 24-25):
```typescript
const noPetBanner = $<HTMLElement>('noPetBanner')
```

Then in the init IIFE (`src/renderer/settings.ts:336-366`), change:
```typescript
  status.textContent = snap.hasKey ? '(已配置 Key,如需更换请重新填写)' : '首次使用:选 Provider、填 Key 即可。'
  showPage('model') // 默认落地页:模型 · API
})()
```
to:
```typescript
  noPetBanner.style.display = snap.noPetInstalled ? '' : 'none'
  status.textContent = snap.hasKey ? '(已配置 Key,如需更换请重新填写)' : '首次使用:选 Provider、填 Key 即可。'
  showPage(snap.noPetInstalled ? 'pet' : 'model') // 没有宠物包时直接落地到"宠物"页,引导导入
})()
```

- [ ] **Step 3: Hide the banner immediately after a successful import**

In `src/renderer/settings.ts`, the `importPetBtn` click handler (lines 246-259) currently:
```typescript
importPetBtn.addEventListener('click', async () => {
  try {
    const res = await window.settingsApi.importPet()
    if (!res) return // 用户取消,静默
    if (res.ok) {
      await refreshPets(res.pet.id)
      status.textContent = `✓ 已导入:${res.pet.displayName}(选它并保存后重启生效)`
    } else {
      status.textContent = `✗ ${res.message}`
    }
  } catch (err) {
    status.textContent = `✗ ${(err as Error)?.message ?? '出错了'}`
  }
})
```
becomes:
```typescript
importPetBtn.addEventListener('click', async () => {
  try {
    const res = await window.settingsApi.importPet()
    if (!res) return // 用户取消,静默
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
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Manual verification**

Reuse the same zero-pets setup from Task 4 Step 7 (or, if already restored, redo it briefly): run `pnpm preview` with empty `pets/`/`userData/pets/`, open Settings, confirm the "宠物" page is shown by default with the amber banner visible above the pet picker, and that importing a pet makes the banner disappear immediately (before any reload). If you don't have a real display available, state that explicitly and defer to the user.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/settings.html src/renderer/settings.ts
git commit -m "feat(settings): 无宠物包时在设置页显示导入提示横幅并默认落地宠物页"
```

---

### Task 7: Final full-suite verification

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: PASS, count = (previous total) + 4 (Task 2's new tests).

- [ ] **Step 3: Full build**

Run: `pnpm build`
Expected: PASS (typecheck + electron-vite build, all three bundles).

- [ ] **Step 4: Real-app smoke test with pets present (regression check)**

Run `pnpm preview` with the repo's normal `pets/` directory intact (not emptied). Expected: app boots exactly as before this plan — pet sprite window appears, no onboarding path triggered, Settings window opens normally via tray with all sections working. This confirms the `resolvePetHome`/`startOnboarding` changes are a no-op for the common case.

If a real display isn't available in this session for Step 4, state that explicitly and defer it to the user rather than looping on it.
