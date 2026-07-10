import { describe, it, expect } from 'vitest'
import { createSseParser } from './sseParser'

describe('createSseParser', () => {
  it('单个完整帧', () => {
    const p = createSseParser()
    const frames = p.push('event: audio\ndata: {"a":1}\n\n')
    expect(frames).toEqual([{ event: 'audio', data: '{"a":1}' }])
  })

  it('一次 push 含多个帧', () => {
    const p = createSseParser()
    const frames = p.push('event: audio\ndata: {"a":1}\n\nevent: done\ndata: {}\n\n')
    expect(frames).toEqual([{ event: 'audio', data: '{"a":1}' }, { event: 'done', data: '{}' }])
  })

  it('帧跨多次 push(网络分片)→ 缓冲到完整帧再吐出', () => {
    const p = createSseParser()
    expect(p.push('event: audio\nda')).toEqual([])
    expect(p.push('ta: {"a":1}\n\n')).toEqual([{ event: 'audio', data: '{"a":1}' }])
  })

  it('data 跨多行 → 按 \\n 拼接', () => {
    const p = createSseParser()
    const frames = p.push('event: audio\ndata: line1\ndata: line2\n\n')
    expect(frames).toEqual([{ event: 'audio', data: 'line1\nline2' }])
  })

  it('缺失 event 行 → 默认 event 为 message', () => {
    const p = createSseParser()
    const frames = p.push('data: hi\n\n')
    expect(frames).toEqual([{ event: 'message', data: 'hi' }])
  })

  it('没有 data 行的帧 → 不产出(避免空帧误判为音频结束)', () => {
    const p = createSseParser()
    const frames = p.push('event: ping\n\n')
    expect(frames).toEqual([])
  })
})
