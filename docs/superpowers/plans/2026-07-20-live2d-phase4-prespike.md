# Live2D Phase 2 前置真实模型加载 Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭一个独立、验证完即删除的 Electron 诊断工具,用两个真实购买的 Live2D 模型(`白-免费版` 16384² 单贴图 / `茕兔pack` 10×4096² 分块贴图+VTube Studio 游离表情动作),在软渲染/硬件加速两种模式下实测贴图尺寸上限、引擎 API 真实行为,把结果写回设计文档供 Phase 2/4 决策使用。

**Architecture:** `scripts/live2d-spike/` 是完全独立于 pet-Agent 主项目的一次性 Node/Electron 工具,自带 `package.json`+`node_modules`(只装 `pixi.js`+`untitled-pixi-live2d-engine`,不碰主项目 `pnpm-lock.yaml`),复用主项目已安装的 Electron 43 二进制来跑(不重复下载)。主进程(`main.cjs`)按命令行参数决定软/硬渲染;渲染进程(`renderer.cjs`,走 `require()` 而非浏览器原生 ESM `import`,因为两个目标包虽是 `"type":"module"` 但都发布了 CJS 双构建,`require()` 更稳妥、不依赖 import map)加载模型、采集数据、写入 `results.ndjson`。

**Tech Stack:** Electron(复用主项目 `node_modules/electron`,当前是 43.x)、`pixi.js@8.19.0`、`untitled-pixi-live2d-engine@1.3.5`,均为 npm 已发布版本,与本机已克隆的引擎源码版本一致。

## Global Constraints

- 不改动 `d:\LProject\claude_Project\pet-Agent` 根目录的 `package.json`/`pnpm-lock.yaml`/任何 `src/` 生产代码。
- 不修改 `D:\LProject\claude_Project\live2dModel\` 下的任何原始购买文件(只读)。
- 引擎/pixi 版本精确锁定为 `untitled-pixi-live2d-engine@1.3.5`、`pixi.js@8.19.0`(与本机已克隆的引擎源码版本一致,避免 spike 数据和以后 Phase 4 正式引入的版本不一致)。
- 渲染进程用 `require()`(CommonJS)访问这两个包,不使用 `<script type="module">` 的裸模块说明符 import(浏览器原生 ESM 不支持 node_modules 裸说明符解析,会直接报错;两个包都发布了 CJS 构建,`require()` 是唯一被验证过确定可行的路径)。
- `scripts/live2d-spike/` 全程不接触任何生产 IPC 通道、不引用 `src/shared`/`src/main`/`src/renderer` 里的任何代码。
- 最终验证(模型是否正常渲染、贴图是否加载成功、FPS/呼吸眨眼观感)必须由用户在真机上执行——当前 agent 会话没有可用的真实显示器/GPU 环境,这一点适用于本计划的每一个任务。

---

### Task 1: 独立 package.json + 安装依赖

**Files:**
- Create: `scripts/live2d-spike/package.json`

**Interfaces:**
- Produces: `scripts/live2d-spike/node_modules/{pixi.js,untitled-pixi-live2d-engine}`,供 Task 3(`renderer.cjs`)`require()`。

- [ ] **Step 1: 创建目录和 package.json**

```json
{
  "name": "live2d-spike",
  "private": true,
  "version": "0.0.0",
  "description": "一次性诊断工具,验证完即删除,不是 pet-Agent 的一部分",
  "dependencies": {
    "pixi.js": "8.19.0",
    "untitled-pixi-live2d-engine": "1.3.5"
  }
}
```

- [ ] **Step 2: 安装依赖**

在 `scripts/live2d-spike/` 目录内执行(注意:是在这个子目录内跑,不是仓库根目录,避免碰到根目录的 `pnpm-lock.yaml`):

```bash
cd scripts/live2d-spike && pnpm install
```

Expected: 成功生成 `scripts/live2d-spike/node_modules/`,包含 `pixi.js` 和 `untitled-pixi-live2d-engine` 两个包,退出码 0。

- [ ] **Step 3: 确认根目录 lockfile 未受影响**

```bash
git status
```

Expected: 只有 `scripts/live2d-spike/` 下的新文件是 untracked,根目录 `pnpm-lock.yaml`/`package.json` 没有 `modified` 标记。

---

### Task 2: 生成 VTube-orphan 修复用的 fixture model3.json

**Files:**
- Create: `scripts/live2d-spike/fixtures/build-fixture.cjs`
- Produces (运行后生成,不提交进 git,加进 `.gitignore` 或直接不 add): `scripts/live2d-spike/fixtures/茕兔.model3.json`

**Interfaces:**
- Consumes: `D:\LProject\claude_Project\live2dModel\茕兔pack\茕兔\` 目录下的真实文件(只读)。
- Produces: `scripts/live2d-spike/fixtures/茕兔.model3.json`,一份把原始 `FileReferences` 里所有字段(含新增的 `Expressions`/`Motions`)都改写成绝对 `file://` URL 的副本,供 Task 4 的 `renderer.cjs` 用 `model=qiongtu-full` 时加载。

