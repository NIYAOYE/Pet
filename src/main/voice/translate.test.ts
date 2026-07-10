import { describe, it, expect } from 'vitest'
import { createLlmTranslator } from './translate'
import { createFakeProvider } from '../providers/fakeProvider'

describe('createLlmTranslator', () => {
  it('把 provider 的流式文本拼成完整译文', async () => {
    const translator = createLlmTranslator(createFakeProvider({ reply: 'こんにちは' }))
    const out = await translator.translate('你好', 'ja', new AbortController().signal)
    expect(out).toBe('こんにちは')
  })

  it('provider 报错 → 向上抛出', async () => {
    const translator = createLlmTranslator(createFakeProvider({ failWith: '模型不可用' }))
    await expect(translator.translate('你好', 'en', new AbortController().signal)).rejects.toThrow('模型不可用')
  })

  it('已取消的 signal → fakeProvider 立即结束,返回空字符串', async () => {
    const translator = createLlmTranslator(createFakeProvider({ reply: 'hello', delayMs: 50 }))
    const ctrl = new AbortController()
    ctrl.abort()
    const out = await translator.translate('你好', 'en', ctrl.signal)
    expect(out).toBe('')
  })
})
