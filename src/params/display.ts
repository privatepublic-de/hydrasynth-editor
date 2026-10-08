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
  if (def.options) return def.options.find(([v]) => v === value)?.[1] ?? String(value)
  if (def.display !== undefined) return DISPLAY_TABLES[def.display][value - def.min] ?? String(value)
  if (def.choices !== undefined) return CHOICE_TABLES[def.choices].find(([v]) => v === value)?.[1] ?? String(value)
  if (def.widget === 'check') return value ? 'On' : 'Off'
  return String(value - (def.displayOffset ?? 0))
}

export function choicesOf(def: ParamDef): [number, string][] {
  return def.options ?? (def.choices !== undefined ? CHOICE_TABLES[def.choices] : [])
}

const ZERO_LABEL = /^[-+]?0([.,]0*)?\s*(%|dB)?$/
const isZeroLabel = (s: string) => ZERO_LABEL.test(s.trim()) || s === 'Linear' || s === '--'
const centers = new Map<string, number | undefined>()

/**
 * A bipolar dial's zero (the raw value shown as 0, Linear or a centred pan), or undefined for
 * a dial that starts at its zero. Most bipolar params are stored 0..1024 with a table, so this
 * goes by the display, not by `min < 0`.
 */
export function centerValue(def: ParamDef): number | undefined {
  if (centers.has(def.key)) return centers.get(def.key)
  const zeros: number[] = []
  for (let v = def.min; v <= def.max; v++) if (isZeroLabel(formatValue(def, v))) zeros.push(v)
  const center = zeros.length && zeros[0] > def.min && zeros.at(-1)! < def.max ? zeros[zeros.length >> 1] : undefined
  centers.set(def.key, center)
  return center
}