**为什么每个字段都要改写成绝对 URL,不能只加 Expressions/Motions**:引擎的路径解析工具 `src/utils/url.ts` 里的 `resolveURL(base, path)`,当 `path` 本身已经带 URL scheme(如 `file:`)时会直接原样返回、完全跳过相对路径解析(`SCHEME_RE.test(path)` 命中直接 `return path`)。如果这份 fixture 文件放在 `scripts/live2d-spike/fixtures/` 下,而 `Moc`/`Textures`/`Physics`/`DisplayInfo` 还留着相对路径(如 `"茕兔.moc3"`),就会被错误地相对 `fixtures/` 目录解析,而不是原始模型所在目录——所以统一改写成绝对 URL 是唯一稳妥的做法。

- [ ] **Step 1: 写生成脚本**

```js
// scripts/live2d-spike/fixtures/build-fixture.cjs
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const SRC_DIR = 'D:\\LProject\\claude_Project\\live2dModel\\茕兔pack\\茕兔'
const OUT_FILE = path.join(__dirname, '茕兔.model3.json')

function toFileUrl(relativePath) {
  return pathToFileURL(path.join(SRC_DIR, relativePath)).href
}

const original = JSON.parse(
  fs.readFileSync(path.join(SRC_DIR, '茕兔.model3.json'), 'utf-8')
)

original.FileReferences.Moc = toFileUrl(original.FileReferences.Moc)
original.FileReferences.Textures = original.FileReferences.Textures.map(toFileUrl)
original.FileReferences.Physics = toFileUrl(original.FileReferences.Physics)
original.FileReferences.DisplayInfo = toFileUrl(original.FileReferences.DisplayInfo)

const files = fs.readdirSync(SRC_DIR)
const expressionFiles = files.filter((f) => f.endsWith('.exp3.json'))
const motionFiles = files.filter((f) => f.endsWith('.motion3.json'))

original.FileReferences.Expressions = expressionFiles.map((f) => ({
  Name: f.replace(/\.exp3\.json$/, ''),
  File: toFileUrl(f)
}))

original.FileReferences.Motions = {
  Idle: motionFiles.map((f) => ({ File: toFileUrl(f) }))
}

fs.writeFileSync(OUT_FILE, JSON.stringify(original, null, 2), 'utf-8')

console.log(
  `wrote ${OUT_FILE}: ${expressionFiles.length} expressions, ` +
  `${motionFiles.length} motions, ${original.FileReferences.Textures.length} textures`
)
```

- [ ] **Step 2: 语法检查**

```bash
node --check scripts/live2d-spike/fixtures/build-fixture.cjs
```

Expected: 无输出,退出码 0(纯语法检查,不执行)。

- [ ] **Step 3: 实际运行,生成 fixture**

```bash
node scripts/live2d-spike/fixtures/build-fixture.cjs
```

Expected 输出类似:

