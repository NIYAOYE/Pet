export interface QuickAction { id: string; label: string; instruction: string }

/** 托盘「快捷加工」子菜单项;菜单与本表同源。翻译中↔英的自动方向写在 instruction 里。 */
export const QUICK_ACTIONS: QuickAction[] = [
  { id: 'translate', label: '翻译(中↔英)', instruction: '若下面内容主要是中文,翻成地道英文;否则翻成通顺中文。只输出译文,不加解释。' },
  { id: 'summarize', label: '总结要点', instruction: '把下面内容压成 3–5 条要点,简洁准确,用中文。' },
  { id: 'polish', label: '润色改写', instruction: '把下面文字润色得更通顺得体,保持原意与原语言,不要新增信息。只输出润色后的文本。' },
  { id: 'explain', label: '解释说明', instruction: '把下面的术语/代码/报错用通俗中文解释清楚。' }
]

export function findQuickAction(id: string): QuickAction | undefined {
  return QUICK_ACTIONS.find((a) => a.id === id)
}
