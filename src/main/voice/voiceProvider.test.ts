import { describe, it, expect, vi } from 'vitest'
import { createVoiceProvider } from './voiceProvider'
import { DEFAULT_TTS_SETTINGS } from '@shared/llm'
import type { VoiceSidecar, PcmChunk } from './voiceSidecar'
import type { Translator } from './translate'

function fakeSidecar(impl?: Partial<VoiceSidecar>): VoiceSidecar {
  return {
    start: vi.fn(async () => {}),
    speak: vi.fn(async (_req, onChunk) => { onChunk({ audioBase64: 'QUJD', sampleRate: 32000 }) }),
    stop: vi.fn(),
    ...impl
  }
}

describe('createVoiceProvider', () => {
  it('targetLanguage=auto → 不翻译,直接把原文送去合成', async () => {
    const translate = vi.fn()
    const sidecar = fakeSidecar()
    const chunks: PcmChunk[] = []
    const vp = createVoiceProvider({
      sidecar, translator: { translate },
      getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'auto' }),
      onChunk: (c) => chunks.push(c), onError: () => {}
    })
    await vp.speak('你好')
    expect(translate).not.toHaveBeenCalled()
    expect(sidecar.speak).toHaveBeenCalledWith(expect.objectContaining({ text: '你好' }), expect.any(Function), expect.any(Object))
    expect(chunks).toEqual([{ audioBase64: 'QUJD', sampleRate: 32000 }])
  })

  it('targetLanguage=ja 且文本不含假名 → 先翻译再合成翻译后的文本', async () => {
    const translate = vi.fn(async () => 'こんにちは')
    const sidecar = fakeSidecar()
    const vp = createVoiceProvider({
      sidecar, translator: { translate },
      getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'ja' }),
      onChunk: () => {}, onError: () => {}
    })
    await vp.speak('你好')
    expect(translate).toHaveBeenCalledWith('你好', 'ja', expect.any(Object))
    expect(sidecar.speak).toHaveBeenCalledWith(expect.objectContaining({ text: 'こんにちは' }), expect.any(Function), expect.any(Object))
  })

  it('targetLanguage=ja 且文本已含假名 → 跳过翻译', async () => {
    const translate = vi.fn()
    const sidecar = fakeSidecar()
    const vp = createVoiceProvider({
      sidecar, translator: { translate },
      getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'ja' }),
      onChunk: () => {}, onError: () => {}
    })
    await vp.speak('こんにちは')
    expect(translate).not.toHaveBeenCalled()
  })

  it('翻译失败 → onError 收到消息,不调用 sidecar.speak', async () => {
    const translate = vi.fn(async () => { throw new Error('翻译服务不可用') })
    const sidecar = fakeSidecar()
    const errors: string[] = []
    const vp = createVoiceProvider({
      sidecar, translator: { translate },
      getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'ja' }),
      onChunk: () => {}, onError: (m) => errors.push(m)
    })
    await vp.speak('你好')
    expect(sidecar.speak).not.toHaveBeenCalled()
    expect(errors[0]).toContain('翻译服务不可用')
  })

  it('sidecar.speak 失败 → onError 收到消息', async () => {
    const sidecar = fakeSidecar({ speak: vi.fn(async () => { throw new Error('合成失败') }) })
    const errors: string[] = []
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onChunk: () => {}, onError: (m) => errors.push(m)
    })
    await vp.speak('你好')
    expect(errors[0]).toContain('合成失败')
  })

  it('空文本/纯空白 → 直接跳过,不调用 sidecar', async () => {
    const sidecar = fakeSidecar()
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onChunk: () => {}, onError: () => {}
    })
    await vp.speak('   ')
    expect(sidecar.speak).not.toHaveBeenCalled()
  })

  it('stop() 让正在进行的 speak() 的 signal 被 abort', async () => {
    let capturedSignal: AbortSignal | null = null
    const sidecar = fakeSidecar({
      speak: vi.fn(async (_req, _onChunk, signal: AbortSignal) => { capturedSignal = signal })
    })
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onChunk: () => {}, onError: () => {}
    })
    const p = vp.speak('你好')
    vp.stop()
    await p
    expect((capturedSignal as AbortSignal | null)?.aborted).toBe(true)
  })

  it('stream 模式下两句重叠合成时,stop() 必须 abort 全部在途请求(而非仅最后一个)', async () => {
    // 模拟 chat.ts 在 stream 模式下不等待前一句 speak() 完成就触发下一句:
    // 句子 A 的 sidecar.speak 尚未 resolve 时,句子 B 的 speak() 就已开始 —— 两者在
    // stop() 被调用的那一刻都必须仍处于「在途」状态(测试期间都不 resolve),
    // 才能真正复现「仅最后一个被 abort」的 bug。
    const capturedSignals: AbortSignal[] = []
    let releaseA: () => void = () => {}
    let releaseB: () => void = () => {}
    const pendingA = new Promise<void>((resolve) => { releaseA = resolve })
    const pendingB = new Promise<void>((resolve) => { releaseB = resolve })

    const sidecar = fakeSidecar({
      speak: vi.fn(async (req: { text: string }, _onChunk, signal: AbortSignal) => {
        capturedSignals.push(signal)
        await (req.text === 'A' ? pendingA : pendingB) // 挂起,直到测试显式放行
      })
    })
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onChunk: () => {}, onError: () => {}
    })

    // 两次 speak() 均不 await,且中间没有任何 await —— 与 chat.ts 的
    // fire-and-forget 调用方式一致,保证 stop() 执行时 A、B 都仍在 inFlight 集合中。
    const pA = vp.speak('A')
    const pB = vp.speak('B')

    vp.stop() // 此时应同时 abort A 和 B 的 controller

    releaseA()
    releaseB()
    await pA
    await pB

    expect(capturedSignals).toHaveLength(2)
    expect(capturedSignals.every((s) => s.aborted)).toBe(true)
  })
})
