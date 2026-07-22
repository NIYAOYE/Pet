// 副作用 import:pixi.js 的 WebGLRenderer 构造时会探测 eval 能力,在本项目严格 CSP
// (script-src 'self',无 unsafe-eval)下会直接抛错。这个模块名叫 unsafe-eval,实际做的是
// 相反的事——打上 CSP 安全的多边形填充/uniform 同步 polyfill,禁用那个探测,不需要放宽 CSP。
import 'pixi.js/unsafe-eval'
import { Application, extensions } from 'pixi.js'
import { Live2DModel, Live2DPlugin } from 'untitled-pixi-live2d-engine/cubism'
import type { PetRenderSource, Live2DManifest } from '@shared/petPackage'
import type { PetRenderer, PetVisualState, PetHitResult, PetViewport } from './petRenderer'
import { resolveStateMotion, nextSequentialIndex, type ResolvedMotion } from './live2dStateMapResolver'
import { pointInBounds, toCanvasCoords } from './live2dHitTestFallback'
import { applyCubismCoreCompatPatch } from './live2dCubismCoreCompat'
import { needsAutoFit, pickWatermarkBreakExpressionName, type ExpressionDefinition } from './live2dAutoSetup'

const MOTION_PRIORITY_NORMAL = 2 // untitled-pixi-live2d-engine: 0 无优先级/1 IDLE/2 NORMAL/3 FORCE

let pluginRegistered = false

/** live2d 渲染器:实现 Phase 3 定义的 PetRenderer 接口,驱动真实的
 *  untitled-pixi-live2d-engine + pixi.js 模型加载/播放。 */
export class Live2DPetRenderer implements PetRenderer {
  private app: Application | null = null
  private model: Live2DModel | null = null
  private manifest: Live2DManifest | null = null
  private sequentialIndexByGroup = new Map<string, number>()
  private baseScale = 1

  constructor(private canvas: HTMLCanvasElement) {}

  async load(source: PetRenderSource): Promise<void> {
    if (source.type !== 'live2d') throw new Error('Live2DPetRenderer 只能加载 type:"live2d" 的 PetRenderSource')
    if (!pluginRegistered) {
      extensions.add(Live2DPlugin)
      pluginRegistered = true
    }
    await this.destroy()

    this.manifest = source.manifest
    this.sequentialIndexByGroup.clear()

    const app = new Application()
    let model: Live2DModel
    try {
      // backgroundAlpha 默认是 1(不透明黑底)——不传的话画布会盖住模型,真机验证时复现过。
      await app.init({ canvas: this.canvas, width: 256, height: 288, preference: 'webgl', autoDensity: true, resolution: window.devicePixelRatio, backgroundAlpha: 0 })
      const modelUrl = `${source.resourceBaseUrl}${source.manifest.render.model}`
      model = await Live2DModel.from(modelUrl)
    } catch (err) {
      try {
        app.destroy(false, { children: true })
      } catch {
        // app.init() 可能在 Pixi 内部插件(如 ResizePlugin)完成初始化前就抛出了
        // (例如 canvas 已被 SpriteRenderer 用 getContext('2d') 占用,'webgl' 请求返回
        // null),此时 destroy() 内部插件清理会因状态未就绪而二次抛错。这是次生错误,
        // 不是真正原因,吞掉它以确保下面 throw 的是 app.init()/Live2DModel.from()
        // 的原始错误。
      }
      throw err
    }
    this.app = app
    applyCubismCoreCompatPatch(model.internalModel.coreModel)

    const t = source.manifest.render.transform
    model.anchor.set(t.anchorX, t.anchorY)
    this.baseScale = t.scale
    model.scale.set(this.baseScale)
    model.position.set(app.screen.width / 2 + t.offsetX, app.screen.height / 2 + t.offsetY)
    app.stage.addChild(model)
    this.model = model

    // 首次自动对齐:autoFit() 内部的 scale.set/position.set 是同步调用,发生在这一帧
    // 渲染之前,不会出现"先显示错误比例再纠正"的闪烁。写回 pet.json 是 fire-and-forget——
    // 失败顶多下次启动重新算一遍,不影响这次的显示效果。
    if (needsAutoFit(t)) {
      const fit = this.autoFit()
      if (fit) void window.petApi.updateLive2DTransform({ ...fit, autoFitted: true })
    }

    // 水印/游离资源找回后仍卡在初始姿势的通用兜底:参见 live2dAutoSetup.ts 的判断逻辑注释。
    const expressionManager = model.internalModel.motionManager.expressionManager as
      | { definitions?: ExpressionDefinition[] }
      | undefined
    const watermarkExpression = pickWatermarkBreakExpressionName(source.manifest, expressionManager?.definitions)
    if (watermarkExpression) void model.expression(watermarkExpression)

    // 高级故障排查用:把 app/model 挂到 window 上,方便在 DevTools Console 里直接读写
    // scale/position/visible 等属性做实时诊断。正常情况下导入后会自动完成对齐(见上面
    // needsAutoFit 分支),这个挂钩只在需要人工核对细节或覆盖自动计算结果(比如某个疑难
    // 模型自动算出来的比例仍不满意)时才用得上,不是主流程的一部分。
    let lastFit: { scale: number; offsetX: number; offsetY: number } | null = null
    ;(window as unknown as { __kiboLive2D?: unknown }).__kiboLive2D = {
      app,
      model,
      canvas: this.canvas,
      autoFit: (marginPx?: number) => {
        lastFit = this.autoFit(marginPx)
        return lastFit
      },
      saveFit: async () => {
        if (!lastFit) return { ok: false, message: '还没调用过 autoFit(),没有可保存的数值' }
        return window.petApi.updateLive2DTransform({ ...lastFit, autoFitted: true })
      }
    }
  }

