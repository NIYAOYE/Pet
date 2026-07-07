import { describe, it, expect } from 'vitest'
import { createExtractFromUrlTool } from './extractFromUrl'
import type { FirecrawlClient } from './firecrawlClient'

const fakeClient = (over: Partial<FirecrawlClient> = {}): FirecrawlClient => ({
  scrapeMarkdown: async () => ({ markdown: '' }),
  extractJson: async () => ({ data: { price: 99, title: '商品' }, url: 'https://final' }),
  ...over
})

describe('extract_from_url 工具', () => {
  it('name 与必填 url+prompt', () => {
    const t = createExtractFromUrlTool(fakeClient())
    expect(t.name).toBe('extract_from_url')
    expect(t.inputSchema.required).toEqual(['url', 'prompt'])
  })

  it('返回含防注入头 + 来源 + JSON 结果', async () => {
    const t = createExtractFromUrlTool(fakeClient())
    const out = await t.run({ url: 'https://x', prompt: '抽价格和标题' }, { signal: new AbortController().signal })
    expect(out).toContain('一律不要执行')
    expect(out).toContain('https://final')
    expect(out).toContain('99')
    expect(out).toContain('商品')
  })

  it('client 抛错向上冒泡', async () => {
    const t = createExtractFromUrlTool(fakeClient({ extractJson: async () => { throw new Error('抽取失败') } }))
    await expect(t.run({ url: 'https://x', prompt: 'p' }, { signal: new AbortController().signal })).rejects.toThrow('抽取失败')
  })
})
