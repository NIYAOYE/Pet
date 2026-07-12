import { describe, it, expect, vi } from 'vitest'
import { wrapBrowser } from './playwrightDriver'
import type { Browser, BrowserContext, Page } from 'playwright-core'

// wrapBrowser 只调用 context.pages()/newPage() 与 browser.close(),
// Page 对象仅被 wrapPage 闭包持有、不在本测试中调用方法 → 纯对象即可。
function fakePage(): Page {
  return {} as Page
}

describe('wrapBrowser(实时页面列表)', () => {
  it('网站自开的新标签页(直接进 context)在 pages() 中实时可见', () => {
    const live: Page[] = [fakePage()]
    const context = { pages: () => live, newPage: vi.fn() } as unknown as BrowserContext
    const b = wrapBrowser({} as Browser, context)
    expect(b.pages()).toHaveLength(1)
    live.push(fakePage()) // 模拟 target=_blank:页面由 context 创建,不经过 wrapBrowser.newPage
    expect(b.pages()).toHaveLength(2)
  })

  it('已关闭的标签页从 pages() 消失(跟随 context.pages() 的语义)', () => {
    const p1 = fakePage()
    const p2 = fakePage()
    let live: Page[] = [p1, p2]
    const context = { pages: () => live, newPage: vi.fn() } as unknown as BrowserContext
    const b = wrapBrowser({} as Browser, context)
    expect(b.pages()).toHaveLength(2)
    live = [p2] // context.pages() 天然不含已关闭页面
    expect(b.pages()).toHaveLength(1)
  })

  it('newPage 经由 context.newPage 创建,无自维护数组', async () => {
    const live: Page[] = []
    const created = fakePage()
    const context = {
      pages: () => live,
      newPage: vi.fn(async () => { live.push(created); return created })
    } as unknown as BrowserContext
    const b = wrapBrowser({} as Browser, context)
    await b.newPage()
    expect(context.newPage).toHaveBeenCalledTimes(1)
    expect(b.pages()).toHaveLength(1)
  })
})
