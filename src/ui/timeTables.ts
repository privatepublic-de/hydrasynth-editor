// Raw values for times and rates, read from the synth's own display tables (src/params/display.ts):
// an envelope's Attack, Decay and Release each have their own table (Attack runs half as long as
// Decay at the same raw value), so each key gets its own.
import { formatValue } from '../params/display'
import { param } from '../params/patch'

/** A number from a label like "448ms", "1.28s", "5.00" or "2,5" (s and ms as ms, else as shown). */
export function labelNumber(label: string): number {
  const n = parseFloat(label.replace(',', '.'))
  return /\ds$/.test(label.trim()) ? n * 1000 : n
}

const tables = new Map<string, [number, number][]>()
/** Every raw value of `key` with what it shows, as a number (times in ms), increasing. */
export function valueTable(key: string): [number, number][] {
  let table = tables.get(key)
  if (!table) {
    const def = param(key)
    table = []
    for (let v = def.min; v <= def.max; v++) table.push([v, labelNumber(formatValue(def, v))])
    tables.set(key, table)
  }
  return table
}

/** The raw value of `key` showing the nearest to `value` (ms for times), on a log scale. */
export function rawFor(key: string, value: number): number {
  const table = valueTable(key)
  const far = (shown: number) => (value <= 0 || shown <= 0 ? Math.abs(shown - value) * 1e6 : Math.abs(Math.log(shown / value)))
  let best = table[0]
  for (const row of table) if (far(row[1]) < far(best[1])) best = row
  return best[0]
}
