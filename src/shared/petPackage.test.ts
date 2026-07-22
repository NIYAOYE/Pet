import { describe, it, expect } from 'vitest'
import { frameRect, frameDurationMs, parsePetManifest } from './petPackage'

const sheet = { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 }

describe('frameRect', () => {
  it('computes pixel rect from row/col', () => {
    expect(frameRect(sheet, 0, 0)).toEqual({ x: 0, y: 0, w: 192, h: 208 })
    expect(frameRect(sheet, 2, 3)).toEqual({ x: 576, y: 416, w: 192, h: 208 })
  })
})

describe('frameDurationMs', () => {
  it('uses durations when present', () => {
    const anim = { row: 0, frames: 2, fps: 5, loop: true, durations: [280, 120] }
    expect(frameDurationMs(anim, 1)).toBe(120)
  })
  it('falls back to 1000/fps without durations', () => {
    const anim = { row: 1, frames: 8, fps: 8, loop: true }
    expect(frameDurationMs(anim, 0)).toBe(125)
  })
})

describe('parsePetManifest', () => {
  const valid = {
    id: 'luluka', displayName: '露露卡', description: 'x', spritesheetPath: 'spritesheet.webp',
    sheet, animations: { idle: { row: 0, frames: 6, fps: 5, loop: true } }
  }
  it('accepts a valid manifest', () => {
    expect(parsePetManifest(valid).id).toBe('luluka')
  })
  it('rejects missing animations', () => {
    const bad = { ...valid, animations: {} }
    expect(() => parsePetManifest(bad)).toThrow(/animations/)
  })
  it('rejects missing sheet fields', () => {
    const bad = { ...valid, sheet: { rows: 13, cols: 8 } }
    expect(() => parsePetManifest(bad)).toThrow(/sheet/)
  })
})

describe('parsePetManifest voice 字段(可选)', () => {
  const base = {
    id: 'alice', displayName: 'Alice', description: 'd', spritesheetPath: 'spritesheet.webp',
    sheet: { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 },
    animations: { idle: { row: 0, frames: 1, fps: 1, loop: true } }
  }

  it('缺失 voice 字段 → 解析成功,voice 为 undefined', () => {
    const m = parsePetManifest(base)
    expect(m.voice).toBeUndefined()
  })

  it('完整 voice 字段 → 原样保留', () => {
    const m = parsePetManifest({
      ...base,
      voice: { gptModel: 'voice/a.ckpt', sovitsModel: 'voice/a.pth', refAudio: 'voice/a.wav', refText: 'voice/a.txt' }
    })
    expect(m.voice).toEqual({ gptModel: 'voice/a.ckpt', sovitsModel: 'voice/a.pth', refAudio: 'voice/a.wav', refText: 'voice/a.txt' })
  })

  it('voice 字段存在但缺子字段 → 抛错', () => {
    expect(() => parsePetManifest({ ...base, voice: { gptModel: 'x' } })).toThrow()
  })

  it('voice 子字段为空字符串 → 抛错', () => {
    expect(() => parsePetManifest({
      ...base,
      voice: { gptModel: '', sovitsModel: 'voice/a.pth', refAudio: 'voice/a.wav', refText: 'voice/a.txt' }
    })).toThrow()
  })

  it('只提供 onnxModel(Genie-TTS 后端)→ 解析成功,原样保留', () => {
    const m = parsePetManifest({
      ...base,
      voice: { onnxModel: 'voice/alice-onnx', refAudio: 'voice/a.wav', refText: 'voice/a.txt', language: 'ja' }
    })
    expect(m.voice).toEqual({ onnxModel: 'voice/alice-onnx', refAudio: 'voice/a.wav', refText: 'voice/a.txt', language: 'ja' })
  })

  it('gptModel/sovitsModel 与 onnxModel 都提供 → 都保留', () => {
    const m = parsePetManifest({
      ...base,
      voice: {
        gptModel: 'voice/a.ckpt', sovitsModel: 'voice/a.pth', onnxModel: 'voice/a-onnx',
        refAudio: 'voice/a.wav', refText: 'voice/a.txt', language: 'ja'
      }
    })
    expect(m.voice?.onnxModel).toBe('voice/a-onnx')
    expect(m.voice?.gptModel).toBe('voice/a.ckpt')
  })

  it('既没有 onnxModel 也没有 gptModel/sovitsModel → 抛错', () => {
    expect(() => parsePetManifest({
      ...base,
      voice: { refAudio: 'voice/a.wav', refText: 'voice/a.txt' }
    })).toThrow(/onnxModel|gptModel/)
  })

  it('只给 gptModel 不给 sovitsModel(反之亦然)→ 抛错', () => {
    expect(() => parsePetManifest({
      ...base,
      voice: { gptModel: 'voice/a.ckpt', refAudio: 'voice/a.wav', refText: 'voice/a.txt' }
    })).toThrow()
    expect(() => parsePetManifest({
      ...base,
      voice: { sovitsModel: 'voice/a.pth', refAudio: 'voice/a.wav', refText: 'voice/a.txt' }
    })).toThrow()
  })

  it('onnxModel 存在但 language 缺失/非法 → 抛错', () => {
    expect(() => parsePetManifest({
      ...base,
      voice: { onnxModel: 'voice/a-onnx', refAudio: 'voice/a.wav', refText: 'voice/a.txt' }
    })).toThrow(/language/)
    expect(() => parsePetManifest({
      ...base,
      voice: { onnxModel: 'voice/a-onnx', refAudio: 'voice/a.wav', refText: 'voice/a.txt', language: 'fr' }
    })).toThrow(/language/)
  })
})

