# Live2D 呈现改造 · Phase 2:宠物包 v2 + 导入器 + 资源协议 — 设计文档

## 背景

`docs/superpowers/specs/2026-07-20-live2d-renderer-design.md`(下称"主设计文档")§16 把整个 Live2D 改造拆成 8 个实施阶段,Phase 2 是"宠物包 v2、路径验证、导入器和资源协议"。Phase 0(GPU reboot-degrade)、Phase 1(Electron 31→43 升级)已完成并合并推送;Phase 4 的前置真实模型加载 spike 已完成,结论记在主设计文档 §17,其中三条新发现的隐患(引擎版本兼容性、Cubism Core 运行时需单独下载、购买模型可能自带防盗版水印保护)连同此前审查发现的隐患一起汇总在 `docs/superpowers/plans/notes/2026-07-20-live2d-remaining-work.md` §3。

本文档是 Phase 2 的详细设计,把主设计文档 §3-6 的原始设计,结合 remaining-work §3 隐患清单(尤其是 spike 新确认的三条)和一次 brainstorming 会话中的多轮范围澄清,落实成可以直接写 plan 的具体方案。

## 目标

1. `pet.json` schema 升级到 v2,新增 `render` 判别式(`sprite` | `live2d`)和可选 `thumbnail` 字段,向后兼容现有 sprite 包。
2. 把现有"导入宠物"整文件夹入口(`importPetFolder`,MVP-09)重写为统一的 staging + 安全校验 + 原子移动流程,sprite 包和 live2d 包走同一套代码,分支只在 live2d 专属校验步骤。
3. 落地 `kibo-pet://` 受限资源协议的主进程实现(scheme 注册、token 校验、路径二次验证、撤销),作为 Phase 4 的现成基础设施,本阶段不接消费方。
4. 宠物目录扫描与寄养选择器/聊天列表/设置下拉框能正确识别、展示、但阻止切换到 live2d 包(因为渲染引擎还不存在)。
5. 把与 Phase 2 无关但在设计过程中浮现的、真正影响 Phase 4/5/6 范围的想法(尤其是"LLM 依据宠物包实际状态清单自主选择切换状态"这个替代当前硬编码状态机的思路)写成前置设计备忘录,不在本阶段实现。

## 非目标

- 不实现 `PetRenderer` 抽象(Phase 3)、不实现任何真实 Live2D 渲染(Phase 4)。
- 导入预览不渲染真实模型,只展示静态占位图/信息卡片。
- 不做交互式"自动动作映射向导"——`stateMap` 由用户像写 `persona.md` 一样自己手写在 `pet.json` 里,导入器只做静态存在性校验+警告。
- 不实现准备-提交热切换 ACK 通道(Phase 5)、动态窗口尺寸/气泡锚点消费(Phase 5)、语音端口串行化(Phase 5)、鼠标追踪/口型(Phase 6)。
- 不改动 `LoadedPet`/`loadPet`/`GET_PET` IPC 四件套——这是渲染消费方(Phase 3)要接的东西,Phase 2 没有消费方,现在改会改两遍。
- 不实现"LLM 自主选状态"机制本身,只在 schema 里预留字段。

## 范围边界(brainstorming 结论)

Phase 2 = **后端骨架 + 静态占位预览**,不是完整可用的 Live2D 导入体验。理由:主设计文档 §5.1 描述的"导入预览显示模型"和"热切换立即启用"都依赖还不存在的 Phase 3/4/5 产出,如果现在就实现会导致 Phase 2 的改动面模糊地跨进后续阶段的地盘。用户在 Phase 2 结束后可以把一个 live2d 宠物包完整、安全地导入进 `userData/pets/`,并在选择器里看到它,但暂时不能真的切换到它运行——UI 上明确标注"渲染引擎未就绪"。

## pet.json schema v2

