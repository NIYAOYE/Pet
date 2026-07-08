/**
 * press_key 的白名单:只接受这里列出的键名,拒绝一切组合键/系统级快捷键
 * (Alt+F4、Win 键组合、Ctrl+Alt+Delete 等),把一次模型误判的破坏范围锁死。
 * vk code 参考:https://learn.microsoft.com/windows/win32/inputdev/virtual-key-codes
 */
const VK_CONTROL = 0x11

const ALLOWLIST: Record<string, number[]> = {
  Enter: [0x0d],
  Tab: [0x09],
  Escape: [0x1b],
  Backspace: [0x08],
  Delete: [0x2e],
  ArrowUp: [0x26],
  ArrowDown: [0x28],
  ArrowLeft: [0x25],
  ArrowRight: [0x27],
  'Ctrl+A': [VK_CONTROL, 0x41],
  'Ctrl+C': [VK_CONTROL, 0x43],
  'Ctrl+V': [VK_CONTROL, 0x56],
  'Ctrl+X': [VK_CONTROL, 0x58],
  'Ctrl+Z': [VK_CONTROL, 0x5a]
}

export const ALLOWED_KEY_NAMES: string[] = Object.keys(ALLOWLIST)

export function resolveKey(key: string): number[] | null {
  return ALLOWLIST[key] ?? null
}