import { parseLive2DManifest, isLive2DManifestRaw } from './petPackage'

const validLive2D = {
  schemaVersion: 2,
  id: 'chitose', displayName: '千岁', description: 'x',
  render: {
    type: 'live2d',
    model: 'model/character.model3.json',
    viewport: { width: 360, height: 480, resolutionCap: 1.5 },
    transform: { scale: 1, offsetX: 0, offsetY: 0, anchorX: 0.5, anchorY: 1, bubbleAnchorX: 0.5, bubbleAnchorY: 0 },
    interaction: { mirrorOnWalk: true, mouseTracking: true, lipSyncParameter: 'ParamMouthOpenY' },
    stateMap: {
      idle: { motionGroup: 'Idle', selection: 'random', loop: true },
      greet: { motionGroup: 'TapBody', selection: 'random', loop: false, fallback: 'idle', description: '被点击时的问候动作' }
    }
  }
}

describe('isLive2DManifestRaw', () => {
  it('true when render.type is live2d', () => {
    expect(isLive2DManifestRaw(validLive2D)).toBe(true)
  })
  it('false for legacy sprite manifest (no render field)', () => {
    const valid = {
      id: 'luluka', displayName: '露露卡', description: 'x', spritesheetPath: 'spritesheet.webp',
      sheet: { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 }, animations: { idle: { row: 0, frames: 6, fps: 5, loop: true } }
    }
    expect(isLive2DManifestRaw(valid)).toBe(false)
  })
  it('false for non-objects', () => {
    expect(isLive2DManifestRaw(null)).toBe(false)
    expect(isLive2DManifestRaw('x')).toBe(false)
  })
})

describe('parseLive2DManifest', () => {
  it('accepts a valid manifest', () => {
    const m = parseLive2DManifest(validLive2D)
    expect(m.render.model).toBe('model/character.model3.json')
    expect(m.render.stateMap.greet.description).toBe('被点击时的问候动作')
  })
  it('accepts an empty stateMap (author need not fill every state)', () => {
    const m = parseLive2DManifest({ ...validLive2D, render: { ...validLive2D.render, stateMap: {} } })
    expect(m.render.stateMap).toEqual({})
  })
  it('rejects schemaVersion other than 2', () => {
    expect(() => parseLive2DManifest({ ...validLive2D, schemaVersion: 1 })).toThrow(/schemaVersion/)
  })
  it('rejects render.type other than live2d', () => {
    const bad = { ...validLive2D, render: { ...validLive2D.render, type: 'sprite' } }
    expect(() => parseLive2DManifest(bad)).toThrow(/render\.type/)
  })
  it('rejects missing render.model', () => {
    const { model, ...rest } = validLive2D.render
    expect(() => parseLive2DManifest({ ...validLive2D, render: rest })).toThrow(/model/)
  })
  it('rejects non-numeric viewport fields', () => {
    const bad = { ...validLive2D, render: { ...validLive2D.render, viewport: { width: '360', height: 480, resolutionCap: 1.5 } } }
    expect(() => parseLive2DManifest(bad)).toThrow(/viewport/)
  })
  it('rejects non-boolean interaction fields', () => {
    const bad = { ...validLive2D, render: { ...validLive2D.render, interaction: { mirrorOnWalk: 'yes', mouseTracking: true, lipSyncParameter: 'x' } } }
    expect(() => parseLive2DManifest(bad)).toThrow(/interaction/)
  })
  it('rejects a stateMap entry with wrong field type', () => {
    const bad = { ...validLive2D, render: { ...validLive2D.render, stateMap: { idle: { loop: 'yes' } } } }
    expect(() => parseLive2DManifest(bad)).toThrow(/stateMap\.idle\.loop/)
  })
  it('accepts optional thumbnail string', () => {
    const m = parseLive2DManifest({ ...validLive2D, thumbnail: 'thumbnail.png' })
    expect(m.thumbnail).toBe('thumbnail.png')
  })
  it('accepts optional transform.autoFitted boolean', () => {
    const m = parseLive2DManifest({
      ...validLive2D,
      render: { ...validLive2D.render, transform: { ...validLive2D.render.transform, autoFitted: true } }
    })
    expect(m.render.transform.autoFitted).toBe(true)
  })
  it('rejects non-boolean transform.autoFitted', () => {
    const bad = {
      ...validLive2D,
      render: { ...validLive2D.render, transform: { ...validLive2D.render.transform, autoFitted: 'yes' } }
    }
    expect(() => parseLive2DManifest(bad)).toThrow(/autoFitted/)
  })
  it('accepts optional render.possibleWatermark boolean', () => {
    const m = parseLive2DManifest({ ...validLive2D, render: { ...validLive2D.render, possibleWatermark: true } })
    expect(m.render.possibleWatermark).toBe(true)
  })
  it('rejects non-boolean render.possibleWatermark', () => {
    const bad = { ...validLive2D, render: { ...validLive2D.render, possibleWatermark: 'yes' } }
    expect(() => parseLive2DManifest(bad)).toThrow(/possibleWatermark/)
  })
  it('both fields absent from a legacy manifest still parse fine', () => {
    const m = parseLive2DManifest(validLive2D)
    expect(m.render.transform.autoFitted).toBeUndefined()
    expect(m.render.possibleWatermark).toBeUndefined()
  })
})
