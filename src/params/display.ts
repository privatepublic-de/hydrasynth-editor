import { CHOICE_TABLES, DISPLAY_TABLES, PARAMS } from './generated'
import { EXTRA_VALUE_LABELS, LABELS_FROM } from './overrides'
import type { ParamDef } from './types'

export function formatValue(def: ParamDef, value: number): string {
  const extra = EXTRA_VALUE_LABELS[def.key]?.[value]
  if (extra !== undefined) return extra
  // Values the tables don't know (FX sidechain 5/6 on an EQ, unset LFO steps): shown, kept.
  if (value < def.min || value > def.max) return `? (${value})`
  const source = LABELS_FROM[def.key]
  if (source) {
    const named = CHOICE_TABLES[PARAMS.find((p) => p.key === source)!.choices!].find(([v]) => v === value)
    if (named) return named[1]
  }
  if (def.display !== undefined) return DISPLAY_TABLES[def.display][value - def.min] ?? String(value)
  if (def.choices !== undefined) return CHOICE_TABLES[def.choices].find(([v]) => v === value)?.[1] ?? String(value)
  if (def.widget === 'check') return value ? 'On' : 'Off'
  return String(value - (def.displayOffset ?? 0))
}

export function choicesOf(def: ParamDef): [number, string][] {
  return def.choices !== undefined ? CHOICE_TABLES[def.choices] : []
}
