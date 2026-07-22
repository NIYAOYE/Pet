/**
 * untitled-pixi-live2d-engine@1.3.5 的 CubismModel.getDrawableRenderOrders() 读
 * this._model.drawables.renderOrders,但真实 Cubism Core 5 运行时(live2dcubismcore.js,
 * 06.00.0001)里原生 Model 类的 renderOrders 是跟 drawables 平级的顶层属性
 * (`this.renderOrders = new Int32Array(...)`,构造时和 `this.drawables = new Drawables(...)`
 * 分开赋值),drawables 自己从来没有过 renderOrders 字段——引擎这处代码假设的嵌套路径本身
 * 就是错的,不是"新版本 Core 把字段设成 private 了"。
 *
 * `coreModel`(untitled-pixi-live2d-engine 的 CubismModel 包装类实例,`model.internalModel.coreModel`)
 * 自己也没有公开的 `.drawables`,只有 `getModel()` 能拿到原生 Model 实例,所以必须先经过它才能
 * 摸到真正的 drawables 对象。自我禁用式设计:先探测 drawables.renderOrders 是否已经可用,
 * 未来引擎修复这处 bug 后自动跳过,不需要跟着版本号手动开关。
 */
export function applyCubismCoreCompatPatch(coreModel: unknown): void {
  const wrapper = coreModel as { getModel?: () => unknown }
  if (!wrapper || typeof wrapper !== 'object') {
    console.warn('[live2d] applyCubismCoreCompatPatch: coreModel 不是对象,跳过', coreModel)
    return
  }
  if (typeof wrapper.getModel !== 'function') {
    console.warn('[live2d] applyCubismCoreCompatPatch: coreModel.getModel 不是函数,跳过', wrapper)
    return
  }
  const nativeModel = wrapper.getModel() as
    | { drawables?: { renderOrders?: unknown }; getRenderOrders?: () => unknown }
    | null
    | undefined
  if (!nativeModel || typeof nativeModel !== 'object') {
    console.warn('[live2d] applyCubismCoreCompatPatch: getModel() 没返回对象,跳过', nativeModel)
    return
  }
  if (!nativeModel.drawables) {
    console.warn('[live2d] applyCubismCoreCompatPatch: 原生 model 没有 drawables,跳过', nativeModel)
    return
  }
  if (nativeModel.drawables.renderOrders !== undefined) return // 已经可用,自我禁用
  if (typeof nativeModel.getRenderOrders !== 'function') {
    console.warn('[live2d] applyCubismCoreCompatPatch: 原生 model 没有 getRenderOrders 方法,跳过', nativeModel)
    return
  }
  // 必须原样保留 nativeModel.getRenderOrders() 这个方法调用形态(不能把方法引用摘出来单独调),
  // 真实实现是 `return this.renderOrders`,摘出来调用会丢失 this 绑定,静默返回 undefined
  // 而不是抛错——曾经复现过这个坑,不是随手写的防御。
  Object.defineProperty(nativeModel.drawables, 'renderOrders', { get: () => nativeModel.getRenderOrders!() })
}
