import { describe, it, expect, vi } from 'vitest'
import { installWithMirrorFallback, type MirrorCandidate } from './pipMirrorInstall'

describe('installWithMirrorFallback', () => {
  it('第一个候选成功 → 只调用一次 attempt,onProgress 只收到一条"使用中"提示', async () => {
    const candidates: MirrorCandidate[] = [
      { indexUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple', label: '清华源' },
      { indexUrl: undefined, label: '官方源' }
    ]
    const attempt = vi.fn(async () => {})
    const progress: string[] = []
    await installWithMirrorFallback(candidates, attempt, (m) => progress.push(m))
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(attempt).toHaveBeenCalledWith(candidates[0])
    expect(progress).toEqual(['使用清华源安装…'])
  })

  it('第一个候选失败、第二个成功 → 依次调用两次 attempt,onProgress 含失败提示与降级提示', async () => {
    const candidates: MirrorCandidate[] = [
      { indexUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple', label: '清华源' },
      { indexUrl: undefined, label: '官方源' }
    ]
    const attempt = vi.fn()
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValueOnce(undefined)
    const progress: string[] = []
    await installWithMirrorFallback(candidates, attempt, (m) => progress.push(m))
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(attempt).toHaveBeenNthCalledWith(1, candidates[0])
    expect(attempt).toHaveBeenNthCalledWith(2, candidates[1])
    expect(progress).toEqual([
      '使用清华源安装…',
      '清华源安装失败(网络中断),改用下一个源重试…',
      '使用官方源安装…'
    ])
  })

  it('全部候选都失败 → 抛出最后一个错误,attempt 调用次数等于候选数,最后一个候选失败不再输出"改用下一个源"', async () => {
    const candidates: MirrorCandidate[] = [
      { indexUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple', label: '清华源' },
      { indexUrl: undefined, label: '官方源' }
    ]
    const attempt = vi.fn()
      .mockRejectedValueOnce(new Error('镜像 404'))
      .mockRejectedValueOnce(new Error('官方源也超时'))
    const progress: string[] = []
    await expect(installWithMirrorFallback(candidates, attempt, (m) => progress.push(m)))
      .rejects.toThrow('官方源也超时')
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(progress).toEqual(['使用清华源安装…', '清华源安装失败(镜像 404),改用下一个源重试…', '使用官方源安装…'])
  })
})
