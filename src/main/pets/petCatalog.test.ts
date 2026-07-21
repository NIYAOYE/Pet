import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isValidPetId, listPets, importPetFolder, cleanupStaleStaging } from './petCatalog'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'petcatalog-'))
}

/** 写一个最小合法宠物包目录(pet.json + 占位 spritesheet)。 */
function makePet(root: string, id: string, displayName = id): string {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  const manifest = {
    id,
    displayName,
    description: `${id} 的描述`,
    spritesheetPath: 'spritesheet.webp',
    sheet: { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 },
    animations: { idle: { row: 0, frames: 4, fps: 6, loop: true } }
  }
  writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
  writeFileSync(join(dir, 'spritesheet.webp'), 'fake-bytes', 'utf-8')
  return dir
}

/** 写一个最小合法 live2d 宠物包目录(pet.json render.type=live2d + 占位 model3.json)。 */
function makeLive2DPet(root: string, id: string, displayName = id): string {
  const dir = join(root, id)
  mkdirSync(join(dir, 'model'), { recursive: true })
  const manifest = {
    schemaVersion: 2, id, displayName, description: `${id} 的描述`,
    render: {
      type: 'live2d', model: 'model/character.model3.json',
      viewport: { width: 360, height: 480, resolutionCap: 1.5 },
      transform: { scale: 1, offsetX: 0, offsetY: 0, anchorX: 0.5, anchorY: 1, bubbleAnchorX: 0.5, bubbleAnchorY: 0 },
      interaction: { mirrorOnWalk: true, mouseTracking: true, lipSyncParameter: 'ParamMouthOpenY' },
      stateMap: {}
    }
  }
  writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
  writeFileSync(join(dir, 'model', 'character.model3.json'), JSON.stringify({ FileReferences: {} }), 'utf-8')
  return dir
}

describe('isValidPetId', () => {
  it('接受纯字母数字下划线连字符', () => {
    expect(isValidPetId('luluka')).toBe(true)
    expect(isValidPetId('shiraishi-mio')).toBe(true)
    expect(isValidPetId('pet_2')).toBe(true)
  })
  it('拒绝路径分隔/穿越/空/非字符串', () => {
    expect(isValidPetId('../evil')).toBe(false)
    expect(isValidPetId('a/b')).toBe(false)
    expect(isValidPetId('')).toBe(false)
    expect(isValidPetId(123)).toBe(false)
  })
})

describe('listPets', () => {
  it('合并两来源、按 displayName 排序', () => {
    const bundled = scratch()
    const user = scratch()
    makePet(bundled, 'youka', '幽香')
    makePet(user, 'aaa', 'AAA')
    const out = listPets({ bundledPetsDir: bundled, userPetsDir: user })
    expect(out.map((p) => p.id)).toEqual(['aaa', 'youka'])
    expect(out.find((p) => p.id === 'youka')?.displayName).toBe('幽香')
    expect(out.find((p) => p.id === 'youka')).toMatchObject({ renderType: 'sprite', renderReady: true })
  })

  it('同 id 去重,userData 优先', () => {
    const bundled = scratch()
    const user = scratch()
    makePet(bundled, 'luluka', '内置露露卡')
    makePet(user, 'luluka', '用户露露卡')
    const out = listPets({ bundledPetsDir: bundled, userPetsDir: user })
    expect(out).toHaveLength(1)
    expect(out[0].displayName).toBe('用户露露卡')
  })

  it('坏包(pet.json 非法/缺失)跳过,不炸整表', () => {
    const bundled = scratch()
    const user = scratch()
    makePet(bundled, 'good', '好包')
    // 坏包:pet.json 缺 displayName
    const bad = join(bundled, 'bad')
    mkdirSync(bad, { recursive: true })
    writeFileSync(join(bad, 'pet.json'), JSON.stringify({ id: 'bad' }), 'utf-8')
    // 无 pet.json 的目录
    mkdirSync(join(bundled, 'empty'), { recursive: true })
    const out = listPets({ bundledPetsDir: bundled, userPetsDir: user })
    expect(out.map((p) => p.id)).toEqual(['good'])
  })

  it('来源目录不存在 → 返回空数组不抛', () => {
    const out = listPets({ bundledPetsDir: join(tmpdir(), 'no-such-x'), userPetsDir: join(tmpdir(), 'no-such-y') })
    expect(out).toEqual([])
  })
})

