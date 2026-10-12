// Builds src/params/generated.ts from what tools/edisyn-extract/ dumped out of Edisyn's
// Hydrasynth driver. Usage: npx vite-node tools/generateParams.ts [extract dir, default local/extract]
import { readFileSync, writeFileSync } from 'node:fs'
import type { Condition, NrpnSpec, ParamDef } from '../src/params/types'

const dir = process.argv[2] ?? 'local/extract'
const EDISYN_COMMIT = readFileSync(`${dir}/EDISYN_COMMIT`, 'utf8').trim()

interface Meta {
  key: string
  string?: boolean
  min: number
  max: number
  kind?: string
  labels?: string[]
  display?: string[]
  choices?: [number, string][]
}

const meta = new Map<string, Meta>()
for (const line of readFileSync(`${dir}/meta.jsonl`, 'utf8').trim().split('\n')) {
  const m = JSON.parse(line) as Meta
  meta.set(m.key, m)
}

const layout = new Map<string, { offset: number; size: 1 | 2; bit?: number }>()
for (const line of readFileSync(`${dir}/layout.tsv`, 'utf8').trim().split('\n')) {
  const [key, pos, width, bit] = line.split('\t')
  if (layout.has(key)) throw new Error(`${key} read at two positions`)
  layout.set(key, { offset: +pos, size: +width as 1 | 2, ...(+bit >= 0 ? { bit: +bit } : {}) })
}

const nrpnRows = new Map<string, (number | null | number[])[][]>()
for (const line of readFileSync(`${dir}/nrpn.jsonl`, 'utf8').trim().split('\n')) {
  const o = JSON.parse(line)
  nrpnRows.set(o.key, o.emits)
}

// Edisyn reads these with its 1-byte setter, but real patches hold 256 (= +128) here, which needs both bytes.
const TWO_BYTE_OVERRIDES = /^voicemodulation\d$/
// FX params never reach Edisyn's FX branch (its per-key NRPN lookup fails first); its code
// implies the generic per-slot param numbers, x8. Confirmed on the user's Desktop
// (2026-10-08: Pre-FX EQ Low Gain and Xover Lo set live showed the expected values).
const FX_PARAM_NRPN: Record<string, number[]> = {
  pre: [8431, 8432, 7600, 7616, 7632],
  post: [8434, 8435, 7728, 7744, 7760],
}

function condition(key: string): Condition | undefined {
  let m: RegExpMatchArray | null
  if ((m = key.match(/^((?:env|lfo)\d)\w+sync(on|off)$/))) return { key: `${m[1]}bpmsync`, values: [m[2] === 'on' ? 1 : 0] }
  if ((m = key.match(/^delaytimesync(on|off)$/))) return { key: 'delaybpmsync', values: [m[1] === 'on' ? 1 : 0] }
  if ((m = key.match(/^voicevibratoratesync(on|off)$/))) return { key: 'voicevibratobpmsync', values: [m[1] === 'on' ? 1 : 0] }
  if ((m = key.match(/^(mutant\d)sourceoscsync$/))) return { key: `${m[1]}mode`, values: [2] }
  if ((m = key.match(/^(mutant\d)sourcefmlin$/))) return { key: `${m[1]}mode`, values: [2], negate: true }
  if ((m = key.match(/^(pre|post)fx(\d)param\d$/))) return { key: `${m[1]}fxtype`, values: [+m[2]] }
  return undefined
}

// Captions Edisyn shortens where the editor shows the knob without its context.
const LABEL_OVERRIDES: Record<string, string[]> = {
  mixerfilterrouting: ['Filter Routing'],
}