```
wrote D:\LProject\claude_Project\pet-Agent\scripts\live2d-spike\fixtures\茕兔.model3.json: 17 expressions, 1 motions, 10 textures
```

- [ ] **Step 4: 检查生成的文件内容合理**

```bash
node -e "const j = require('./scripts/live2d-spike/fixtures/茕兔.model3.json'); console.log(j.FileReferences.Expressions.length, j.FileReferences.Motions.Idle.length, j.FileReferences.Moc)"
```

Expected: 打印 `17 1 file:///D:/LProject/claude_Project/live2dModel/...` 这样的绝对 `file://` URL(具体数字以 Step 3 实际输出为准),不是相对路径。

---

### Task 3: 主进程 main.cjs(模式切换 + 窗口 + 日志转发)

**Files:**
- Create: `scripts/live2d-spike/main.cjs`

**Interfaces:**
- Consumes: 无(不依赖前面任务的产物,只依赖 Electron 自身 API)。
- Produces: 一个可以用 `<electron 可执行文件> scripts/live2d-spike/main.cjs --model=<key> --mode=<sw|hw>` 启动的窗口,加载 `index.html`(Task 4 产物)并把 URL 查询参数 `model`/`mode` 传给渲染进程;把渲染进程的 `console.log` 转发到宿主终端。

- [ ] **Step 1: 写 main.cjs**

```js
// scripts/live2d-spike/main.cjs
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

function argValue(flag, fallback) {
  const found = process.argv.find((a) => a.startsWith(flag + '='))
  return found ? found.slice(flag.length + 1) : fallback
}

const mode = argValue('--mode', 'sw')
const model = argValue('--model', 'free')

if (mode === 'sw') {
  app.disableHardwareAcceleration()
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 900,
    height: 900,
    title: `live2d-spike: ${model} / ${mode}`,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  win.webContents.on('console-message', (_event, _level, message) => {
    console.log('[renderer]', message)
  })

  win.loadFile(path.join(__dirname, 'index.html'), { query: { model, mode } })
})

app.on('window-all-closed', () => app.quit())
```

- [ ] **Step 2: 语法检查**

```bash
node --check scripts/live2d-spike/main.cjs
```

Expected: 无输出,退出码 0。

---

### Task 4: index.html + renderer.cjs(核心测量逻辑)

**Files:**
- Create: `scripts/live2d-spike/index.html`
- Create: `scripts/live2d-spike/renderer.cjs`

**Interfaces:**
- Consumes: Task 1 的 `node_modules/{pixi.js,untitled-pixi-live2d-engine}`;Task 2 的 `fixtures/茕兔.model3.json`(仅当 `model=qiongtu-full` 时);`window.location.search` 里的 `model`/`mode` 查询参数(由 Task 3 的 `main.cjs` 传入)。
- Produces: `scripts/live2d-spike/results.ndjson`(每行一条 JSON,`{ts, model, mode, event, ...data}`),供 Task 6 汇总结论时读取。

