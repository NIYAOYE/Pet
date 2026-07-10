import { describe, it, expect, vi } from 'vitest'
import { importVoiceRuntimeArchive, exportVoiceRuntimeArchive, type ArchiveIO } from './voiceRuntimeArchive'

describe('importVoiceRuntimeArchive', () => {
  it('extractZip 成功 → ok:true', async () => {
    const io: ArchiveIO = { extractZip: vi.fn(async () => {}), createZip: vi.fn() }
    const r = await importVoiceRuntimeArchive({ zipPath: 'a.zip', destDir: 'D:/vr', io })
    expect(r).toEqual({ ok: true })
    expect(io.extractZip).toHaveBeenCalledWith('a.zip', 'D:/vr')
  })

  it('extractZip 失败 → ok:false 带错误信息', async () => {
    const io: ArchiveIO = { extractZip: vi.fn(async () => { throw new Error('压缩包损坏') }), createZip: vi.fn() }
    const r = await importVoiceRuntimeArchive({ zipPath: 'a.zip', destDir: 'D:/vr', io })
    expect(r).toEqual({ ok: false, error: '压缩包损坏' })
  })
})

describe('exportVoiceRuntimeArchive', () => {
  it('createZip 成功 → ok:true', async () => {
    const io: ArchiveIO = { extractZip: vi.fn(), createZip: vi.fn(async () => {}) }
    const r = await exportVoiceRuntimeArchive({ srcDir: 'D:/vr', zipPath: 'out.zip', io })
    expect(r).toEqual({ ok: true })
    expect(io.createZip).toHaveBeenCalledWith('D:/vr', 'out.zip')
  })

  it('createZip 失败 → ok:false 带错误信息', async () => {
    const io: ArchiveIO = { extractZip: vi.fn(), createZip: vi.fn(async () => { throw new Error('磁盘空间不足') }) }
    const r = await exportVoiceRuntimeArchive({ srcDir: 'D:/vr', zipPath: 'out.zip', io })
    expect(r).toEqual({ ok: false, error: '磁盘空间不足' })
  })
})
