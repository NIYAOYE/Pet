import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { evaluateTextureBudget, readTextureInfos, TEXTURE_SOFT_WARN_PX, TEXTURE_HARD_LIMIT_PX, TEXTURE_HARD_LIMIT_COUNT } from './live2dTextureBudget'

function fakePngBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

describe('evaluateTextureBudget', () => {
  it('no warnings for small textures', () => {
    const r = evaluateTextureBudget([{ fileName: 'a.png', dims: { width: 2048, height: 2048 } }])
    expect(r).toEqual({ softWarnings: [], hardViolation: null })
  })
  it('soft warning between 4096 and 8192', () => {
    const r = evaluateTextureBudget([{ fileName: 'a.png', dims: { width: 4097, height: 100 } }])
    expect(r.hardViolation).toBeNull()
    expect(r.softWarnings).toHaveLength(1)
    expect(r.softWarnings[0]).toContain('a.png')
  })
  it('hard violation above 8192', () => {
    const r = evaluateTextureBudget([{ fileName: 'a.png', dims: { width: 8193, height: 100 } }])
    expect(r.hardViolation).toContain('a.png')
  })
  it('hard violation when texture count exceeds 16', () => {
    const textures = Array.from({ length: TEXTURE_HARD_LIMIT_COUNT + 1 }, (_, i) => ({ fileName: `t${i}.png`, dims: { width: 100, height: 100 } }))
    const r = evaluateTextureBudget(textures)
    expect(r.hardViolation).toContain(String(TEXTURE_HARD_LIMIT_COUNT))
  })
  it('ignores textures whose dims could not be read (handled elsewhere)', () => {
    const r = evaluateTextureBudget([{ fileName: 'broken.png', dims: null }])
    expect(r).toEqual({ softWarnings: [], hardViolation: null })
  })
  it('exposes the threshold constants used above', () => {
    expect(TEXTURE_SOFT_WARN_PX).toBe(4096)
    expect(TEXTURE_HARD_LIMIT_PX).toBe(8192)
  })
})

describe('readTextureInfos', () => {
  it('reads dimensions for each named file relative to modelDir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'texbudget-'))
    writeFileSync(join(dir, 'tex_00.png'), fakePngBytes(1024, 512))
    const out = readTextureInfos(dir, ['tex_00.png'])
    expect(out).toEqual([{ fileName: 'tex_00.png', dims: { width: 1024, height: 512 } }])
  })
  it('returns dims:null for a file that is not a valid PNG (e.g. missing)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'texbudget-'))
    const out = readTextureInfos(dir, ['missing.png'])
    expect(out).toEqual([{ fileName: 'missing.png', dims: null }])
  })
})
