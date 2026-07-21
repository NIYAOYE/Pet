const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface PngDimensions { width: number; height: number }

/** 只读文件头 24 字节(签名 8 + 长度 4 + "IHDR" 4 + 宽 4 + 高 4),不做完整解码。
 *  格式不对/尺寸非法一律返回 null,调用方决定怎么处理(不是这里的职责)。 */
export function readPngDimensions(buf: Buffer): PngDimensions | null {
  if (buf.length < 24) return null
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (width <= 0 || height <= 0) return null
  return { width, height }
}
