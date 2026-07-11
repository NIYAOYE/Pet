# 展开对话框/设置窗视觉统一 + 对话框 MomoTalk 化 · 设计文档

## 背景

`ROADMAP.md`「打磨与统一」轨道记录：气泡窗（`bubble.html`）已换成宠物主题色浅紫渐变，但展开对话框（`dialog.html`）、设置窗（`settings.html`）仍是旧的深色系（`#1e1e28` / `rgba(30,30,40,0.92)` / 蓝色强调色），两套视觉语言并存。本次是这条"轻量跟进分支"。

brainstorming 过程中用户提出把对话框进一步改成《蔚蓝档案》MomoTalk 聊天界面的结构风格（头像+名字栏、漫画描边气泡、时间戳），但配色仍走宠物自己的紫色系，不套用 MomoTalk 原版的黄色。这是本设计的最终方向，已经过浏览器画板确认。

## 范围

- **改**：`dialog.html`/`dialog.ts`（折叠态+展开态）、`settings.html`（连带 `settingsWindow.ts` 窗口创建参数）、新增共享主题 CSS。
- **不改**：`bubble.html`（已经是目标配色，作为其他两者的参照基准）。
- **不做**：设置窗不套用手机 app 视觉（只是配色/窗体统一，不引入 MomoTalk 结构）；不加窗口最大化/缩放；不引入新运行时依赖；不做"手机状态栏"装饰（时间/电量图标不承载任何真实信息，属于纯装饰，明确排除）。

## 一、共享主题 token（新文件）

新增 `src/renderer/theme.css`，定义 CSS 自定义属性，三个窗口（`bubble.html`/`dialog.html`/`settings.html`）都 `<link>` 引用，替代目前各自内联写死的颜色值。CSP（`style-src 'self' 'unsafe-inline'`）已允许本地样式表，无需改动。

```css
:root {
  --surface-grad: linear-gradient(160deg, #efe3ff, #f7ecff);
  --app-bg: #f9f4ff;
  --card-bg: #ffffff;
  --text-primary: #4a3a63;
  --text-secondary: rgba(74, 58, 99, 0.65);
  --accent: #6a4fb3;
  --accent-strong: #5a3f9e;
  --accent-soft: rgba(106, 79, 179, 0.14);
  --border: rgba(106, 79, 179, 0.18);
  --outline: #2b2140;         /* MomoTalk 描边色,对话框专用 */
  --danger-bg: rgba(214, 90, 90, 0.08);
  --danger-border: rgba(214, 90, 90, 0.4);
  --danger-text: #8a3f3f;
  --shadow-float: 0 10px 26px rgba(150, 120, 220, 0.32);
  --radius-window: 20px;
  --radius-panel: 12px;
  --radius-control: 8px;
  --radius-pill: 999px;
}
```

`bubble.html` 的既有内联颜色逐步替换为引用这些变量（值不变，只是消除重复定义），不改变气泡窗现有视觉。

## 二、设置窗（`settings.html` + `settingsWindow.ts`）

**窗体**：`BrowserWindow` 参数改为 `frame: false, transparent: true`（`settingsWindow.ts:13`），尺寸不变（560×520，`resizable:false`）。`html, body { background: transparent }`（复用 `dialog.html` 已有的透明窗惯例），内容套一层圆角卡片（`border-radius: var(--radius-window)`，`overflow:hidden`），背景用 `--app-bg`，配 `--shadow-float`。

**自绘标题栏**：顶部新增一条 34px 高的栏，左侧标题「Kibo 设置」，右侧一个圆角关闭按钮（悬浮态 `--danger-bg` 提示）。点击直接调用渲染进程自身的 `window.close()`（Electron 允许页面关闭自己所在的 `BrowserWindow`，不需要新增 IPC）。栏区域 `-webkit-app-region: drag`，关闭按钮单独 `no-drag`（与 `dialog.html` 现有 `#panel` 拖拽模式一致，抄同一套约定）。不加最小化按钮（用户已确认）。

**侧边栏**：`.navitem.active` 从深色蓝底改为 `--accent-soft` 背景 + `--accent-strong` 文字，并加一条左侧 3px 强调竖条（`::before` 伪元素，色为 `--accent`）。非选中态 hover 用更浅的 `--accent-soft` 半透明。

**表单控件**：`input`/`select` 背景从 `rgba(255,255,255,0.12)`（深色系数值）换成白底 + `1px solid var(--border)`；`select option` 同步改浅色配色（保留"option 单独给不透明配色"的现有惯例，只是从深底改浅底，避免下拉列表在系统层看不清的老问题复现）。按钮：主操作用 `--accent` 实底白字,`.secondary` 用浅色描边按钮。

**风险提示条**（`desktopControlEnabled`/`browserControlEnabled` 两处）：背景/描边改用 `--danger-bg`/`--danger-border`/`--danger-text`，色相仍是暖红，只是柔和度和整体浅色基调匹配，不改变"这是高风险操作"的视觉警示强度。

