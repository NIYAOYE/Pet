import { describe, it, expect } from 'vitest'
import { parseAppFocusRules, matchAppFocusRule } from './appFocusWatcher'

describe('parseAppFocusRules', () => {
  it('解析合法规则', () => {
    const raw = JSON.stringify({
      app_focus: [
        { match: ['code.exe', 'visual studio'], lines: [{ text: '又在写代码啦' }] },
        { match: ['chrome.exe'], lines: [{ text: '在看什么', audio: 'voice/x.wav' }] }
      ]
    })
    const rules = parseAppFocusRules(raw)
    expect(rules).toEqual([
      { match: ['code.exe', 'visual studio'], lines: [{ text: '又在写代码啦' }] },
      { match: ['chrome.exe'], lines: [{ text: '在看什么', audio: 'voice/x.wav' }] }
    ])
  })

  it('坏 JSON → 空数组', () => {
    expect(parseAppFocusRules('{ not json')).toEqual([])
  })

  it('没有 app_focus 键 → 空数组', () => {
    expect(parseAppFocusRules(JSON.stringify({ idle: [{ text: 'a' }] }))).toEqual([])
  })

  it('跳过缺 match 或 match 为空数组的规则', () => {
    const raw = JSON.stringify({
      app_focus: [
        { lines: [{ text: 'a' }] },
        { match: [], lines: [{ text: 'b' }] },
        { match: ['ok.exe'], lines: [{ text: 'c' }] }
      ]
    })
    expect(parseAppFocusRules(raw)).toEqual([{ match: ['ok.exe'], lines: [{ text: 'c' }] }])
  })

  it('跳过缺 lines 或 lines 全部无效的规则', () => {
    const raw = JSON.stringify({
      app_focus: [
        { match: ['a.exe'] },
        { match: ['b.exe'], lines: [{ nope: 1 }] },
        { match: ['c.exe'], lines: [{ text: 'ok' }] }
      ]
    })
    expect(parseAppFocusRules(raw)).toEqual([{ match: ['c.exe'], lines: [{ text: 'ok' }] }])
  })
})

describe('matchAppFocusRule', () => {
  const rules = [
    { match: ['code.exe', 'visual studio'], lines: [{ text: 'a' }] },
    { match: ['chrome.exe'], lines: [{ text: 'b' }] }
  ]

  it('按进程名命中(大小写不敏感)', () => {
    expect(matchAppFocusRule(rules, { processName: 'Code.EXE', windowTitle: 'x' })).toEqual(rules[0])
  })

  it('按窗口标题命中', () => {
    expect(matchAppFocusRule(rules, { processName: 'unknown', windowTitle: 'Visual Studio Code - main.ts' })).toEqual(rules[0])
  })

  it('都不命中 → null', () => {
    expect(matchAppFocusRule(rules, { processName: 'notepad.exe', windowTitle: 'Untitled' })).toBeNull()
  })

  it('多规则按顺序取第一个命中', () => {
    const overlapping = [
      { match: ['exe'], lines: [{ text: 'first' }] },
      { match: ['chrome.exe'], lines: [{ text: 'second' }] }
    ]
    expect(matchAppFocusRule(overlapping, { processName: 'chrome.exe', windowTitle: '' })).toEqual(overlapping[0])
  })
})
