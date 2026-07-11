import type { Line } from '../lines/linesLoader'

export interface AppFocusRule { match: string[]; lines: Line[] }

export function parseAppFocusRules(raw: string): AppFocusRule[] {
  let data: unknown
  try { data = JSON.parse(raw) } catch { return [] }
  if (typeof data !== 'object' || data === null) return []
  const rulesRaw = (data as Record<string, unknown>).app_focus
  if (!Array.isArray(rulesRaw)) return []

  const rules: AppFocusRule[] = []
  for (const item of rulesRaw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>

    if (!Array.isArray(rec.match)) continue
    const match = rec.match.filter((m): m is string => typeof m === 'string' && m.length > 0)
    if (match.length === 0) continue

    if (!Array.isArray(rec.lines)) continue
    const lines: Line[] = []
    for (const lineItem of rec.lines) {
      if (typeof lineItem !== 'object' || lineItem === null) continue
      const lineRec = lineItem as Record<string, unknown>
      if (typeof lineRec.text !== 'string') continue
      const line: Line = { text: lineRec.text }
      if (typeof lineRec.audio === 'string') line.audio = lineRec.audio
      lines.push(line)
    }
    if (lines.length === 0) continue

    rules.push({ match, lines })
  }
  return rules
}

export function matchAppFocusRule(
  rules: AppFocusRule[],
  sample: { processName: string; windowTitle: string }
): AppFocusRule | null {
  const haystack = `${sample.processName} ${sample.windowTitle}`.toLowerCase()
  for (const rule of rules) {
    if (rule.match.some((m) => haystack.includes(m.toLowerCase()))) return rule
  }
  return null
}
