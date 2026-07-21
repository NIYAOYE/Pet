import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, extname, resolve, sep } from 'node:path'

export type SecurityViolationReason =
  | 'path-traversal' | 'symlink-rejected' | 'forbidden-file-type'
  | 'dir-too-large' | 'too-many-files' | 'json-too-large'

export interface SecurityViolation { reason: SecurityViolationReason; message: string }

const FORBIDDEN_EXTENSIONS = new Set([
  '.js', '.html', '.htm', '.exe', '.dll', '.bat', '.cmd', '.ps1', '.vbs', '.scr', '.com', '.msi', '.sh'
])
const MAX_DIR_BYTES = 1024 * 1024 * 1024
const MAX_JSON_BYTES = 10 * 1024 * 1024
const MAX_FILE_COUNT = 5000

/** 纯路径字符串校验:拒绝绝对路径/UNC/盘符路径/`..`穿越。不碰文件系统。 */
export function isPathSafe(baseDir: string, candidateRelPath: string): boolean {
  if (isAbsolute(candidateRelPath)) return false
  if (candidateRelPath.startsWith('\\\\') || candidateRelPath.startsWith('//')) return false
  if (/^[A-Za-z]:/.test(candidateRelPath)) return false
  const base = resolve(baseDir)
  const resolved = resolve(base, candidateRelPath)
  return resolved === base || resolved.startsWith(base + sep)
}

/** 递归扫描导入源目录:符号链接/reparse point、扩展名黑名单、单 JSON 大小、
 *  目录总大小、文件总数,任一违规立即返回(不用扫完全部)。 */
export function scanImportSource(srcDir: string): SecurityViolation | null {
  let totalBytes = 0
  let fileCount = 0

  function walk(dir: string): SecurityViolation | null {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const lst = lstatSync(full)
      if (lst.isSymbolicLink()) {
        return { reason: 'symlink-rejected', message: `拒绝符号链接/reparse point:${full}` }
      }
      // 目录本身也计入文件数硬限制,且在递归前检查——否则大量空子目录(或极深嵌套链)
      // 完全绕过 5000 上限,还可能在极深嵌套时触发未捕获的 RangeError(调用栈溢出)
      // 而不是这个模块承诺的"返回 SecurityViolation"契约。
      fileCount++
      if (fileCount > MAX_FILE_COUNT) {
        return { reason: 'too-many-files', message: `文件数量超过硬限制 ${MAX_FILE_COUNT}` }
      }
      if (lst.isDirectory()) {
        const sub = walk(full)
        if (sub) return sub
        continue
      }
      const ext = extname(name).toLowerCase()
      if (FORBIDDEN_EXTENSIONS.has(ext)) {
        return { reason: 'forbidden-file-type', message: `拒绝的文件类型:${full}` }
      }
      const size = statSync(full).size
      totalBytes += size
      if (ext === '.json' && size > MAX_JSON_BYTES) {
        return { reason: 'json-too-large', message: `JSON 文件超过 10MB:${full}` }
      }
      if (totalBytes > MAX_DIR_BYTES) {
        return { reason: 'dir-too-large', message: '目录总大小超过硬限制 1GB' }
      }
    }
    return null
  }

  if (!existsSync(srcDir)) return null
  return walk(srcDir)
}
