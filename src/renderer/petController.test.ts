import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PetController } from './petController'
import type { PetRenderer, PetHitResult } from './petRenderer'
import type { PetRenderSource } from '@shared/petPackage'

function makeFakeRenderer(): PetRenderer & { destroyed: boolean; loadedWith: PetRenderSource[] } {
  const loadedWith: PetRenderSource[] = []
  return {
    destroyed: false,
    loadedWith,
    async load(source) { loadedWith.push(source) },
    playState() {},
    setFacing() {},
    setLipSync() {},
    hitTest(): PetHitResult { return { hit: false } },
    resize() {},
    setVisible() {},
    async destroy() { this.destroyed = true }
  }
}

const spriteSource: PetRenderSource = { type: 'sprite', manifest: {} as any, spritesheetDataUrl: 'data:x' }
const live2dSource: PetRenderSource = { type: 'live2d', manifest: {} as any, resourceBaseUrl: 'kibo-pet://tok/' }

describe('PetController.reload() 渲染器类型热切换', () => {
  let getPetMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    getPetMock = vi.fn()
    ;(globalThis as any).window = { petApi: { getPet: getPetMock } }
  })

  afterEach(() => {
    delete (globalThis as any).window
  })

  it('类型不变时复用同一个渲染器实例,不销毁不重建', async () => {
    getPetMock.mockResolvedValue(spriteSource)
    const initial = makeFakeRenderer()
    const factory = vi.fn(() => makeFakeRenderer())
    const controller = new PetController(initial, 'sprite', factory)

    await controller.reload()

    expect(factory).not.toHaveBeenCalled()
    expect(initial.destroyed).toBe(false)
    expect(initial.loadedWith).toEqual([spriteSource])
  })

  it('类型从 sprite 变成 live2d 时销毁旧实例、用工厂构造新实例', async () => {
    getPetMock.mockResolvedValue(live2dSource)
    const initial = makeFakeRenderer()
    const replacement = makeFakeRenderer()
    const factory = vi.fn(() => replacement)
    const controller = new PetController(initial, 'sprite', factory)

    await controller.reload()

    expect(initial.destroyed).toBe(true)
    expect(factory).toHaveBeenCalledWith(live2dSource)
    expect(replacement.loadedWith).toEqual([live2dSource])
  })

  it('hitTest() 转发到当前渲染器实例(切换后也转发到新实例,不是旧的)', async () => {
    getPetMock.mockResolvedValue(live2dSource)
    const initial = makeFakeRenderer()
    initial.hitTest = () => ({ hit: false })
    const replacement = makeFakeRenderer()
    replacement.hitTest = () => ({ hit: true, area: 'Head' })
    const controller = new PetController(initial, 'sprite', () => replacement)

    expect(controller.hitTest(1, 2)).toEqual({ hit: false })
    await controller.reload()
    expect(controller.hitTest(1, 2)).toEqual({ hit: true, area: 'Head' })
  })
})
