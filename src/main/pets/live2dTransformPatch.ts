import type { Live2DTransformPatch } from '@shared/ipc'

export type PatchResult = { ok: true; raw: unknown } | { ok: false; reason: string }

/** 只覆盖 pet.json 的 render.transform.{scale,offsetX,offsetY,autoFitted} 四个字段,anchorX/anchorY/
 *  bubbleAnchorX/bubbleAnchorY 原样保留——这四个是 Live2DPetRenderer.autoFit() 现场测量算出来的,
 *  锚点是宠物包作者自己定的语义,不该被这条自动化通道覆盖。只接受 live2d 包,不接受 sprite 包
 *  (sprite 没有 render.transform 这个概念)。纯函数,不修改传入的 raw,返回一份新对象。 */
export function patchLive2DTransform(raw: unknown, patch: Live2DTransformPatch): PatchResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'pet.json 不是一个对象' }
  const m = raw as Record<string, unknown>
  const render = m.render as Record<string, unknown> | undefined
  if (!render || typeof render !== 'object' || render.type !== 'live2d') {
    return { ok: false, reason: '不是 live2d 宠物包(render.type 不是 live2d)' }
  }
  const transform = render.transform as Record<string, unknown> | undefined
  if (!transform || typeof transform !== 'object') {
    return { ok: false, reason: 'render.transform 缺失' }
  }
  for (const key of ['scale', 'offsetX', 'offsetY'] as const) {
    const value = patch[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, reason: `${key} 必须是有限数字` }
    }
  }
  if (typeof patch.autoFitted !== 'boolean') {
    return { ok: false, reason: 'autoFitted 必须是 boolean' }
  }
  return {
    ok: true,
    raw: {
      ...m,
      render: {
        ...render,
        transform: { ...transform, scale: patch.scale, offsetX: patch.offsetX, offsetY: patch.offsetY, autoFitted: patch.autoFitted }
      }
    }
  }
}
