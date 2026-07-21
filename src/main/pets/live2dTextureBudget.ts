import { openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { readPngDimensions, type PngDimensions } from './pngDimensions'

export const TEXTURE_SOFT_WARN_PX = 4096
export const TEXTURE_HARD_LIMIT_PX = 8192
export const TEXTURE_HARD_LIMIT_COUNT = 16

export interface TextureInfo { fileName: string; dims: PngDimensions | null }
export interface TextureBudgetResult { softWarnings: string[]; hardViolation: string | null }

function readFileHead(path: string, n: number): Buffer | null {
  let fd: number
  try { fd = openSync(path, 'r') } catch { return null }
  try {
    const buf = Buffer.alloc(n)
    const read = readSync(fd, buf, 0, n, 0)
    return read < n ? buf.subarray(0, read) : buf
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** 读一批贴图文件(相对 modelDir 的文件名)的宽高,只读前 24 字节,不做完整解码。
 *  读不到/不是合法 PNG 头 → dims:null,交给引用完整性校验去判断"文件缺失"这类别的问题。 */
export function readTextureInfos(modelDir: string, relativeFilePaths: string[]): TextureInfo[] {
  return relativeFilePaths.map((fileName) => {
    const head = readFileHead(join(modelDir, fileName), 24)
    return { fileName, dims: head ? readPngDimensions(head) : null }
  })
}

/** 纯函数:软预算(>4096 警告)/硬限制(>8192 或数量>16 拒绝),数据来自 spike §17.1 实测。 */
export function evaluateTextureBudget(textures: TextureInfo[]): TextureBudgetResult {
  const softWarnings: string[] = []
  let hardViolation: string | null = null
  if (textures.length > TEXTURE_HARD_LIMIT_COUNT) {
    hardViolation = `纹理数量 ${textures.length} 张超过硬限制 ${TEXTURE_HARD_LIMIT_COUNT} 张`
  }
  for (const t of textures) {
    if (!t.dims) continue
    const maxSide = Math.max(t.dims.width, t.dims.height)
    if (maxSide > TEXTURE_HARD_LIMIT_PX) {
      hardViolation = hardViolation ?? `纹理 ${t.fileName} 尺寸 ${t.dims.width}x${t.dims.height} 超过硬限制 ${TEXTURE_HARD_LIMIT_PX}px`
    } else if (maxSide > TEXTURE_SOFT_WARN_PX) {
      softWarnings.push(`纹理 ${t.fileName} 尺寸 ${t.dims.width}x${t.dims.height},可能明显影响帧率(建议 ≤${TEXTURE_SOFT_WARN_PX}px)`)
    }
  }
  return { softWarnings, hardViolation }
}
