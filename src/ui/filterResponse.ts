// Frequency-response pictures of the two filters, from type, cutoff, resonance and (Filter 2)
// morph. Textbook analog responses of each type's order and kind -- the slopes and the
// resonance peak read right, but the synth's own circuits aren't modelled. Cutoff 0..1024 is
// drawn over 20 Hz .. 20 kHz on a log scale (the synth only shows 0..128).
import type { Patch } from '../params/patch'

type C = [number, number]
const mul = (a: C, b: C): C => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]
const div = (a: C, b: C): C => {
  const d = b[0] * b[0] + b[1] * b[1]
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]
}
const add = (a: C, b: C): C => [a[0] + b[0], a[1] + b[1]]
const scale = (a: C, k: number): C => [a[0] * k, a[1] * k]
const abs = (a: C) => Math.hypot(a[0], a[1])

export const F_MIN = 20
export const F_MAX = 20000
export const cutoffHz = (v: number) => F_MIN * (F_MAX / F_MIN) ** (Math.max(0, Math.min(1024, v)) / 1024)
/** Resonance 0..1024 as the Q of the resonant section: 0.5 (none) up to ~16. */
const resonanceQ = (v: number) => 0.5 + 15.5 * (Math.max(0, Math.min(1024, v)) / 1024) ** 2

/** Second-order sections at s = j*w/wc: denominator s^2 + s/Q + 1. */
function sections(w: number, q: number) {
  const s: C = [0, w]
  const s2 = mul(s, s)
  const d = add(add(s2, scale(s, 1 / q)), [1, 0])
  return {
    lp: div([1, 0], d),
    bp: div(scale(s, 1 / q), d),
    hp: div(s2, d),
    notch: div(add(s2, [1, 0]), d),
    lp1: div([1, 0], add(s, [1, 0])),
    hp1: div(s, add(s, [1, 0])),
  }
}

/** Filter 1 types (filter1type); 16 is a second code for Vowel. */
const F1 = {
  LADDER_12: 0, LADDER_24: 1, FAT_12: 2, FAT_24: 3, GATE: 4, MS20_LP: 5, MS20_HP: 6,
  THREE_LP: 7, THREE_BP: 8, THREE_HP: 9, VOWEL: 10, STN_LP: 11, STN_BP: 12, STN_HP: 13,
  ONE_POLE: 14, EIGHT_POLE: 15, VOWEL_ALT: 16,
}

/** Male formants F1-F3 (Hz) of the five vowels, as commonly tabulated. */
const FORMANTS: Record<string, [number, number, number]> = {
  A: [730, 1090, 2440],
  E: [530, 1840, 2480],
  I: [270, 2290, 3010],
  O: [570, 840, 2410],
  U: [300, 870, 2240],
}
const VOWEL_ORDERS = ['AEIOU', 'AIUEO', 'AUIOE', 'AOUIE', 'IOUAE', 'UEAOI', 'IOEAU', 'UIEAO']

/** Linear gain of Filter 1 at `hz`. */
export function filter1Gain(patch: Patch, hz: number): number {
  const type = patch.get('filter1type')
  const fc = cutoffHz(patch.get('filter1cutoff'))
  const q = resonanceQ(patch.get('filter1resonance'))
  const w = hz / fc
  const r = sections(w, q)
  const plain = sections(w, 0.54)
  switch (type) {
    case F1.LADDER_12:
    case F1.FAT_12:
    case F1.GATE:
    case F1.MS20_LP:
    case F1.STN_LP:
      return abs(r.lp)
    case F1.LADDER_24:
    case F1.FAT_24:
      return abs(mul(r.lp, plain.lp))
    case F1.MS20_HP:
    case F1.STN_HP:
      return abs(r.hp)
    case F1.THREE_LP:
      return abs(mul(r.lp, r.lp1))
    case F1.THREE_BP:
    case F1.STN_BP:
      return abs(r.bp)
    case F1.THREE_HP:
      return abs(mul(r.hp, r.hp1))
    case F1.ONE_POLE:
      return abs(r.lp1)
    case F1.EIGHT_POLE:
      return abs(mul(mul(r.lp, plain.lp), mul(plain.lp, plain.lp)))
    case F1.VOWEL:
    case F1.VOWEL_ALT:
      return vowelGain(patch, hz)
    default:
      return abs(r.lp)
  }
}

/** Three formant band-passes, interpolated along the Vowel Order by Control; Cutoff shifts them. */
function vowelGain(patch: Patch, hz: number): number {
  const order = VOWEL_ORDERS[patch.get('filter1vowelorder')] ?? VOWEL_ORDERS[0]
  const pos = (patch.get('filter1special') / 1024) * (order.length - 1)
  const i = Math.min(order.length - 2, Math.floor(pos))
  const f = pos - i
  const a = FORMANTS[order[i]]
  const b = FORMANTS[order[i + 1]]
  const shift = 2 ** ((patch.get('filter1cutoff') - 512) / 512)
  const q = 4 + resonanceQ(patch.get('filter1resonance'))
  let sum: C = [0, 0]
  for (let k = 0; k < 3; k++) {
    const fk = (a[k] + (b[k] - a[k]) * f) * shift
    sum = add(sum, scale(sections(hz / fk, q).bp, k === 0 ? 1 : 0.7))
  }
  return abs(sum)
}

/** Linear gain of Filter 2: a state-variable filter morphing LP > BP (or Notch) > HP. */
export function filter2Gain(patch: Patch, hz: number): number {
  const fc = cutoffHz(patch.get('filter2cutoff'))
  const q = resonanceQ(patch.get('filter2resonance'))
  const r = sections(hz / fc, q)
  const middle = patch.get('filter2type') === 1 ? r.notch : r.bp
  const m = (patch.get('filter2morph') / 1024) * 2
  const h = m <= 1 ? add(scale(r.lp, 1 - m), scale(middle, m)) : add(scale(middle, 2 - m), scale(r.hp, m - 1))
  return abs(h)
}

/** Points (x 0..1 over log frequency, y in dB) for drawing. */
export function responseCurve(gain: (hz: number) => number, points = 160): { x: number; db: number }[] {
  return Array.from({ length: points + 1 }, (_, i) => {
    const x = i / points
    const hz = F_MIN * (F_MAX / F_MIN) ** x
    return { x, db: 20 * Math.log10(Math.max(1e-6, gain(hz))) }
  })
}
