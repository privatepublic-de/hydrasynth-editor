// The oscillators in a held note: each a harmonic series of its own, found in one long spectrum of
// the note's body. Two oscillators a ninth or a fifth apart repeat together only at a common
// divisor far under either (A#2 +13 cents and C4 every 29 Hz), which the period search then takes
// for the note; apart, each plays at its own pitch with its own harmonics.
import { fft } from './fft'

/** One oscillator: its pitch and its share of the note's power in harmonics (0..1). */
export interface Series {
  f0: number
  share: number
}

/** Peaks within this many Hz are one partial: a pulse width's sidebands, a chorus's spread. */
const CLUSTER_HZ = 4
/** A candidate has to have this share of its first 8 harmonics (a square's odd ones are half). */
const DENSITY = 0.45
/** A lower candidate has to explain this much more than a higher one (the period search's 0.9). */
const HIGHER = 0.9
/** What an oscillator has to explain to be one: this share of the power. */
const LEAST = 0.03
const TOP_HZ = 6000

/**
 * The harmonic series in `x[from..to)` (up to 4 s of it), the loudest first; their pitches pinned
 * down from all their harmonics. An empty list where there is nothing like a series.
 */
export function seriesIn(x: Float32Array, sampleRate: number, from: number, to: number): Series[] {
  let n = 8192
  while (n * 2 <= Math.min(to - from, 4 * sampleRate)) n *= 2
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i++) re[i] = (x[from + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)))
  fft(re, im)
  const bin = sampleRate / n
  const last = Math.min(n / 2 - 1, Math.floor(TOP_HZ / bin))
  const power = new Float64Array(last + 2)
  for (let b = 0; b <= last + 1; b++) power[b] = re[b] * re[b] + im[b] * im[b]
  const top = power.reduce((m, v) => Math.max(m, v), 0)
  if (!top) return []

  // Peaks over -50 dB, where the parabola through the log power puts them; then clusters.
  const partials: { hz: number; e: number }[] = []
  for (let b = 2; b <= last; b++) {
    if (!(power[b] > power[b - 1] && power[b] >= power[b + 1] && power[b] > top * 1e-5)) continue
    const [l, m, r] = [Math.log(power[b - 1]), Math.log(power[b]), Math.log(power[b + 1])]
    const d = l - 2 * m + r
    const hz = (b + (d < 0 ? (0.5 * (l - r)) / d : 0)) * bin
    const prev = partials[partials.length - 1]
    if (prev && hz - prev.hz < CLUSTER_HZ) {
      if (power[b] > prev.e) prev.hz = hz
      prev.e += power[b]
    } else partials.push({ hz, e: power[b] })
  }
  const total = partials.reduce((s, p) => s + p.e, 0)

  const found: Series[] = []
  let left = partials
  for (let round = 0; round < 3 && left.length; round++) {
    const loud = [...left].sort((a, b) => b.e - a.e).slice(0, 10)
    const quiet = loud[0].e * 1e-4
    const candidates: { f0: number; e: number; used: Set<number>; fit: [number, number] }[] = []
    for (const p of loud)
      for (let k = 1; k <= 8 && p.hz / k >= 20; k++) {
        const f0 = p.hz / k
        let e = 0
        let hits = 0
        const used = new Set<number>()
        // Least squares for f0 from the harmonics found: sum(w k hz) / sum(w k^2).
        let skh = 0
        let skk = 0
        // An oscillator plays its fundamental; two a fifth apart share harmonics of one an octave under, but not it.
        let fundamental = false
        for (let h = 1; h * f0 < TOP_HZ; h++) {
          const tol = Math.max(2, 0.004 * h * f0)
          let j = -1
          let off = Infinity
          for (let i = 0; i < left.length; i++) {
            const o = Math.abs(left[i].hz - h * f0)
            if (o < tol && o < off) [j, off] = [i, o]
          }
          if (j < 0) continue
          e += left[j].e
          used.add(j)
          skh += left[j].e * h * left[j].hz
          skk += left[j].e * h * h
          if (h <= 8 && left[j].e > quiet) hits++
          if (h === 1 && left[j].e > quiet) fundamental = true
        }
        if (fundamental && hits / Math.min(8, Math.floor(TOP_HZ / f0)) >= DENSITY) candidates.push({ f0, e, used, fit: [skh, skk] })
      }
    if (!candidates.length) break
    // An octave down explains as much (every other harmonic empty): the highest that explains nearly the most.
    const most = Math.max(...candidates.map((c) => c.e))
    const pick = candidates.filter((c) => c.e >= HIGHER * most).reduce((a, c) => (c.f0 > a.f0 ? c : a))
    if (pick.e < LEAST * total) break
    found.push({ f0: pick.fit[0] / pick.fit[1], share: pick.e / total })
    left = left.filter((_, i) => !pick.used.has(i))
  }
  return found
}

