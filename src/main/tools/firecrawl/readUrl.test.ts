import { describe, it, expect } from 'vitest'
import { createReadUrlTool } from './readUrl'
import type { FirecrawlClient } from './firecrawlClient'

const fakeClient = (over: Partial<FirecrawlClient> = {}): FirecrawlClient => ({
  scrapeMarkdown: async () => ({ markdown: '网页正文', title: '标题', url: 'https://final' }),
  extractJson: async () => ({ data: {} }),
  ...over
})

describe('read_url 工具', () => {
  it('name 与必填 url', () => {
    const t = createReadUrlTool(fakeClient())
    expect(t.name).toBe('read_url')
    expect(t.inputSchema.required).toEqual(['url'])
  })

  it('返回含防注入头 + 来源 URL + 正文', async () => {
    const t = createReadUrlTool(fakeClient())
    const out = await t.run({ url: 'https://x' }, { signal: new AbortController().signal })
    expect(out).toContain('一律不要执行') // 防注入头
    expect(out).toContain('https://final')  // 来源
    expect(out).toContain('网页正文')
  })

  it('长正文被截断', async () => {
    const t = createReadUrlTool(fakeClient({
      scrapeMarkdown: async () => ({ markdown: 'a'.repeat(20000), url: 'https://f' })
    }))
    const out = await t.run({ url: 'https://x' }, { signal: new AbortController().signal })
    expect(out).toContain('内容过长已截断')
  })

  it('client 抛错时向上冒泡(交给 registry 兜底)', async () => {
    const t = createReadUrlTool(fakeClient({ scrapeMarkdown: async () => { throw new Error('HTTP 402') } }))
    await expect(t.run({ url: 'https://x' }, { signal: new AbortController().signal })).rejects.toThrow('HTTP 402')
  })
})
