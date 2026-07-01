import { frameRect, frameDurationMs, type PetManifest, type PetAnimation } from '@shared/petPackage'

export function nextFrameIndex(current: number, frames: number, loop: boolean): number {
  const next = current + 1
  if (next < frames) return next
  return loop ? 0 : frames - 1
}

export class SpritePlayer {
  private timer: number | null = null
  private frame = 0
  private state = ''
  constructor(
    private canvas: HTMLCanvasElement,
    private sheet: HTMLImageElement,
    private manifest: PetManifest
  ) {}

  play(state: string): void {
    const anim = this.manifest.animations[state]
    if (!anim) return
    this.state = state
    this.frame = 0
    this.tick(anim)
  }

  stop(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
  }

  private tick(anim: PetAnimation): void {
    this.draw(anim, this.frame)
    const delay = frameDurationMs(anim, this.frame)
    const next = nextFrameIndex(this.frame, anim.frames, anim.loop)
    if (next === this.frame && !anim.loop) return // held last frame
    this.timer = window.setTimeout(() => {
      this.frame = next
      if (this.manifest.animations[this.state] === anim) this.tick(anim)
    }, delay)
  }

  private draw(anim: PetAnimation, index: number): void {
    const r = frameRect(this.manifest.sheet, anim.row, index)
    const ctx = this.canvas.getContext('2d')!
    this.canvas.width = r.w
    this.canvas.height = r.h
    ctx.clearRect(0, 0, r.w, r.h)
    ctx.drawImage(this.sheet, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
  }
}
