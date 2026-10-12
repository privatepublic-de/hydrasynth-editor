// An FM tine: a DX piano's or bell's bright start, partials high over the note in a series of their
// own (a modulator's sidebands, spaced at its ratio times the note, often a little off the note's
// harmonics) that fade within a few hundred ms while the body sounds on. A closing filter fades the
// upper harmonics too, but all of them, one note's spacing apart: that's no tine. Ratios up to 3
// can't be told from a pulse wave's missing harmonics (3n plus and minus 1 is a 1/3 pulse): a tine
// here is a high one, as on a DX piano or electric piano.
import { fft } from './fft'

export interface Tine {
  /** The series' spacing over the note's pitch, and the whole ratio nearest it (Mutant ratios run 1-12). */
  spacing: number
  ratio: number
  /** The series' power against the whole attack's (dB). */
  db: number
  /** How long until it has faded 20 dB from its loudest (s). */
  fadeS: number
}

/** What counts (see tineOf). */
const TINE = {
  /** Lowest partial considered: over this many Hz and this many harmonics. */
  fromHz: 1500,
  fromHarmonic: 8,
  /** A peak stands this far (dB) over the spectrum around it, within this far under the attack's loudest. */
  prominence: 10,
  range: 60,
  /** Fading: this much more (dB) between the attack and LATE_S than the body under 1 kHz does. */
  fade: 15,
  lateS: 0.3,
  /** A series: at least this many peaks, this share of the fading ones, spaced at least this many notes apart. */
  least: 4,
  share: 0.6,
  minSpacing: 1.8,
  /** Quieter than this against the whole attack (dB) it's a bright wave's own fading top, not heard as a tine. */
  leastDb: -20,
  /** A sideband pair (FM's carrier either side of each point) at least this many notes apart: twice the carrier. */
  pairApart: 1.5,
  /** How far the spacing may be from a whole number of notes (a DX's fine ratio: 6.97 read). */
  offWhole: 0.15,
  /** How close (share of the spacing) a peak must sit to its place in the series. */
  tolerance: 0.04,
}

/** Power (dB) per bin of `x[from..from+n)`, Hann. */
function spectrum(x: Float32Array, from: number, n: number): Float64Array {
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i++) re[i] = (x[from + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)))
  fft(re, im)
  return Float64Array.from({ length: n / 2 }, (_, b) => 10 * Math.log10(re[b] * re[b] + im[b] * im[b] + 1e-20))
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : NaN
}

/**
 * The tine in a note at `f0` starting at sample `onset`, or null: peaks over TINE.fromHz in the
 * first window (4096 samples from the onset) that have faded by LATE_S far more than the body has,
 * a series of TINE.least or more spaced TINE.minSpacing notes apart or more.
 */
