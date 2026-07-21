import { describe, it, expect } from 'vitest'
import { applyCubismCoreCompatPatch } from './live2dCubismCoreCompat'

describe('applyCubismCoreCompatPatch', () => {
  it('drawables.renderOrders 已存在时不做任何事', () => {
    const drawables = { renderOrders: [1, 2, 3] }
    const coreModel = { drawables, getRenderOrders: () => [9, 9, 9] }
    applyCubismCoreCompatPatch(coreModel)
    expect(coreModel.drawables.renderOrders).toEqual([1, 2, 3])
  })

  it('renderOrders 缺失但 getRenderOrders 存在时,打补丁回填', () => {
    const drawables: { renderOrders?: number[] } = {}
    const coreModel = { drawables, getRenderOrders: () => [7, 8, 9] }
    applyCubismCoreCompatPatch(coreModel)
    expect(coreModel.drawables.renderOrders).toEqual([7, 8, 9])
  })

  it('两者都缺失时不崩溃(静默跳过)', () => {
    const coreModel = {}
    expect(() => applyCubismCoreCompatPatch(coreModel)).not.toThrow()
  })

  it('drawables 存在但 getRenderOrders 不是函数时不崩溃', () => {
    const drawables: { renderOrders?: number[] } = {}
    const coreModel = { drawables, getRenderOrders: 'not-a-function' }
    expect(() => applyCubismCoreCompatPatch(coreModel)).not.toThrow()
    expect(coreModel.drawables.renderOrders).toBeUndefined()
  })
})
