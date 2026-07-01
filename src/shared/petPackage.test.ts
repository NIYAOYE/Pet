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
