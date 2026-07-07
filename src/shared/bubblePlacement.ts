import type { Bounds } from './petBrain'

export interface BubblePlacement {
  x: number
  y: number
  tailSide: 'top' | 'bottom'
  tailOffsetX: number
}

const GAP = 8          // 气泡与宠物之间的竖直间隙
const TAIL_MARGIN = 16 // 尾巴中心离气泡左右缘的最小距离

/**
 * 计算气泡伴随窗的左上角坐标与尾巴指向。
 * 默认放宠物头顶、水平以宠物中心对齐;越界时:
 *  - 头顶放不下 → 翻到宠物下方(尾巴改朝上);
 *  - 左右放不下 → 水平夹进工作区,尾巴水平偏移单独算以持续指向宠物;
 *  - 上下都放不下 → 夹进工作区(可见性优先)。
 * 输出的 x/y 始终完全落在 workArea 内。
 */
export function bubblePlacement(
  pet: Bounds,
  workArea: Bounds,
  bubble: { width: number; height: number }
): BubblePlacement {
  const petCenterX = pet.x + pet.width / 2

  // 水平:以宠物中心对齐,再夹进工作区
  let x = Math.round(petCenterX - bubble.width / 2)
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - bubble.width))

  // 竖直:优先头顶,不够翻下方,再不够夹进工作区
  const aboveY = pet.y - bubble.height - GAP
  const belowY = pet.y + pet.height + GAP
  let y: number
  let tailSide: 'top' | 'bottom'
  if (aboveY >= workArea.y) {
    y = aboveY
    tailSide = 'bottom'
  } else if (belowY + bubble.height <= workArea.y + workArea.height) {
    y = belowY
    tailSide = 'top'
  } else {
    y = Math.max(workArea.y, Math.min(aboveY, workArea.y + workArea.height - bubble.height))
    tailSide = 'bottom'
  }

  // 尾巴水平偏移:指向宠物中心(相对气泡左缘),夹到内边距范围内
  let tailOffsetX = Math.round(petCenterX - x)
  tailOffsetX = Math.max(TAIL_MARGIN, Math.min(tailOffsetX, bubble.width - TAIL_MARGIN))

  return { x, y, tailSide, tailOffsetX }
}