```ts
interface PetManifestV2 {
  schemaVersion: 2;
  id: string;
  displayName: string;
  description: string;
  thumbnail?: string;          // 相对路径,如 "thumbnail.png";导入时校验存在性+格式,内嵌为 data URL
  render: SpriteRender | Live2DRender;
  voice?: VoiceConfig;         // 不变,沿用现有 GPT-SoVITS/Genie-TTS 配置
}

interface SpriteRender {
  type: 'sprite';
  spritesheetPath: string;
  sheet: { rows: number; cols: number; cellWidth: number; cellHeight: number };
  animations: Record<string, AnimationDef>;
}

interface Live2DRender {
  type: 'live2d';
  model: string;                // 相对路径,如 "model/character.model3.json"
  viewport: { width: number; height: number; resolutionCap: number };
  transform: {
    scale: number; offsetX: number; offsetY: number;
    anchorX: number; anchorY: number;
    bubbleAnchorX: number; bubbleAnchorY: number;
  };
  interaction: { mirrorOnWalk: boolean; mouseTracking: boolean; lipSyncParameter: string };
  stateMap: Record<string, StateMapEntry>;
}

interface StateMapEntry {
  motionGroup?: string;
  selection?: 'random' | 'sequential' | number;
  loop?: boolean;
  expression?: string;
  lipSync?: boolean;
  fallback?: string;            // 最终必须收敛到 idle
  description?: string;         // 新增:给未来 LLM 状态选择机制读的自然语言描述,Phase 2 只存不用
}
```

设计决定:

- **`stateMap` 键沿用主设计文档 §4.1 列表**(`idle/walk-left/walk-right/drag/sleep/greet/thinking/talk/happy/sad/cry/surprised/love`),但**不要求作者填满**——只有模型真的有对应资源的状态才会被填,其余状态在运行时天然回退 idle。导入器不会因为某个情绪状态没填而报错或警告。
- **`parsePetManifest` 保留现有"手写 assert、失败即抛"的风格**,不采用 `AppSettings`(`SETTINGS_SCHEMA_VERSION`)那种"填默认值绝不失败"的容错式 normalize。原因:现有两处调用方都依赖抛出语义——`petCatalog.scanDir` 靠 catch 到异常来判定"这个包损坏,跳过";导入器靠异常信息给用户看得懂的拒绝原因。v2 延续这个模式,只是判别式分支变多。
- **无 `schemaVersion` 字段的旧 sprite manifest 继续合法**,内部归一化为 `render.type = 'sprite'`,不要求已安装的宠物包迁移(主设计文档 §4.2 原样保留)。新导入(不论 sprite 还是 live2d)一律写 `schemaVersion: 2`。

## 导入流程(替换 `importPetFolder`)

沿用现有入口——设置窗口"导入宠物"按钮 + 原生文件夹选择器,不新增按钮。内部重写为统一流程:

```
1.  用户选文件夹(不变)
2.  读 pet.json → parsePetManifest,按 render.type 分支后续步骤
3.  路径安全校验(两种包都过,主设计文档 §5.3 全套):
    - 拒绝绝对路径/UNC/盘符路径/`..`穿越/解码后穿越
    - 拒绝符号链接、Windows junction、reparse point
    - 只复制数据文件,不执行/不复制脚本类扩展名(js/html/exe/dll/bat/cmd/ps1 等)
    - ID 只允许字母数字下划线连字符;与已有 id(含 bundled)冲突直接拒绝,不覆盖
    - 软预算:目录 ≤500MB;硬限制:目录 ≤1GB、单 JSON ≤10MB、递归文件数 ≤5000
4.  复制到 userData/pets/.staging/<random>/(不再直接 cpSync 到最终目录)
5.  [仅 live2d] 引用完整性校验:model3.json 引用的 moc3/纹理/motions/expressions/
    physics/pose 是否都存在于 staging 目录内;同时校验 pet.json 自己的
    `stateMap.motionGroup` 名字是否在 model3.json 声明的 Motion Groups 里能找到——
    找不到只记警告,不阻挡导入(运行时回退 `fallback`/idle)
6.  [仅 live2d] 纹理尺寸预算:Cubism 纹理固定为 PNG,读 PNG 文件头(签名 + IHDR
    chunk)取宽高,不做完整解码,避免引入图像库依赖——单张 >4096 或 >8192 触发软
    预算警告(不阻挡,提示"可能影响帧率",数据来自 spike §17.1 实测:16384² 单贴图
    比 10×4096² 分块慢 2-3 倍);单张 >8192 或纹理数 >16 触发硬限制,拒绝导入
7.  [仅 live2d] 游离资源自动找回:扫描 model 目录下未被 model3.json 声明的
    `*.exp3.json`/`*.motion3.json`,自动合成补丁写回 staging 里的 model3.json
    (复用 spike 已验证的 `scripts/live2d-spike/fixtures/build-fixture.cjs` 思路),
    记录找回数量供预览页展示"已自动找回 N 个游离文件"
8.  [仅 live2d] 水印模型启发式提示:第 7 步合成补丁后,若 model3.json 仍然没有任何
    Motions 且没有任何 Expressions,预览页显示一条信息提示"该模型未声明任何动作/
    表情,可能需要额外处理才能正常显示角色"——仅提示,不阻挡导入(检测可能有假阳性,
    实际能否正常显示要等 Phase 4 真实渲染才能验证)
9.  [仅 live2d] thumbnail 字段校验(存在性+是常见图片格式)+ 读取,没有则预览/列表用
    通用占位图标
10. 预览页:sprite 显示现有精灵预览逻辑不变;live2d 显示信息卡片(模型名、贴图数、
    Drawable 数、找回文件数、警告/提示列表),不真实渲染模型
11. 用户确认后,原子改名 staging 目录 → userData/pets/<id>/
12. 中途任何失败:清理 staging 残留,不触碰最终目录;应用下次启动时清理遗留的
    staging 残留目录(未完整提交的导入不会"复活")
```

