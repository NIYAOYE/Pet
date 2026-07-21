import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// `require('electron')` under plain vitest (not the real Electron binary) resolves to a
// path string, not the API surface — `nativeImage` would be `undefined` in every test file.
// Mock just enough of it here so this test verifies petAvatar.ts's own branching/caching
// logic (which live2d/sprite path it takes, what it does with the result), not Electron's
// real PNG decoding — consistent with this codebase's convention that Electron-native-API
// behavior itself is verified by running the app, not vitest (see CLAUDE.md).
vi.mock('electron', () => ({
  nativeImage: {
    createFromPath: (_path: string) => ({
      isEmpty: () => false,
      resize: (_opts: unknown) => ({ toDataURL: () => 'data:image/png;base64,ZmFrZQ==' }),
      crop: (_rect: unknown) => ({
        resize: (_opts: unknown) => ({ toDataURL: () => 'data:image/png;base64,ZmFrZQ==' })
      })
    })
  }
}))

import { createPetAvatarCache } from './petAvatar'

function scratch(): string { return mkdtempSync(join(tmpdir(), 'petavatar-')) }

function fakePngBytes(): Buffer {
  const buf = Buffer.alloc(24)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(4, 16)
  buf.writeUInt32BE(4, 20)
  return buf
}

describe('createPetAvatarCache — live2d thumbnail branch', () => {
  it('返回 "" 且不抛,当 live2d 包没有 thumbnail 字段', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'model'), { recursive: true })
    const manifest = {
      schemaVersion: 2, id: 'x', displayName: 'X', description: 'd',
      render: { type: 'live2d', model: 'model/x.model3.json', viewport: { width: 1, height: 1, resolutionCap: 1 },
        transform: { scale: 1, offsetX: 0, offsetY: 0, anchorX: 0, anchorY: 0, bubbleAnchorX: 0, bubbleAnchorY: 0 },
        interaction: { mirrorOnWalk: false, mouseTracking: false, lipSyncParameter: 'p' }, stateMap: {} }
    }
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
    const cache = createPetAvatarCache()
    expect(cache.avatarOf(dir, 'x')).toBe('')
  })

  it('从 thumbnail 字段读到有效 PNG 时返回非空 data URL', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'model'), { recursive: true })
    writeFileSync(join(dir, 'thumbnail.png'), fakePngBytes())
    const manifest = {
      schemaVersion: 2, id: 'y', displayName: 'Y', description: 'd', thumbnail: 'thumbnail.png',
      render: { type: 'live2d', model: 'model/y.model3.json', viewport: { width: 1, height: 1, resolutionCap: 1 },
        transform: { scale: 1, offsetX: 0, offsetY: 0, anchorX: 0, anchorY: 0, bubbleAnchorX: 0, bubbleAnchorY: 0 },
        interaction: { mirrorOnWalk: false, mouseTracking: false, lipSyncParameter: 'p' }, stateMap: {} }
    }
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
    const cache = createPetAvatarCache()
    expect(cache.avatarOf(dir, 'y')).toMatch(/^data:image\/png;base64,/)
  })
})
