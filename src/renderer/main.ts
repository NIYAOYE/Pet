import { SpritePlayer } from './spritePlayer'

async function boot(): Promise<void> {
  const canvas = document.getElementById('pet') as HTMLCanvasElement
  const { manifest, spritesheetDataUrl } = await window.petApi.getPet()

  const sheet = new Image()
  sheet.src = spritesheetDataUrl
  await sheet.decode()

  const player = new SpritePlayer(canvas, sheet, manifest)
  player.play('idle')

  // 拖拽移动窗口:用鼠标位移增量通知主进程移窗
  let dragging = false
  let lastX = 0
  let lastY = 0

  canvas.addEventListener('mousedown', (e: MouseEvent) => {
    dragging = true
    lastX = e.screenX
    lastY = e.screenY
    canvas.style.cursor = 'grabbing'
  })
  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (!dragging) return
    window.petApi.moveWindow({ dx: e.screenX - lastX, dy: e.screenY - lastY })
    lastX = e.screenX
    lastY = e.screenY
  })
  window.addEventListener('mouseup', () => {
    dragging = false
    canvas.style.cursor = 'grab'
  })
}

boot().catch((err) => console.error('boot failed', err))
