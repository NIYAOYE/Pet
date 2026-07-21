import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const CORE_SDK_URL = 'https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-5-r.5.zip'
const ZIP_ENTRY_PREFIX = 'CubismSdkForWeb-5-r.5/Core/'

const _dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(_dirname, '..')
const vendorDir = join(repoRoot, 'vendor', 'live2d-core')
const publicDir = join(repoRoot, 'src', 'renderer', 'public')

async function main() {
  console.log(`Downloading ${CORE_SDK_URL} ...`)
  const res = await fetch(CORE_SDK_URL)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length === 0) throw new Error('downloaded zip is empty')

  const zip = new AdmZip(buffer)
  const jsEntry = zip.getEntry(`${ZIP_ENTRY_PREFIX}live2dcubismcore.js`)
  const dtsEntry = zip.getEntry(`${ZIP_ENTRY_PREFIX}live2dcubismcore.d.ts`)
  if (!jsEntry) {
    throw new Error(`zip 里找不到 ${ZIP_ENTRY_PREFIX}live2dcubismcore.js —— Live2D 可能改了 SDK 包的目录结构,需要更新这个脚本`)
  }

  mkdirSync(vendorDir, { recursive: true })
  mkdirSync(publicDir, { recursive: true })

  const jsBuffer = jsEntry.getData()
  writeFileSync(join(vendorDir, 'live2dcubismcore.js'), jsBuffer)
  writeFileSync(join(publicDir, 'live2dcubismcore.js'), jsBuffer)
  if (dtsEntry) writeFileSync(join(vendorDir, 'live2dcubismcore.d.ts'), dtsEntry.getData())

  console.log(`Done. Wrote:\n  ${join(vendorDir, 'live2dcubismcore.js')}\n  ${join(publicDir, 'live2dcubismcore.js')}`)
}

main().catch((err) => {
  console.error('[fetch-live2d-core] 失败:', err)
  process.exitCode = 1
})
