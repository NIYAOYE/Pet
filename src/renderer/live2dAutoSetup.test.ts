import { describe, it, expect } from 'vitest'
import { needsAutoFit, pickWatermarkBreakExpressionName } from './live2dAutoSetup'
import type { Live2DManifest, Live2DTransform } from '@shared/petPackage'

function makeTransform(overrides: Partial<Live2DTransform> = {}): Live2DTransform {
  return { scale: 1, offsetX: 0, offsetY: 0, anchorX: 0.5, anchorY: 1, bubbleAnchorX: 0.5, bubbleAnchorY: 0, ...overrides }
}

function makeManifest(overrides: { possibleWatermark?: boolean; idleExpression?: string } = {}): Live2DManifest {
  return {
    schemaVersion: 2,
    id: 'tu', displayName: '茕兔', description: 'x',
    render: {
      type: 'live2d',
      model: 'model/character.model3.json',
      viewport: { width: 360, height: 480, resolutionCap: 1.5 },
      transform: makeTransform(),
      interaction: { mirrorOnWalk: true, mouseTracking: true, lipSyncParameter: 'ParamMouthOpenY' },
      stateMap: overrides.idleExpression
        ? { idle: { motionGroup: 'Recovered', selection: 'random', loop: true, expression: overrides.idleExpression } }
        : { idle: { motionGroup: 'Recovered', selection: 'random', loop: true } },
      ...(overrides.possibleWatermark !== undefined ? { possibleWatermark: overrides.possibleWatermark } : {})
    }
  }
}

describe('needsAutoFit', () => {
  it('autoFitted 未设置时需要自动对齐', () => {
    expect(needsAutoFit(makeTransform())).toBe(true)
  })
  it('autoFitted:false 时仍需要自动对齐', () => {
    expect(needsAutoFit(makeTransform({ autoFitted: false }))).toBe(true)
  })
  it('autoFitted:true 时不需要', () => {
    expect(needsAutoFit(makeTransform({ autoFitted: true }))).toBe(false)
  })
})

describe('pickWatermarkBreakExpressionName', () => {
  it('possibleWatermark 不是 true 时返回 undefined(即便有可用表情)', () => {
    const manifest = makeManifest({ possibleWatermark: false })
    expect(pickWatermarkBreakExpressionName(manifest, [{ Name: 'happy' }])).toBeUndefined()
  })
  it('possibleWatermark 缺失(未声明字段)时返回 undefined', () => {
    const manifest = makeManifest()
    expect(pickWatermarkBreakExpressionName(manifest, [{ Name: 'happy' }])).toBeUndefined()
  })
  it('stateMap.idle 已显式声明 expression 时返回 undefined,不覆盖作者配置', () => {
    const manifest = makeManifest({ possibleWatermark: true, idleExpression: 'sy' })
    expect(pickWatermarkBreakExpressionName(manifest, [{ Name: 'happy' }])).toBeUndefined()
  })
  it('definitions 为 undefined 或空数组时安全返回 undefined,不抛错', () => {
    const manifest = makeManifest({ possibleWatermark: true })
    expect(pickWatermarkBreakExpressionName(manifest, undefined)).toBeUndefined()
    expect(pickWatermarkBreakExpressionName(manifest, [])).toBeUndefined()
  })
  it('满足条件时返回第一个可用表情的名字', () => {
    const manifest = makeManifest({ possibleWatermark: true })
    expect(pickWatermarkBreakExpressionName(manifest, [{ Name: 'happy' }, { Name: 'sad' }])).toBe('happy')
  })
})
