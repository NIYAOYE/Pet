import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanAndPatchOrphanResources, detectPossibleWatermarkProtection, listModelFilesRecursive, type Model3Json } from './live2dOrphanResources'

const bareModel3Json: Model3Json = {
  FileReferences: { Moc: 'character.moc3', Textures: ['textures/tex_00.png'] }
}

describe('scanAndPatchOrphanResources', () => {
  it('finds unreferenced .exp3.json/.motion3.json files and patches them in', () => {
    const files = ['character.moc3', 'textures/tex_00.png', 'expressions/happy.exp3.json', 'motions/Scene1.motion3.json']
    const { patchedModel3Json, recoveredExpressionCount, recoveredMotionCount } = scanAndPatchOrphanResources(bareModel3Json, files)
    expect(recoveredExpressionCount).toBe(1)
    expect(recoveredMotionCount).toBe(1)
    expect(patchedModel3Json.FileReferences.Expressions).toEqual([{ Name: 'happy', File: 'expressions/happy.exp3.json' }])
    expect(patchedModel3Json.FileReferences.Motions?.Recovered).toEqual([{ File: 'motions/Scene1.motion3.json' }])
  })
  it('does not duplicate already-declared expressions/motions', () => {
    const declared: Model3Json = {
      FileReferences: {
        ...bareModel3Json.FileReferences,
        Expressions: [{ Name: 'happy', File: 'expressions/happy.exp3.json' }],
        Motions: { Idle: [{ File: 'motions/idle.motion3.json' }] }
      }
    }
    const files = ['expressions/happy.exp3.json', 'motions/idle.motion3.json']
    const { recoveredExpressionCount, recoveredMotionCount } = scanAndPatchOrphanResources(declared, files)
    expect(recoveredExpressionCount).toBe(0)
    expect(recoveredMotionCount).toBe(0)
  })
  it('leaves model3Json untouched when nothing is orphaned', () => {
    const files = ['character.moc3', 'textures/tex_00.png']
    const { recoveredExpressionCount, recoveredMotionCount } = scanAndPatchOrphanResources(bareModel3Json, files)
    expect(recoveredExpressionCount).toBe(0)
    expect(recoveredMotionCount).toBe(0)
  })
})

describe('detectPossibleWatermarkProtection', () => {
  it('true when patched model3.json still has no motions/expressions', () => {
    expect(detectPossibleWatermarkProtection(bareModel3Json)).toBe(true)
  })
  it('false once expressions exist', () => {
    const withExpr: Model3Json = { FileReferences: { ...bareModel3Json.FileReferences, Expressions: [{ Name: 'x', File: 'x.exp3.json' }] } }
    expect(detectPossibleWatermarkProtection(withExpr)).toBe(false)
  })
  it('false once motions exist', () => {
    const withMotion: Model3Json = { FileReferences: { ...bareModel3Json.FileReferences, Motions: { Idle: [{ File: 'i.motion3.json' }] } } }
    expect(detectPossibleWatermarkProtection(withMotion)).toBe(false)
  })
})

describe('listModelFilesRecursive', () => {
  it('lists nested files as forward-slash relative paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-'))
    mkdirSync(join(dir, 'expressions'), { recursive: true })
    writeFileSync(join(dir, 'character.moc3'), 'x')
    writeFileSync(join(dir, 'expressions', 'happy.exp3.json'), '{}')
    const out = listModelFilesRecursive(dir).sort()
    expect(out).toEqual(['character.moc3', 'expressions/happy.exp3.json'])
  })
})
