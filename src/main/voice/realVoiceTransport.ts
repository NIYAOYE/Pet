import { spawn, execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { createWriteStream, mkdirSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createSseParser, type SseFrame } from './sseParser'

const execFileP = promisify(execFileCb)

/** spawn gsv_server.py,监听 stdout 直到看到 "READY" 才算就绪;进程提前退出则拒绝。 */
export function realSpawnProcess(opts: {
  pythonExe: string
  scriptPath: string
  port: number
  voice: { gptModel: string; sovitsModel: string; refAudio: string; refText: string }
  device: 'auto' | 'cuda' | 'cpu'
  useFlashAttn: boolean
}): { kill(): void; waitReady(): Promise<void> } {
  const args = [
    opts.scriptPath,
    '--port', String(opts.port),
    '--gpt-model', opts.voice.gptModel,
    '--sovits-model', opts.voice.sovitsModel,
    '--ref-audio', opts.voice.refAudio,
    '--ref-text-file', opts.voice.refText
  ]
  if (opts.device !== 'auto') args.push('--device', opts.device)
  if (opts.useFlashAttn) args.push('--use-flash-attn')

  const child = spawn(opts.pythonExe, args, { windowsHide: true })

  return {
    kill(): void { child.kill() },
    waitReady(): Promise<void> {
      return new Promise((resolve, reject) => {
        let settled = false
        child.stdout?.on('data', (buf: Buffer) => {
          if (!settled && buf.toString('utf-8').includes('READY')) { settled = true; resolve() }
        })
        child.once('exit', (code) => {
          if (!settled) { settled = true; reject(new Error(`语音 sidecar 提前退出(code=${code})`)) }
        })
        child.once('error', (err) => {
          if (!settled) { settled = true; reject(err) }
        })
      })
    }
  }
}

/** 发 POST + 手动解析 text/event-stream 响应体(纯文本协议,不引入 ws 包)。 */
export function realPostSse(port: number, path: string, body: unknown, onFrame: (f: SseFrame) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      const parser = createSseParser()
      res.setEncoding('utf-8')
      res.on('data', (chunk: string) => { for (const f of parser.push(chunk)) onFrame(f) })
      res.on('end', () => resolve())
      res.on('error', reject)
    })
    req.on('error', reject)
    signal.addEventListener('abort', () => req.destroy(new Error('已取消')))
    req.write(payload)
    req.end()
  })
}

export async function realDownloadEmbeddablePython(destDir: string, downloadUrl: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  mkdirSync(destDir, { recursive: true })
  const res = await fetchImpl(downloadUrl)
  if (!res.ok || !res.body) throw new Error(`下载失败:HTTP ${res.status}`)
  const zipPath = join(destDir, 'python-embed.zip')
  // Node 18+ 的 fetch body 是 web ReadableStream,转成 node stream 再落盘
  const { Readable } = await import('node:stream')
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(zipPath))
}

export async function realDetectGpu(): Promise<boolean> {
  try {
    await execFileP('nvidia-smi', [])
    return true
  } catch {
    return false
  }
}

export async function realPipInstall(pythonDir: string, args: string[]): Promise<void> {
  const pythonExe = join(pythonDir, 'python.exe')
  await execFileP(pythonExe, ['-m', 'pip', 'install', ...args], { maxBuffer: 1024 * 1024 * 64 })
}
