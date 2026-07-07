export const DEFAULT_FIRECRAWL_BASE = 'https://api.firecrawl.dev'
const SCRAPE_PATH = '/v2/scrape'
export const MAX_CONTENT_CHARS = 12000

export function buildScrapeBody(url: string): Record<string, unknown> {
  return { url, formats: ['markdown'], onlyMainContent: true }
}

export function buildExtractBody(url: string, prompt: string): Record<string, unknown> {
  return { url, formats: [{ type: 'json', prompt }] }
}

export interface ScrapeMarkdown { markdown: string; title?: string; url?: string }
export interface ScrapeJson { data: unknown; url?: string }

function asData(json: unknown): { success?: boolean; error?: string; data: Record<string, unknown> } {
  const o = (json ?? {}) as { success?: boolean; error?: string; data?: unknown }
  const data = (o.data ?? {}) as Record<string, unknown>
  return { success: o.success, error: o.error, data }
}

export function parseScrapeMarkdown(json: unknown): ScrapeMarkdown {
  const { success, error, data } = asData(json)
  if (success === false) throw new Error(error ?? 'Firecrawl 抓取失败')
  const markdown = data.markdown
  if (typeof markdown !== 'string' || markdown.length === 0) throw new Error('Firecrawl 未返回网页正文(markdown)')
  const meta = (data.metadata ?? {}) as Record<string, unknown>
  return {
    markdown,
    title: typeof meta.title === 'string' ? meta.title : undefined,
    url: typeof meta.url === 'string' ? meta.url : undefined
  }
}

export function parseScrapeJson(json: unknown): ScrapeJson {
  const { success, error, data } = asData(json)
  if (success === false) throw new Error(error ?? 'Firecrawl 抽取失败')
  if (data.json == null) throw new Error('Firecrawl 未返回抽取结果(json)')
  const meta = (data.metadata ?? {}) as Record<string, unknown>
  return { data: data.json, url: typeof meta.url === 'string' ? meta.url : undefined }
}

export function truncate(text: string, max = MAX_CONTENT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n\n(内容过长已截断)` : text
}

export function wrapUntrusted(header: string, body: string): string {
  return `${header}\n\n${body}`
}

export interface FirecrawlClient {
  scrapeMarkdown(url: string, signal: AbortSignal): Promise<ScrapeMarkdown>
  extractJson(url: string, prompt: string, signal: AbortSignal): Promise<ScrapeJson>
}

/** key 由外部注入(来自 firecrawl secret store),本模块不落盘不打日志(同 tavily.ts) */
export function createFirecrawlClient(opts: {
  getKey: () => string | null
  baseURL?: string
  fetchFn?: typeof fetch
}): FirecrawlClient {
  const fetchFn = opts.fetchFn ?? fetch
  const base = ((opts.baseURL && opts.baseURL.trim()) || DEFAULT_FIRECRAWL_BASE).replace(/\/+$/, '')
  async function post(body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const key = opts.getKey()
    if (!key) throw new Error('未配置 Firecrawl API key:请在设置的「工具能力」里填写并启用')
    const res = await fetchFn(`${base}${SCRAPE_PATH}`, {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) throw new Error(`Firecrawl 请求失败(HTTP ${res.status}),请检查 key 是否有效或稍后重试`)
    return res.json()
  }
  return {
    async scrapeMarkdown(url, signal) { return parseScrapeMarkdown(await post(buildScrapeBody(url), signal)) },
    async extractJson(url, prompt, signal) { return parseScrapeJson(await post(buildExtractBody(url, prompt), signal)) }
  }
}
