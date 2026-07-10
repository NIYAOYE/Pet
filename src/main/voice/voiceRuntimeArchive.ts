import AdmZip from 'adm-zip'

export interface ArchiveIO {
  extractZip(zipPath: string, destDir: string): Promise<void>
  createZip(srcDir: string, zipPath: string): Promise<void>
}

export async function importVoiceRuntimeArchive(opts: {
  zipPath: string
  destDir: string
  io: ArchiveIO
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await opts.io.extractZip(opts.zipPath, opts.destDir)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

export async function exportVoiceRuntimeArchive(opts: {
  srcDir: string
  zipPath: string
  io: ArchiveIO
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await opts.io.createZip(opts.srcDir, opts.zipPath)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

export function createAdmZipArchiveIO(): ArchiveIO {
  return {
    async extractZip(zipPath: string, destDir: string): Promise<void> {
      const zip = new AdmZip(zipPath)
      zip.extractAllTo(destDir, true)
    },
    async createZip(srcDir: string, zipPath: string): Promise<void> {
      const zip = new AdmZip()
      zip.addLocalFolder(srcDir)
      zip.writeZip(zipPath)
    }
  }
}
