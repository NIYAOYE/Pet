import { SpritePlayer } from './spritePlayer'

async function boot(): Promise<void> {
  const canvas = document.getElementById('pet') as HTMLCanvasElement
  const { manifest, spritesheetDataUrl } = await window.petApi.getPet()

  const sheet = new Image()
  sheet.src = spritesheetDataUrl
  await sheet.decode()

  const player = new SpritePlayer(canvas, sheet, manifest)
  player.play('idle')
}

boot().catch((err) => console.error('boot failed', err))
