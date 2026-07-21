import { describe, it, expect } from 'vitest'
import { readPngDimensions } from './pngDimensions'

/** 手工拼一份只有合法 PNG 签名 + IHDR 头(签名 8 字节 + 长度 4 字节 + "IHDR" 4 字节 +
 *  宽 4 字节 + 高 4 字节 = 24 字节)的 buffer——足够 readPngDimensions 用,
 *  不需要 CRC/IDAT/IEND(它只读前 24 字节)。 */
function fakePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0) // PNG signature
  buf.writeUInt32BE(13, 8)          // IHDR chunk length (unused by our reader, but realistic)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

describe('readPngDimensions', () => {
  it('reads width/height from a valid PNG header', () => {
    expect(readPngDimensions(fakePng(4096, 2048))).toEqual({ width: 4096, height: 2048 })
  })
  it('returns null for a buffer shorter than 24 bytes', () => {
    expect(readPngDimensions(Buffer.alloc(10))).toBeNull()
  })
  it('returns null when the PNG signature is wrong', () => {
    const buf = fakePng(100, 100)
    buf[0] = 0x00
    expect(readPngDimensions(buf)).toBeNull()
  })
  it('returns null when the chunk type is not IHDR', () => {
    const buf = fakePng(100, 100)
    buf.write('IDAT', 12, 'ascii')
    expect(readPngDimensions(buf)).toBeNull()
  })
  it('returns null for zero width/height', () => {
    expect(readPngDimensions(fakePng(0, 100))).toBeNull()
  })
})
