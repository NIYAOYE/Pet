export interface SseFrame { event: string; data: string }

export interface SseParser {
  /** 喂入一段原始响应体文本(可能是不完整的网络分片),返回本次新解析出的完整帧。 */
  push(chunk: string): SseFrame[]
}

export function createSseParser(): SseParser {
  let buf = ''
  return {
    push(chunk: string): SseFrame[] {
      buf += chunk
      const frames: SseFrame[] = []
      let sep: number
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        let event = 'message'
        const dataLines: string[] = []
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7)
          else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
        }
        if (dataLines.length > 0) frames.push({ event, data: dataLines.join('\n') })
      }
      return frames
    }
  }
}
