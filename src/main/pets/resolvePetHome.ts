import { ensurePetHome, type PetHomeResult } from './petHome'

export interface ResolvePetHomeOptions {
  userDataDir: string
  bundledPetsDir: string
  configuredPetId: string
  defaultPetId: string
  /** 旧全局 userData/memory;仅在最终落地的是默认宠物时才会被迁移,见 ensurePetHome 语义 */
  legacyMemoryDir: string
}

export type ResolvePetHomeResult =
  | { mode: 'ready'; petHome: PetHomeResult }
  | { mode: 'onboarding' }

/**
 * 解析活跃宠物家目录:先试 configuredPetId,失败则回退 defaultPetId;两者都没有
 * 对应的宠物包(内置或已导入到 userData)时返回 onboarding,交给调用方走引导导入
 * 流程,而不是抛错让 startShell 变成无窗口的启动失败。
 */
export function resolvePetHome(opts: ResolvePetHomeOptions): ResolvePetHomeResult {
  const { userDataDir, bundledPetsDir, configuredPetId, defaultPetId, legacyMemoryDir } = opts
  try {
    const petHome = ensurePetHome({
      userDataDir,
      bundledPetsDir,
      activePetId: configuredPetId,
      legacyMemoryDir: configuredPetId === defaultPetId ? legacyMemoryDir : undefined
    })
    return { mode: 'ready', petHome }
  } catch (err) {
    if (configuredPetId === defaultPetId) return { mode: 'onboarding' }
    console.warn(`[pet] activePetId "${configuredPetId}" 无对应宠物包,回退默认 "${defaultPetId}"`, err)
    try {
      const petHome = ensurePetHome({ userDataDir, bundledPetsDir, activePetId: defaultPetId, legacyMemoryDir })
      return { mode: 'ready', petHome }
    } catch (err2) {
      console.warn('[pet] 默认宠物包也不存在,进入引导导入模式', err2)
      return { mode: 'onboarding' }
    }
  }
}
