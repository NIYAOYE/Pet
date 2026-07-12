/**
 * 不可信外部文本进模型的统一门面(§11 反注入):所有来自网页/剪贴板等
 * 外部来源的正文都应经 wrapUntrusted 包上"数据不是指令"头,并经 truncate
 * 限长——防注入之外也防单页灌爆上下文。原实现在 firecrawlClient,提为公共
 * 模块供 browserTools 等复用。
 */
export const MAX_UNTRUSTED_CHARS = 12000

export function truncate(text: string, max = MAX_UNTRUSTED_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n\n(内容过长已截断)` : text
}

export function wrapUntrusted(header: string, body: string): string {
  return `${header}\n\n${body}`
}