// The synth sends these but ignores them on receive (Edisyn's notes): whole-patch send only.
const RECEIVE_IGNORED = new Set(['arptempo', 'filter1vowelorder'])
// Bytes outside the param layout that a field's high byte must not overwrite: the patch name
// (9-25) and the macro names (1630 + 17 per macro).
const STRING_BYTES = new Set<number>([
  ...Array.from({ length: 17 }, (_, i) => 9 + i),
  ...Array.from({ length: 8 * 17 }, (_, i) => 1630 + i),
])
// What the extraction is expected to leave out; a different set means the dump didn't
// exercise some parser branch (or Edisyn changed), so look before trusting the schema.
const EXPECTED_SKIPPED = [
  'bank', 'env2trigsrc1', 'name', 'number',
  ...Array.from({ length: 8 }, (_, i) => `macro${i + 1}name`),
  ...Array.from({ length: 5 }, (_, i) => `postfxparam${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `prefxparam${i + 1}`),
].sort()

const cleanLabel = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()

function interned<T>(tables: T[], index: Map<string, number>, table: T): number {
  const id = JSON.stringify(table)
  let i = index.get(id)
  if (i === undefined) {
    i = tables.push(table) - 1
    index.set(id, i)
  }
  return i
}

const displayTables: string[][] = []
const displayIndex = new Map<string, number>()
const choiceTables: [number, string][][] = []
const choiceIndex = new Map<string, number>()
const nrpnTables: number[][] = []
const nrpnIndex = new Map<string, number>()

function nrpnSpec(key: string, min: number): NrpnSpec | undefined {
  const fx = key.match(/^(pre|post)fx\dparam(\d)$/)
  if (fx) return { param: FX_PARAM_NRPN[fx[1]][+fx[2] - 1], base: 0, mul: 8, negAdd: 0 }
  const rows = nrpnRows.get(key)
  if (!rows) return undefined
  // Edisyn sends Env/LFO Quantize unscaled because firmware 2.0.0 didn't divide it by 8 on input
  // (it always sent it x8); on 2.2.0 it divides, so only the last choice landed, as the first.
  if (/^(env|lfo)\dquantize$/.test(key)) return { ...nrpnSpecFromRows(key, min, rows)!, mul: 8 }
  return nrpnSpecFromRows(key, min, rows)
}

function nrpnSpecFromRows(key: string, min: number, rows: (number | null | number[])[][]): NrpnSpec | undefined {
  const points: [number, number, number][] = []
  for (const [v, ...msgs] of rows as [number, ...(number[] | null)[]][]) {
    if (msgs.length === 1 && msgs[0] === null) continue
    if (msgs.length === 0) continue
    const cc = new Map((msgs as number[][]).map(([c, x]) => [c, x]))
    if (msgs.length !== 4 || ![99, 98, 6, 38].every((c) => cc.has(c))) throw new Error(`${key}=${v}: not one NRPN: ${JSON.stringify(msgs)}`)
    points.push([v, (cc.get(99)! << 7) | cc.get(98)!, (cc.get(6)! << 7) | cc.get(38)!])
  }
  if (points.length === 0) return undefined
  const params = new Set(points.map((p) => p[1]))
  if (params.size !== 1) throw new Error(`${key}: NRPN number varies with the value`)
  const param = points[0][1]
  if (points.length !== rows.length) throw new Error(`${key}: NRPN for some values only`)
  for (const mul of [1, 8]) {
    const nonNeg = points.filter((p) => p[0] >= 0)
    const neg = points.filter((p) => p[0] < 0)
    const bases = new Set(nonNeg.map(([v, , w]) => w - v * mul))
    if (bases.size > 1) continue
    const base = nonNeg.length ? [...bases][0] : 0
    const negAdds = new Set(neg.map(([v, , w]) => w - base - v * mul))
    if (negAdds.size > 1) continue
    return { param, base, mul, negAdd: neg.length ? [...negAdds][0] : 0 }
  }
  const values = points.map((p) => p[2])
  if (points[0][0] !== min) throw new Error(`${key}: table does not start at min`)
  return { param, table: interned(nrpnTables, nrpnIndex, values) }
}

const params: ParamDef[] = []
const skipped: string[] = []
for (const m of meta.values()) {
  const field = layout.get(m.key)
  if (m.string || m.key === 'bank' || m.key === 'number' || (!field && m.key !== 'voicevibratoamount')) {
    skipped.push(m.key)
    continue
  }
  if (!m.kind || !['dial', 'choice', 'check'].includes(m.kind)) throw new Error(`${m.key}: widget ${m.kind}`)
  const def: ParamDef = {
    key: m.key,
    labels: LABEL_OVERRIDES[m.key] ?? (m.labels ?? []).map(cleanLabel).filter(Boolean),
    min: m.min,
    max: m.max,
    widget: m.kind as ParamDef['widget'],
  }
  if (field) {
    def.field = { ...field, signed: m.min < 0 }
    if (TWO_BYTE_OVERRIDES.test(m.key)) def.field.size = 2
  } else def.special = 'vibratoAmount'
  const when = condition(m.key)
  if (when) def.when = when
  if (m.display) {
    const shown = m.display.map(cleanLabel)
    const offsets = new Set(shown.map((s, i) => (/^-?\d+$/.test(s) ? m.min + i - Number(s) : NaN)))
    if (offsets.size === 1 && !offsets.has(NaN)) def.displayOffset = [...offsets][0]
    else def.display = interned(displayTables, displayIndex, shown)
  } else if (m.choices) {
    def.choices = interned(
      choiceTables,
      choiceIndex,
      m.choices.map(([v, l]) => [v, cleanLabel(l)] as [number, string]),
    )
  }
  const nrpn = RECEIVE_IGNORED.has(m.key) ? undefined : nrpnSpec(m.key, m.min)
  if (nrpn) def.nrpn = nrpn
  params.push(def)
}

// Every byte two params share must be told apart by a condition (or be separate bits).
const byOffset = new Map<number, ParamDef[]>()
for (const p of params) if (p.field && p.field.bit === undefined) byOffset.set(p.field.offset, [...(byOffset.get(p.field.offset) ?? []), p])
for (const [offset, ps] of byOffset) if (ps.length > 1 && ps.some((p) => !p.when)) throw new Error(`byte ${offset} shared without a condition: ${ps.map((p) => p.key)}`)

if (JSON.stringify([...skipped].sort()) !== JSON.stringify(EXPECTED_SKIPPED))
  throw new Error(`skipped keys changed: ${[...skipped].sort().join(' ')}`)

const owned = new Set<number>(STRING_BYTES)
for (const p of params) if (p.field) owned.add(p.field.offset)
for (const p of params) {
  const f = p.field
  if (f && f.size === 1 && f.bit === undefined && !f.signed && owned.has(f.offset + 1)) f.packed = true
}

const categories = JSON.parse(readFileSync(`${dir}/tables.json`, 'utf8')).MOD_DESTINATION_CATEGORIES as number[]

const json = (v: unknown) => JSON.stringify(v)
const out = `// GENERATED by tools/generateParams.ts -- do not edit.
// Derived from Edisyn's ASM Hydrasynth driver (https://github.com/eclab/edisyn, commit ${EDISYN_COMMIT}),
// Copyright 2023 Sean Luke, Apache License 2.0; see NOTICE.
import type { ParamDef } from './types'

export const PARAMS: ParamDef[] = [
${params.map((p) => `  ${json(p)},`).join('\n')}
]

export const DISPLAY_TABLES: string[][] = ${json(displayTables)}

export const CHOICE_TABLES: [number, string][][] = ${json(choiceTables)}

export const NRPN_TABLES: number[][] = ${json(nrpnTables)}

/** Category byte the synth stores next to each mod-matrix and macro target, indexed by target. */
export const MOD_DESTINATION_CATEGORIES: number[] = ${json(categories)}
`
writeFileSync('src/params/generated.ts', out)
console.log(
  `${params.length} params (${params.filter((p) => p.nrpn).length} with NRPN), skipped ${skipped.length}: ${skipped.join(' ')}`,
)
console.log(`tables: ${displayTables.length} display, ${choiceTables.length} choice, ${nrpnTables.length} nrpn; ${(out.length / 1024).toFixed(0)} KB`)
