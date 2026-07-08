export interface IdleWatcherConfig {
  /** 轮询间隔 */
  pollIntervalMs: number
  /** 闲置超过此值判定为 AFK 离开 */
  afkThresholdMs: number
  /** 持续活跃(无长间隔)累计超过此值判定为久坐 */
  breakThresholdMs: number
  /** 单次采样闲置 ≥ 此值视为"歇了一下",久坐累加器清零 */
  activeResetIdleMs: number
}

export const DEFAULT_IDLE_WATCHER_CONFIG: IdleWatcherConfig = {
  pollIntervalMs: 30_000,
  afkThresholdMs: 5 * 60_000,
  breakThresholdMs: 45 * 60_000,
  activeResetIdleMs: 60_000
}

export interface IdleWatcherState {
  activeAccumMs: number
  afkArmed: boolean
}

export function initIdleWatcher(): IdleWatcherState {
  return { activeAccumMs: 0, afkArmed: true }
}

export type IdleWatcherEvent = 'afk_leave' | 'break_reminder'

/**
 * 纯函数核心:注入一次 OS 闲置采样(ms),返回下一状态 + 本次触发的事件。
 */
export function stepIdleWatcher(
  state: IdleWatcherState,
  idleMs: number,
  cfg: IdleWatcherConfig
): { state: IdleWatcherState; events: IdleWatcherEvent[] } {
  const events: IdleWatcherEvent[] = []
  let next: IdleWatcherState = { ...state }

  // AFK:边沿触发,闲置回落后重新武装
  if (idleMs >= cfg.afkThresholdMs) {
    if (next.afkArmed) {
      events.push('afk_leave')
      next = { ...next, afkArmed: false }
    }
  } else {
    next = { ...next, afkArmed: true }
  }

  // 久坐:持续活跃累加,遇到像样的闲置间隔就清零
  if (idleMs < cfg.activeResetIdleMs) {
    next = { ...next, activeAccumMs: next.activeAccumMs + cfg.pollIntervalMs }
  } else {
    next = { ...next, activeAccumMs: 0 }
  }
  if (next.activeAccumMs >= cfg.breakThresholdMs) {
    events.push('break_reminder')
    next = { ...next, activeAccumMs: 0 }
  }

  return { state: next, events }
}