- [ ] **Step 1: 写 index.html**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>live2d-spike</title>
  <style>html,body{margin:0;background:#222;overflow:hidden}</style>
</head>
<body>
  <script src="./renderer.cjs"></script>
</body>
</html>
```

（`<script>` 不加 `type="module"`,普通 CommonJS 脚本,靠 `nodeIntegration:true` 提供的 `require` 全局变量加载依赖。）

- [ ] **Step 2: 写 renderer.cjs**

```js
// scripts/live2d-spike/renderer.cjs
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { Application, extensions } = require('pixi.js')
const { Live2DModel, Live2DPlugin } = require('untitled-pixi-live2d-engine')

const params = new URLSearchParams(window.location.search)
const modelKey = params.get('model') || 'free'
const mode = params.get('mode') || 'sw'

const RESULTS_FILE = path.join(__dirname, 'results.ndjson')

const MODEL_PATHS = {
  free: 'D:\\LProject\\claude_Project\\live2dModel\\白-免费版\\白-免费版.model3.json',
  qiongtu: 'D:\\LProject\\claude_Project\\live2dModel\\茕兔pack\\茕兔\\茕兔.model3.json',
  'qiongtu-full': path.join(__dirname, 'fixtures', '茕兔.model3.json')
}

function log(event, data) {
  const entry = { ts: new Date().toISOString(), model: modelKey, mode, event, ...data }
  const line = JSON.stringify(entry)
  console.log(line)
  fs.appendFileSync(RESULTS_FILE, line + '\n')
}

function safeGetParam(core, id) {
  try {
    return core.getParameterValueById(id)
  } catch (err) {
    return { error: String(err) }
  }
}

async function main() {
  const modelPath = MODEL_PATHS[modelKey]
  if (!modelPath) {
    log('fatal', { error: `unknown model key: ${modelKey}` })
    return
  }
  const modelUrl = pathToFileURL(modelPath).href

  extensions.add(Live2DPlugin)

  const app = new Application()
  await app.init({ width: 900, height: 900, preference: 'webgl', autoDensity: true, resolution: window.devicePixelRatio })
  document.body.appendChild(app.canvas)

  const gl = app.renderer.gl
  log('gl-info', { maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) })

  const t0 = performance.now()
  let model
  try {
    model = await Live2DModel.from(modelUrl)
    log('load', { ok: true, loadMs: Math.round(performance.now() - t0) })
  } catch (err) {
    log('load', { ok: false, error: String((err && err.stack) || err) })
    return
  }

  model.anchor.set(0.5)
  model.position.set(app.screen.width / 2, app.screen.height / 2)
  const scale = Math.min(app.screen.width / model.width, app.screen.height / model.height) * 0.9
  model.scale.set(Number.isFinite(scale) && scale > 0 ? scale : 1)
  app.stage.addChild(model)

  try {
    const x = app.screen.width / 2
    const y = app.screen.height / 2
    const hits = model.hitTest(x, y)
    log('hitTest', { x, y, hits })
  } catch (err) {
    log('hitTest', { ok: false, error: String(err) })
  }

  try {
    const core = model.internalModel.coreModel
    if (typeof core.setParameterValueById !== 'function') {
      log('paramWrite', {
        ok: false,
        error: 'setParameterValueById is not a function on coreModel',
        availableMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(core)).filter(
          (n) => typeof core[n] === 'function'
        )
      })
    } else {
      core.setParameterValueById('ParamAngleX', 30)
      requestAnimationFrame(() => {
        log('paramWrite', {
          param: 'ParamAngleX',
          wrote: 30,
          readNextFrame: safeGetParam(core, 'ParamAngleX')
        })
      })
    }
  } catch (err) {
    log('paramWrite', { ok: false, error: String(err) })
  }

  const samples = []
  const startTime = performance.now()
  let frames = 0
  app.ticker.add(() => { frames++ })

  const sampleTimer = setInterval(() => {
    try {
      const core = model.internalModel.coreModel
      samples.push({
        t: Math.round(performance.now() - startTime),
        breath: safeGetParam(core, 'ParamBreath'),
        eyeLOpen: safeGetParam(core, 'ParamEyeLOpen')
      })
    } catch (err) {
      samples.push({ t: Math.round(performance.now() - startTime), error: String(err) })
    }
  }, 1000)

  setTimeout(async () => {
    clearInterval(sampleTimer)
    const elapsedS = (performance.now() - startTime) / 1000
    log('idleSample', {
      durationMs: Math.round(performance.now() - startTime),
      fps: Math.round((frames / elapsedS) * 10) / 10,
      paramSamples: samples
    })

    if (modelKey === 'qiongtu-full') {
      try {
        const okExpr = await model.expression('sy')
        log('vtubeOrphan', { kind: 'expression', name: 'sy', ok: okExpr })
      } catch (err) {
        log('vtubeOrphan', { kind: 'expression', name: 'sy', ok: false, error: String(err) })
      }
      try {
        const okMotion = await model.motion('Idle', 0)
        log('vtubeOrphan', { kind: 'motion', group: 'Idle', index: 0, ok: okMotion })
      } catch (err) {
        log('vtubeOrphan', { kind: 'motion', group: 'Idle', index: 0, ok: false, error: String(err) })
      }
    }

    log('done', {})
  }, 5000)
}

