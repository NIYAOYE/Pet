import { BrowserWindow, shell } from 'electron'
import { IPC } from '@shared/ipc'
import type { Bounds } from '@shared/petBrain'
import { bubblePlacement } from '@shared/bubblePlacement'

// 气泡框 240×160 + 底部 12px 尾巴区 = 172;bubblePlacement 以此整体尺寸计算越界
const SIZE = { width: 240, height: 172 }

export interface BubbleController {
  show(pet: Bounds, workArea: Bounds): void
  hide(): void
  reposition(pet: Bounds, workArea: Bounds): void
  isVisible(): boolean
  pushStream(text: string): void
  pushStatus(text: string): void
  pushDone(): void
  pushError(message: string): void
  clear(): void
  window(): BrowserWindow | null
}

export function createBubbleController(opts: {
  preload: string
  url: string | undefined // bubble.html 的 dev URL(含 /bubble.html),打包为 undefined
  bubbleHtml: string
}): BubbleController {
  // 眼急建窗并隐藏:流式回复是连续多帧,若懒建窗则首批 token 会在渲染层监听器就绪前
  // 被静默丢弃(丢开头)。启动即建好、监听器就绪,后续 show 只切换可见性。
  const win = new BrowserWindow({
    width: SIZE.width,
    height: SIZE.height,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false, // 气泡不抢焦点,输入焦点始终留在对话框输入框
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  // 回复里的来源链接在系统浏览器打开,绝不导航/替换气泡窗本身
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault()
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (opts.url) win.loadURL(opts.url)
  else win.loadFile(opts.bubbleHtml)

  function place(pet: Bounds, workArea: Bounds): void {
    const p = bubblePlacement(pet, workArea, SIZE)
    const wasResizable = win.isResizable()
    if (!wasResizable) win.setResizable(true)
    win.setBounds({ x: p.x, y: p.y, width: SIZE.width, height: SIZE.height })
    if (!wasResizable) win.setResizable(false)
    win.webContents.send(IPC.BUBBLE_PLACE, { tailSide: p.tailSide, tailOffsetX: p.tailOffsetX })
  }

  return {
    window: () => win,
    isVisible: () => win.isVisible(),
    show(pet, workArea): void {
      place(pet, workArea)
      win.showInactive() // 显示但不激活,不抢焦点
    },
    hide(): void { win.hide() },
    reposition(pet, workArea): void { if (win.isVisible()) place(pet, workArea) },
    pushStream: (t) => win.webContents.send(IPC.BUBBLE_STREAM, t),
    pushStatus: (t) => win.webContents.send(IPC.BUBBLE_STATUS, t),
    pushDone: () => win.webContents.send(IPC.BUBBLE_DONE),
    pushError: (m) => win.webContents.send(IPC.BUBBLE_ERROR, m),
    clear: () => win.webContents.send(IPC.BUBBLE_CLEAR)
  }
}
