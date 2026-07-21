export interface RectBounds {
  x: number
  y: number
  width: number
  height: number
}

/** model.hitTest() 在没有声明 HitAreas 的模型上返回空数组(spike 已确认这是预期行为,
 *  不是引擎的 bug——见主设计文档 §17.2)。这个函数提供退化路径:落在模型可见包围盒
 *  内就算命中,用于点击穿透判断,不区分具体部位。 */
export function pointInBounds(bounds: RectBounds, x: number, y: number): boolean {
  return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height
}

/** DOM 客户端坐标 → Live2D/Pixi 舞台的逻辑坐标。
 *  注意:这里的换算方式与 SpriteRenderer.isPetPixel() 不同,不能混用——SpriteRenderer 的
 *  canvas 没有 DPI 缩放(width/height 直接来自精灵表单元格尺寸),而这里的 canvas 由
 *  Live2DPetRenderer 以 autoDensity:true + resolution:devicePixelRatio 初始化 Pixi Application,
 *  其 canvas.width/height 是 DPI 放大后的物理分辨率,但 model.hitTest()/model.getBounds() 用的
 *  是逻辑坐标系(即 app.screen.width/height,等于 CSS 尺寸)。所以这里只需要减去 rect 的偏移,
 *  不能再乘以 canvas.width/rect.width 这类 DPI 比例,否则会在非 100% 缩放的显示器上把坐标点
 *  甩到模型实际位置之外,导致点击穿透判断错位。 */
export function toCanvasCoords(canvas: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect()
  return {
    x: clientX - rect.left,
    y: clientY - rect.top
  }
}
