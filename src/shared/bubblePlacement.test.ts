import { describe, it, expect } from 'vitest'
import { bubblePlacement } from './bubblePlacement'

const WA = { x: 0, y: 0, width: 1920, height: 1040 } // 主屏工作区
const B = { width: 240, height: 172 }

describe('bubblePlacement', () => {
  it('屏幕中央:放头顶、水平居中、尾巴在底部指向宠物中心', () => {
    const pet = { x: 800, y: 500, width: 256, height: 288 }
    const p = bubblePlacement(pet, WA, B)
    expect(p.tailSide).toBe('bottom')
    expect(p.y).toBe(500 - 172 - 8)          // pet.y - height - GAP
    expect(p.x).toBe(Math.round(928 - 120))  // petCenterX(928) - width/2
    expect(p.tailOffsetX).toBe(120)          // 尾巴对准宠物中心 = width/2
  })

  it('宠物贴屏幕顶:头顶放不下 → 翻到下方,尾巴在顶部', () => {
    const pet = { x: 800, y: 10, width: 256, height: 288 }
    const p = bubblePlacement(pet, WA, B)
    expect(p.tailSide).toBe('top')
    expect(p.y).toBe(10 + 288 + 8)           // pet.y + height + GAP
  })

  it('宠物被拖拽到屏幕左侧界外(手动拖拽不夹取位置,可为负):x 夹进工作区左缘', () => {
    // pet.x=-100,width=256 → petCenterX=28;不夹取会得到 x=round(28-120)=-92(越界)
    const pet = { x: -100, y: 500, width: 256, height: 288 }
    const p = bubblePlacement(pet, WA, B)
    expect(p.x).toBe(0)                       // 夹到 workArea.x
    // tailOffsetX = petCenterX - x = 28 - 0 = 28,仍在 [16, 224] 内
    expect(p.tailOffsetX).toBe(28)
  })

  it('宠物被拖拽到屏幕右侧界外:x 夹到右边界,尾巴右移且不超过气泡右内边距', () => {
    // pet.x=1770,width=256 → petCenterX=1898;不夹取会得到 x=round(1898-120)=1778(越界,右边界=1920-240=1680)
    const pet = { x: 1770, y: 500, width: 256, height: 288 }
    const p = bubblePlacement(pet, WA, B)
    expect(p.x).toBe(1920 - 240)              // workArea.right - width
    // tailOffsetX = petCenterX - x = 1898 - 1680 = 218(在 [16,224] 范围内)
    expect(p.tailOffsetX).toBe(218)
  })

  it('宠物被拖拽到右上角界外:同时翻到下方并夹右,尾巴跟随夹取后的 x', () => {
    const pet = { x: 1770, y: 5, width: 256, height: 288 }
    const p = bubblePlacement(pet, WA, B)
    expect(p.tailSide).toBe('top')
    expect(p.x).toBe(1920 - 240)
    expect(p.tailOffsetX).toBe(218)
  })

  it('副屏工作区带偏移,宠物拖到该工作区左侧界外:坐标仍夹在该工作区内(不回退到主屏原点)', () => {
    const wa = { x: 1920, y: 0, width: 1280, height: 1040 }
    // pet.x=1820(工作区左缘 1920 以左 100px) → petCenterX=1948;不夹取得 x=round(1948-120)=1828(< wa.x=1920,越界)
    const pet = { x: 1820, y: 500, width: 256, height: 288 }
    const p = bubblePlacement(pet, wa, B)
    expect(p.x).toBe(1920)                     // 夹到副屏 workArea.x,不回到主屏
    expect(p.tailOffsetX).toBe(28)             // petCenterX - x = 1948 - 1920 = 28
  })

  it('宠物被拖拽到屏幕下方界外(手动拖拽不夹取位置):y 仍夹进工作区', () => {
    // pet.y=5000 远超工作区高度;aboveY = 5000-172-8 = 4820,不夹取会越界
    const pet = { x: 800, y: 5000, width: 256, height: 288 }
    const p = bubblePlacement(pet, WA, B)
    expect(p.y).toBe(1040 - 172) // 夹到 workArea.y + workArea.height - bubble.height
    expect(p.y).toBeGreaterThanOrEqual(WA.y)
    expect(p.y + B.height).toBeLessThanOrEqual(WA.y + WA.height)
  })

  it('宠物被拖拽到屏幕上方界外(手动拖拽不夹取位置):y 仍夹进工作区', () => {
    // pet.y=-500 远在工作区上方;belowY = -500+288+8 = -204,不夹取会越界(负值)
    const pet = { x: 800, y: -500, width: 256, height: 288 }
    const p = bubblePlacement(pet, WA, B)
    expect(p.y).toBe(0) // 夹到 workArea.y
    expect(p.y).toBeGreaterThanOrEqual(WA.y)
  })
})
