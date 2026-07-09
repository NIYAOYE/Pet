import { describe, it, expect } from 'vitest'
import { resolveLaunchPlan, DEFAULT_CDP_PORT } from './browserLifecycle'

describe('resolveLaunchPlan', () => {
  it('mode:isolated → isolated 计划,channel chrome,不指定 userDataDir', () => {
    const plan = resolveLaunchPlan({ mode: 'isolated' }, {})
    expect(plan).toEqual({ kind: 'isolated', channel: 'chrome', headless: false })
  })

  it('mode:isolated 且设置了 chromePath → 计划里带 executablePath,绕开 channel 自动探测', () => {
    const plan = resolveLaunchPlan({ mode: 'isolated', chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }, {})
    expect(plan).toEqual({
      kind: 'isolated',
      channel: 'chrome',
      headless: false,
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    })
  })

  it('mode:isolated 且 chromePath 为空字符串/未设置 → 不带 executablePath(继续走 channel 自动探测)', () => {
    const plan = resolveLaunchPlan({ mode: 'isolated', chromePath: '' }, {})
    expect(plan).toEqual({ kind: 'isolated', channel: 'chrome', headless: false })
  })

  it('mode:cdp 未传端口 → 用默认端口 9222 拼出 endpoint', () => {
    const plan = resolveLaunchPlan({ mode: 'cdp' }, {})
    expect(plan).toEqual({ kind: 'cdp', endpointURL: `http://localhost:${DEFAULT_CDP_PORT}` })
  })

  it('mode:cdp 传自定义端口 → 拼进 endpoint', () => {
    const plan = resolveLaunchPlan({ mode: 'cdp' }, { cdpPort: 9333 })
    expect(plan).toEqual({ kind: 'cdp', endpointURL: 'http://localhost:9333' })
  })
})
