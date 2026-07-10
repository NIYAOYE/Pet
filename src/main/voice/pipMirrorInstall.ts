export interface MirrorCandidate {
  indexUrl?: string
  label: string
}

export async function installWithMirrorFallback(
  candidates: MirrorCandidate[],
  attempt: (candidate: MirrorCandidate) => Promise<void>,
  onProgress: (message: string) => void
): Promise<void> {
  let lastError: unknown
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    onProgress(`使用${candidate.label}安装…`)
    try {
      await attempt(candidate)
      return
    } catch (e) {
      lastError = e
      const isLast = i === candidates.length - 1
      if (!isLast) {
        onProgress(`${candidate.label}安装失败(${String((e as Error)?.message ?? e)}),改用下一个源重试…`)
      }
    }
  }
  throw lastError
}
