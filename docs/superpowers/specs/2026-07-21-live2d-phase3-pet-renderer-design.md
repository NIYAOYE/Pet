# Live2D 呈现改造 · Phase 3:PetRenderer 抽象 + 精灵兼容驱动 — 设计文档

## 背景

主设计文档(`docs/superpowers/specs/2026-07-20-live2d-renderer-design.md` §7)定义了 `PetRenderer` 接口边界,但 Phase 0/1/2 都刻意没有触碰它——Phase 2 设计文档明确写"`LoadedPet`/`loadPet`/`GET_PET` IPC 四件套改判别式留给 Phase 3 一次性做,避免 Phase 2 改一半、Phase 3 再改一遍"。

现状(改造前):

- `src/shared/ipc.ts` 的 `LoadedPet` 是扁平结构 `{ manifest: PetManifest; spritesheetDataUrl: string }`,隐含假设"宠物永远是精灵"。
- `src/main/petLoader.ts` 的 `loadPet()` 直接调 `parsePetManifest`,从不检查 `render.type`。
- `src/renderer/spritePlayer.ts` 的 `SpritePlayer` 类是唯一的渲染实现,被 `PetController`(`src/renderer/petController.ts`)和 `main.ts`(`src/renderer/main.ts`)直接引用,不经过任何接口。
- `PetSummary.renderReady`(Phase 2 已落地)只在 `switchPet()`(`src/main/shell/index.ts:497`)处拦截热切换到 live2d 包;**启动路径**(`resolvePetHome` → `effectivePetId` → `createPetSession`,`src/main/shell/index.ts:184-208`)不做这个检查,理论上若 `settings.json` 的 `activePetId` 被手动改成一个 `renderReady:false` 的包,应用会尝试正常启动并让 renderer 拿到一个它不认识的 manifest 形状。

## 目标

1. 把 `LoadedPet`/`loadPet`/`GET_PET` 拓宽成 sprite/live2d 判别式,完整贯穿 main → preload → renderer。
2. 定义 `PetRenderer` 接口(与主设计文档 §7.1 一致),并把现有 `SpritePlayer` 收编成实现该接口的 `SpriteRenderer`——不推倒重写内部逐帧绘制逻辑。
3. `PetController` 改为只依赖 `PetRenderer` 接口,不再直接引用 `SpritePlayer` 类型。
4. 补上启动路径的 `renderReady` 守卫,与 `switchPet()` 已有的守卫口径一致。
5. 解决 `setFacing()`(live2d 镜像翻转)与 sprite 包 `walk-left`/`walk-right` 独立绘制行之间的方向表达歧义,现在定规则,不留到 Phase 4/5。

## 非目标

- 不实现任何真实 Live2D 渲染(`Live2DPetRenderer` 类本身不在本阶段创建;那是 Phase 4 的工作,前置 spike 已完成,结论见主设计文档 §17)。
- 不改动动态窗口尺寸(`PET_WINDOW_SIZE` 仍写死,Phase 5 处理)。
- 不改动气泡锚点消费、语音端口串行化、热切换 ACK 通道(均已记录在 Phase 2 设计文档"Phase 4/5/6 前置设计备忘录"里,留给对应阶段)。
- 不改动 `kibo-pet://` 协议本身或导入流程(Phase 2 已完成)。

## 类型层

### `PetRenderSource`(新增,`src/shared/petPackage.ts`)

```ts
export type PetRenderSource =
  | { type: 'sprite'; manifest: PetManifest; spritesheetDataUrl: string }
  | { type: 'live2d'; manifest: Live2DManifest }
```

live2d 分支**不内嵌任何模型字节,也不带 `baseUrl`**。

