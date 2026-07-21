import { Application, extensions } from 'pixi.js'
import { Live2DModel, Live2DPlugin } from 'untitled-pixi-live2d-engine/cubism'
import type { PetRenderSource, Live2DManifest } from '@shared/petPackage'
import type { PetRenderer, PetVisualState, PetHitResult, PetViewport } from './petRenderer'
import { resolveStateMotion, nextSequentialIndex, type ResolvedMotion } from './live2dStateMapResolver'
import { pointInBounds, toCanvasCoords } from './live2dHitTestFallback'
import { applyCubismCoreCompatPatch } from './live2dCubismCoreCompat'

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
      await app.init({ canvas: this.canvas, width: 256, height: 288, preference: 'webgl', autoDensity: true, resolution: window.devicePixelRatio })
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
