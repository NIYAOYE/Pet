# 展开对话框/设置窗视觉统一 + MomoTalk 对话框 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把展开对话框（`dialog.html`）改成《蔚蓝档案》MomoTalk 风格的聊天室结构（头像+名字栏、漫画描边气泡、时间戳），把设置窗（`settings.html`）改成和气泡窗一致的浅紫无边框圆角浮窗，三个渲染窗口共享一套主题 token。

**Architecture:** 新增 `src/renderer/theme.css` 作为三窗口共享的 CSS 自定义属性表；`ChatMessage` 新增可选 `timestamp` 字段，由 `memoryManager.appendMessage` 用已注入的 `now()` 时钟统一补齐；对话框展开态渲染逻辑从"整表 `.msg` 平铺"改成"按发送者分组 + 头像/时间戳"结构，头像来自现有 spritesheet 的 idle 首帧裁切（复用 `frameRect`），不引入新美术资源；设置窗从原生标题栏窗口改成 `frame:false, transparent:true` 的自绘圆角浮窗。

**Tech Stack:** Electron + TypeScript + electron-vite + Vitest；无新增运行时依赖。

## Global Constraints

- 包管理器用 **pnpm**（`pnpm install`/`pnpm dev`/`pnpm build`/`pnpm test`/`pnpm vitest run <path>`）
- 不要给 `package.json` 加 `"type": "module"`（会导致 Electron 主进程/preload 崩溃）
- 三个渲染窗口的 `BrowserWindow` 都必须保持 `contextIsolation:true, sandbox:true, nodeIntegration:false`
- 不引入新的 npm 依赖
- 纯逻辑（类型转换/分组/格式化）走 TDD 先写失败测试；GUI/Electron 视觉与拖拽交互只能靠 `pnpm build && pnpm preview` 真机确认，自动化测试通过不代表窗口渲染正确
- 每个任务完成后用简洁的 conventional-commit 风格提交一次（`feat(scope): ...`），中文提交信息
- 跨进程共享的类型/常量只从 `src/shared` 走 `@shared/*` 别名导入，不在各进程里重复定义

---

### Task 1: 共享主题 token（`theme.css`）+ 接入三个窗口

**Files:**
- Create: `src/renderer/theme.css`
- Modify: `src/renderer/bubble.html`（接入 token，颜色值替换为 var() 引用，视觉像素级不变）
- Modify: `src/renderer/dialog.html`（仅接入 `<link>`，颜色改造留到 Task 6）
- Modify: `src/renderer/settings.html`（仅接入 `<link>`，颜色改造留到 Task 5）

**Interfaces:**
- Produces：`theme.css` 里定义的 CSS 自定义属性（`--surface-grad` `--tail-color` `--app-bg` `--card-bg` `--pet-bubble-bg` `--text-primary` `--text-secondary` `--accent` `--accent-strong` `--accent-soft` `--border` `--outline` `--code-tint` `--danger-bg` `--danger-border` `--danger-text` `--shadow-bubble` `--shadow-float` `--radius-window` `--radius-panel` `--radius-control` `--radius-pill`），后续所有任务都引用这些变量名，不再另起新名字。

- [ ] **Step 1: 新建 `src/renderer/theme.css`**

```css
:root {
  --surface-grad: linear-gradient(160deg, #efe3ff, #f7ecff);
  --tail-color: #f2e8ff;
  --app-bg: #f9f4ff;
  --card-bg: #ffffff;
  --pet-bubble-bg: #fffdf7;
  --text-primary: #4a3a63;
  --text-secondary: rgba(74, 58, 99, 0.65);
  --accent: #6a4fb3;
  --accent-strong: #5a3f9e;
  --accent-soft: rgba(106, 79, 179, 0.14);
  --border: rgba(106, 79, 179, 0.18);
  --outline: #2b2140;
  --code-tint: rgba(74, 58, 99, 0.10);
  --danger-bg: rgba(214, 90, 90, 0.08);
  --danger-border: rgba(214, 90, 90, 0.4);
  --danger-text: #8a3f3f;
  --shadow-bubble: 0 4px 14px rgba(150, 120, 220, 0.28);
  --shadow-float: 0 10px 26px rgba(150, 120, 220, 0.32);
  --radius-window: 20px;
  --radius-panel: 12px;
  --radius-control: 8px;
  --radius-pill: 999px;
}
```

- [ ] **Step 2: 把 `src/renderer/bubble.html` 的颜色值换成 var() 引用**

把整份文件替换为（CSP/结构不变，只在 `<head>` 加一行 `<link>`，`<style>` 里的颜色字面量换成 token）：

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:" />
    <link rel="stylesheet" href="./theme.css" />
    <style>
      html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
                   font-family: system-ui, sans-serif; font-size: 13px; color: var(--text-primary); }
      /* 竖直栈:气泡框 + 尾巴区。尾巴在底/顶由 body 的 tail-bottom/tail-top 类切换。 */
      #wrap { box-sizing: border-box; height: 100%; display: flex; flex-direction: column; }
      body.tail-top #wrap { flex-direction: column-reverse; }

      /* 气泡框:占据除尾巴外的全部高度,内部滚动(超过 MAX_TOTAL_HEIGHT 才会触发) */
      #box { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
             box-sizing: border-box; padding: 10px 14px; border-radius: 22px;
             background: var(--surface-grad);
             box-shadow: var(--shadow-bubble);
             word-break: break-word; line-height: 1.5; }
      #box:empty { display: none; }

      /* 尾巴区:固定 12px 高,内含一个 CSS 三角,水平位置由 --tail-x 决定 */
      #tail { position: relative; height: 12px; flex-shrink: 0; }
      #tail::before { content: ''; position: absolute; left: var(--tail-x, 120px);
                      transform: translateX(-50%); width: 0; height: 0;
                      border-left: 9px solid transparent; border-right: 9px solid transparent; }
      body.tail-bottom #tail::before { top: 0; border-top: 12px solid var(--tail-color); }
      body.tail-top    #tail::before { bottom: 0; border-bottom: 12px solid var(--tail-color); }

      /* pet 回复内渲染的 Markdown 子集样式(与对话框保持一致,配色适配浅色底) */
      #box ul { margin: 4px 0; padding-left: 18px; }
      #box li { margin: 1px 0; }
      #box strong { font-weight: 600; }
      #box code { background: var(--code-tint); border-radius: 4px; padding: 0 3px; font-size: 12px; }
      #box a.md-link { color: var(--accent); text-decoration: underline; word-break: break-all; }
      #box.status { opacity: 0.75; font-style: italic; }
    </style>
  </head>
  <body class="tail-bottom">
    <div id="wrap">
      <div id="box"></div>
      <div id="tail"></div>
    </div>
    <script type="module" src="./bubble.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: 给 `src/renderer/dialog.html`、`src/renderer/settings.html` 的 `<head>` 各加一行 `<link>`**

在两份文件现有的 `<meta http-equiv="Content-Security-Policy" ...>` 之后各插入一行（此步骤只加这一行,不改其余内容,Task 5/6 会整体重写这两份文件的其余部分）：

```html
    <link rel="stylesheet" href="./theme.css" />
```

- [ ] **Step 4: 构建确认**

