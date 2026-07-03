import { app, dialog } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startShell } from './shell'

/**
 * 打包后的 GUI 进程没有控制台,任何致命错误都无处可看(表现为"任务栏闪一下就消失")。
 * 把致命信息落到 userData/startup-crash.log,便于诊断;绝不因日志本身再抛错。
 */
function logDiag(tag: string, detail: unknown): void {
  try {
    const p = join(app.getPath('userData'), 'startup-crash.log')
    const msg = detail instanceof Error ? (detail.stack ?? detail.message) : String(detail)
    writeFileSync(p, `[${new Date().toISOString()}] ${tag}: ${msg}\n`, { flag: 'a' })
  } catch {
    /* 最后兜底:连日志都写不了也不能崩 */
  }
}

// GUI 进程(双击启动)无有效 stdout/stderr,向其写入会触发未处理的 'error' 事件→
// 未捕获异常→进程 abort(0x80000003)。挂处理器,令写失败不致命。
process.stdout.on('error', (e) => logDiag('stdout error', e))
process.stderr.on('error', (e) => logDiag('stderr error', e))
process.on('uncaughtException', (e) => logDiag('uncaughtException', e))
process.on('unhandledRejection', (e) => logDiag('unhandledRejection', e))

app.whenReady()
  .then(() => startShell())
  .catch((e) => {
    logDiag('startShell threw', e)
    try {
      dialog.showErrorBox('Pet-Agent 启动失败', String(e instanceof Error ? (e.stack ?? e.message) : e))
    } catch {
      /* dialog 不可用也不能再崩 */
    }
  })
app.on('window-all-closed', () => { /* 保持常驻,由托盘退出 */ })
