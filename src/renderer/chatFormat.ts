import type { ChatMessage } from '@shared/ipc'

export interface MessageGroup { role: ChatMessage['role']; messages: ChatMessage[] }

/** 连续同一发送者的消息合并为一组,同组内只需在首条显示头像/名字。 */
export function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  for (const m of messages) {
    const last = groups[groups.length - 1]
    if (last && last.role === m.role) last.messages.push(m)
    else groups.push({ role: m.role, messages: [m] })
  }
  return groups
}

/** 本地 24 小时制 HH:mm,供 MomoTalk 风格气泡旁的时间戳使用。 */
export function formatClockTime(epochMs: number): string {
  const d = new Date(epochMs)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}