```bash
pnpm build
```

Expected: 无 TypeScript/构建报错。

- [ ] **Step 5: 跑现有测试确认没有连带破坏**

```bash
pnpm test
```

Expected: 全部通过（这一步是纯 CSS 改动，不应该有测试受影响）。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/theme.css src/renderer/bubble.html src/renderer/dialog.html src/renderer/settings.html
git commit -m "feat(theme): 新增共享主题 token 并接入气泡/对话框/设置窗"
```

---

### Task 2: `ChatMessage.timestamp` 类型 + `transcriptStore` 透传

**Files:**
- Modify: `src/shared/ipc.ts:95`
- Modify: `src/main/memory/transcriptStore.ts`
- Test: `src/main/memory/transcriptStore.test.ts`

**Interfaces:**
- Consumes: 无（本任务是最底层的类型/存储层改动）
- Produces: `ChatMessage.timestamp?: number`；`appendMessage(t: TranscriptFile, msg: ChatMessage, max?: number): TranscriptFile` 在 `msg.timestamp` 是 number 时把它透传进存储的消息对象；`parseTranscript(raw: unknown): TranscriptFile` 从磁盘读回时同样保留合法的 `timestamp`。后续 Task 3（`memoryManager`）、Task 6（`dialog.ts` 渲染）都依赖这两个行为。

- [ ] **Step 1: 在 `src/shared/ipc.ts` 给 `ChatMessage` 加 `timestamp` 字段**

把 `src/shared/ipc.ts:95` 这一行：

```ts
export interface ChatMessage { role: 'user' | 'pet'; text: string; attachments?: ChatAttachment[] }
```

改成：

```ts
export interface ChatMessage { role: 'user' | 'pet'; text: string; attachments?: ChatAttachment[]; timestamp?: number }
```

- [ ] **Step 2: 写失败测试（追加到 `src/main/memory/transcriptStore.test.ts` 末尾）**

```ts
describe('appendMessage 透传 timestamp', () => {
  it('传入 timestamp 时原样保留', () => {
    let t = emptyTranscript()
    t = appendMessage(t, { role: 'user', text: 'hi', timestamp: 1000 })
    expect(t.messages[0]).toEqual({ role: 'user', text: 'hi', timestamp: 1000 })
  })
  it('未传 timestamp 时不生成该字段', () => {
    let t = emptyTranscript()
    t = appendMessage(t, { role: 'user', text: 'hi' })
    expect(t.messages[0]).toEqual({ role: 'user', text: 'hi' })
  })
})

