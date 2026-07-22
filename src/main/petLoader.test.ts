import { describe, it, expect } from 'vitest'
import { resolve } from 'path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { loadPet } from './petLoader'

const lulukaDir = resolve(__dirname, '../../pets/luluka')

/** 故意不创建 model3.json 指向的文件:证明 loadPet 的 live2d 分支只读 pet.json,不读模型文件。 */
function makeLive2DPetDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'petloader-live2d-'))
  const dir = join(root, 'chitose')
  mkdirSync(dir, { recursive: true })
  const manifest = {
    schemaVersion: 2, id: 'chitose', displayName: '千岁', description: '千岁的描述',
    render: {
      type: 'live2d', model: 'model/character.model3.json',
      viewport: { width: 360, height: 480, resolutionCap: 1.5 },
      transform: { scale: 1, offsetX: 0, offsetY: 0, anchorX: 0.5, anchorY: 1, bubbleAnchorX: 0.5, bubbleAnchorY: 0 },
      interaction: { mirrorOnWalk: true, mouseTracking: true, lipSyncParameter: 'ParamMouthOpenY' },
      stateMap: {}
    }
  }
  writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
  return dir
}

describe('loadPet', () => {
  it('loads luluka manifest and embeds spritesheet as data url', async () => {
    const pet = await loadPet(lulukaDir)
    expect(pet.type).toBe('sprite')
    if (pet.type !== 'sprite') throw new Error('unreachable')
    expect(pet.manifest.id).toBe('luluka')
    expect(pet.manifest.animations.idle.row).toBe(0)
    expect(pet.spritesheetDataUrl.startsWith('data:image/webp;base64,')).toBe(true)
    expect(pet.spritesheetDataUrl.length).toBeGreaterThan(1000)
  })

  it('loads a live2d manifest without touching any model file', async () => {
    const dir = makeLive2DPetDir()
    const pet = await loadPet(dir)
    expect(pet.type).toBe('live2d')
    if (pet.type !== 'live2d') throw new Error('unreachable')
    expect(pet.manifest.id).toBe('chitose')
    expect(pet.manifest.render.model).toBe('model/character.model3.json')
  })

  it('throws on a directory without pet.json', async () => {
    await expect(loadPet(resolve(__dirname, '__no_such_pet_dir__'))).rejects.toThrow()
  })

  // 防御纵深(C-1 的第二道关卡):即便一个恶意/被篡改过的 pet.json 绕过了 import 时的
  // isPathSafe 校验、直接落到了 petDir 里,loadPet() 自己也不能无条件读盘。
  it('rejects a spritesheetPath that escapes petDir, even when the traversal target actually exists (would otherwise read+exfiltrate an arbitrary file)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'petloader-traversal-'))
    const dir = join(root, 'evil')
    mkdirSync(dir, { recursive: true })
    const outsideRoot = mkdtempSync(join(tmpdir(), 'petloader-outside-'))
    const outsideFile = join(outsideRoot, 'secret.webp')
    writeFileSync(outsideFile, 'super-secret-bytes-outside-petDir', 'utf-8')
    const traversalRelPath = relative(dir, outsideFile)
    const manifest = {
      id: 'evil', displayName: 'Evil', description: 'd', spritesheetPath: traversalRelPath,
      sheet: { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 },
      animations: { idle: { row: 0, frames: 4, fps: 6, loop: true } }
    }
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
    await expect(loadPet(dir)).rejects.toThrow()
  })
})