## 三、对话框（`dialog.html` + `dialog.ts`）——MomoTalk 结构

### 折叠态（输入条）

结构不变，只换配色：胶囊形（`border-radius: var(--radius-pill)`）白底 + 描边，图标按钮改圆形浅紫底。不加头像/标题栏（保持"随手唤出输入"的轻量定位）。

### 展开态

新增结构（现状只有 `#history` + `#bar`，本次新增顶部头像栏）：

```
┌ #chat-head ─────────────────┐   ← 新增:头像 + 宠物名 + 折叠按钮
│ #history（消息列表，含分组/气泡/时间戳）│
│ #bar（输入条，胶囊化）              │
└──────────────────────────────┘
```

- **`#chat-head`**：圆形头像（见下方"头像来源"）+ `manifest.displayName` + 右侧折叠按钮（复用现有 `#toggle` 的收起语义，视觉挪到头部）。只在展开态显示,折叠态没有这一栏。
- **消息分组**：连续同一 `role` 的消息合并为一组，组内只在第一条左侧（`role==='pet'`）显示头像+名字标签，同组后续消息头像位置留空白占位对齐；`role==='user'` 一侧不需要头像/名字（自己发的消息不用标"我"）。分组逻辑是纯函数,可单元测试（输入 `ChatMessage[]`，输出 `{ role, items: ChatMessage[] }[]`）。
- **气泡**：`border: 1.6px solid var(--outline)`，pet 气泡 `background:#fffdf7`（暖白，制造"贴纸感"，不是纯白），user 气泡 `background: var(--accent)` 白字；两者都在贴近发送者一侧的角做成直角（`border-bottom-left-radius`/`border-bottom-right-radius: 4px`），模拟 MomoTalk 的气泡尾巴效果，不用额外画三角形。
- **时间戳**：每条消息气泡外侧（pet 在右下方外部、user 在左下方外部）显示 `HH:mm`，来自 `msg.timestamp`；旧消息若无该字段则不显示时间（向后兼容,见下方数据变更）。

### 窗口尺寸

`dialogWindow.ts` 的 `EXPANDED` 从 `{ width: 320, height: 440 }` 调整为 `{ width: 320, height: 470 }`（新增头部栏挤占的约 30px 补回来）；`COLLAPSED` 不变。

## 四、数据变更：消息时间戳

- `src/shared/ipc.ts`：`ChatMessage` 加 `timestamp?: number`（epoch ms，可选，向后兼容旧 transcript 文件）。
- `src/main/memory/transcriptStore.ts`：
  - `appendMessage(t, msg, max)` 写入时补 `timestamp: msg.timestamp ?? Date.now()`（单一戳记点，`chat.ts` 里所有 `appendMessage` 调用点不用逐个改）。
  - `parseTranscript` 放行 `timestamp`（现有实现会把消息收窄成 `{role,text}`，需要跟着扩成 `{role,text,timestamp?}`），缺失时保持 `undefined`，不回填假值。
- `dialog.ts` 渲染时：`m.timestamp ? formatTime(m.timestamp) : null`，为空则不渲染时间戳节点（不留空白占位造成对不齐的视觉噪音——直接不渲染该 span）。

## 五、头像来源

不引入新美术资源，复用现有共享几何函数：

```ts
import { frameRect } from '@shared/petPackage'
const r = frameRect(manifest.sheet, manifest.animations.idle.row, 0) // idle 第一帧
```

`dialog.ts` 在拿到 `LoadedPet`（`petApi.getPet()`，与主宠物窗口同一份数据，`dialog.html` 目前没引入 `petApi`，需要新增这一次性调用）后，用一次性的离屏 `<canvas>`（尺寸 `cellWidth×cellHeight`）`drawImage` 裁出该帧，`toDataURL()` 生成静态头像图，赋给 `.avatar { background-image: url(...); border-radius:50% }`。全程只在对话框打开时算一次，不逐帧重绘，和 `SpritePlayer` 的持续动画渲染是两条独立路径。

## 非目标 / 明确不做

- 不做手机状态栏装饰（时间/信号/电量图标）——不承载真实信息，纯装饰
- 不做消息已读/未读状态、打字气泡动画之外的 MomoTalk 元素
- 设置窗不套用 MomoTalk 结构，只统一配色 token + 窗体圆角/自绘标题栏
- 不改变现有 IPC 契约以外的行为（发送/流式/取消等逻辑不动，纯视觉层）
- `bubble.html` 不动

## 测试

- `transcriptStore.test.ts`：追加断言 `appendMessage` 补齐 `timestamp`、`parseTranscript` 兼容无 `timestamp` 的旧数据
- 新增消息分组纯函数的单元测试（同 role 连续消息合并、role 切换断组）
- 视觉/交互（窗体拖拽、圆角渲染、头像裁切是否对齐）走 `pnpm preview` 真机确认，不强求自动化覆盖