## `kibo-pet://` 受限资源协议

沿用主设计文档 §6 的设计,Phase 2 交付**协议 handler 本身 + 独立测试**,不接任何 `BrowserWindow` 或 renderer 消费代码:

- `app.ready` 之前以 `standard:true, secure:true, supportFetchAPI:true` 注册,不启用 `bypassCSP`/Service Worker/扩展权限。
- `registerToken(petRootDir): string` 生成随机不透明 session-token,映射到一个已验证的宠物根目录;`revokeToken(token): void` 撤销映射。Phase 2 暴露这两个函数并测试其行为,真正在什么时机调用(热切换开始/完成/失败)留给 Phase 4/5 接线,现在没有触发点。
- Handler 对请求 URL 解码、规范化、扩展名、根目录包含关系、reparse point 做二次校验;只返回 model 子树内允许的文件类型并设置正确 MIME;不支持目录列举。
- 测试方式:不需要起 Electron 窗口,直接在 Vitest 里构造 request 对象喂给 handler 函数,断言各分支(合法请求返回文件、越权路径 403、未知 token 404、目录列举请求拒绝)。

宠物窗口 CSP 收紧规则(`connect-src`/`img-src`/`media-src` 追加 `kibo-pet:`)记录在设计里,但由于本阶段没有消费方,不需要现在改 `index.html`——留给 Phase 4 真正建 live2d 窗口时一起加。

## 目录扫描与选择器展示

- `petCatalog.scanDir` 跳过 `.staging` 目录,不当成宠物条目。
- `PetSummary` 新增字段:
  ```ts
  interface PetSummary {
    id: string;
    displayName: string;
    description: string;
    renderType: 'sprite' | 'live2d';
    renderReady: boolean;        // sprite 恒 true;live2d 在 Phase 2 恒 false
    thumbnailDataUrl?: string;   // live2d 有 thumbnail 时内嵌;sprite 继续用现有裁剪 idle 帧逻辑
  }
  ```
- `PetChatListItem`(聊天左侧列表)同步加 `renderReady`:`false` 的条目置灰、不可点击、hover 提示"渲染引擎未就绪"。
- `switchPet` 主进程侧新增防御性校验:`renderReady === false` 直接拒绝并返回错误,不只依赖 UI 层拦截(UI 被绕过或未来出现别的调用路径时仍然安全)。
- 设置窗口下拉框同理:`renderReady === false` 的 `<option disabled>`。

## Phase 4/5/6 前置设计备忘录(本阶段不实现)

