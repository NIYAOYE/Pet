export interface PetSheet { rows: number; cols: number; cellWidth: number; cellHeight: number }
export interface PetAnimation { row: number; frames: number; fps: number; loop: boolean; durations?: number[] }
export interface PetManifest {
  id: string; displayName: string; description: string; spritesheetPath: string
  sheet: PetSheet; animations: Record<string, PetAnimation>
}
export interface FrameRect { x: number; y: number; w: number; h: number }

export function frameRect(sheet: PetSheet, row: number, col: number): FrameRect {
  return { x: col * sheet.cellWidth, y: row * sheet.cellHeight, w: sheet.cellWidth, h: sheet.cellHeight }
}

export function frameDurationMs(anim: PetAnimation, index: number): number {
  if (anim.durations && anim.durations[index] != null) return anim.durations[index]
  return Math.round(1000 / anim.fps)
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

export function parsePetManifest(raw: unknown): PetManifest {
  const m = raw as Record<string, any>
  assert(m && typeof m === 'object', 'manifest must be an object')
  for (const k of ['id', 'displayName', 'description', 'spritesheetPath']) {
    assert(typeof m[k] === 'string' && m[k].length > 0, `manifest.${k} must be a non-empty string`)
  }
  const s = m.sheet
  assert(s && typeof s === 'object', 'manifest.sheet is required')
  for (const k of ['rows', 'cols', 'cellWidth', 'cellHeight']) {
    assert(typeof s[k] === 'number' && s[k] > 0, `manifest.sheet.${k} must be a positive number`)
  }
  assert(m.animations && typeof m.animations === 'object', 'manifest.animations is required')
  const animKeys = Object.keys(m.animations)
  assert(animKeys.length > 0, 'manifest.animations must not be empty')
  for (const key of animKeys) {
    const a = m.animations[key]
    for (const k of ['row', 'frames', 'fps']) {
      assert(typeof a[k] === 'number', `animation ${key}.${k} must be a number`)
    }
    assert(typeof a.loop === 'boolean', `animation ${key}.loop must be a boolean`)
  }
  return m as PetManifest
}