export function tineOf(x: Float32Array, sampleRate: number, f0: number, onset: number): Tine | null {
  const n = 4096
  const late = onset + Math.round(TINE.lateS * sampleRate)
  if (late + n > x.length) return null
  const bin = sampleRate / n
  const early = spectrum(x, onset, n)
  const after = spectrum(x, late, n)
  // The body's own fall, under 1 kHz, at its harmonics.
  const bodyFade = median(Array.from({ length: Math.floor(1000 / f0) }, (_, k) => Math.round(((k + 1) * f0) / bin)).filter((b) => b > 0).map((b) => early[b] - after[b]))
  const top = Math.max(...early)
  const lo = Math.max(Math.ceil(TINE.fromHz / bin), Math.ceil((TINE.fromHarmonic * f0) / bin))
  const hi = Math.min(early.length - 4, Math.floor(Math.min(12000, 0.45 * sampleRate) / bin))
  const peaks: number[] = []
  for (let b = lo; b <= hi; b++) {
    let isPeak = early[b] > top - TINE.range
    for (let d = 1; isPeak && d <= 3; d++) isPeak = early[b] >= early[b - d] && early[b] >= early[b + d]
    if (!isPeak) continue
    const around = median(Array.from({ length: 41 }, (_, i) => early[Math.min(early.length - 1, Math.max(0, b - 20 + i))]))
    if (early[b] - around < TINE.prominence) continue
    if (early[b] - after[b] - bodyFade < TINE.fade) continue
    peaks.push(b * bin)
  }
  if (peaks.length < TINE.least) return null
  // The spacing they share. FM puts its sidebands either side of each multiple of the modulator
  // (n x ratio, plus and minus the carrier): around a series' points the peaks gather at one or two
  // places, the same each time. Every gap between peaks is tried; the one gathering the most, the
  // widest of equals. Two places half a spacing apart are a series of half the spacing (all the
  // harmonics of a closing filter, two to a step).
  const gaps = [...new Set(peaks.flatMap((p, i) => peaks.slice(i + 1).map((q) => q - p)))].filter((g) => g >= TINE.minSpacing * f0 && g <= 12.5 * f0)
  const circular = (a: number, b: number) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b))
  let best = { spacing: 0, members: [] as number[], count: 0 }
  for (const gap of gaps) {
    const place = peaks.map((p) => ((((p - peaks[0]) / gap) % 1) + 1) % 1)
    const gathered = (c: number) => place.filter((v) => circular(v, c) < TINE.tolerance).length
    const first = place.reduce((x, v) => (gathered(v) > gathered(x) ? v : x))
    const rest = place.filter((v) => circular(v, first) >= TINE.tolerance)
    const second = rest.length ? rest.reduce((x, v) => (gathered(v) > gathered(x) ? v : x)) : null
    // Nor are two places a note or so apart: a pulse wave lacking every third harmonic, its top fading.
    const paired = second !== null && Math.abs(circular(first, second) - 0.5) >= TINE.tolerance && circular(first, second) * gap >= TINE.pairApart * f0
    const count = gathered(first) + (paired ? gathered(second!) : 0)
    if (count > best.count || (count === best.count && gap > best.spacing))
      best = { spacing: gap, count, members: peaks.filter((_, i) => circular(place[i], first) < TINE.tolerance) }
  }
  if (best.count < TINE.least || best.count < TINE.share * peaks.length || best.members.length < 2) return null
  // The spacing refined over the series' ends, on one side of its points.
  const steps = Math.round((best.members[best.members.length - 1] - best.members[0]) / best.spacing)
  const spacingHz = (best.members[best.members.length - 1] - best.members[0]) / steps
  // Its power against the attack's, and how it fades: the fading peaks' bins every 10 ms over 0.6 s.
  const power = (s: Float64Array, bins: number[]) => bins.reduce((sum, b) => sum + 10 ** (s[b] / 10), 0)
  const near = (s: Float64Array, hz: number, width: number) => {
    const c = Math.round(hz / (sampleRate / (2 * s.length)))
    return Array.from({ length: 2 * width + 1 }, (_, i) => c - width + i).filter((b) => b > 0 && b < s.length)
  }
  const memberBins = peaks.flatMap((hz) => near(early, hz, 2))
  const db = 10 * Math.log10(power(early, memberBins) / power(early, Array.from({ length: early.length - 1 }, (_, i) => i + 1)))
  if (db < TINE.leastDb) return null
  const m = 2048
  const track: number[] = []
  for (let t = onset; t + m <= Math.min(x.length, onset + 0.6 * sampleRate); t += Math.round(0.01 * sampleRate)) {
    const s = spectrum(x, t, m)
    track.push(10 * Math.log10(power(s, peaks.flatMap((hz) => near(s, hz, 1)))))
  }
  const loudest = track.indexOf(Math.max(...track))
  const faded = track.findIndex((v, i) => i > loudest && v <= track[loudest] - 20)
  // A tine is gone in a few hundred ms: one still there after 0.6 s is the note's own top.
  if (faded < 0) return null
  const fadeS = (faded - loudest) * 0.01
  // A modulator at a whole ratio of the note: its series sits near a whole number of notes.
  const spacing = spacingHz / f0
  if (Math.abs(spacing - Math.round(spacing)) > TINE.offWhole) return null
  return { spacing, ratio: Math.max(1, Math.min(12, Math.round(spacing))), db, fadeS }
}