describe('importPetFolder', () => {
  it('合法包 → 复制到 userPetsDir/<id> 并返回 summary', () => {
    const src = scratch()
    const user = scratch()
    const bundled = scratch()
    const petSrc = makePet(src, 'newpet', '新宠物')
    const r = importPetFolder(petSrc, { bundledPetsDir: bundled, userPetsDir: user })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.pet).toEqual({ id: 'newpet', displayName: '新宠物', description: 'newpet 的描述', renderType: 'sprite', renderReady: true })
    expect(existsSync(join(user, 'newpet', 'pet.json'))).toBe(true)
    expect(existsSync(join(user, 'newpet', 'spritesheet.webp'))).toBe(true)
  })

  it('缺 pet.json → no-manifest,不复制', () => {
    const src = scratch()
    const user = scratch()
    mkdirSync(join(src, 'x'), { recursive: true })
    const r = importPetFolder(join(src, 'x'), { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r).toMatchObject({ ok: false, reason: 'no-manifest' })
  })

  it('pet.json 字段不合法 → invalid-manifest', () => {
    const src = scratch()
    const dir = join(src, 'x'); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pet.json'), JSON.stringify({ id: 'x' }), 'utf-8')
    const r = importPetFolder(dir, { bundledPetsDir: scratch(), userPetsDir: scratch() })
    expect(r).toMatchObject({ ok: false, reason: 'invalid-manifest' })
  })

  it('spritesheet 缺失 → missing-spritesheet', () => {
    const src = scratch()
    const dir = join(src, 'x'); mkdirSync(dir, { recursive: true })
    const manifest = {
      id: 'x', displayName: 'X', description: 'd', spritesheetPath: 'spritesheet.webp',
      sheet: { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 },
      animations: { idle: { row: 0, frames: 4, fps: 6, loop: true } }
    }
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
    const r = importPetFolder(dir, { bundledPetsDir: scratch(), userPetsDir: scratch() })
    expect(r).toMatchObject({ ok: false, reason: 'missing-spritesheet' })
  })

  it('id 含路径穿越 → bad-id', () => {
    const src = scratch()
    const dir = join(src, 'x'); mkdirSync(dir, { recursive: true })
    const manifest = {
      id: '../evil', displayName: 'X', description: 'd', spritesheetPath: 'spritesheet.webp',
      sheet: { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 },
      animations: { idle: { row: 0, frames: 4, fps: 6, loop: true } }
    }
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
    writeFileSync(join(dir, 'spritesheet.webp'), 'x', 'utf-8')
    const r = importPetFolder(dir, { bundledPetsDir: scratch(), userPetsDir: scratch() })
    expect(r).toMatchObject({ ok: false, reason: 'bad-id' })
  })

  it('id 与 userData 已有宠物冲突 → id-exists,不覆盖', () => {
    const src = scratch()
    const user = scratch()
    const petSrc = makePet(src, 'dup', '导入版')
    makePet(user, 'dup', '原有版') // userData 已存在
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r).toMatchObject({ ok: false, reason: 'id-exists' })
    // 原有目录未被覆盖
    const kept = JSON.parse(readFileSync(join(user, 'dup', 'pet.json'), 'utf-8'))
    expect(kept.displayName).toBe('原有版')
  })

  it('id 与内置宠物冲突 → id-exists', () => {
    const src = scratch()
    const bundled = scratch()
    const petSrc = makePet(src, 'youka', '导入幽香')
    makePet(bundled, 'youka', '内置幽香')
    const r = importPetFolder(petSrc, { bundledPetsDir: bundled, userPetsDir: scratch() })
    expect(r).toMatchObject({ ok: false, reason: 'id-exists' })
  })
})

describe('listPets — render 判别式', () => {
  it('sprite 包 renderType=sprite, renderReady=true', () => {
    const bundled = scratch(); const user = scratch()
    makePet(bundled, 'youka', '幽香')
    const out = listPets({ bundledPetsDir: bundled, userPetsDir: user })
    expect(out[0]).toMatchObject({ renderType: 'sprite', renderReady: true })
  })
  it('live2d 包 renderType=live2d, renderReady=false', () => {
    const bundled = scratch(); const user = scratch()
    makeLive2DPet(user, 'chitose', '千岁')
    const out = listPets({ bundledPetsDir: bundled, userPetsDir: user })
    expect(out[0]).toMatchObject({ id: 'chitose', renderType: 'live2d', renderReady: false })
  })
  it('坏的 live2d 包(render.type 声明了但校验不过)照样跳过,不炸整表', () => {
    const bundled = scratch(); const user = scratch()
    const dir = join(user, 'bad'); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pet.json'), JSON.stringify({ schemaVersion: 2, id: 'bad', render: { type: 'live2d' } }), 'utf-8')
    makePet(bundled, 'good', '好包')
    const out = listPets({ bundledPetsDir: bundled, userPetsDir: user })
    expect(out.map((p) => p.id)).toEqual(['good'])
  })
})

describe('scanDir — .staging 排除', () => {
  it('.staging 目录不当成宠物条目', () => {
    const user = scratch()
    mkdirSync(join(user, '.staging', 'abc123'), { recursive: true })
    writeFileSync(join(user, '.staging', 'abc123', 'pet.json'), '{}', 'utf-8')
    const out = listPets({ bundledPetsDir: scratch(), userPetsDir: user })
    expect(out).toEqual([])
  })
})

describe('cleanupStaleStaging', () => {
  it('清空 .staging 下的所有残留子目录', () => {
    const user = scratch()
    mkdirSync(join(user, '.staging', 'leftover1'), { recursive: true })
    mkdirSync(join(user, '.staging', 'leftover2'), { recursive: true })
    cleanupStaleStaging(user)
    expect(existsSync(join(user, '.staging', 'leftover1'))).toBe(false)
    expect(existsSync(join(user, '.staging', 'leftover2'))).toBe(false)
  })
  it('.staging 目录本身不存在时不抛', () => {
    const user = scratch()
    expect(() => cleanupStaleStaging(user)).not.toThrow()
  })
})

function fakePngBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

describe('importPetFolder — 统一 staging 流程', () => {
  it('sprite 包:不再直接复制到最终目录的同时留下残留——原子提交后 .staging 为空', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makePet(src, 'newpet', '新宠物')
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    expect(existsSync(join(user, 'newpet', 'pet.json'))).toBe(true)
    expect(readdirSync(join(user, '.staging'))).toEqual([])
  })

  it('sprite 包提交后 pet.json 被打上 schemaVersion:2 + render.type=sprite 标记', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makePet(src, 'stamped', '盖章')
    importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    const written = JSON.parse(readFileSync(join(user, 'stamped', 'pet.json'), 'utf-8'))
    expect(written.schemaVersion).toBe(2)
    expect(written.render).toEqual({ type: 'sprite' })
  })

  it('live2d 包:合法输入 → 成功导入,renderType=live2d/renderReady=false', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'chitose', '千岁')
    writeFileSync(join(petSrc, 'model', 'tex_00.png'), fakePngBytes(512, 512))
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.pet).toMatchObject({ id: 'chitose', renderType: 'live2d', renderReady: false })
    expect(existsSync(join(user, 'chitose', 'model', 'character.model3.json'))).toBe(true)
  })

  it('live2d 包:游离表情/动作文件自动找回,warnings 里报告数量', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'orphaned', '游离')
    writeFileSync(join(petSrc, 'model', 'happy.exp3.json'), '{}')
    writeFileSync(join(petSrc, 'model', 'Scene1.motion3.json'), '{}')
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.warnings?.some((w) => w.includes('找回'))).toBe(true)
    const written = JSON.parse(readFileSync(join(user, 'orphaned', 'model', 'character.model3.json'), 'utf-8'))
    expect(written.FileReferences.Expressions).toHaveLength(1)
  })

  it('live2d 包:补丁后仍无动作/表情 → warnings 含水印提示,但仍然导入成功', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'watermarked', '水印')
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.warnings?.some((w) => w.includes('未声明任何动作'))).toBe(true)
  })

  it('live2d 包:纹理超过硬限制(>8192px) → 拒绝导入,staging 清理干净', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'toobig', '太大')
    writeFileSync(join(petSrc, 'model', 'huge.png'), fakePngBytes(9000, 9000))
    // makeLive2DPet 默认的 render.model 已经指向 model/character.model3.json,直接覆盖该文件内容即可
    const modelJson = { FileReferences: { Textures: ['huge.png'] } }
    writeFileSync(join(petSrc, 'model', 'character.model3.json'), JSON.stringify(modelJson))
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('texture-too-large')
    expect(existsSync(join(user, '.staging'))).toBe(false)
    expect(existsSync(join(user, 'toobig'))).toBe(false)
  })

  it('live2d 包:model3.json 引用的贴图缺失 → missing-model-refs,不提交', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'brokenref', '缺引用')
    const modelJson = { FileReferences: { Textures: ['does-not-exist.png'] } }
    writeFileSync(join(petSrc, 'model', 'character.model3.json'), JSON.stringify(modelJson))
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('missing-model-refs')
  })

  it('live2d 包:model3.json 引用路径穿越出 modelDir → path-traversal,不提交', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'traversal', '穿越')
    const modelJson = { FileReferences: { Textures: ['../../../../evil.png'] } }
    writeFileSync(join(petSrc, 'model', 'character.model3.json'), JSON.stringify(modelJson))
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('path-traversal')
    expect(existsSync(join(user, '.staging'))).toBe(false)
  })

  it('禁止的文件类型(.exe)出现在源目录 → forbidden-file-type,sprite/live2d 都适用', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makePet(src, 'withexe', '带exe')
    writeFileSync(join(petSrc, 'evil.exe'), 'x')
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('forbidden-file-type')
  })

  it('live2d 包:model3.json 缺少 FileReferences 字段 → invalid-manifest,不崩溃', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'noreferences', '缺字段')
    writeFileSync(join(petSrc, 'model', 'character.model3.json'), JSON.stringify({}))
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid-manifest')
  })

  it('live2d 包:model3.json 的 Textures 含非字符串元素 → invalid-manifest,不崩溃', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'badtextures', '坏纹理')
    writeFileSync(join(petSrc, 'model', 'character.model3.json'), JSON.stringify({ FileReferences: { Textures: [123] } }))
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid-manifest')
  })

  it('中途校验失败不留 .staging 残留(以纹理超限用例为准复查)', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'cleanup', '清理')
    writeFileSync(join(petSrc, 'model', 'huge.png'), fakePngBytes(9000, 9000))
    const modelJson = { FileReferences: { Textures: ['huge.png'] } }
    writeFileSync(join(petSrc, 'model', 'character.model3.json'), JSON.stringify(modelJson))
    importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(existsSync(join(user, '.staging'))).toBe(false)
  })
})
