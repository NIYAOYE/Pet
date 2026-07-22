# Live2D 首次自动对齐 + 水印自动破冰 — 设计文档

日期:2026-07-21
状态:已确认,待写实施计划

## 背景

Phase 4(PixiJS/Live2D 最小加载)已经完整实现并合并进本地 `main`,真机联调也跑通了——能正常导入、渲染、点击穿透、热切换。但联调过程中为了调参数,在渲染层加了一个只能靠 DevTools Console 手动操作的调试工具(`window.__kiboLive2D.autoFit()`/`.saveFit()`,见 `src/renderer/live2dRenderer.ts`,代码里标了"临时调试用,验证完要删")。

真机联调还发现:一个叫"茕兔"(`tu`)的测试模型,原始素材没有声明任何动作/表情,导入器的游离资源找回补丁(`live2dOrphanResources.ts`)把散落的 `.motion3.json`/`.exp3.json` 都找回来了,但光靠播放找回的动作没能让模型脱离初始画面(常见于购买模型的防盗版水印告示图),要靠手动调用一次表情才能让画面切走。

这份设计把两条已经跑通的手动流程(缩放/位置对齐、水印表情破冰)自动化,让"导入宠物包"之后的使用者不需要打开控制台。

## 目标 / 非目标

**目标:**
- 首次加载 Live2D 宠物包时自动测出合适的 scale/位置,写回 `pet.json`,以后启动直接读现成值
- 检测到"原始模型没有声明任何动作/表情"(可能触发水印告示卡死)时,持久化这个信号,并在运行时尝试自动破冰
- 调试工具保留,重新定位为"高级故障排查手段"而非临时代码
- 同步更新 `docs/making-a-pet.md`,把手动步骤改写为"通常不需要手动操作"

**非目标:**
- 不改变 Phase 5(动态窗口/锚点/命中/无闪烁热切换)范围内的任何东西
- 不处理"自动对齐算法本身不准"的情况——算法沿用已验证的 `autoFit()` 实现,不重新设计
- 不试图让水印类模型 100% 破冰成功(`bai` 模型没有任何真实表情可用,自动机制预期对它不生效,这是已知边界,不是 bug)

## 架构 / 数据流

```
导入阶段(petCatalog.importLive2DPet):
  detectPossibleWatermarkProtection(patchedModel3Json) === true
    → 写 staging 里的 pet.json: render.possibleWatermark = true

首次运行阶段(Live2DPetRenderer.load):
  manifest.render.transform.autoFitted !== true
    → 同步 autoFit() 算 scale/offset 并应用到 model(不闪烁)
    → fire-and-forget petApi.updateLive2DTransform({...fit, autoFitted: true})
       → IPC → patchLive2DTransform → 写回 %APPDATA%/kibo-pet/pets/<id>/pet.json

  manifest.render.possibleWatermark === true
  且 stateMap.idle?.expression 未指定
    → 读 expressionManager.definitions[0].Name(或等价字段)
    → model.expression(name)(忽略返回值真假)

以后再次启动:
  autoFitted === true → 跳过测量,直接用 manifest 里的 scale/offset
  possibleWatermark 字段与是否重复触发破冰无关——每次加载只要
  stateMap.idle 没显式 expression 就会尝试(幂等,重复调用同一个表情无副作用)
```

## 组件改动

### 1. 类型 — `src/shared/petPackage.ts`

- `Live2DTransform` 新增 `autoFitted?: boolean`
- `Live2DRender` 新增 `possibleWatermark?: boolean`
- `parseLive2DManifest`:两个新字段若存在则必须是 `boolean`,不存在时不报错(向后兼容旧 `pet.json`)

### 2. IPC 契约 — `src/shared/ipc.ts` / `src/main/pets/live2dTransformPatch.ts`

- `Live2DTransformPatch` 新增必填字段 `autoFitted: boolean`——调用方每次回写都显式声明"这次写的是不是最终对齐值",不给默认值、不做隐式推断
- `patchLive2DTransform` 写回 `render.transform` 时带上 `autoFitted: patch.autoFitted`,其余字段(`anchorX`/`anchorY`/`bubbleAnchorX`/`bubbleAnchorY`)原样保留,行为与现有 `scale`/`offsetX`/`offsetY` 覆盖逻辑一致
- `src/main/shell/index.ts` 里 `IPC.UPDATE_LIVE2D_TRANSFORM` 的 handler 不需要改动,本来就是把 `patch` 整体透传给 `patchLive2DTransform`

### 3. 首次自动对齐 — `src/renderer/live2dRenderer.ts` `Live2DPetRenderer.load()`

- 在 `app.stage.addChild(model)` / `this.model = model` 之后(现第 66-67 行附近),读 `source.manifest.render.transform.autoFitted`
- 不是 `true` 时:同步调用私有 `autoFit()`(已有实现,内部 `scale.set`/`position.set` 是同步的,发生在这一帧渲染前,不会出现"先显示错误比例再纠正"的闪烁),然后 `void petApi.updateLive2DTransform({ ...fitResult, autoFitted: true })`——不 `await`,不阻塞加载流程;写入失败只代表下次启动会重新测一遍,不影响这次的显示效果
- 已经是 `true` 的包保持现状:只应用 manifest 里的值(现有代码逻辑不变)

### 4. 调试工具去留 — 保留,重新定位