1. **LLM 自主选状态**:`stateMap` 每项的可选 `description` 字段(见上)是为这个机制预留的。真正的机制:把宠物包实际拥有的状态清单(只列模型真的有对应 Motion/Expression 的状态,不列凭空状态)组织成类似 skill 描述的文本注入 agent 系统提示,由 LLM 在对话/交互过程中主动决定切换到哪个状态,替代当前 `src/main/petBrain.ts` 里硬编码的 `PetLogicalState` 分支机制。这个思路顺带解决 remaining-work 隐患 2(`happy/sad/cry/surprised/love` 凭空发明的问题)——状态清单从宠物包实际内容"长出来",不是设计文档拍脑袋定的固定枚举。留给 Phase 4/5/6 写 plan 时展开成具体设计(prompt 注入格式、和现有工具调用机制的关系、sprite 包要不要也支持这套机制而不是继续用旧状态机)。
2. **热切换 ACK 通道**(remaining-work 隐患 4):Phase 5 新增 renderer→main 的"模型就绪"IPC,配合旧模型不销毁、新模型后台加载完成后再原子提交,实现无闪烁切换。当前的 `PET_CHANGED` 单向推送不够用。
3. **贴图预算的运行时消费**:Phase 2 只在导入时警告,"超预算自动降采样/降分辨率"的运行时行为留给 Phase 4(要有真实引擎才能决定怎么降)。
4. **`PET_WINDOW_SIZE` 写死**(remaining-work 隐患 3):Phase 5 处理,`src/main/shell/index.ts:651-655/665/671/673` 的边界夹取逻辑 + `petController.ts` 默认值都要改;窗口尺寸只能在加载/切换时改一次,不能进每帧循环(参考记忆 `electron-isvisible-setresizable-drift` 的 `setResizable` 抖动教训)。
5. **气泡锚点消费**:schema 里 `bubbleAnchorX/Y` 已在本阶段落地,但接到 `bubbleWindow.ts` 的 `bubblePlacement` 留给 Phase 5。
6. **语音固定端口串行化**(remaining-work 隐患 5):Phase 5 处理,视觉模型可重叠加载,`petSession.ts` 的语音 sidecar 用固定端口,必须严格先拆旧再起新。
7. **引擎版本兼容 patch / esbuild 打包链路**(主设计文档 §17.2/§17.5):Phase 4 实施计划必须包含的任务项——`untitled-pixi-live2d-engine@1.3.5` 与 Cubism Core 5 的 `drawables.renderOrders` 字段兼容性问题、`require()` ESM 互操作崩溃问题(必须走 esbuild/vite bundler 路径),都不是可以临场发挥的细节。
8. **`LoadedPet`/`loadPet`/`GET_PET` IPC 四件套改判别式**:留给 Phase 3(`PetRenderer` 抽象接进来时)一次性做,避免 Phase 2 改一半、Phase 3 再改一遍。

## 测试策略

**纯逻辑 Vitest:**
- `parsePetManifest` v2:判别式各分支(sprite/live2d)、`thumbnail` 字段校验、向后兼容归一化(无 schemaVersion 的旧 manifest)
- 路径安全校验:穿越/符号链接/reparse point/扩展名黑名单/ID 合法性,每类给至少一个失败用例
- 纹理尺寸软硬预算判断(纯函数,喂宽高数字断言阈值分支)
- 游离资源扫描 + 合成补丁的纯函数部分(输入文件名列表 + 原始 model3.json,断言输出补丁后的 JSON)
- 水印模型启发式判断(纯函数,输入 Motions/Expressions 是否为空,断言提示触发与否)

**主进程集成测试:**
- staging → 原子移动的完整导入流程,用临时目录跑真实文件系统操作,包括中途失败后的 staging 清理
- `kibo-pet://` 协议 handler 的注册/解析/路径校验/撤销(直接构造 request 对象喂给 handler,不起 Electron 窗口)
- `petCatalog.scanDir` 跳过 `.staging`、`renderReady` 计算正确性
- `switchPet` 对 `renderReady === false` 目标的防御性拒绝

**真机验收:** Phase 2 完全不碰渲染/GPU/窗口可见性,不像 Phase 0/1 那样有"自动检查通过≠能跑"的坑。`pnpm build && pnpm test` 通过后,`pnpm preview` 走一遍导入 UI 点击流程(确认占位卡片正确显示、选择器里 live2d 条目正确置灰禁用)作为轻量真机确认即可,不需要专门的真机走查清单。

## 验收标准

- [ ] `pet.json` schemaVersion 2 + `render` 判别式解析/校验落地,旧 sprite manifest 继续兼容
- [ ] 统一导入流程(staging + 安全校验 + 原子移动)替换现有 `importPetFolder`,sprite 包行为不回退(现有 MVP-09 测试不能因此变红)
- [ ] live2d 包能被安全导入,经过引用完整性/纹理预算/游离资源找回/水印提示/thumbnail 校验
- [ ] `kibo-pet://` 协议 handler 完整实现并有独立测试覆盖,暂无消费方
- [ ] 寄养选择器/聊天列表/设置下拉框正确展示 live2d 条目并阻止切换,主进程侧有防御性校验
- [ ] Phase 4/5/6 前置设计备忘录写入本文档,供后续 phase 写 plan 时直接引用
- [ ] `pnpm build && pnpm test` 全绿;`pnpm preview` 走查导入 UI 与选择器禁用态
