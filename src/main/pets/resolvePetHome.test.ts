import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolvePetHome } from './resolvePetHome'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'resolvepethome-'))
}
function makeBundledPet(bundledRoot: string, id: string): void {
  const dir = join(bundledRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'pet.json'), JSON.stringify({ id }), 'utf-8')
}

describe('resolvePetHome', () => {
  it('配置的宠物包存在 → ready,用配置的 id', () => {
    const userDataDir = scratch()
    const bundledPetsDir = scratch()
    makeBundledPet(bundledPetsDir, 'alice')
    makeBundledPet(bundledPetsDir, 'luluka')
    const result = resolvePetHome({
      userDataDir,
      bundledPetsDir,
      configuredPetId: 'alice',
      defaultPetId: 'luluka',
      legacyMemoryDir: join(userDataDir, 'memory')
    })
    expect(result.mode).toBe('ready')
    if (result.mode === 'ready') {
      expect(existsSync(join(result.petHome.petHome, 'pet.json'))).toBe(true)
      expect(result.petHome.petHome).toBe(join(userDataDir, 'pets', 'alice'))
    }
  })

  it('配置的宠物包缺失,默认宠物包存在 → ready,回退默认 id 并迁移旧 memory', () => {
    const userDataDir = scratch()
    const bundledPetsDir = scratch()
    makeBundledPet(bundledPetsDir, 'luluka')
    const legacyMemoryDir = join(userDataDir, 'memory')
    mkdirSync(legacyMemoryDir, { recursive: true })
    writeFileSync(join(legacyMemoryDir, 'facts.json'), '[]', 'utf-8')
    const result = resolvePetHome({
      userDataDir,
      bundledPetsDir,
      configuredPetId: 'ghost',
      defaultPetId: 'luluka',
      legacyMemoryDir
    })
    expect(result.mode).toBe('ready')
    if (result.mode === 'ready') {
      expect(result.petHome.petHome).toBe(join(userDataDir, 'pets', 'luluka'))
      expect(existsSync(join(result.petHome.memoryDir, 'facts.json'))).toBe(true)
    }
  })

  it('配置的宠物包和默认宠物包都缺失 → onboarding', () => {
    const userDataDir = scratch()
    const bundledPetsDir = scratch()
    mkdirSync(bundledPetsDir, { recursive: true }) // 空目录,一个宠物都没有
    const result = resolvePetHome({
      userDataDir,
      bundledPetsDir,
      configuredPetId: 'ghost',
      defaultPetId: 'luluka',
      legacyMemoryDir: join(userDataDir, 'memory')
    })
    expect(result.mode).toBe('onboarding')
  })

  it('配置的 id 就是默认 id 且缺失 → 直接 onboarding(不重复尝试)', () => {
    const userDataDir = scratch()
    const bundledPetsDir = scratch()
    mkdirSync(bundledPetsDir, { recursive: true })
    const result = resolvePetHome({
      userDataDir,
      bundledPetsDir,
      configuredPetId: 'luluka',
      defaultPetId: 'luluka',
      legacyMemoryDir: join(userDataDir, 'memory')
    })
    expect(result.mode).toBe('onboarding')
  })
})
