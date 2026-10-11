// Which params the mod matrix and macro destinations modulate. A destination is an index
// into the synth's destination list (modmatrixNmodtarget, macroNtargetM share it); this maps
// each one onto the param keys it acts on, by the list's own names.
import type { Patch } from '../params/patch'

const range = (n: number, from = 1) => Array.from({ length: n }, (_, i) => i + from)
const synced = (p: string) => [`${p}syncoff`, `${p}syncon`]
const fx = (side: 'pre' | 'post', n: number) => range(9).map((t) => `${side}fx${t}param${n}`)

/** Destination index -> the keys it modulates (null: nothing in the patch, e.g. a MIDI CC). */
export const DESTINATION_KEYS: (string[] | null)[] = [
  null, // Off
  ...['mode', 'division', 'swing', 'gate', 'octave', 'octmode', 'length', 'phrase', 'ratchet', 'chance'].map((k) => [`arp${k}`]),
  ['osc1semi', 'osc1cent'], ['osc1type'], ['osc1wavscan'],
  ['osc2semi', 'osc2cent'], ['osc2type'], ['osc2wavscan'],
  ['osc3semi', 'osc3cent'], ['osc3type'],
  null, // All Osc Pitch: no single param
  ...range(4).flatMap((m) => [
    ...['ratio', 'depth', 'window', 'feedback', 'wet'].map((k) => [`mutant${m}${k}`]),
    ...range(8).map((w) => [`mutant${m}warp${w}`]),
  ]),
  ['ringmoddepth'],
  ...['osc1', 'osc2', 'osc3', 'ringmod', 'noise'].map((s) => [`mixer${s}vol`]),
  ...['osc1', 'osc2', 'osc3', 'ringmod', 'noise'].map((s) => [`mixer${s}pan`]),
  ...['osc1', 'osc2', 'osc3', 'ringmod', 'noise'].map((s) => [`mixer${s}filterratio`]),
  ...['cutoff', 'resonance', 'drive', 'special', 'env1amount', 'lfo1amount', 'keytrack'].map((k) => [`filter1${k}`]),
  ...['morph', 'cutoff', 'resonance', 'env1amount', 'lfo1amount', 'keytrack'].map((k) => [`filter2${k}`]),
  ['amplfo2amount'], ['amplevel'],
  fx('pre', 1), fx('pre', 2), ['prefxwet'],
  synced('delaytime'), ['delayfeedback'], ['delaywettone'], ['delayfeedtone'], ['delaywet'],
  ['reverbtime'], ['reverbtone'], ['reverbhidamp'], ['reverblodamp'], ['reverbwet'],
  fx('post', 1), fx('post', 2), ['postfxwet'],
  ...range(5).flatMap((e) => [synced(`env${e}attack`), synced(`env${e}hold`), synced(`env${e}decay`), [`env${e}sustain`], synced(`env${e}release`)]),
  ...range(5).flatMap((l) => [synced(`lfo${l}rate`), [`lfo${l}level`]]),
  ...range(32).map((r) => [`modmatrix${r}depth`]),
  ...range(8).map((m) => [`macro${m}panelvalue`]),
  ['voicedetune'], ['voiceanalogfeel'], ['voicepitchbend'], ['voicevibratoamount'], synced('voicevibratorate'), ['voiceglidetime'],
  null, null, // CV Mod Out 1, 2
  ...range(128, 0).map(() => null), // CC 0-127
]

const DESTINATION_OF = new Map<string, number>()
DESTINATION_KEYS.forEach((keys, i) => keys?.forEach((k) => DESTINATION_OF.set(k, i)))

/** The destination that modulates `key`, if any. */
export const destinationOf = (key: string): number | undefined => DESTINATION_OF.get(key)

export type Modulation = { kind: 'matrix'; route: number } | { kind: 'macro'; macro: number; slot: number }

export const MATRIX_ROUTES = 32
export const MACROS = 8
export const MACRO_SLOTS = 8

/** Every param modulated in the patch, with the routes and macro assignments doing it. */
export function modulations(patch: Patch): Map<string, Modulation[]> {
  const out = new Map<string, Modulation[]>()
  const add = (dest: number, m: Modulation) => {
    for (const key of DESTINATION_KEYS[dest] ?? []) out.set(key, [...(out.get(key) ?? []), m])
  }
  for (const route of range(MATRIX_ROUTES)) {
    const dest = patch.get(`modmatrix${route}modtarget`)
    // A route needs a source too; with Off it moves nothing.
    if (dest && patch.get(`modmatrix${route}modsource`)) add(dest, { kind: 'matrix', route })
  }
  for (const macro of range(MACROS))
    for (const slot of range(MACRO_SLOTS)) {
      const dest = patch.get(`macro${macro}target${slot}`)
      if (dest) add(dest, { kind: 'macro', macro, slot })
    }
  return out
}

/** The first mod-matrix route with neither source nor destination, or undefined if all are used. */
export const freeRoute = (patch: Patch) =>
  range(MATRIX_ROUTES).find((r) => !patch.get(`modmatrix${r}modtarget`) && !patch.get(`modmatrix${r}modsource`))

/** The first unused assignment (destination) of a macro. */
export const freeMacroSlot = (patch: Patch, macro: number) => range(MACRO_SLOTS).find((s) => !patch.get(`macro${macro}target${s}`))

/** Depth's raw value for zero: the middle of 0..1024 (-128..128 on the synth). */
export const CENTER_DEPTH = 512

/**
 * When `key` puts something into an empty mod matrix route or macro assignment, the depth to centre
 * with it: an empty slot's depth reads 0, which is full negative, not none.
 */
export function newSlotDepth(patch: Patch, key: string, value: number): string | undefined {
  if (!value) return undefined
  const route = /^modmatrix(\d+)mod(?:target|source)$/.exec(key)?.[1]
  const macro = /^macro(\d+)target(\d+)$/.exec(key)
  const depth = route ? `modmatrix${route}depth` : macro ? `macro${macro[1]}depth${macro[2]}` : undefined
  if (!depth || patch.get(depth) !== 0) return undefined
  const empty = route ? !patch.get(`modmatrix${route}modtarget`) && !patch.get(`modmatrix${route}modsource`) : !patch.get(key)
  return empty ? depth : undefined
}