main().catch((err) => log('fatal', { error: String((err && err.stack) || err) }))
```

- [ ] **Step 3: 语法检查**

```bash
node --check scripts/live2d-spike/renderer.cjs
```

Expected: 无输出,退出码 0。（这只检查语法,不检查 `require('pixi.js')`/`require('untitled-pixi-live2d-engine')` 是否能在浏览器渲染进程里正确解析——这部分只能在真机 Electron 窗口里验证,见 Task 6。）

---

### Task 5: run.cjs 启动包装脚本

**Files:**
- Create: `scripts/live2d-spike/run.cjs`

**Interfaces:**
- Consumes: 主项目根目录 `node_modules/electron`(复用已安装的 Electron 43,不在 `scripts/live2d-spike/package.json` 里重复声明依赖);Task 3 的 `main.cjs`。
- Produces: 用户实际执行的入口命令 `node scripts/live2d-spike/run.cjs --model=<key> --mode=<sw|hw>`。

- [ ] **Step 1: 写 run.cjs**

```js
// scripts/live2d-spike/run.cjs
const { spawn } = require('node:child_process')
const path = require('node:path')

const electronPath = require(path.join(__dirname, '..', '..', 'node_modules', 'electron'))
const mainPath = path.join(__dirname, 'main.cjs')

const forwardedArgs = process.argv.slice(2)

const child = spawn(electronPath, [mainPath, ...forwardedArgs], {
  stdio: 'inherit',
  cwd: __dirname
})

child.on('exit', (code) => process.exit(code ?? 0))
```

- [ ] **Step 2: 语法检查**

```bash
node --check scripts/live2d-spike/run.cjs
```

Expected: 无输出,退出码 0。

- [ ] **Step 3: 确认能解析到根目录的 electron 二进制路径**

```bash
node -e "console.log(require('./node_modules/electron'))"
```

Expected: 打印一个指向 `electron.exe`(或对应平台可执行文件)的绝对路径,不报错。这条命令验证的是 `run.cjs` 里 `require(path.join(__dirname, '..', '..', 'node_modules', 'electron'))` 这行的可行性(等价路径,从仓库根目录跑等效于从 `scripts/live2d-spike/` 用 `../../node_modules/electron`)。

---

### Task 6: README + 交给用户在真机运行,汇总结论回填 spec

**Files:**
- Create: `scripts/live2d-spike/README.md`
- Modify: `docs/superpowers/specs/2026-07-20-live2d-renderer-design.md`(追加"Phase 2 前置 spike 结论"小节)
- Modify: `docs/superpowers/plans/notes/2026-07-20-live2d-remaining-work.md`(更新 §3 隐患清单的验证状态)

**Interfaces:**
- Consumes: 用户真机跑完 Task 1-5 产出的工具后,汇报的 `results.ndjson` 内容和肉眼观察结果。
- Produces: 无代码产物,是本计划的收尾/交接任务。

- [ ] **Step 1: 写 README.md,给出确切的运行命令清单**

```markdown
# live2d-spike

一次性诊断工具,验证完请直接删除整个 `scripts/live2d-spike/` 目录。

## 运行

在仓库根目录(`pet-Agent/`)执行,依次跑完这 6 条(建议每条跑完看一眼弹出的窗口和终端输出,再关窗口跑下一条):

