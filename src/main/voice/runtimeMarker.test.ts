import { describe, it, expect } from 'vitest'
import { parseRuntimeMarker, isRuntimeUsable, serializeRuntimeMarker, VOICE_RUNTIME_MARKER_VERSION } from './runtimeMarker'

describe('runtimeMarker', () => {
  it('序列化后能原样解析回来', () => {
    const m = { markerVersion: VOICE_RUNTIME_MARKER_VERSION, gsvTtsLiteVersion: '0.4.6', device: 'cuda' as const }
    expect(parseRuntimeMarker(serializeRuntimeMarker(m))).toEqual(m)
  })

  it('非法 JSON → 返回 null', () => {
    expect(parseRuntimeMarker('not json')).toBeNull()
  })

  it('缺字段 → 返回 null', () => {
    expect(parseRuntimeMarker(JSON.stringify({ markerVersion: 1 }))).toBeNull()
  })

  it('device 不是 cuda/cpu → 返回 null', () => {
    expect(parseRuntimeMarker(JSON.stringify({ markerVersion: 1, gsvTtsLiteVersion: '0.4.6', device: 'quantum' }))).toBeNull()
  })

  it('isRuntimeUsable:null → false', () => {
    expect(isRuntimeUsable(null)).toBe(false)
  })

  it('isRuntimeUsable:markerVersion 与当前版本不符 → false(需要重新安装)', () => {
    expect(isRuntimeUsable({ markerVersion: VOICE_RUNTIME_MARKER_VERSION + 1, gsvTtsLiteVersion: '0.4.6', device: 'cpu' })).toBe(false)
  })

  it('isRuntimeUsable:版本匹配 → true', () => {
    expect(isRuntimeUsable({ markerVersion: VOICE_RUNTIME_MARKER_VERSION, gsvTtsLiteVersion: '0.4.6', device: 'cpu' })).toBe(true)
  })
})
