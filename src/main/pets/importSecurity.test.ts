import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isPathSafe, scanImportSource } from './importSecurity'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'importsec-'))
}

describe('isPathSafe', () => {
  it('accepts a plain relative path', () => {
    expect(isPathSafe('C:/pets/foo', 'model/character.model3.json')).toBe(true)
  })
  it('rejects absolute paths', () => {
    expect(isPathSafe('C:/pets/foo', 'C:/evil/x.png')).toBe(false)
  })
  it('rejects UNC paths', () => {
    expect(isPathSafe('C:/pets/foo', '\\\\server\\share\\x.png')).toBe(false)
  })
  it('rejects .. traversal', () => {
    expect(isPathSafe('C:/pets/foo', '../../evil.png')).toBe(false)
    expect(isPathSafe('C:/pets/foo', 'model/../../evil.png')).toBe(false)
  })
  // M-4: 内嵌控制字符(如 NUL 字节)不触发上面任何一条检查(非绝对路径、非 UNC、非盘符、
  // 无 ..),下游的 existsSync/readFileSync/cpSync 目前是靠"抛异常被上层 catch"来兜底,
  // 而不是这个函数自己的契约——加一道显式拒绝,做纯字符串层面的 belt-and-suspenders。
  it('rejects embedded control characters (e.g. a NUL byte)', () => {
    expect(isPathSafe('C:/pets/foo', 'foo\x00bar')).toBe(false)
  })
})

describe('scanImportSource', () => {
  it('clean directory → null', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'pet.json'), '{}', 'utf-8')
    expect(scanImportSource(dir)).toBeNull()
  })
  it('rejects forbidden extensions', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'run.exe'), 'x', 'utf-8')
    expect(scanImportSource(dir)?.reason).toBe('forbidden-file-type')
  })
  it('rejects symlinks', () => {
    const dir = scratch()
    const target = join(scratch(), 'outside.txt')
    writeFileSync(target, 'x', 'utf-8')
    try {
      symlinkSync(target, join(dir, 'link.txt'))
    } catch {
      return // 某些 Windows 环境无权限创建符号链接,跳过这条真机才能验的用例
    }
    expect(scanImportSource(dir)?.reason).toBe('symlink-rejected')
  })
  it('rejects a JSON file over the 10 MiB limit', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'huge.json'), Buffer.alloc(10 * 1024 * 1024 + 1))
    expect(scanImportSource(dir)?.reason).toBe('json-too-large')
  })
  it('小文件目录不会被误判为超过 1GiB 总量硬限制(边界健全性检查)', () => {
    // 真正写 1GiB+ 数据会让这个用例变得很慢且浪费磁盘;目录总量累加逻辑与已经过
    // 测试的 json-too-large/too-many-files 判断走同一段数值比较代码路径,这里只
    // 确认小文件不会被误判命中该分支,不覆盖真正跨越 1GiB 边界那条路径本身。
    const dir = scratch()
    writeFileSync(join(dir, 'small.bin'), Buffer.alloc(1024))
    expect(scanImportSource(dir)).toBeNull()
  })
  it('rejects when recursive file count exceeds 5000', () => {
    const dir = scratch()
    const sub = join(dir, 'many'); mkdirSync(sub)
    for (let i = 0; i < 5001; i++) writeFileSync(join(sub, `f${i}.txt`), '')
    expect(scanImportSource(dir)?.reason).toBe('too-many-files')
  }, 20000)
  it('directory entries alone (no files) also count toward the 5000 limit — a source made entirely of empty subdirectories cannot bypass the cap', () => {
    const dir = scratch()
    for (let i = 0; i < 5001; i++) mkdirSync(join(dir, `d${i}`))
    expect(scanImportSource(dir)?.reason).toBe('too-many-files')
  }, 20000)
})
