# Live2D 呈现改造 · Phase 2 前置：真实模型加载 Spike 设计

## 背景

`docs/superpowers/specs/2026-07-20-live2d-renderer-design.md`(Live2D 渲染模式设计文档)的审查结论(汇总于 `docs/superpowers/plans/notes/2026-07-20-live2d-remaining-work.md` §3)列出了两条尚未被任何计划覆盖、且写 Phase 2(宠物包 v2 + 导入器 + 资源协议)plan 前必须先弄清楚的隐患:

1. **引擎 API 未做深度验证**:`untitled-pixi-live2d-engine@1.3.5` 已克隆到本机(`D:\LProject\claude_Project\untitled-pixi-live2d-engine`),但 Motion Group/HitArea/参数写入的真实调用方式还没有用真实模型跑过,不能照抄设计文档假设的接口形状。
2. **情绪状态凭空发明**:spec 里的 `happy/sad/cry/surprised/love` 等 stateMap 键在当前代码里没有任何产出依据,需要先看真实模型到底有什么表情资源,再决定 Phase 4/5 怎么 scope down。

用户购入了两个真实 Live2D 模型作为参考素材,放在 `D:\LProject\claude_Project\live2dModel\`:

- **`白-免费版`**:单张 **16384×16384** 贴图(64MB 文件,未压缩情况下单张贴图占用 GPU 显存约 1GB)。`model3.json` 的 `FileReferences` 只有 `Moc`/`Textures`/`Physics`/`DisplayInfo`,**没有任何 Motion/Expression**,只有一个非空的 `EyeBlink` 参数组(`ParamEyeLOpen`/`ParamEyeROpen`)。
- **`茕兔pack/茕兔`**:10 张 4096×4096 分块贴图(约 64MB/张,总计 ~640MB),1 个 `Scene1.motion3.json`,17 个 `.exp3.json` 表情文件,外加 `physics3.json`。但读取 `茕兔.model3.json` 发现 **`FileReferences` 同样没有 `Expressions`/`Motions` 字段,`EyeBlink` 分组的 `Ids` 也是空的**——这 17 个表情实际是通过 `.vtube.json`(VTube Studio 的私有项目文件)的 `Hotkeys` 列表(`"Action":"ToggleExpression","File":"sy.exp3.json"`)挂接的,不是标准 Cubism `model3.json` 机制。读引擎源码(`src/cubism/CubismModelSettings.ts:97-101`)确认:引擎的 `ModelSettings` 只解析 `json.FileReferences.Expressions`/`Motions`,不会自己扫描目录——按标准流程原样导入 `茕兔pack`,引擎会认为这个模型一个表情、一个动作都没有。

两个模型都不是"干净的宠物包":`茕兔pack` 购买目录里还混了封面图、聊天背景、mp4、表情包 jpg 等营销素材,真正的 Cubism 模型在 `茕兔pack/茕兔/` 子目录。

这些发现如果不先验证清楚,Phase 2 的资源协议设计(导入器要不要处理贴图降采样、要不要处理"游离动作/表情文件找回")就是建立在假设上,写完了很可能要返工。因此本文档只覆盖一次**独立的、验证完就丢弃的最小加载 spike**,不是 Phase 4 本身的实现。

## 目标

用最小代码量,在和生产环境同样的 Electron/Chromium/SwiftShader 环境下,针对两个真实模型 × 软件渲染/硬件加速两种模式,拿到:

1. **贴图尺寸/显存/性能的真实数据**:`MAX_TEXTURE_SIZE`、加载成功与否、加载耗时、渲染是否有可见异常、静置时的 FPS。
2. **引擎 API 真实形状**:`Live2DModel.from()` + `autoUpdate` 在零动作文件的情况下(免费版)能否驱动 physics 自动呼吸/眨眼;`model.hitTest(x, y)` 返回的命中区域名称是否符合预期;手动 `setParameterValueById()` 写入的参数值,下一帧会不会被自动更新覆盖掉。
3. **VTube-Studio 游离资源找回是否可行**:手工合成一份补全了 `Expressions`/`Motions` 的 `model3.json` 副本,确认引擎能读到并播放 `茕兔pack` 里那 17 个表情和 1 个动作。

## 非目标

- 不实现 Phase 4(PixiJS/Live2D 最小加载)本身,不接入 `PetRenderer` 抽象,不改动 `src/main`/`src/renderer` 任何生产代码。
- 不测试 Motion *Group* 语义(多动作分组/随机播放/优先级)——两个模型加起来只有 1 个动作文件,没有分组可测。
- 不处理 `茕兔pack` 目录里那些营销素材文件的导入/过滤逻辑,只记录"导入器要能定位到真正的模型子目录"这个结论,具体怎么定位留给 Phase 2 plan。
- 不做贴图压缩/降采样的实现,只是测出"16384² 在两种渲染模式下分别会发生什么",压缩策略留给 Phase 2 资源协议设计。
- 不做自动化测试——spike 是探索性质,成功判据是真机运行时的日志和肉眼观察,不是单元测试。

## 方案选择

### 采用:独立临时 Electron 入口,不依赖/不污染主项目依赖树

新建 `scripts/live2d-spike/` 目录,自带一份独立的 `package.json`,在该目录内单独跑 `pnpm install`(不受 `pnpm-workspace.yaml` 影响,因为本项目本来就没有 workspace 配置)。产出:

- `main.cjs`:最小 Electron 主进程,按 CLI 参数 `--mode=sw|hw` 决定要不要在 `app.whenReady()` 之前调用 `app.disableHardwareAcceleration()`——复刻 Phase 0 里"这段决策必须在 app ready 前跑完"的硬约束,但不依赖真实 app 的 settings/marker 文件机制。
- `index.html` + `renderer.mjs`:普通 `<script type="module">`,直接用浏览器原生 ESM 加载 `pixi.js`(npm 已发布 `8.19.0`,与本机已克隆的引擎源码要求的 peer 版本一致)和 `untitled-pixi-live2d-engine`(npm 已发布 `1.3.5`,与本机克隆版本一致)。
- 模型文件直接用 `file://` 协议指向 `D:\LProject\claude_Project\live2dModel\...` 的真实路径,不拷贝进仓库。

