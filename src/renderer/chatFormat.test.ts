import { describe, it, expect } from 'vitest'
import { groupMessages, formatClockTime } from './chatFormat'

describe('groupMessages', () => {
  it('连续同角色的消息合并为一组', () => {
    const groups = groupMessages([
      { role: 'pet', text: 'a' },
      { role: 'pet', text: 'b' },
      { role: 'user', text: 'c' },
      { role: 'pet', text: 'd' }
    ])
    expect(groups).toEqual([
      { role: 'pet', messages: [{ role: 'pet', text: 'a' }, { role: 'pet', text: 'b' }] },
      { role: 'user', messages: [{ role: 'user', text: 'c' }] },
      { role: 'pet', messages: [{ role: 'pet', text: 'd' }] }
    ])
  })
  it('空数组 → 空分组', () => {
    expect(groupMessages([])).toEqual([])
  })
})

describe('formatClockTime', () => {
  it('两位数补零', () => {
    expect(formatClockTime(new Date(2026, 0, 1, 9, 5).getTime())).toBe('09:05')
  })
  it('整点两位数', () => {
    expect(formatClockTime(new Date(2026, 0, 1, 23, 0).getTime())).toBe('23:00')
  })
})