describe('parseTranscript 透传 timestamp', () => {
  it('保留合法 timestamp,非法类型的直接丢弃该字段', () => {
    const t = parseTranscript({
      messages: [
        { role: 'user', text: 'a', timestamp: 123 },
        { role: 'pet', text: 'b', timestamp: 'bad' }
      ]
    })
    expect(t.messages).toEqual([
      { role: 'user', text: 'a', timestamp: 123 },
      { role: 'pet', text: 'b' }
    ])
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
pnpm vitest run src/main/memory/transcriptStore.test.ts
```

Expected: 新增的两个 `describe` 块 FAIL（当前实现把消息收窄成只剩 `{role,text}`，`timestamp` 会被丢弃）。

- [ ] **Step 4: 实现 —— 修改 `src/main/memory/transcriptStore.ts`**

把 `parseTranscript` 里的这一行：

```ts
      ).map((m) => ({ role: m.role, text: m.text }))
```

改成：

```ts
      ).map((m) => (typeof m.timestamp === 'number' ? { role: m.role, text: m.text, timestamp: m.timestamp } : { role: m.role, text: m.text }))
```

把 `appendMessage` 函数体：

```ts
export function appendMessage(t: TranscriptFile, msg: ChatMessage, max = TRANSCRIPT_MAX): TranscriptFile {
  const messages = [...t.messages, { role: msg.role, text: msg.text }]
  return {
    schemaVersion: 1,
    totalCount: t.totalCount + 1,
    messages: messages.length > max ? messages.slice(messages.length - max) : messages
  }
}
```

改成：

```ts
export function appendMessage(t: TranscriptFile, msg: ChatMessage, max = TRANSCRIPT_MAX): TranscriptFile {
  const entry = typeof msg.timestamp === 'number'
    ? { role: msg.role, text: msg.text, timestamp: msg.timestamp }
    : { role: msg.role, text: msg.text }
  const messages = [...t.messages, entry]
  return {
    schemaVersion: 1,
    totalCount: t.totalCount + 1,
    messages: messages.length > max ? messages.slice(messages.length - max) : messages
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
pnpm vitest run src/main/memory/transcriptStore.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc.ts src/main/memory/transcriptStore.ts src/main/memory/transcriptStore.test.ts
git commit -m "feat(memory): ChatMessage 支持可选 timestamp 字段并在 transcript 存储中透传"
```

---

### Task 3: `memoryManager.appendMessage` 用注入的时钟自动补时间戳

**Files:**
- Modify: `src/main/memory/memoryManager.ts:63-66`
- Test: `src/main/memory/memoryManager.test.ts`

**Interfaces:**
- Consumes: Task 2 产出的 `ChatMessage.timestamp?: number`、`transcriptStore.appendMessage` 的透传行为
- Produces: `MemoryManager.appendMessage(msg: ChatMessage): void` 在 `msg.timestamp` 缺失时用构造时注入的 `now: () => Date`（未注入则默认 `() => new Date()`）补上 `timestamp: now().getTime()`；已带 `timestamp` 的调用不被覆盖。Task 6 的 `dialog.ts` 依赖"从 `chatApi.onUpdate` 收到的每条消息都带 `timestamp`"这一保证。

- [ ] **Step 1: 修改已有测试 —— 让第 24 行那个用例注入固定时钟并断言 timestamp**

把 `src/main/memory/memoryManager.test.ts` 里这一段（第 23-34 行）：

```ts
describe('saveFact / messages / appendMessage 持久化', () => {
  it('saveFact 落盘 facts.json;appendMessage 落盘 transcript.json;重建 manager 后仍在', () => {
    const m1 = createMemoryManager({ dir, getEmbedder: () => null })
    m1.saveFact('用户叫小星')
    m1.appendMessage({ role: 'user', text: '你好' })
    expect(existsSync(join(dir, 'facts.json'))).toBe(true)
    const m2 = createMemoryManager({ dir, getEmbedder: () => null })
    expect(m2.messages()).toEqual([{ role: 'user', text: '你好' }])
    const facts = JSON.parse(readFileSync(join(dir, 'facts.json'), 'utf-8'))
    expect(facts.facts[0].text).toBe('用户叫小星')
  })
})
```

改成：

```ts
describe('saveFact / messages / appendMessage 持久化', () => {
  it('saveFact 落盘 facts.json;appendMessage 落盘 transcript.json;重建 manager 后仍在', () => {
    const fixedNow = () => new Date(2026, 0, 1, 12, 0, 0)
    const m1 = createMemoryManager({ dir, getEmbedder: () => null, now: fixedNow })
    m1.saveFact('用户叫小星')
    m1.appendMessage({ role: 'user', text: '你好' })
    expect(existsSync(join(dir, 'facts.json'))).toBe(true)
    const m2 = createMemoryManager({ dir, getEmbedder: () => null })
    expect(m2.messages()).toEqual([{ role: 'user', text: '你好', timestamp: fixedNow().getTime() }])
    const facts = JSON.parse(readFileSync(join(dir, 'facts.json'), 'utf-8'))
    expect(facts.facts[0].text).toBe('用户叫小星')
  })
})

describe('appendMessage 补时间戳', () => {
  it('未传 timestamp 时用注入的 now() 补上', () => {
    const m = createMemoryManager({ dir, getEmbedder: () => null, now: () => new Date(2026, 0, 2, 8, 30, 0) })
    m.appendMessage({ role: 'pet', text: '早呀' })
    expect(m.messages()[0].timestamp).toBe(new Date(2026, 0, 2, 8, 30, 0).getTime())
  })
  it('已带 timestamp 时不覆盖', () => {
    const m = createMemoryManager({ dir, getEmbedder: () => null, now: () => new Date(2026, 0, 2, 8, 30, 0) })
    m.appendMessage({ role: 'user', text: '嗨', timestamp: 42 })
    expect(m.messages()[0].timestamp).toBe(42)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm vitest run src/main/memory/memoryManager.test.ts
```

Expected: 上面三个用例 FAIL（当前 `appendMessage` 不补时间戳，`m2.messages()` 里没有 `timestamp` 字段）。

- [ ] **Step 3: 实现 —— 修改 `src/main/memory/memoryManager.ts:63-66`**

把：

```ts
    appendMessage(msg) {
      transcript = appendToTranscript(transcript, msg)
      try { saveTranscript(transcriptFile, transcript) } catch (e) { console.warn('[memory] transcript 写盘失败', e) }
    },
```

改成：

```ts
    appendMessage(msg) {
      const stamped: ChatMessage = { ...msg, timestamp: msg.timestamp ?? now().getTime() }
      transcript = appendToTranscript(transcript, stamped)
      try { saveTranscript(transcriptFile, transcript) } catch (e) { console.warn('[memory] transcript 写盘失败', e) }
    },
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm vitest run src/main/memory/memoryManager.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 5: 跑一遍全量测试确认没有连带破坏其他用到 `messages()`/`appendMessage` 的用例**

```bash
pnpm test
```

Expected: 全部通过。

- [ ] **Step 6: Commit**

```bash
git add src/main/memory/memoryManager.ts src/main/memory/memoryManager.test.ts
git commit -m "feat(memory): appendMessage 用注入的时钟自动补 timestamp"
```

---

### Task 4: 对话框渲染用的纯函数助手（`chatFormat.ts`）

**Files:**
- Create: `src/renderer/chatFormat.ts`
- Test: `src/renderer/chatFormat.test.ts`

**Interfaces:**
- Consumes: `ChatMessage` 类型（`@shared/ipc`，含 Task 2 加的 `timestamp?: number`）
- Produces: `interface MessageGroup { role: ChatMessage['role']; messages: ChatMessage[] }`；`groupMessages(messages: ChatMessage[]): MessageGroup[]`；`formatClockTime(epochMs: number): string`（本地 24 小时制 `HH:mm`）。Task 6 的 `dialog.ts` 直接导入并使用这两个函数。

- [ ] **Step 1: 写失败测试 —— 新建 `src/renderer/chatFormat.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { groupMessages, formatClockTime } from './chatFormat'

describe('groupMessages', () => {
  it('连续同角色的消息合并为一组', () => {
    const groups = groupMessages([
      { role: 'pet', text: 'a' },
      { role: 'pet', text: 'b' },
      { role: 'user', text: 'c' },
      { role: 'pet', text: 'd' }
    ])
    expect(groups).toEqual([
      { role: 'pet', messages: [{ role: 'pet', text: 'a' }, { role: 'pet', text: 'b' }] },
      { role: 'user', messages: [{ role: 'user', text: 'c' }] },
      { role: 'pet', messages: [{ role: 'pet', text: 'd' }] }
    ])
  })
  it('空数组 → 空分组', () => {
    expect(groupMessages([])).toEqual([])
  })
})

describe('formatClockTime', () => {
  it('两位数补零', () => {
    expect(formatClockTime(new Date(2026, 0, 1, 9, 5).getTime())).toBe('09:05')
  })
  it('整点两位数', () => {
    expect(formatClockTime(new Date(2026, 0, 1, 23, 0).getTime())).toBe('23:00')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm vitest run src/renderer/chatFormat.test.ts
```

Expected: FAIL，报错 `Cannot find module './chatFormat'`。

- [ ] **Step 3: 实现 —— 新建 `src/renderer/chatFormat.ts`**

```ts
import type { ChatMessage } from '@shared/ipc'

export interface MessageGroup { role: ChatMessage['role']; messages: ChatMessage[] }

/** 连续同一发送者的消息合并为一组,同组内只需在首条显示头像/名字。 */
export function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  for (const m of messages) {
    const last = groups[groups.length - 1]
    if (last && last.role === m.role) last.messages.push(m)
    else groups.push({ role: m.role, messages: [m] })
  }
  return groups
}

/** 本地 24 小时制 HH:mm,供 MomoTalk 风格气泡旁的时间戳使用。 */
export function formatClockTime(epochMs: number): string {
  const d = new Date(epochMs)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm vitest run src/renderer/chatFormat.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/chatFormat.ts src/renderer/chatFormat.test.ts
git commit -m "feat(dialog): 新增消息分组/时间格式化的纯函数助手"
```

---

### Task 5: 设置窗改成无边框圆角浮窗 + 浅紫配色

**Files:**
- Modify: `src/main/shell/settingsWindow.ts:13-25`
- Modify: `src/renderer/settings.html`（整份重写，所有原有 id 保持不变）
- Modify: `src/renderer/settings.ts:26`（新增 `closeBtn` 引用与点击处理）

**Interfaces:**
- Consumes: Task 1 产出的 `theme.css` token
- Produces: 无新的跨任务接口（纯窗体/视觉层，`settings.ts` 里其余的 id 查询、`settingsApi` 调用完全不变）

- [ ] **Step 1: 修改 `src/main/shell/settingsWindow.ts`**

把第 12-25 行的 `build()` 函数里 `new BrowserWindow({...})` 参数：

```ts
    const w = new BrowserWindow({
      width: 560,
      height: 520,
      title: 'Kibo 设置',
      resizable: false,
      skipTaskbar: false,
      webPreferences: {
        preload: opts.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })
```

改成：

```ts
    const w = new BrowserWindow({
      width: 560,
      height: 520,
      title: 'Kibo 设置',
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: false,
      webPreferences: {
        preload: opts.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })
```

- [ ] **Step 2: 整份重写 `src/renderer/settings.html`**

把整份文件替换为（CSP 不变；结构上把旧的 `<div id="app"><header><h1>...</h1></header>...` 换成 `#card` 包一层自绘标题栏 + 原有 `#layout`/`footer`；`#layout` 内部五个 `<section class="page">` 与其中所有表单控件 id **原样保留**，只改了两处高风险提示框和一处语音安装框的内联 `style` 属性，把写死的颜色值换成 token 引用）：

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'" />
    <link rel="stylesheet" href="./theme.css" />
    <style>
      html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
                   font-family: system-ui, sans-serif; font-size: 13px; }
      #card { box-sizing: border-box; height: 100%; display: flex; flex-direction: column;
              border-radius: var(--radius-window); overflow: hidden; background: var(--app-bg);
              box-shadow: var(--shadow-float); color: var(--text-primary); }

      #titlebar { -webkit-app-region: drag; flex-shrink: 0; display: flex; align-items: center;
                  justify-content: space-between; height: 34px; padding: 0 8px 0 14px;
                  background: linear-gradient(180deg, #efe3ff, var(--app-bg));
                  border-bottom: 1px solid var(--border); }
      #titlebar .t { font-size: 12px; font-weight: 600; color: var(--text-primary); }
      #closeBtn { -webkit-app-region: no-drag; width: 22px; height: 22px; border: none;
                  border-radius: var(--radius-control); padding: 0; cursor: pointer;
                  display: flex; align-items: center; justify-content: center; font-size: 13px;
                  background: transparent; color: var(--accent); }
      #closeBtn:hover { background: var(--danger-bg); color: var(--danger-text); }

      #layout { flex: 1; display: flex; min-height: 0; }
      /* 左侧边栏 */
      #sidenav { flex: 0 0 118px; display: flex; flex-direction: column; gap: 4px; padding: 8px; border-right: 1px solid var(--border); }
      .navitem { text-align: left; border: none; border-radius: var(--radius-control); padding: 9px 10px; cursor: pointer;
                 background: transparent; color: var(--text-secondary); font-size: 13px; position: relative; }
      .navitem:hover { background: var(--accent-soft); }
      .navitem.active { background: var(--accent-soft); color: var(--accent-strong); font-weight: 600; }
      .navitem.active::before { content: ''; position: absolute; left: -8px; top: 6px; bottom: 6px;
                                 width: 3px; border-radius: 2px; background: var(--accent); }
      /* 右侧分页内容 */
      #pages { flex: 1; min-width: 0; overflow-y: auto; padding: 12px 16px; }
      .page { display: none; flex-direction: column; gap: 10px; }
      .page.active { display: flex; }
      .page h2 { font-size: 13px; margin: 0 0 2px; color: var(--text-primary); }
      .hint { color: var(--text-secondary); line-height: 1.5; }
      .banner-warn { background: rgba(230,160,60,0.22); border: 1px solid rgba(200,130,40,0.55);
                     border-radius: var(--radius-control); padding: 8px 10px; line-height: 1.5; color: var(--text-primary); }
      label { display: flex; flex-direction: column; gap: 4px; color: var(--text-primary); }
      input { border: 1px solid var(--border); border-radius: var(--radius-control); padding: 8px;
              background: var(--card-bg); color: var(--text-primary); }
      /* select 用不透明底色,option 单独给高对比配色(半透明背景会让 OS 下拉列表很淡看不清) */
      select { border: 1px solid var(--border); border-radius: var(--radius-control); padding: 8px;
               background: var(--card-bg); color: var(--text-primary); }
      select option { background: var(--card-bg); color: var(--text-primary); }
      .row { display: flex; gap: 8px; align-items: center; }
      button { border: none; border-radius: var(--radius-control); padding: 8px 12px; cursor: pointer;
               background: var(--accent); color: #fff; }
      button.secondary { background: var(--card-bg); border: 1px solid var(--border); color: var(--text-primary); }
      /* 底部固定操作条 */
      footer { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-top: 1px solid var(--border); }
      #status { flex: 1; min-height: 18px; color: var(--text-secondary); }
    </style>
  </head>
  <body>
    <div id="card">
      <div id="titlebar">
        <span class="t">Kibo 设置</span>
        <button id="closeBtn" type="button" title="关闭">✕</button>
      </div>
      <div id="layout">
        <nav id="sidenav">
          <button class="navitem" data-page="model" type="button">模型 · API</button>
          <button class="navitem" data-page="pet" type="button">宠物</button>
          <button class="navitem" data-page="tools" type="button">工具能力</button>
          <button class="navitem" data-page="memory" type="button">记忆</button>
          <button class="navitem" data-page="voice" type="button">语音</button>
        </nav>
        <div id="pages">

          <section class="page" data-page="model">
            <h2>模型 · API</h2>
            <label>Provider 预设
              <select id="preset"></select>
            </label>
            <label>Base URL(可留空用默认)
              <input id="baseURL" type="text" placeholder="https://..." />
            </label>
            <label>模型
              <input id="model" type="text" />
            </label>
            <label>API Key
              <input id="key" type="password" placeholder="仅本机加密存储,不外传" />
            </label>
            <div class="row">
              <button id="test" class="secondary">测试连接</button>
            </div>
          </section>

          <section class="page" data-page="pet">
            <h2>宠物</h2>
            <div id="noPetBanner" class="banner-warn" style="display:none">未检测到宠物包,请先导入一个宠物包,选中它并点击"保存",再点击"立即重启"。</div>
            <label>当前宠物(重启后生效)
              <select id="petSelect"></select>
            </label>
            <div class="row">
              <button id="importPet" class="secondary">导入宠物包…</button>
              <button id="relaunch" class="secondary" style="display:none">立即重启</button>
            </div>
          </section>

          <section class="page" data-page="tools">
            <h2>工具能力</h2>
            <label>搜索后端
              <select id="searchBackend">
                <option value="duckduckgo">免费·内置(默认)</option>
                <option value="tavily">Tavily(需 API key)</option>
              </select>
            </label>
            <label id="searchKeyRow" style="display:none">Tavily API Key
              <input id="searchKey" type="password" placeholder="仅本机加密存储,不外传" />
            </label>
            <label style="display:flex;align-items:center;gap:8px;flex-direction:row">
              <input id="autoCopyResult" type="checkbox" style="width:auto" />
              <span>快捷加工结果自动复制到剪贴板(会覆盖当前剪贴板)</span>
            </label>
            <label style="display:flex;align-items:center;gap:8px;flex-direction:row">
              <input id="firecrawlEnabled" type="checkbox" style="width:auto" />
              <span>启用网页深度阅读(Firecrawl · 需 API key · 按量计费)</span>
            </label>
            <label id="firecrawlKeyRow" style="display:none">Firecrawl API Key
              <input id="firecrawlKey" type="password" placeholder="仅本机加密存储,不外传" />
            </label>
            <label id="firecrawlBaseRow" style="display:none">Firecrawl Base URL(可选 · 自托管才需改)
              <input id="firecrawlBaseURL" type="text" placeholder="https://api.firecrawl.dev" />
            </label>
            <div style="margin-top:14px;padding:10px;border:1px solid var(--danger-border);border-radius:8px;background:var(--danger-bg)">
              <label style="display:flex;align-items:center;gap:8px;flex-direction:row">
                <input id="desktopControlEnabled" type="checkbox" style="width:auto" />
                <span>允许宠物自主截屏与控制鼠标/键盘(高风险)</span>
              </label>
              <div class="hint" style="margin-top:6px">
                开启后 AI 可能在对话中截屏(屏幕内容会发给你配置的模型服务商)、控制鼠标点击与键盘输入,
                可能造成误操作或截取到敏感信息。默认关闭,开启前会再次弹窗确认。
              </div>
            </div>
            <div style="margin-top:14px;padding:10px;border:1px solid var(--danger-border);border-radius:8px;background:var(--danger-bg)">
              <label style="display:flex;align-items:center;gap:8px;flex-direction:row">
                <input id="browserControlEnabled" type="checkbox" style="width:auto" />
                <span>允许宠物自主浏览/操作网页(高风险)</span>
              </label>
              <div class="hint" style="margin-top:6px">
                开启后 AI 可能自主打开浏览器窗口浏览网页、点击、填表。默认使用隔离的临时浏览器环境,
                不影响你日常浏览器的登录状态。默认关闭,开启前会再次弹窗确认。
              </div>
              <label id="browserControlModeRow" style="display:none;margin-top:8px">浏览器接管方式
                <select id="browserControlMode">
                  <option value="isolated">独立隔离浏览器(推荐,不影响你的真实浏览器)</option>
                  <option value="cdp">接管我正在用的真实浏览器(高风险,能用到已登录账号)</option>
                </select>
              </label>
              <label id="browserControlChromePathRow" style="display:none;margin-top:8px">自定义 Chrome 路径(可选 · 仅独立隔离模式生效)
                <input id="browserControlChromePath" type="text" placeholder="留空则自动探测,例如 C:\Program Files\Google\Chrome\Application\chrome.exe" />
              </label>
              <div id="browserControlChromePathHint" class="hint" style="display:none;margin-top:2px">
                如果宠物打开浏览器一直失败(常见于同一台电脑装了两个 Chrome,坏掉的那个被自动选中),
                把能正常打开的那个 chrome.exe 完整路径填在这里。
              </div>
            </div>
          </section>

          <section class="page" data-page="memory">
            <h2>记忆(可选)</h2>
            <div class="hint">配置 embedding 后,宠物记住的事实会发送到该端点做向量化,以便按话题召回;三项留空则记忆完全本地(按最近记忆召回)。</div>
            <label>Embedding Base URL
              <input id="embBaseURL" type="text" placeholder="https://...(OpenAI 兼容,如 DashScope)" />
            </label>
            <label>Embedding 模型
              <input id="embModel" type="text" placeholder="如 text-embedding-v3" />
            </label>
            <label>Embedding API Key
              <input id="embKey" type="password" placeholder="留空且与聊天同 Base URL 时自动复用聊天 Key" />
            </label>
            <div class="row">
              <button id="openMemoryDir" class="secondary">打开记忆文件夹</button>
            </div>
          </section>

          <section class="page" data-page="voice">
            <h2>语音(实验性)</h2>
            <div class="hint">配音使用本地 GSV-TTS-Lite 运行时(独立 Python 环境 + 模型,体积较大),需先安装运行时才能生效。</div>
            <label style="display:flex;align-items:center;gap:8px;flex-direction:row">
              <input id="ttsEnabled" type="checkbox" style="width:auto" />
              <span>启用配音(宠物回复时朗读)</span>
            </label>

            <div style="margin-top:6px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--card-bg)">
              <div id="ttsRuntimeStatus" class="hint">运行时状态:检测中…</div>
              <label style="margin-top:8px">安装位置
                <div class="row">
                  <input id="ttsInstallPath" type="text" readonly placeholder="尚未选择" style="flex:1" />
                  <button id="ttsPickPath" class="secondary" type="button">选择安装位置</button>
                </div>
              </label>
              <div class="hint" style="margin-top:2px">选择安装位置后请先点击下方"保存",再进行安装/导入/导出(否则仍会使用上次保存的位置)。</div>
              <div class="row" style="margin-top:8px">
                <button id="ttsInstall" class="secondary" type="button">现场安装</button>
                <button id="ttsImport" class="secondary" type="button">导入压缩包…</button>
                <button id="ttsExport" class="secondary" type="button">导出压缩包…</button>
              </div>
              <pre id="ttsInstallLog" style="margin-top:8px;max-height:120px;overflow-y:auto;white-space:pre-wrap;background:rgba(0,0,0,0.3);border-radius:8px;padding:8px;font-size:12px;display:none;color:#f0f0f4"></pre>
            </div>

            <label>设备
              <select id="ttsDevice">
                <option value="auto">自动</option>
                <option value="cuda">GPU(cuda)</option>
                <option value="cpu">CPU</option>
              </select>
            </label>
            <label style="display:flex;align-items:center;gap:8px;flex-direction:row">
              <input id="ttsUseFlashAttn" type="checkbox" style="width:auto" />
              <span>启用 Flash Attention(需自行满足 README 中 Windows wheel 安装前提)</span>
            </label>
            <label>目标朗读语言
              <select id="ttsTargetLanguage">
                <option value="auto">自动</option>
                <option value="zh">中文</option>
                <option value="ja">日语</option>
                <option value="en">英语</option>
              </select>
            </label>
            <label>播放触发方式
              <select id="ttsPlaybackTrigger">
                <option value="batch">整句合成后播放(推荐,不易卡顿)</option>
                <option value="stream">边生成边播放(可能不流畅)</option>
              </select>
            </label>
            <label>合成切分方式
              <select id="ttsSynthesisChunking">
                <option value="token">按 token</option>
                <option value="sentence">按句子(推荐)</option>
              </select>
            </label>
            <label>朗读文本切分(边生成边播放时生效)
              <select id="ttsTextSplit">
                <option value="smart">智能合并短句(推荐,翻译更稳、不易漏读)</option>
                <option value="sentence">按句子(开口最快)</option>
              </select>
            </label>

            <details style="margin-top:6px">
              <summary style="cursor:pointer;opacity:0.9">生成参数(高级,默认即可)</summary>
              <div style="display:flex;flex-direction:column;gap:10px;margin-top:8px">
                <label>语速 speed(0.1 - 2)
                  <input id="ttsSpeed" type="number" min="0.1" max="2" step="0.1" />
                </label>
                <label>噪声比例 noiseScale(0.1 - 1)
                  <input id="ttsNoiseScale" type="number" min="0.1" max="1" step="0.1" />
                </label>
                <label>温度 temperature(0.1 - 2)
                  <input id="ttsTemperature" type="number" min="0.1" max="2" step="0.1" />
                </label>
                <label>Top K(1 - 50,整数)
                  <input id="ttsTopK" type="number" min="1" max="50" step="1" />
                </label>
                <label>Top P(0.1 - 1)
                  <input id="ttsTopP" type="number" min="0.1" max="1" step="0.1" />
                </label>
                <label>重复惩罚 repetitionPenalty(1 - 2)
                  <input id="ttsRepetitionPenalty" type="number" min="1" max="2" step="0.01" />
                </label>
                <label style="display:flex;align-items:center;gap:8px;flex-direction:row">
                  <input id="ttsIsCutText" type="checkbox" style="width:auto" />
                  <span>合成前自动切分长文本</span>
                </label>
                <label>最小切分长度 cutMinLen(整数)
                  <input id="ttsCutMinLen" type="number" min="1" step="1" />
                </label>
                <label>切分静音时长 cutMute(秒,0 - 2)
                  <input id="ttsCutMute" type="number" min="0" max="2" step="0.1" />
                </label>
              </div>
            </details>
          </section>

        </div>
      </div>
      <footer>
        <div id="status"></div>
        <button id="save">保存</button>
      </footer>
    </div>
    <script type="module" src="./settings.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: 在 `src/renderer/settings.ts` 加关闭按钮的引用与事件**

把 `src/renderer/settings.ts:26` 这一行（`const noPetBanner = ...` 之后）：

```ts
const noPetBanner = $<HTMLElement>('noPetBanner')
```

改成：

```ts
const noPetBanner = $<HTMLElement>('noPetBanner')
const closeBtn = $<HTMLButtonElement>('closeBtn')
closeBtn.addEventListener('click', () => window.close())
```

- [ ] **Step 4: 构建确认**

```bash
pnpm build
```

Expected: 无 TypeScript/构建报错（尤其确认 `settings.html` 里所有 id 都还和 `settings.ts` 对得上，没有因为重写漏掉哪个控件）。

- [ ] **Step 5: 跑测试确认没有连带破坏**

```bash
pnpm test
```

Expected: 全部通过。

- [ ] **Step 6: Commit**

```bash
git add src/main/shell/settingsWindow.ts src/renderer/settings.html src/renderer/settings.ts
git commit -m "feat(settings): 设置窗改为无边框圆角浮窗,配色统一到浅紫 token"
```

---

### Task 6: 对话框改造成 MomoTalk 结构(头像/名字/描边气泡/时间戳)

**Files:**
- Modify: `src/renderer/dialog.html`（整份重写）
- Modify: `src/renderer/dialog.ts`（整份重写）
- Modify: `src/main/shell/dialogWindow.ts:4-5`（展开态窗口高度微调）

**Interfaces:**
- Consumes: Task 1 的 `theme.css` token、Task 4 的 `groupMessages`/`formatClockTime`、`@shared/petPackage` 的 `frameRect`、`window.petApi.getPet(): Promise<LoadedPet>`（已在 preload 全局暴露，无需改动）
- Produces: 无新的跨任务接口（`chatApi`/`mediaApi` 的调用方式完全不变，纯渲染层重写）

- [ ] **Step 1: 整份重写 `src/renderer/dialog.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:" />
    <link rel="stylesheet" href="./theme.css" />
    <style>
      html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
                   font-family: system-ui, sans-serif; font-size: 13px; }
      /* 按住对话框本体任意空白处即可拖动整窗(OS 级拖拽);交互控件单独设为 no-drag */
      #panel { box-sizing: border-box; height: 100%; display: flex; flex-direction: column;
               border-radius: var(--radius-window); overflow: hidden; background: var(--app-bg);
               box-shadow: var(--shadow-float); cursor: move; -webkit-app-region: drag; }
      #input, button, #history { -webkit-app-region: no-drag; }
      #history, .bubble { cursor: default; }

      /* 头部:仅展开态显示,含头像/名字/折叠按钮 */
      #chat-head { display: none; align-items: center; gap: 8px; padding: 8px 10px; flex-shrink: 0;
                   background: linear-gradient(180deg, var(--titlebar-highlight), var(--app-bg));
                   border-bottom: 1px solid var(--border); -webkit-app-region: drag; }
      #panel.expanded #chat-head { display: flex; }
      #avatar { width: 26px; height: 26px; border-radius: 50%; background-color: var(--accent-soft);
                background-size: cover; background-position: center; flex-shrink: 0; }
      #pet-name { flex: 1; font-size: 12.5px; font-weight: 700; color: var(--text-primary); }
      #headCollapse { -webkit-app-region: no-drag; width: 22px; height: 22px; border: none;
                      border-radius: var(--radius-control); padding: 0; cursor: pointer;
                      display: flex; align-items: center; justify-content: center;
                      font-size: 13px; background: transparent; color: var(--accent); }
      #headCollapse:hover { background: var(--accent-soft); }

      /* 历史列表:仅展开态显示 */
      /* min-height:0 关键:flex 子项默认 min-height:auto 不会收缩到内容高度以下,
         回复较长时会把下方输入条挤出固定高度的窗口(body overflow:hidden 裁掉)。
         设 0 后 #history 才能收缩并内部滚动,输入条始终可见。 */
      #history { flex: 1; min-height: 0; overflow-y: auto; display: none; flex-direction: column; gap: 8px;
                 padding: 10px; background: var(--surface-grad); }
      #panel.expanded #history { display: flex; }

      .group { display: flex; flex-direction: column; gap: 3px; }
      .name-tag { font-size: 10.5px; color: var(--text-secondary); margin: 0 0 1px 28px; }
      .row { display: flex; align-items: flex-end; gap: 6px; }
      .row.user { justify-content: flex-end; }
      .mini-avatar { width: 22px; height: 22px; border-radius: 50%; background-color: var(--accent-soft);
                     background-size: cover; background-position: center; flex-shrink: 0; }
      .avatar-spacer { width: 22px; flex-shrink: 0; }

      .bubble { max-width: 78%; padding: 7px 11px; border-radius: 14px; word-break: break-word;
                line-height: 1.45; border: 1.6px solid var(--outline); }
      .bubble.pet { background: var(--pet-bubble-bg); color: var(--text-primary); border-bottom-left-radius: 4px; }
      .bubble.user { background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
      .bubble.status { opacity: 0.75; font-style: italic; }
      /* pet 回复内渲染的 Markdown 子集样式(小气泡里克制:标题降级为加粗、列表紧凑) */
      .bubble.pet ul { margin: 4px 0; padding-left: 18px; }
      .bubble.pet li { margin: 1px 0; }
      .bubble.pet strong { font-weight: 600; }
      .bubble.pet code { background: var(--code-tint); border-radius: 4px; padding: 0 3px; font-size: 12px; }
      .bubble.pet a.md-link { color: var(--accent); text-decoration: underline; word-break: break-all; }

      .time { font-size: 9.5px; color: var(--text-secondary); flex-shrink: 0; padding-bottom: 2px; }

      /* 输入条:折叠态/展开态共用同一条,胶囊化 */
      #bar { display: flex; flex-shrink: 0; margin-top: auto; gap: 6px; align-items: center;
             background: var(--card-bg); border: 1.5px solid var(--border); border-radius: var(--radius-pill);
             padding: 6px 6px 6px 14px; }
      #input { flex: 1; min-width: 0; border: none; outline: none; padding: 2px 0;
               background: transparent; color: var(--text-primary); cursor: text;
               font-family: inherit; font-size: inherit; line-height: 1.4; resize: none;
               max-height: 66px; overflow-y: auto; }
      #input::placeholder { color: var(--text-secondary); }
      button.icon, #toggle, #send { border: none; border-radius: 50%; width: 26px; height: 26px; padding: 0;
             cursor: pointer; background: var(--accent-soft); color: var(--accent); font-size: 12px;
             display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
      #send { display: none; background: var(--accent); color: #fff; }
      #panel.expanded #send { display: flex; }
      #panel.expanded #toggle { display: none; }

      /* 待发缩略图带 */
      #attach { display: none; flex-shrink: 0; gap: 6px; flex-wrap: wrap; padding: 0 10px; -webkit-app-region: no-drag; }
      #attach .thumb { position: relative; width: 44px; height: 44px; }
      #attach .thumb img { width: 44px; height: 44px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border); }
      #attach .thumb button { position: absolute; top: -6px; right: -6px; width: 16px; height: 16px;
             padding: 0; line-height: 14px; border-radius: 8px; font-size: 11px;
             background: var(--outline); color: #fff; }
      .imgmark { opacity: 0.85; margin-right: 4px; }
    </style>
  </head>
  <body>
    <div id="panel" class="collapsed">
      <div id="chat-head">
        <div id="avatar"></div>
        <div id="pet-name"></div>
        <button id="headCollapse" type="button" title="收起">⤡</button>
      </div>
      <div id="history"></div>
      <div id="attach"></div>
      <div id="bar">
        <textarea id="input" rows="1" placeholder="说点什么…"></textarea>
        <button id="pick" class="icon" title="选择图片">＋</button>
        <button id="shot" class="icon" title="框选截屏">📷</button>
        <button id="toggle" title="展开">⤢</button>
        <button id="send">➤</button>
      </div>
    </div>
    <script type="module" src="./dialog.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: 整份重写 `src/renderer/dialog.ts`**

```ts
import type { ChatMessage, ChatSendAttachment } from '@shared/ipc'
import { frameRect } from '@shared/petPackage'
import { renderMarkdownSafe } from './markdown'
import { groupMessages, formatClockTime } from './chatFormat'

const panel = document.getElementById('panel') as HTMLElement
const history = document.getElementById('history') as HTMLElement
const input = document.getElementById('input') as HTMLTextAreaElement
const toggleBtn = document.getElementById('toggle') as HTMLButtonElement
const sendBtn = document.getElementById('send') as HTMLButtonElement
const pickBtn = document.getElementById('pick') as HTMLButtonElement
const shotBtn = document.getElementById('shot') as HTMLButtonElement
const attachStrip = document.getElementById('attach') as HTMLElement
const avatarEl = document.getElementById('avatar') as HTMLElement
const petNameEl = document.getElementById('pet-name') as HTMLElement
const headCollapseBtn = document.getElementById('headCollapse') as HTMLButtonElement

const MAX_ATTACH = 6
let pending: ChatSendAttachment[] = []
let avatarDataUrl = ''

function renderPending(): void {
  attachStrip.innerHTML = ''
  attachStrip.style.display = pending.length ? 'flex' : 'none'
  pending.forEach((a, i) => {
    const wrap = document.createElement('div')
    wrap.className = 'thumb'
    const im = document.createElement('img')
    im.src = `data:${a.mimeType};base64,${a.dataBase64}`
    const x = document.createElement('button')
    x.textContent = '×'
    x.title = '移除'
    x.addEventListener('click', () => { pending.splice(i, 1); renderPending() })
    wrap.append(im, x)
    attachStrip.appendChild(wrap)
  })
}

function addPending(atts: ChatSendAttachment[]): void {
  for (const a of atts) { if (pending.length >= MAX_ATTACH) break; pending.push(a) }
  renderPending()
}

/** 渲染层统一降采样到 ≤1568 JPEG,保证 IPC payload 有界 */
async function downscale(file: File, maxEdge = 1568): Promise<ChatSendAttachment> {
  const bmp = await createImageBitmap(file)
  const longest = Math.max(bmp.width, bmp.height)
  const s = longest > maxEdge ? maxEdge / longest : 1
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s)
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  c.getContext('2d')!.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  const url = c.toDataURL('image/jpeg', 0.85)
  return { kind: 'image', mimeType: 'image/jpeg', dataBase64: url.split(',')[1] }
}

async function addFiles(files: Iterable<File>): Promise<void> {
  const out: ChatSendAttachment[] = []
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue
    try { out.push(await downscale(f)) } catch { /* 跳过坏图 */ }
  }
  if (out.length) addPending(out)
}

/** 从宠物 spritesheet 裁出 idle 动画首帧,作为聊天室头像;失败(如包缺 idle 动画)时静默放弃,
 *  头像元素退回 CSS 里的浅紫底色占位,不影响聊天功能本身。 */
async function loadAvatar(): Promise<void> {
  const pet = await window.petApi.getPet()
  petNameEl.textContent = pet.manifest.displayName
  const idle = pet.manifest.animations.idle
  if (!idle) return
  const rect = frameRect(pet.manifest.sheet, idle.row, 0)
  const img = new Image()
  img.src = pet.spritesheetDataUrl
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = rect.w
  canvas.height = rect.h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
  avatarDataUrl = canvas.toDataURL()
  avatarEl.style.backgroundImage = `url(${avatarDataUrl})`
}

let collapsed = true
let streaming = '' // 进行中的 pet 回复(逐字累积)
let streamingStartTime = 0
let statusEl: HTMLElement | null = null

function clearStatus(): void {
  document.getElementById('status-row')?.remove()
  statusEl = null
}

/** 组装一行消息:pet 一侧在左带头像(或占位)+ 时间在气泡右侧,user 一侧在右、时间在气泡左侧。 */
function buildRow(role: ChatMessage['role'], bubbleEl: HTMLElement, timestamp: number | undefined, showAvatar: boolean): HTMLElement {
  const row = document.createElement('div')
  row.className = `row ${role}`
  if (role === 'pet') {
    const av = document.createElement('div')
    av.className = showAvatar ? 'mini-avatar' : 'avatar-spacer'
    if (showAvatar && avatarDataUrl) av.style.backgroundImage = `url(${avatarDataUrl})`
    row.appendChild(av)
  }
  const time = timestamp != null ? formatClockTime(timestamp) : null
  if (role === 'user' && time) {
    const t = document.createElement('span')
    t.className = 'time'
    t.textContent = time
    row.appendChild(t)
  }
  row.appendChild(bubbleEl)
  if (role === 'pet' && time) {
    const t = document.createElement('span')
    t.className = 'time'
    t.textContent = time
    row.appendChild(t)
  }
  return row
}

function buildBubble(m: ChatMessage): HTMLElement {
  const el = document.createElement('div')
  el.className = `bubble ${m.role}`
  // pet 回复渲染安全 Markdown 子集(转义后再套有限规则,防注入);用户消息保持纯文本。
  if (m.role === 'pet') {
    el.innerHTML = renderMarkdownSafe(m.text)
  } else {
    const n = m.attachments?.length ?? 0
    if (n > 0) {
      const mark = document.createElement('span')
      mark.className = 'imgmark'
      mark.textContent = `🖼×${n}`
      el.appendChild(mark)
    }
    el.appendChild(document.createTextNode(m.text))
  }
  return el
}

function renderStreaming(): void {
  let row = document.getElementById('streaming-row') as HTMLElement | null
  if (!row) {
    streamingStartTime = Date.now()
    const bubble = document.createElement('div')
    bubble.className = 'bubble pet'
    bubble.id = 'streaming-bubble'
    row = buildRow('pet', bubble, streamingStartTime, true)
    row.id = 'streaming-row'
    history.appendChild(row)
  }
  const bubble = document.getElementById('streaming-bubble') as HTMLElement
  bubble.textContent = streaming
  history.scrollTop = history.scrollHeight
}

function render(messages: ChatMessage[]): void {
  clearStatus()
  document.getElementById('streaming-row')?.remove()
  history.innerHTML = ''
  for (const group of groupMessages(messages)) {
    const groupEl = document.createElement('div')
    groupEl.className = 'group'
    if (group.role === 'pet') {
      const tag = document.createElement('div')
      tag.className = 'name-tag'
      tag.textContent = petNameEl.textContent ?? ''
      groupEl.appendChild(tag)
    }
    group.messages.forEach((m, i) => {
      const bubble = buildBubble(m)
      groupEl.appendChild(buildRow(m.role, bubble, m.timestamp, i === 0))
    })
    history.appendChild(groupEl)
  }
  history.scrollTop = history.scrollHeight
}

function setCollapsed(c: boolean): void {
  collapsed = c
  panel.classList.toggle('collapsed', c)
  panel.classList.toggle('expanded', !c)
  toggleBtn.textContent = c ? '⤢' : '⤡'
  toggleBtn.title = c ? '展开' : '收起'
  window.chatApi.setSize(c)
}

function submit(): void {
  const text = input.value.trim()
  if (!text && pending.length === 0) return
  // 开新一轮:立即抹掉上一条(正在流式/将被取消)回复的累积与显示,让"打断"在视觉上
  // 即时生效——不必等主进程回推 CHAT_UPDATE。否则 collapsed 气泡会残留旧文字直到淡出,
  // 且被取消回复的残留前缀会串进新回复(取消结果被静默丢弃,不发 onDone/onError)。
  streaming = ''
  document.getElementById('streaming-row')?.remove()
  clearStatus()
  window.chatApi.send({ text, attachments: pending.length ? pending : undefined })
  input.value = ''
  input.style.height = 'auto'
  pending = []
  renderPending()
}

toggleBtn.addEventListener('click', () => setCollapsed(!collapsed))
headCollapseBtn.addEventListener('click', () => setCollapsed(true))
sendBtn.addEventListener('click', submit)
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() }
  // Shift+Enter / 输入法组合中 → 走默认,插入换行
})
// textarea 随内容自增高(上限由 CSS max-height 接管,超出内部滚动)
input.addEventListener('input', () => {
  input.style.height = 'auto'
  input.style.height = `${input.scrollHeight}px`
})
pickBtn.addEventListener('click', async () => {
  const atts = await window.mediaApi.pickImage()
  if (atts.length) addPending(atts)
})
shotBtn.addEventListener('click', async () => {
  const att = await window.mediaApi.captureRegion()
  if (att) addPending([att])
})
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => {
  e.preventDefault()
  if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files)
})
window.addEventListener('paste', (e) => {
  const files: File[] = []
  for (const it of e.clipboardData?.items ?? []) {
    if (it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) files.push(f) }
  }
  if (files.length) void addFiles(files)
})
window.chatApi.onUpdate(render)
window.chatApi.onStream((text) => {
  clearStatus()
  streaming += text
  renderStreaming()
})
window.chatApi.onDone(() => { streaming = '' })
window.chatApi.onError((message) => {
  clearStatus()
  streaming = ''
  const bubble = document.createElement('div')
  bubble.className = 'bubble pet'
  bubble.textContent = `⚠ ${message}`
  history.appendChild(buildRow('pet', bubble, Date.now(), true))
  history.scrollTop = history.scrollHeight
})
window.chatApi.onStatus((text) => {
  if (!statusEl) {
    const bubble = document.createElement('div')
    bubble.className = 'bubble pet status'
    bubble.id = 'status-bubble'
    const row = buildRow('pet', bubble, undefined, true)
    row.id = 'status-row'
    history.appendChild(row)
    statusEl = bubble
  }
  statusEl.textContent = `🔍 ${text}`
  history.scrollTop = history.scrollHeight
})

