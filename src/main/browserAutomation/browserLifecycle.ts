import type { BrowserControlSettings } from '@shared/llm'

export const DEFAULT_CDP_PORT = 9222

export type LaunchPlan =
  | { kind: 'isolated'; channel: 'chrome'; headless: false; executablePath?: string }
  | { kind: 'cdp'; endpointURL: string }

export function resolveLaunchPlan(
  settings: Pick<BrowserControlSettings, 'mode' | 'chromePath'>,
  opts: { cdpPort?: number }
): LaunchPlan {
  if (settings.mode === 'cdp') {
    const port = opts.cdpPort ?? DEFAULT_CDP_PORT
    return { kind: 'cdp', endpointURL: `http://localhost:${port}` }
  }
  const chromePath = settings.chromePath?.trim()
  return {
    kind: 'isolated',
    channel: 'chrome',
    headless: false,
    ...(chromePath ? { executablePath: chromePath } : {})
  }
}