/**
 * Voices: peaks within this many cents of each harmonic, this loud (dB under the loudest there), at
 * this many harmonics; together no wider than `spread` cents, none weaker than `weakest` dB.
 */
const VOICES = { reach: 25, loud: -25, same: 1.2, harmonics: 6, seen: 4, stray: -15, most: 3, spread: 15, weakest: -10 }

/**
 * Voices a few cents apart on one note (three oscillators detuned, a unison): in a long spectrum of
 * `x[from..to)` (up to 6 s) around each of the first harmonics of `f0`, peaks the same cents off at
 * three harmonics or more. An LFO's sidebands stand the same Hz apart, not the same cents, and fill
 * the gaps between: where loud peaks (VOICES.stray) lie off the voices, it's no voices. The
 * loudest VOICES.most, as cents from `f0` and dB under the loudest; null for fewer than three.
 */
export function voicesIn(x: Float32Array, sampleRate: number, f0: number, from: number, to: number): { cents: number; db: number }[] | null {
  let n = 1
  while (n * 2 <= Math.min(to - from, 6 * sampleRate)) n *= 2
  if (n < sampleRate) return null
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i++) re[i] = x[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)))
  fft(re, im)
  const bin = sampleRate / n
  const power = (b: number) => re[b] * re[b] + im[b] * im[b]
  const peaks: { k: number; cents: number; db: number }[] = []
  for (let k = 1; k <= VOICES.harmonics; k++) {
    const lo = Math.floor((k * f0 * 2 ** (-VOICES.reach / 1200)) / bin)
    const hi = Math.ceil((k * f0 * 2 ** (VOICES.reach / 1200)) / bin)
    let top = 0
    for (let b = lo; b <= hi; b++) top = Math.max(top, power(b))
    for (let b = lo; b <= hi; b++) {
      if (!(power(b) > power(b - 1) && power(b) >= power(b + 1)) || power(b) < top * 10 ** (VOICES.loud / 10)) continue
      const [l, m, r] = [Math.log(power(b - 1)), Math.log(power(b)), Math.log(power(b + 1))]
      const d = l - 2 * m + r
      peaks.push({ k, cents: 1200 * Math.log2(((b + (d < 0 ? (0.5 * (l - r)) / d : 0)) * bin) / (k * f0)), db: 10 * Math.log10(power(b) / top) })
    }
  }
  // Group the loud peaks by their cents (each within VOICES.same of its group's mean; quieter ones
  // would bridge voices); a voice is a group at VOICES.seen harmonics or more.
  const sorted = peaks.filter((p) => p.db >= VOICES.stray).sort((a, b) => a.cents - b.cents)
  const groups: (typeof peaks)[] = []
  const mean = (g: typeof peaks) => g.reduce((s, p) => s + p.cents, 0) / g.length
  for (const p of sorted) {
    const last = groups[groups.length - 1]
    if (last && p.cents - mean(last) <= VOICES.same) last.push(p)
    else groups.push([p])
  }
  const voices = groups.filter((g) => new Set(g.map((p) => p.k)).size >= VOICES.seen)
  if (voices.length < 3) return null
  const on = new Set(voices.flat())
  if (peaks.some((p) => !on.has(p) && p.db >= VOICES.stray)) return null
  const level = voices.map((g) => ({ cents: g.reduce((s, p) => s + p.cents, 0) / g.length, db: g.reduce((s, p) => s + p.db, 0) / g.length }))
  const top = Math.max(...level.map((v) => v.db))
  const loudest = level
    .sort((a, b) => b.db - a.db)
    .slice(0, VOICES.most)
    .map((v) => ({ ...v, db: v.db - top }))
    .sort((a, b) => a.cents - b.cents)
  const wide = loudest[loudest.length - 1].cents - loudest[0].cents
  return wide <= VOICES.spread && loudest.every((v) => v.db >= VOICES.weakest) ? loudest : null
}