// 渲染层是折叠态的唯一真源:窗口每次重新显示时,把当前折叠态重新告知主进程,
// 纠正主进程窗口尺寸与面板态可能出现的不同步(否则展开后关闭再开会卡在错误尺寸,无法恢复)。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') window.chatApi.setSize(collapsed)
})

setCollapsed(true)
void loadAvatar().catch(() => { /* 头像纯装饰,加载失败不影响聊天功能 */ })
```

- [ ] **Step 3: 微调对话框展开态窗口高度 —— `src/main/shell/dialogWindow.ts:4-5`**

把：

```ts
const COLLAPSED = { width: 320, height: 120 }
const EXPANDED = { width: 320, height: 440 }
```

改成：

```ts
const COLLAPSED = { width: 320, height: 120 }
const EXPANDED = { width: 320, height: 470 }
```

- [ ] **Step 4: 构建确认**

```bash
pnpm build
```

Expected: 无 TypeScript/构建报错。

- [ ] **Step 5: 跑测试确认没有连带破坏**

```bash
pnpm test
```

Expected: 全部通过。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/dialog.html src/renderer/dialog.ts src/main/shell/dialogWindow.ts
git commit -m "feat(dialog): 展开对话框改为 MomoTalk 风格聊天室结构"
```

---

### Task 7: 真机视觉验收(不阻塞前面任务的提交)