> **修正(写 plan 前发现,已同步到此处)**:最初设想 live2d 分支带一个 `baseUrl: kibo-pet://<petId>/` 字段,但核对 `src/main/pets/kiboPetProtocol.ts` 后发现这个假设是错的——`kibo-pet://` 的 host 不是 petId,而是**每次加载时铸造的随机不透明 token**(`registry.registerToken(rootDir)`),且协议 handler 本身(`installKiboPetProtocolHandler` + `app.ready` 前的 `registerSchemesAsPrivileged`)**目前完全没有接入应用**——Phase 2 只建了纯基础设施,文件自己的注释写明"真正接线留给 Phase 4"。主设计文档 §6 也明确"session-token 是每次加载生成的随机不透明令牌",铸造/撤销 token 是跟着会话生命周期走的运行时动作(热切换时撤销旧 token),不是 `loadPet()` 这种纯读盘函数能凭空生成的静态值。Phase 3 若塞一个假 `baseUrl` 进去,就是一个没有真实协议处理器支撑的占位符。因此 Phase 3 的 live2d 分支只携带 `manifest`;真正的 token 铸造 + `baseUrl`(主设计文档称 `resourceBaseUrl`)传递,连同协议 handler 接线一起留给 Phase 4 一次性做。
- `src/shared/ipc.ts` 的 `LoadedPet` 接口删除,`PetApi.getPet(): Promise<LoadedPet>` 改为 `Promise<PetRenderSource>`(直接引用 `petPackage.ts` 的类型,不留冗余别名)。

### `PetRenderer` 接口(新增,`src/renderer/petRenderer.ts`)

不跨 IPC,只在 renderer 进程内用,因此不放 `@shared`:

```ts
export type PetVisualState = string   // 与 petBrain.ts StepEffects.animation 同形状,直接复用其取值('idle'/'walk-left'/'walk-right'/'drag'/'sleep'/'greet'/'thinking'/'talk')
export interface PetHitResult { hit: boolean; area?: string }
export interface PetViewport { width: number; height: number }

export interface PetRenderer {
  load(source: PetRenderSource): Promise<void>
  playState(state: PetVisualState): void
  setFacing(direction: 'left' | 'right'): void
  setLipSync(level: number): void
  hitTest(x: number, y: number): PetHitResult
  resize(viewport: PetViewport): void
  setVisible(visible: boolean): void
  destroy(): Promise<void>
}
```

### 朝向语义(解决 remaining-work 隐患 #2)

**规则:`setFacing()` 对 `SpriteRenderer`是 no-op。** sprite 包的朝向完全由 `playState('walk-left' | 'walk-right')` 自身决定(两行独立绘制的精灵动画,CLAUDE.md 已明确"`walk-left` 是独立绘制行,不得由 `walk-right` 镜像产生")。`PetController` 在 Phase 3 **不调用** `setFacing()`——只调 `playState()`。`setFacing()` 只对未来的 `Live2DPetRenderer`(通常没有独立的左右行走 Motion,需要靠镜像变换表达朝向,见主设计文档 §7.3)有真实语义;届时驱动 `setFacing()` 调用点的逻辑属于 Phase 4/5。这样接口从一开始语义就明确,不留模糊地带。

## 主进程改动

### `src/main/petLoader.ts`

`loadPet()` 按 `isLive2DManifestRaw(raw)`(`petPackage.ts` 已有的判别式检查,`petCatalog.ts` 的 `readSummary()` 已在用同一个函数分流)分支:

- sprite 分支:逻辑不变(读 `pet.json` → `parsePetManifest` → 读精灵图 → base64 data URL),返回 `{ type: 'sprite', manifest, spritesheetDataUrl }`。
- live2d 分支:读 `pet.json` → `parseLive2DManifest`,不读任何模型文件,返回 `{ type: 'live2d', manifest }`。

### `src/main/shell/index.ts` —— 启动路径 `renderReady` 守卫

在 `effectivePetId` 解析出来之后(`src/main/shell/index.ts:208` 附近)、`createPetSession` 之前,加一次检查:

```ts
const effectiveSummary = listPets(petCatalogDirs).find((p) => p.id === effectivePetId)
if (effectiveSummary && !effectiveSummary.renderReady) {
  console.warn(`[pet] activePetId "${effectivePetId}" 渲染引擎未就绪,回退默认宠物`)
  // 复用 resolvePetHome 已有的"configuredPetId 无效 → 回退 defaultPetId"路径,
  // 而不是新造一套回退逻辑:把 defaultPetId 当作 configuredPetId 重新解析一次。
}
```

