import { describe, it, expect } from 'vitest'
import { patchLive2DTransform } from './live2dTransformPatch'

function makeLive2DManifest(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'tu',
    displayName: '茕兔',
    description: '茕兔桌面宠物',
    render: {
      type: 'live2d',
      model: '茕兔/茕兔.model3.json',
      viewport: { width: 360, height: 480, resolutionCap: 1.5 },
      transform: { scale: 1, offsetX: 0, offsetY: 0, anchorX: 0.5, anchorY: 1, bubbleAnchorX: 0.5, bubbleAnchorY: 0 },
      interaction: { mirrorOnWalk: true, mouseTracking: true, lipSyncParameter: 'ParamMouthOpenY' },
      stateMap: { idle: { motionGroup: 'Recovered', selection: 'random', loop: true, expression: 'sy' } }
    }
  }
}

describe('patchLive2DTransform', () => {
  it('只覆盖 scale/offsetX/offsetY/autoFitted,其余 transform 字段和整份 manifest 不变', () => {
    const raw = makeLive2DManifest()
    const result = patchLive2DTransform(raw, { scale: 0.0267, offsetX: 0, offsetY: 136, autoFitted: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const render = (result.raw as any).render
    expect(render.transform).toEqual({
      scale: 0.0267, offsetX: 0, offsetY: 136, anchorX: 0.5, anchorY: 1, bubbleAnchorX: 0.5, bubbleAnchorY: 0, autoFitted: true
    })
    // stateMap/其余字段原样保留
    expect((result.raw as any).render.stateMap).toEqual(raw.render && (raw.render as any).stateMap)
    expect((result.raw as any).id).toBe('tu')
  })

  it('不修改传入的原始对象(返回一份新对象)', () => {
    const raw = makeLive2DManifest()
    const originalTransform = { ...(raw.render as any).transform }
    patchLive2DTransform(raw, { scale: 5, offsetX: 1, offsetY: 2, autoFitted: true })
    expect((raw.render as any).transform).toEqual(originalTransform)
  })

  it('raw 不是对象时返回 ok:false', () => {
    expect(patchLive2DTransform(null, { scale: 1, offsetX: 0, offsetY: 0, autoFitted: true })).toMatchObject({ ok: false })
    expect(patchLive2DTransform('x', { scale: 1, offsetX: 0, offsetY: 0, autoFitted: true })).toMatchObject({ ok: false })
  })

  it('render.type 不是 live2d 时返回 ok:false(sprite 包不允许走这个通道)', () => {
    const raw = { render: { type: 'sprite' } }
    const result = patchLive2DTransform(raw, { scale: 1, offsetX: 0, offsetY: 0, autoFitted: true })
    expect(result).toMatchObject({ ok: false })
  })

  it('render.transform 缺失时返回 ok:false', () => {
    const raw = { render: { type: 'live2d' } }
    const result = patchLive2DTransform(raw, { scale: 1, offsetX: 0, offsetY: 0, autoFitted: true })
    expect(result).toMatchObject({ ok: false })
  })

  it('scale/offsetX/offsetY 必须是有限数字,否则返回 ok:false', () => {
    const raw = makeLive2DManifest()
    expect(patchLive2DTransform(raw, { scale: NaN, offsetX: 0, offsetY: 0, autoFitted: true })).toMatchObject({ ok: false })
    expect(patchLive2DTransform(raw, { scale: Infinity, offsetX: 0, offsetY: 0, autoFitted: true })).toMatchObject({ ok: false })
    expect(patchLive2DTransform(raw, { scale: 1, offsetX: 0, offsetY: 0, autoFitted: true })).toMatchObject({ ok: true })
  })

  it('autoFitted 必须是 boolean,否则返回 ok:false', () => {
    const raw = makeLive2DManifest()
    expect(patchLive2DTransform(raw, { scale: 1, offsetX: 0, offsetY: 0, autoFitted: 'yes' as any })).toMatchObject({ ok: false })
    expect(patchLive2DTransform(raw, { scale: 1, offsetX: 0, offsetY: 0 } as any)).toMatchObject({ ok: false })
  })

  it('autoFitted:false 也是合法输入(比如未来允许手动标记回退)', () => {
    const raw = makeLive2DManifest()
    const result = patchLive2DTransform(raw, { scale: 1, offsetX: 0, offsetY: 0, autoFitted: false })
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.raw as any).render.transform.autoFitted).toBe(false)
  })
})
