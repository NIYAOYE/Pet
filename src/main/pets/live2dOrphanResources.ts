import { readdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'

export interface Model3Json {
  FileReferences: {
    Moc?: string
    Textures?: string[]
    Physics?: string
    Pose?: string
    DisplayInfo?: string
    Expressions?: { Name: string; File: string }[]
    Motions?: Record<string, { File: string }[]>
    [key: string]: unknown
  }
  [key: string]: unknown
}

function baseNameNoExt(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath
  return base.replace(/\.exp3\.json$/, '')
}

/** 扫描游离(未被 FileReferences 声明)的 *.exp3.json / *.motion3.json,合成补丁写回。
 *  找到的动作统一挂到 Motions.Recovered 分组;表情按文件名(去扩展名)生成 Name。 */
export function scanAndPatchOrphanResources(
  model3Json: Model3Json,
  allModelDirFiles: string[]
): { patchedModel3Json: Model3Json; recoveredExpressionCount: number; recoveredMotionCount: number } {
  const declaredExpr = new Set((model3Json.FileReferences.Expressions ?? []).map((e) => e.File))
  const declaredMotionFiles = new Set(
    Object.values(model3Json.FileReferences.Motions ?? {}).flat().map((m) => m.File)
  )
  const orphanExpr = allModelDirFiles.filter((f) => f.endsWith('.exp3.json') && !declaredExpr.has(f))
  const orphanMotion = allModelDirFiles.filter((f) => f.endsWith('.motion3.json') && !declaredMotionFiles.has(f))

  const patched: Model3Json = JSON.parse(JSON.stringify(model3Json))
  if (orphanExpr.length > 0) {
    patched.FileReferences.Expressions = [
      ...(model3Json.FileReferences.Expressions ?? []),
      ...orphanExpr.map((f) => ({ Name: baseNameNoExt(f), File: f }))
    ]
  }
  if (orphanMotion.length > 0) {
    patched.FileReferences.Motions = {
      ...(model3Json.FileReferences.Motions ?? {}),
      Recovered: [...(model3Json.FileReferences.Motions?.Recovered ?? []), ...orphanMotion.map((f) => ({ File: f }))]
    }
  }
  return { patchedModel3Json: patched, recoveredExpressionCount: orphanExpr.length, recoveredMotionCount: orphanMotion.length }
}

/** 补丁后仍然没有任何 Motions/Expressions → 可能是需要额外处理的受保护/水印模型(见 spike §17.4)。 */
export function detectPossibleWatermarkProtection(model3Json: Model3Json): boolean {
  const hasExpr = (model3Json.FileReferences.Expressions ?? []).length > 0
  const hasMotion = Object.values(model3Json.FileReferences.Motions ?? {}).some((arr) => arr.length > 0)
  return !hasExpr && !hasMotion
}

/** 递归列出 modelDir 下所有文件,返回相对 modelDir 的正斜杠路径(model3.json 内部引用惯例用正斜杠)。 */
export function listModelFilesRecursive(modelDir: string): string[] {
  const out: string[] = []
  function walk(dir: string, prefix: string): void {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      if (lstatSync(full).isDirectory()) walk(full, rel)
      else out.push(rel)
    }
  }
  walk(modelDir, '')
  return out
}