理由:这个 spike 的唯一目的是"在真实渲染环境里跑一次,看真实数据",接入完整的 pet-Agent 主应用只会增加变量、拖慢验证速度,而且这部分代码本来就该在验证完成后整个删除,不需要保证它长期能跑。

### 不采用:直接在 `src/main`/`src/renderer` 里加调试代码

会把探索性代码和生产代码搅在一起,验证完还要仔细清理干净、容易漏改;且主项目的 `pnpm-lock.yaml` 刚经历过 Electron 43 升级的仔细维护([[live2d-presentation-initiative]] 记录过这次升级),没必要为一次性验证往里面加 `pixi.js`/`untitled-pixi-live2d-engine` 这两个还不确定要不要用的依赖。

### 不采用:用 Node 脚本 + headless canvas 验证

拿不到真实的 Electron/Chromium/SwiftShader 渲染路径,测不出这次真正关心的东西(软件渲染下 16384² 贴图到底行不行、Chromium 的 WebGL 实现在硬件加速下报出的真实 `MAX_TEXTURE_SIZE`)。而且当前 agent 会话本身没有真实显示器/GPU 环境,不管用什么方式搭 harness,最终跑起来观察结果这一步都必须交给用户在真机做。

## 架构与组件

### 主进程:模式切换 + 窗口创建

```js
// scripts/live2d-spike/main.cjs(示意,非最终实现)
const mode = process.argv.includes('--mode=hw') ? 'hw' : 'sw'
if (mode === 'sw') app.disableHardwareAcceleration()

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 900, height: 900, webPreferences: { /* 无需 preload,不接触任何生产 IPC */ } })
  win.loadFile('index.html', { query: { model: process.argv.find(a => a.startsWith('--model='))?.slice(8) ?? 'free' } })
})
```

### 渲染进程:加载 + 采集 + 上报

```js
// scripts/live2d-spike/renderer.mjs(示意)
import { Application, extensions } from 'pixi.js'
import { Live2DModel, Live2DPlugin } from 'untitled-pixi-live2d-engine'

extensions.add(Live2DPlugin)
const app = new Application()
await app.init({ resizeTo: window, preference: 'webgl' })
document.body.appendChild(app.canvas)

const gl = app.renderer.gl
log('maxTextureSize', gl.getParameter(gl.MAX_TEXTURE_SIZE))

const t0 = performance.now()
try {
  const model = await Live2DModel.from(modelUrl) // 或合成过的 model3.json 副本
  log('loadOk', true, 'loadMs', performance.now() - t0)
  app.stage.addChild(model)
  // 持续采样:ParamBreath/ParamEyeLOpen 是否自动变化、FPS、hitTest、手动写参数
} catch (err) {
  log('loadOk', false, 'error', String(err))
}
```

