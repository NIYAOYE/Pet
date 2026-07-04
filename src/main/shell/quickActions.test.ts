import { describe, it, expect } from 'vitest'
import { QUICK_ACTIONS, findQuickAction } from './quickActions'

describe('quickActions', () => {
  it('恰好 4 个预设,id 唯一', () => {
    expect(QUICK_ACTIONS.map((a) => a.id)).toEqual(['translate', 'summarize', 'polish', 'explain'])
    expect(new Set(QUICK_ACTIONS.map((a) => a.id)).size).toBe(4)
  })

  it('每个动作都有非空 label 与 instruction', () => {
    for (const a of QUICK_ACTIONS) {
      expect(a.label.length).toBeGreaterThan(0)
      expect(a.instruction.length).toBeGreaterThan(0)
    }
  })

  it('findQuickAction 命中/未命中', () => {
    expect(findQuickAction('translate')?.label).toContain('翻译')
    expect(findQuickAction('nope')).toBeUndefined()
  })
})
