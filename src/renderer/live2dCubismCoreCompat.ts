/**
 * untitled-pixi-live2d-engine@1.3.5 假设 Cubism Core 的 Model 对象暴露
 * drawables.renderOrders 属性,但官方最新 Cubism Core 5(06.00.0001)把这个字段
 * 设为 private,只能通过 getRenderOrders() 读取——每帧渲染都会因此崩溃(黑屏)。
 * 见主设计文档 §17.2。自我禁用式设计:先探测直接属性是否已经可用,未来引擎或
 * Core 版本修复此问题后自动跳过,不需要跟着版本号手动开关。
 */
export function applyCubismCoreCompatPatch(coreModel: unknown): void {
  const m = coreModel as { drawables?: { renderOrders?: unknown }; getRenderOrders?: unknown }
  if (!m || typeof m !== 'object' || !m.drawables) return
  if (m.drawables.renderOrders !== undefined) return
  if (typeof m.getRenderOrders !== 'function') return
  const getRenderOrders = m.getRenderOrders as () => unknown
  Object.defineProperty(m.drawables, 'renderOrders', { get: () => getRenderOrders() })
}