**Files:** 无代码改动，仅验证。

- [ ] **Step 1: 启动打包预览**

```bash
pnpm build
pnpm preview
```

- [ ] **Step 2: 逐项目视确认**

- 气泡窗（触碰宠物/发一条消息触发）视觉与改造前一致（像素级不应变化）
- 展开对话框：折叠态输入条是浅紫胶囊；点击展开后顶部出现头像+宠物名头部栏；发几条消息，确认连续同角色消息只在组首显示头像/名字、气泡有深紫描边、气泡外侧有时间戳；流式回复期间气泡实时增长不撑破窗口
- 设置窗：托盘打开设置，确认整窗是圆角浮窗（无系统原生标题栏）、点击右上角 ✕ 能正常关闭、侧边栏选中项左侧有强调条、风险提示条仍清晰可辨
- 用 Windows 原生方式拖动对话框和设置窗标题栏区域，确认整窗跟手移动、输入框/按钮不会触发拖拽

Expected: 以上四类现象都符合预期。这一步是人工真机确认，若当前会话没有可用显示器/无法拖拽真实窗口，明确告知用户"以上改动已实现并通过构建，视觉细节等待你真机确认"，不要在没有实际观察到画面的情况下宣称"已验证通过"。

---

## 自查(写完计划后过一遍)

- **spec 覆盖**：共享 token（Task1）、settings 视觉统一（Task5）、dialog MomoTalk 结构（Task6）、timestamp 数据链路（Task2/3）、头像复用 frameRect（Task6 Step2 的 `loadAvatar`）、窗口尺寸调整（Task6 Step3）——spec 里列的每一项都能对应到任务。
- **占位符扫描**：所有代码块都是完整实现，没有 "TODO/类似 Task N 的做法" 这类占位。
- **类型一致性**：`groupMessages`/`formatClockTime`（Task4 定义）在 Task6 的 `dialog.ts` 里按相同签名导入使用；`ChatMessage.timestamp?: number`（Task2 定义）在 Task3/Task6 里全程用同一个可选 number 类型，没有改名。
