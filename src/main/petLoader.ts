import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parsePetManifest, parseLive2DManifest, isLive2DManifestRaw, type Live2DManifest, type PetManifest } from '@shared/petPackage'

export function petsDir(appRoot: string): string {
  return join(appRoot, 'pets')
}

/** loadPet() 的返回类型比对外的 PetRenderSource 少一个 resourceBaseUrl——那个字段是运行时
 *  会话状态(token 铸造),不是这个纯读盘函数能凭空生成的,由 GET_PET handler(shell/index.ts)
 *  补上。见 docs/superpowers/specs/2026-07-21-live2d-phase4-renderer-design.md §3.4。 */
export type LoadedPetSource =
  | { type: 'sprite'; manifest: PetManifest; spritesheetDataUrl: string }
  | { type: 'live2d'; manifest: Live2DManifest }

export async function loadPet(petDir: string): Promise<LoadedPetSource> {
  const manifestRaw = JSON.parse(await readFile(join(petDir, 'pet.json'), 'utf-8'))
  if (isLive2DManifestRaw(manifestRaw)) {
    const manifest = parseLive2DManifest(manifestRaw)
    return { type: 'live2d', manifest }
  }
  const manifest = parsePetManifest(manifestRaw)
  const sheetBytes = await readFile(join(petDir, manifest.spritesheetPath))
  const spritesheetDataUrl = `data:image/webp;base64,${sheetBytes.toString('base64')}`
  return { type: 'sprite', manifest, spritesheetDataUrl }
}
