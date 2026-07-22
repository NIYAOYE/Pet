import { describe, it, expect } from 'vitest'
import { applyCubismCoreCompatPatch } from './live2dCubismCoreCompat'

function fakeCoreModel(nativeModel: unknown): { getModel: () => unknown } {
  return { getModel: () => nativeModel }
}

/** 真实 live2dcubismcore.js 的 Model.prototype.getRenderOrders 就是这个形状——
 *  `return this.renderOrders`,依赖 this 绑定。用箭头函数造假会测不出"摘出来单独调用
 *  丢失 this 绑定"这类 bug(真实复现过),必须用会读 this 的 function 才有区分度。 */
function makeRealShapedNativeModel(renderOrders: number[] | undefined, drawables: { renderOrders?: unknown }): {
  drawables: { renderOrders?: unknown }
  renderOrders: number[] | undefined
  getRenderOrders(): number[] | undefined
} {
  return {
    drawables,
    renderOrders,
    getRenderOrders() {
      return this.renderOrders
    }
  }
}

describe('applyCubismCoreCompatPatch', () => {
  it('drawables.renderOrders 已存在时不做任何事', () => {
    const drawables = { renderOrders: [1, 2, 3] }
    const nativeModel = makeRealShapedNativeModel([9, 9, 9], drawables)
    applyCubismCoreCompatPatch(fakeCoreModel(nativeModel))
    expect(nativeModel.drawables.renderOrders).toEqual([1, 2, 3])
  })

  it('renderOrders 缺失但 getRenderOrders 存在时,打补丁回填(真实 this 绑定形状)', () => {
    const drawables: { renderOrders?: unknown } = {}
    const nativeModel = makeRealShapedNativeModel([7, 8, 9], drawables)
    applyCubismCoreCompatPatch(fakeCoreModel(nativeModel))
    // 这一步如果补丁把 getRenderOrders 摘出来单独调用、丢了 this 绑定,
    // this.renderOrders 会读到 undefined 而不是 [7,8,9] ——这正是曾经复现过的真实 bug。
    expect(nativeModel.drawables.renderOrders).toEqual([7, 8, 9])
  })

  it('两者都缺失时不崩溃(静默跳过)', () => {
    const nativeModel = {}
    expect(() => applyCubismCoreCompatPatch(fakeCoreModel(nativeModel))).not.toThrow()
  })

  it('drawables 存在但 getRenderOrders 不是函数时不崩溃', () => {
    const drawables: { renderOrders?: number[] } = {}
    const nativeModel = { drawables, getRenderOrders: 'not-a-function' }
    expect(() => applyCubismCoreCompatPatch(fakeCoreModel(nativeModel))).not.toThrow()
    expect(nativeModel.drawables.renderOrders).toBeUndefined()
  })

  it('coreModel 没有 getModel() 方法时不崩溃(比如喂进来一个不相干的对象)', () => {
    expect(() => applyCubismCoreCompatPatch({})).not.toThrow()
    expect(() => applyCubismCoreCompatPatch(null)).not.toThrow()
  })

  it('getModel() 返回的原生 model 没有 drawables 时不崩溃', () => {
    expect(() => applyCubismCoreCompatPatch(fakeCoreModel({}))).not.toThrow()
    expect(() => applyCubismCoreCompatPatch(fakeCoreModel(null))).not.toThrow()
  })
})