\`\`\`bash
node scripts/live2d-spike/run.cjs --model=free --mode=sw
node scripts/live2d-spike/run.cjs --model=free --mode=hw
node scripts/live2d-spike/run.cjs --model=qiongtu --mode=sw
node scripts/live2d-spike/run.cjs --model=qiongtu --mode=hw
node scripts/live2d-spike/run.cjs --model=qiongtu-full --mode=sw
node scripts/live2d-spike/run.cjs --model=qiongtu-full --mode=hw
\`\`\`

## 每次运行请观察 / 记录

1. 窗口标题栏会显示当前 `model`/`mode`,窗口里模型是否正常显示(有没有花屏/黑屏/贴图错位/直接空白)。
2. 终端里 `[renderer] ...` 开头的日志(实时镜像自渲染进程)。
3. 跑完(约 5-6 秒后自动打印 `"event":"done"` 那一行)后,`scripts/live2d-spike/results.ndjson` 里新增的那几行——重点看 `gl-info.maxTextureSize`、`load.ok`/`load.loadMs`、`idleSample.fps`、`idleSample.paramSamples` 里 `breath`/`eyeLOpen` 是否在变化、`hitTest.hits`、`paramWrite.readNextFrame` 是否等于写入的 30、（仅 `qiongtu-full`)`vtubeOrphan` 那两行的 `ok` 是否为 `true`。

## 跑完之后

把 `results.ndjson` 整个内容发回来,连同你肉眼观察到的(有没有花屏/卡顿/明显问题),我来写结论并删掉这个目录。
```

- [ ] **Step 2: 语法检查所有 .cjs 文件(汇总确认)**

```bash
node --check scripts/live2d-spike/main.cjs && \
node --check scripts/live2d-spike/renderer.cjs && \
node --check scripts/live2d-spike/run.cjs && \
node --check scripts/live2d-spike/fixtures/build-fixture.cjs && \
echo "all syntax OK"
```

Expected: 打印 `all syntax OK`。

- [ ] **Step 3: 提交这一批 spike 代码(不提交 fixture 生成物和 results.ndjson)**

**不要碰根目录 `.gitignore`**——它当前有用户自己在途、尚未提交的修改(`pets/yyz`/`GenieData` 相关),用 `git add .gitignore` 会把那些无关改动一起带进这次提交。改用 `scripts/live2d-spike/` 目录自己的一份 `.gitignore`,只对这个子目录生效:

```bash
cat > scripts/live2d-spike/.gitignore <<'EOF'
node_modules/
results.ndjson
fixtures/*.model3.json
EOF
git add scripts/live2d-spike/.gitignore scripts/live2d-spike/package.json scripts/live2d-spike/main.cjs scripts/live2d-spike/renderer.cjs scripts/live2d-spike/run.cjs scripts/live2d-spike/index.html scripts/live2d-spike/fixtures/build-fixture.cjs scripts/live2d-spike/README.md
git status
```

Expected: `git status` 的 staged 列表里只有 `scripts/live2d-spike/` 下的这些源码文件 + 它自己的 `.gitignore`,**根目录 `.gitignore` 不在其中**(它的既有未提交修改保持原样不受影响);`node_modules/`、`results.ndjson`、生成的 fixture json 不在 staged 也不在 untracked 提示里(被子目录 `.gitignore` 排除)。确认无误后再提交:

```bash
git commit -m "feat(live2d-spike): 真实模型加载诊断工具(独立、验证完即删除)"
```

- [ ] **Step 4: 交给用户执行,等待结果**

把 README 里的命令列表和"每次运行请观察/记录"部分原样发给用户,请其在真机上依次运行并把 `results.ndjson` 内容 + 肉眼观察反馈发回来。**这一步之后的所有工作(写回 spec 结论、判断 Phase 2 资源协议要不要强制贴图降采样/游离文件找回、删除 `scripts/live2d-spike/`)都依赖用户反馈的真实数据,不在本计划范围内自动完成。**

---

## 计划范围边界

本计划到 Task 6 Step 4(把工具交给用户)为止。收到用户反馈后的后续工作——把结论写回 `docs/superpowers/specs/2026-07-20-live2d-renderer-design.md`、更新 remaining-work notes、删除 `scripts/live2d-spike/`、决定 Phase 2 plan 的范围——属于下一轮对话,不在本 plan 的任务列表里预先写死,因为具体怎么写取决于实测数据长什么样。