具体实现:把 `resolvePetHome` 的调用包一层——若首次解析出的 `effectivePetId` 的 `renderReady === false`,且 `effectivePetId !== defaultPetId`,则以 `configuredPetId: defaultPetId` 重新调用一次 `resolvePetHome`(与 `resolvePetHome` 内部本来应对"目录不存在"的 catch 分支异曲同工,只是触发条件从"目录不存在"换成"渲染引擎未就绪")。若 `effectivePetId === defaultPetId`(即回退目标就是自己,或配置的就是默认宠物本身,且它是 live2d——不应发生,内置默认宠物 `luluka` 恒为 sprite),说明没有更优的二次回退目标,函数按原样放行(`mode: 'ready'` 指向这个 live2d 目录),不强行造一个不存在的"回退的回退"。下游 renderer 的防御性兜底(见后文 `main.ts` 工厂函数)会显示"live2d 渲染器尚未实现"错误横幅收场,而不是让应用尝试静默进入一个它无法处理的状态。

这段逻辑放在 `shell/index.ts` 里做包装,而不是改 `resolvePetHome.ts` 本体——`resolvePetHome` 的职责是"配置的 id 有没有对应的宠物包目录",不适合再塞入"目录存在但渲染引擎没就绪"这个正交的判断维度。

### `GET_PET` handler

`ipcMain.handle(IPC.GET_PET, ...)` 不需要改动逻辑,`loadPet()` 返回类型变化会自动通过类型系统传导。

## 渲染层改动

### `src/renderer/spritePlayer.ts` → `src/renderer/spriteRenderer.ts`(重命名 + 收编)

保留全部现有纯逻辑(`nextFrameIndex`、内部 `tick`/`draw` 用到的 `frameRect`/`frameDurationMs`),类 `SpritePlayer` 更名为 `SpriteRenderer implements PetRenderer`:

| PetRenderer 方法 | 对应旧 SpritePlayer 行为 |
|---|---|
| `load(source)` | 新增:吸收原来散落在 `main.ts`/`petController.reload()` 里的 `new Image(); img.src = spritesheetDataUrl; await img.decode()` 步骤,解出 `manifest`/`sheet` 后等价于旧 `reload()`(首次 `load` 时机等价于构造+首次 `play`) |
| `playState(state)` | 旧 `play(state)`,逻辑不变 |
| `setFacing(direction)` | no-op(见上"朝向语义"节) |
| `setLipSync(level)` | no-op(sprite 包没有口型参数概念;不是遗漏,是当前精灵格式的固有限制) |
| `hitTest(x, y)` | 旧 `isPetPixel(x, y)` 包一层返回值:`{ hit: isPetPixel(...) }`,不带 `area`(sprite 没有部位概念) |
| `resize(viewport)` | no-op(canvas 尺寸仍在 `load`/`playState` 时从 `manifest.sheet` 派生;真正的动态尺寸是 Phase 5 工作) |
| `setVisible(visible)` | 新增:`canvas.style.display = visible ? '' : 'none'` |
| `destroy()` | 旧 `stop()` + 释放 image 引用,返回 `Promise<void>`(sprite 无异步清理工作,直接 `Promise.resolve()`) |

构造函数签名从 `(canvas, sheet, manifest)` 简化为 `(canvas)`——`sheet`/`manifest` 现在都通过 `load(source)` 传入,不再是构造时必须的依赖(这也是为什么 `load` 需要吸收原来外部做的 decode 步骤:构造时不再有 sheet 可用)。

### `src/renderer/petController.ts`

- 构造函数参数类型从 `SpritePlayer` 改为 `PetRenderer`。
- `this.player.play(effects.animation)` → `this.renderer.playState(effects.animation)`。
- `reload()` 方法体简化:`await window.petApi.getPet()` 拿到 `PetRenderSource` 后直接 `await this.renderer.load(source)`,不再手动构造 `Image`/`decode`(这步现在是 `SpriteRenderer.load()` 内部实现细节)。
- 字段/参数改名 `player` → `renderer`(全文件范围)。

