import type { LlmProvider } from '../providers/llmProvider'

export interface Translator {
  translate(text: string, target: 'zh' | 'ja' | 'en', signal: AbortSignal): Promise<string>
}

const LANG_NAME: Record<'zh' | 'ja' | 'en', string> = { zh: '中文', ja: '日语', en: '英语' }

export function createLlmTranslator(provider: LlmProvider): Translator {
  return {
    async translate(text, target, signal) {
      const system = `你是翻译引擎。把用户给的文本整体翻译成${LANG_NAME[target]},只输出翻译结果本身,不要解释、不要加引号、不要保留原文。`
      let acc = ''
      for await (const chunk of provider.streamChat({ system, messages: [{ role: 'user', content: text }], maxOutputTokens: 1024, signal })) {
        if (chunk.type === 'text') acc += chunk.text
        else if (chunk.type === 'error') throw new Error(chunk.message)
      }
      return acc.trim()
    }
  }
}
