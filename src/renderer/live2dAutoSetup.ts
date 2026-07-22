import type { Live2DManifest, Live2DTransform } from '@shared/petPackage'

/** transform.autoFitted 不是 true(缺失或显式 false)时都需要跑一次自动测算——只有明确
 *  标记过 true 的包才代表"已经算过/人工调过,不要再猜"。 */
export function needsAutoFit(transform: Live2DTransform): boolean {
  return transform.autoFitted !== true
}

export interface ExpressionDefinition {
  Name: string
}

/** 判断是否需要用一个表情尝试破冰、以及挑哪一个:只有 possibleWatermark===true
 *  (导入时检测到原始模型没有声明任何动作/表情)且 stateMap.idle 没有显式声明
 *  expression(尊重宠物包作者的显式配置,不覆盖)时才触发,取模型自带的第一个可用表情。
 *  引擎侧的 expressionManager 不存在或没有表情时 definitions 会是 undefined/空数组,
 *  这里安全返回 undefined,调用方据此跳过,不报错、不重试。 */
export function pickWatermarkBreakExpressionName(
  manifest: Live2DManifest,
  definitions: ExpressionDefinition[] | undefined
): string | undefined {
  if (manifest.render.possibleWatermark !== true) return undefined
  if (manifest.render.stateMap.idle?.expression) return undefined
  return definitions?.[0]?.Name
}