- `window.__kiboLive2D.autoFit()`/`.saveFit()` 不删除
- 注释从"临时调试用,验证完要删"改为说明这是自动化机制之外的高级故障排查手段:正常情况下导入后会自动完成对齐,只有需要人工核对细节或覆盖自动计算结果(比如遇到自动算出来比例仍不满意的疑难模型)时才用

### 5. 导入时持久化水印检测结果 — `src/main/pets/petCatalog.ts` `importLive2DPet()`

- 现状(第 220-222 行):`detectPossibleWatermarkProtection(patchedModel3Json)` 结果只拼进 `warnings` 文案返回给调用方,`pet.json` 是 `cpSync`(第 233 行)原样复制到 staging 的,没有"读出来改一下再写回"这一步
- 新增:检测为真时,在 `cpSync` 之后、`renameSync` 提交之前,把 `{ ...manifest, render: { ...manifest.render, possibleWatermark: true } }` 写入 `join(stagingDir, 'pet.json')`,覆盖掉 `cpSync` 带过去的原始文件
- 检测为假时不做这次额外写入,`pet.json` 保持 `cpSync` 原样(不引入无意义的字段/格式变化)
- 失败处理复用现有 try/catch 块(写入失败走已有的 `copy-failed` 分支,清理 staging)

### 6. 运行时自动破冰 — `src/renderer/live2dRenderer.ts` `Live2DPetRenderer.load()`

- 模型加入 stage 之后:若 `manifest.render.possibleWatermark === true` 且 `manifest.render.stateMap.idle?.expression` 未指定,读 `model.internalModel.motionManager.expressionManager?.definitions`,取第一个可用表情的名字,调用 `model.expression(name)`
- 不依赖 `model.expression()`/`model.motion()` 的返回值判断成功与否(已知不可靠,引擎自身的待机动作选择机制会跟显式调用产生优先级竞争)
- 这是通用兜底机制,不是水印专属:任何"原始没有声明动作/表情、靠游离资源找回"的模型都可能需要这一下,水印检测只是目前唯一会把 `possibleWatermark` 置为 `true` 的入口
- `stateMap.idle` 已经显式声明 `expression` 时不触发(尊重宠物包作者的显式配置,不重复/覆盖)
- `expressionManager` 不存在或 `definitions` 为空(比如 `bai` 模型)时,这一步安全跳过,不报错、不重试、不影响其余加载流程

### 7. 文档 — `docs/making-a-pet.md`

- 第 4 步"自动测出合适的缩放/位置":改写为"导入后启动会自动测量并写回,通常不需要手动操作";原 Console 操作步骤搬到文末新增的"高级:手动核对/覆盖对齐结果"小节,作为需要人工介入疑难模型时的排查手段
- 第 6 步水印卡住:改写为"运行时会自动检测并尝试用一个可用表情破冰,大多数情况不需要手动操作;如果自动破冰没有生效(模型确实没有任何可用表情,比如纯告示图水印包),再按以下步骤手动核对/回填 `stateMap.idle.expression`"
- 第 5 步(查真实动作/表情名字)保持不变——`stateMap` 没有显式声明时仍可能需要人工核对具体用哪个名字更合适(比如避免选中一个不适合日常待机的夸张表情)

## 测试策略

- `petPackage.test.ts`:`parseLive2DManifest` 对 `autoFitted`/`possibleWatermark` 的类型校验(存在时必须是 boolean;不存在时通过)
- `live2dTransformPatch.test.ts`:`patchLive2DTransform` 新增对 `autoFitted` 字段写入/覆盖的用例,确认其余字段(尤其 anchor 系列)不受影响
- `petCatalog` 相关测试(参照现有 `importLive2DPet` 测试文件所在位置):
  - 水印模型(`detectPossibleWatermarkProtection` 返回 true)导入后,staging 提交后的最终 `pet.json` 含 `render.possibleWatermark === true`
  - 非水印模型导入后 `pet.json` 不含该字段(不引入多余字段)
- `live2dRenderer.ts` 主体依赖真实 WebGL/Live2D 引擎不便整体 mock;把两处判断逻辑("是否需要 autoFit"、"是否需要破冰表情"以及"选哪个表情名字")抽成可独立测试的纯函数单测,渲染器主体只负责编排调用
- 真机验证(用户执行,agent 会话无真实显示环境):
  - `tu`(茕兔):验证首次加载后 scale/位置自动写回 `%APPDATA%\kibo-pet\pets\tu\pet.json` 且 `autoFitted: true`;二次启动不再重新计算;`possibleWatermark: true` 且首次加载后自动脱离初始告示画面
  - `bai`(白):验证导入/加载不因为"无解"而报错或死循环,`possibleWatermark: true` 但由于没有真实表情可用,自动破冰不生效属预期,画面仍停留在水印图

## 已确认的开放问题

1. 调试工具去留 → **保留**,作为高级故障排查手段,更新注释说明用途
2. `docs/making-a-pet.md` 是否跟随更新 → **是**,与代码改动放在同一个 spec/plan 里一起完成

## 涉及文件清单

- `src/shared/petPackage.ts`
- `src/shared/ipc.ts`
- `src/main/pets/petCatalog.ts`
- `src/main/pets/live2dTransformPatch.ts`
- `src/main/shell/index.ts`(预期无需改动,列出以便实施时确认)
- `src/renderer/live2dRenderer.ts`
- `docs/making-a-pet.md`