  /** 测量模型在当前 scale 下的真实渲染尺寸,算出一个能让模型完整显示在固定 256x288 画布里
   *  (留 marginPx 边距)的 scale,连同"脚底贴着画布底部"的 offsetX/offsetY 一起现场应用并
   *  返回——只覆盖这三个字段,不碰 anchorX/anchorY 等宠物包作者自定的锚点语义。两个调用方:
   *  load() 首次加载时的自动对齐,以及 window.__kiboLive2D 调试挂钩的人工核对/覆盖。 */
  private autoFit(marginPx = 8): { scale: number; offsetX: number; offsetY: number } | null {
    if (!this.model || !this.app) return null
    const currentScale = this.model.scale.x || 1
    const naturalWidth = this.model.width / currentScale
    const naturalHeight = this.model.height / currentScale
    const targetWidth = this.app.screen.width - marginPx * 2
    const targetHeight = this.app.screen.height - marginPx * 2
    const scale = Math.min(targetWidth / naturalWidth, targetHeight / naturalHeight)
    // model.width/height 理论上应该在 Live2DModel.from() resolve 后就已经就绪,但这是
    // load() 里第一次在渲染前同步调用 autoFit(),留一道防线:测出来的 scale 不是有限数字时
    // (比如冷启动 bounds 还没就绪导致除以 0)跳过应用,保留 manifest 里已有的 scale/位置,
    // 不让第一帧画面被 Infinity 缩放毁掉——调用方(load())对 null 的处理本来就是"跳过这次自动对齐"。
    if (!Number.isFinite(scale)) return null
    this.baseScale = scale
    this.model.scale.set(scale)
    const positionX = this.app.screen.width / 2
    const positionY = this.app.screen.height - marginPx
    this.model.position.set(positionX, positionY)
    return {
      scale,
      offsetX: positionX - this.app.screen.width / 2,
      offsetY: positionY - this.app.screen.height / 2
    }
  }

  playState(state: PetVisualState): void {
    if (!this.manifest || !this.model) return
    const resolved = resolveStateMotion(this.manifest.render.stateMap, state)
    if (!resolved) return
    void this.playResolved(resolved, state)
  }

  private async playResolved(resolved: ResolvedMotion, originalState: string): Promise<void> {
    if (!this.model || !this.manifest) return
    const ok = await this.startMotion(resolved)
    if (resolved.expression) void this.model.expression(resolved.expression)
    if (!ok && originalState !== 'idle') {
      const idleFallback = resolveStateMotion(this.manifest.render.stateMap, 'idle')
      if (idleFallback) await this.startMotion(idleFallback)
    }
  }

  private async startMotion(resolved: ResolvedMotion): Promise<boolean> {
    if (!this.model) return false
    let index: number | undefined
    if (typeof resolved.selection === 'number') {
      index = resolved.selection
    } else if (resolved.selection === 'sequential') {
      index = nextSequentialIndex(this.sequentialIndexByGroup.get(resolved.motionGroup))
      this.sequentialIndexByGroup.set(resolved.motionGroup, index)
    } else {
      index = undefined // 'random' → 引擎内部 startRandomMotion
    }
    return this.model.motion(resolved.motionGroup, index, MOTION_PRIORITY_NORMAL, { loop: resolved.loop })
  }

  setFacing(direction: 'left' | 'right'): void {
    if (!this.model || !this.manifest) return
    if (!this.manifest.render.interaction.mirrorOnWalk) return
    const magnitude = Math.abs(this.baseScale)
    this.model.scale.x = direction === 'left' ? -magnitude : magnitude
  }

  setLipSync(level: number): void {
    if (!this.model || !this.manifest) return
    const param = this.manifest.render.interaction.lipSyncParameter
    const coreModel = this.model.internalModel.coreModel as {
      getParameterCount(): number
      getParameterId(index: number): { isEqual(id: string): boolean }
      setParameterValueByIndex(index: number, value: number, weight?: number): void
    }
    const count = coreModel.getParameterCount()
    for (let i = 0; i < count; i++) {
      if (coreModel.getParameterId(i).isEqual(param)) {
        coreModel.setParameterValueByIndex(i, level)
        return
      }
    }
  }

  hitTest(clientX: number, clientY: number): PetHitResult {
    if (!this.model) return { hit: false }
    const { x, y } = toCanvasCoords(this.canvas, clientX, clientY)
    const areas = this.model.hitTest(x, y)
    if (areas.length > 0) return { hit: true, area: areas[0] }
    const b = this.model.getBounds()
    return { hit: pointInBounds({ x: b.x, y: b.y, width: b.width, height: b.height }, x, y) }
  }

  resize(_viewport: PetViewport): void {
    // no-op:与 SpriteRenderer 对齐,Phase 5 才会真正驱动动态窗口尺寸。
  }

  setVisible(visible: boolean): void {
    this.canvas.style.display = visible ? '' : 'none'
    if (this.app) {
      if (visible) this.app.ticker.start()
      else this.app.ticker.stop()
    }
  }

  async destroy(): Promise<void> {
    this.model?.destroy()
    this.model = null
    this.manifest = null
    this.sequentialIndexByGroup.clear()
    if (this.app) {
      this.app.destroy(false, { children: true })
      this.app = null
    }
  }
}
