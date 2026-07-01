// TODO(MVP-03): 将 placeholderReply 替换为真实 agent 调用。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, ChatSendPayload } from '@shared/ipc'
import type { PetEvent } from '@shared/petBrain'

const REPLY_DELAY_MS = 800
const FALLBACK_REPLY = '(还没接上大脑,等我 MVP-03 再好好聊~)'

export interface ChatStore {
  messages(): ChatMessage[]
  handleSend(payload: ChatSendPayload): void
}

export function createChatStore(opts: {
  petDir: string
  emitPetEvent: (event: PetEvent) => void
  pushUpdate: (messages: ChatMessage[]) => void
}): ChatStore {
  const transcript: ChatMessage[] = []
  let timer: NodeJS.Timeout | null = null

  // TODO(MVP-03): 占位回复 — 从 lines.json 的 task_done/greet 池随机挑选;
  // lines.json 不存在或损坏时静默降级到 FALLBACK_REPLY。
  function placeholderReply(): string {
    try {
      const raw = JSON.parse(
        readFileSync(join(opts.petDir, 'lines.json'), 'utf-8')
      ) as Record<string, Array<{ text?: string }>>
      const pool = [...(raw.task_done ?? []), ...(raw.greet ?? [])]
      const picked = pool[Math.floor(Math.random() * pool.length)]
      if (picked && typeof picked.text === 'string' && picked.text.length > 0) return picked.text
    } catch {
      /* lines.json 可选,缺失/损坏则用兜底串 */
    }
    return FALLBACK_REPLY
  }

  return {
    messages: () => transcript,
    handleSend(payload: ChatSendPayload): void {
      const text = (payload?.text ?? '').trim()
      if (!text) return
      transcript.push({ role: 'user', text })
      opts.pushUpdate(transcript)
      opts.emitPetEvent('messageSent')
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        transcript.push({ role: 'pet', text: placeholderReply() })
        opts.pushUpdate(transcript)
        opts.emitPetEvent('replyDone')
        timer = null
      }, REPLY_DELAY_MS)
    }
  }
}
