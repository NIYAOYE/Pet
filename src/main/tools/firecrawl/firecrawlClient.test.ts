import { describe, it, expect, vi } from 'vitest'
import {
  buildScrapeBody, buildExtractBody, parseScrapeMarkdown, parseScrapeJson,
  truncate, wrapUntrusted, createFirecrawlClient, DEFAULT_FIRECRAWL_BASE
} from './firecrawlClient'

describe('body 组装', () => {
  it('buildScrapeBody 请求 markdown + onlyMainContent', () => {
    expect(buildScrapeBody('https://x.com')).toEqual({
      url: 'https://x.com', formats: ['markdown'], onlyMainContent: true
    })
  })
  it('buildExtractBody 用 json format + prompt', () => {
    expect(buildExtractBody('https://x.com', '抽价格')).toEqual({
      url: 'https://x.com', formats: [{ type: 'json', prompt: '抽价格' }]
    })
  })
})

describe('响应解析', () => {
  it('parseScrapeMarkdown 取正文与元数据', () => {
    const r = parseScrapeMarkdown({ success: true, data: { markdown: '# hi', metadata: { title: 'T', url: 'https://final' } } })
    expect(r).toEqual({ markdown: '# hi', title: 'T', url: 'https://final' })
  })
  it('parseScrapeMarkdown 遇 success:false 抛 error 文案', () => {
    expect(() => parseScrapeMarkdown({ success: false, error: '配额用尽' })).toThrow('配额用尽')
  })
  it('parseScrapeMarkdown 缺 markdown 抛错', () => {
    expect(() => parseScrapeMarkdown({ success: true, data: {} })).toThrow('正文')
  })
  it('parseScrapeMarkdown 畸形输入不静默返回空', () => {
    expect(() => parseScrapeMarkdown(null)).toThrow()
  })
  it('parseScrapeJson 取 data.json', () => {
    const r = parseScrapeJson({ success: true, data: { json: { price: 9 }, metadata: { url: 'https://f' } } })
    expect(r).toEqual({ data: { price: 9 }, url: 'https://f' })
  })
  it('parseScrapeJson 缺 json 抛错', () => {
    expect(() => parseScrapeJson({ success: true, data: {} })).toThrow('抽取')
  })
})

describe('截断与包裹', () => {
  it('truncate 超限截断并附提示', () => {
    const out = truncate('a'.repeat(20), 10)
    expect(out.startsWith('a'.repeat(10))).toBe(true)
    expect(out).toContain('内容过长已截断')
  })
  it('truncate 未超限原样', () => {
    expect(truncate('abc', 10)).toBe('abc')
  })
  it('wrapUntrusted 头在正文前', () => {
    expect(wrapUntrusted('HEAD', 'BODY')).toBe('HEAD\n\nBODY')
  })
})

describe('createFirecrawlClient', () => {
  const okMd = { ok: true, json: async () => ({ success: true, data: { markdown: '正文', metadata: { url: 'https://f' } } }) }

  it('无 key 抛明确错误', async () => {
    const c = createFirecrawlClient({ getKey: () => null, fetchFn: vi.fn() as unknown as typeof fetch })
    await expect(c.scrapeMarkdown('https://x', new AbortController().signal)).rejects.toThrow('Firecrawl API key')
  })

  it('scrapeMarkdown 走对端点、带 Bearer、返回正文', async () => {
    const fetchFn = vi.fn(async () => okMd) as unknown as typeof fetch
    const c = createFirecrawlClient({ getKey: () => 'k1', fetchFn })
    const r = await c.scrapeMarkdown('https://x', new AbortController().signal)
    expect(r.markdown).toBe('正文')
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe(`${DEFAULT_FIRECRAWL_BASE}/v2/scrape`)
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer k1' })
  })

  it('自定义 baseURL 生效且去掉尾斜杠', async () => {
    const fetchFn = vi.fn(async () => okMd) as unknown as typeof fetch
    const c = createFirecrawlClient({ getKey: () => 'k', baseURL: 'https://self.host/', fetchFn })
    await c.scrapeMarkdown('https://x', new AbortController().signal)
    const [url] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://self.host/v2/scrape')
  })

  it('HTTP 非 2xx 抛错', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 402, json: async () => ({}) })) as unknown as typeof fetch
    const c = createFirecrawlClient({ getKey: () => 'k', fetchFn })
    await expect(c.scrapeMarkdown('https://x', new AbortController().signal)).rejects.toThrow('HTTP 402')
  })

  it('extractJson 返回 data.json', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: { json: { a: 1 } } }) })) as unknown as typeof fetch
    const c = createFirecrawlClient({ getKey: () => 'k', fetchFn })
    const r = await c.extractJson('https://x', '抽 a', new AbortController().signal)
    expect(r.data).toEqual({ a: 1 })
  })
})