### `src/renderer/main.ts`

- `boot()` 里 `getPet()` 现在返回 `PetRenderSource`。改用一个小工厂按 `source.type` 选择渲染器实现:

```ts
function createRenderer(canvas: HTMLCanvasElement, source: PetRenderSource): PetRenderer {
  if (source.type === 'sprite') return new SpriteRenderer(canvas)
  throw new Error('live2d 渲染器尚未实现(Phase 4)')
}
```

  `type: 'live2d'` 分支理论上不可达(启动守卫已确保只有 `renderReady:true` 的包才会被加载),但防御性地处理而不是让类型系统悄悄允许一个死代码路径——抛出的错误由 `boot().catch(showBootError)` 现有的红色错误横幅机制兜住。`showBootError()` 现状是不管 `err` 内容如何都显示同一句固定文案("宠物包加载失败:请确认 pets/luluka 存在...");这条 live2d 分支保持这个现状不变(不新增"读 `err.message` 分支显示不同文案"的逻辑)——这条路径本来就不可达,属于纯防御性兜底,不值得为一个证明不会触发的死代码路径去改一个本来就工作正常的通用错误横幅。

- 鼠标点击穿透判断:`player.isPetPixel(e.clientX, e.clientY)` → `renderer.hitTest(e.clientX, e.clientY).hit`。

## 测试策略

- `src/main/petLoader.test.ts`:新增 live2d manifest 用例,断言返回 `{ type: 'live2d', baseUrl: 'kibo-pet://<id>/' }` 且不触发任何 spritesheet 文件读取(现有 sprite 用例逻辑不变)。
- 启动守卫:在 `resolvePetHome.test.ts` 同级或 `shell/index.ts` 相关测试里,针对"配置的 `activePetId` 指向一个 `renderReady:false` 的包"这一具体场景写一个判别测试,断言最终回退到 `defaultPetId`。
- `src/renderer/spriteRenderer.test.ts`(原 `spritePlayer.test.ts` 重命名):`nextFrameIndex` 纯函数测试原样保留,不因类重命名而改变断言内容。
- 不新增任何依赖真实 `<canvas>`/DOM 解码的测试——现状(`PetController`/`SpritePlayer` 的绘制路径本来就没有 headless 单测,靠 `pnpm preview` 真机确认)保持不变,与 Phase 2 设计文档"Phase 2 完全不碰渲染/GPU/窗口可见性"的验收哲学一致,Phase 3 虽然touch 了渲染层文件,但只是**接口重排**,没有引入新的可视行为,真机确认成本同样很低。

## 真机验收

Phase 3 不引入任何新的可视行为(sprite 渲染逐帧绘制逻辑原样保留,只是换了个类名和方法名)。`pnpm build && pnpm test` 全绿后,`pnpm preview` 走一遍现有的日常验收(宠物正常显示动画、点击开对话框、拖拽跟手、`聊天面板`点头像热切宠物)确认没有因重构引入回归即可,不需要专门的新验收清单。

## 验收标准

- [ ] `PetRenderSource` 判别式落地,`LoadedPet` 类型删除,`getPet()`/`GET_PET` 全链路类型对齐。
- [ ] `PetRenderer` 接口定义在 `src/renderer/petRenderer.ts`,`SpriteRenderer` 完整实现该接口。
- [ ] `PetController` 只持有 `PetRenderer` 类型,不再 import `SpriteRenderer`/`SpritePlayer` 具体类(除了 `main.ts` 的工厂函数)。
- [ ] `setFacing()` 在 `SpriteRenderer` 上是显式 no-op,`PetController` 不调用它。
- [ ] 启动路径(`effectivePetId` 解析)对 `renderReady:false` 的包有和 `switchPet()` 一致的回退行为,有单测覆盖。
- [ ] `pnpm typecheck && pnpm test && pnpm build` 全绿。
- [ ] `pnpm preview` 真机走查确认 sprite 渲染/交互无回归。