`log()` 把结构化结果同时 `console.log` 和通过一个极简的自定义协议(如 `fetch('http://127.0.0.1:<port>/log', {method:'POST', body})` 打到 `main.cjs` 起的一个本地 HTTP 服务,或者更简单——直接 `require('fs').appendFileSync` 写文件,因为 `nodeIntegration` 在这个一次性 spike 里可以直接打开,不需要遵守生产环境的安全基线)追加写入 `scripts/live2d-spike/results.ndjson`。

### VTube-orphan 合成测试(仅 `茕兔pack`)

在 `scripts/live2d-spike/fixtures/` 下手工放一份 `茕兔.model3.json` 的**副本**(不改动 `D:\...\live2dModel\` 里的原始购买文件),补上:

```json
"Expressions": [{ "Name": "sy", "File": "../../../live2dModel/茕兔pack/茕兔/sy.exp3.json" }, ...],
"Motions": { "Idle": [{ "File": "../../../live2dModel/茕兔pack/茕兔/Scene1.motion3.json" }] }
```

用这份副本的路径调用 `Live2DModel.from()`,验证 `model.expression('sy')` / `model.motion('Idle', 0)` 是否真的播放。

## 数据流

```text
用户执行 node run.mjs --model=<free|qiongtu> --mode=<sw|hw>
  -> main.cjs 按 --mode 决定是否 disableHardwareAcceleration -> 起窗口
  -> renderer.mjs boot:init pixi Application -> 读 MAX_TEXTURE_SIZE
       -> Live2DModel.from(modelUrl 或合成 model3.json) -> 记录成功/失败/耗时
       -> 挂到 stage,静置 ~5s 采样 FPS + physics 参数是否自动变化
       -> 若干次 model.hitTest(x, y) -> 记录命中结果
       -> setParameterValueById 手动写值 -> 下一帧读回验证
       -> (仅茕兔)model.expression()/model.motion() -> 记录播放成功与否
       -> 全部结果 append 到 results.ndjson
```

不涉及 `PET_CHANGED`/`MOVE_WINDOW` 等任何生产 IPC 通道,不涉及 `petBrain`/`petController`。

## 测试策略

### 构建验证

- `scripts/live2d-spike/` 内的代码只要求能跑起来(`node run.mjs`),不接入主项目的 `pnpm typecheck`/`pnpm test`/`pnpm build`——它是纯 JS 的一次性脚本,不是要长期维护的 TypeScript 代码。

### 真机验证(本次 spike 的核心,也是唯一的成功判据来源)

用户在自己机器上依次跑:

```
node run.mjs --model=free --mode=sw
node run.mjs --model=free --mode=hw
node run.mjs --model=qiongtu --mode=sw
node run.mjs --model=qiongtu --mode=hw
```

每次观察:窗口里模型是否正常显示(有无花屏/黑屏/贴图错位)、`results.ndjson` 里的 `maxTextureSize`/`loadOk`/`loadMs`/FPS 数据、肉眼判断静置时是否有呼吸/眨眼动作。`茕兔` 的两次额外确认表情/动作合成加载是否成功。

## 成功标准(这次没有单一 Go/No-Go,是给 Phase 2/4 提供决策依据)

不是"通过/不通过"式的判据,而是要拿到能回答以下问题的真实数据,写回 spec:

1. 软渲染 vs 硬件加速,`MAX_TEXTURE_SIZE` 分别是多少?16384² 贴图在哪种/哪些模式下能正常加载渲染,哪种/哪些模式下失败或异常?
2. 免费版模型(零动作文件)静置时,physics 驱动的自动呼吸/眨眼是否真的在没有任何 Motion 的情况下工作?
3. `hitTest`/手动参数写入的行为是否符合设计文档 §4.1 假设的接口形状?
4. 手工合成 `Expressions`/`Motions` 字段这条路径,能否让引擎正常读取并播放 VTube-Studio 遗留的游离表情/动作文件?这直接决定 Phase 2 资源协议要不要做"扫描游离文件并合成 model3.json"这一步。

结论(连同真机数据)写回 `docs/superpowers/specs/2026-07-20-live2d-renderer-design.md` 的一个新增小节,并更新 `docs/superpowers/plans/notes/2026-07-20-live2d-remaining-work.md`。`scripts/live2d-spike/` 目录在结论写完后整个删除。
