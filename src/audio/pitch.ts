// The pitch of a recorded note, at any pitch from 20 Hz to 2 kHz: McLeod's normalised square
// difference (NSDF), its first strong peak taken (so a weak fundamental doesn't read an octave
// up), then pinned down over many periods as tools/waveAudio.ts `period` does for the C2 waves.

const F0_MIN = 20
const F0_MAX = 2000

/** NSDF of `x[from..from+length)` at lag `lag`: 1 for a perfect repeat, about 0 for none. */
function nsdf(x: Float32Array, from: number, length: number, lag: number): number {
  let r = 0
  let m = 0
  const end = from + length - lag
  for (let i = from; i < end; i++) {
    const a = x[i]
    const b = x[i + lag]
    r += a * b
    m += a * a + b * b
  }
  return m > 0 ? (2 * r) / m : 0
}

/** The peak of y at the three points around index 1, as an offset (-0.5..0.5) and height. */
function parabola(y0: number, y1: number, y2: number): [number, number] {
  const d = y0 - 2 * y1 + y2
  if (d >= 0) return [0, y1]
  const off = (0.5 * (y0 - y2)) / d
  return [off, y1 - 0.25 * (y0 - y2) * off]
}

/**
 * The period (samples, fractional) of the note in `x[from..to)`, and how clearly it repeats
 * (the NSDF peak, 0..1: under ~0.8 it's no single note, a chord, a drum or noise).
 */
export function detectPeriod(x: Float32Array, sampleRate: number, from = 0, to = x.length): { period: number; clarity: number } {
  const minLag = Math.max(2, Math.floor(sampleRate / F0_MAX))
  const maxLag = Math.ceil(sampleRate / F0_MIN)
  // At least two of the longest periods to compare; no more than 150 ms of the note.
  const length = Math.min(to - from, Math.max(Math.round(0.15 * sampleRate), 2 * maxLag + 2))
  // Lags up to half the stretch: past that too few samples overlap, and any lag can look like a repeat.
  const top = Math.min(maxLag, Math.floor(length / 2))
  if (top <= minLag) return { period: 0, clarity: 0 }
  const n = new Float32Array(top + 2)
  for (let lag = 0; lag <= top + 1; lag++) n[lag] = nsdf(x, from, length, lag)
  // Key maxima: the highest point between each rise through zero and the next fall through it.
  const peaks: number[] = []
  let best = -1
  for (let lag = 1; lag <= top; lag++) {
    if (n[lag - 1] <= 0 && n[lag] > 0) best = lag
    else if (best >= 0 && n[lag] > n[best]) best = lag
    if (best >= 0 && n[lag] > 0 && n[lag + 1] <= 0) {
      if (best >= minLag) peaks.push(best)
      best = -1
    }
  }
  if (best >= minLag) peaks.push(best)
  if (!peaks.length) return { period: 0, clarity: 0 }
  const highest = Math.max(...peaks.map((p) => n[p]))
  const lag = peaks.find((p) => n[p] >= 0.9 * highest)!
  const [off, clarity] = parabola(n[lag - 1], n[lag], n[lag + 1])
  return { period: lag + off, clarity: Math.min(1, clarity) }
}

/**
 * `period` pinned down over the span `x[from..to)` (up to a second of it): the lag of k periods
 * finds it k times finer than one period does.
 */
export function refinePeriod(x: Float32Array, sampleRate: number, period: number, from: number, to: number): number {
  const span = Math.min(to - from, sampleRate)
  const k = Math.floor((0.5 * span) / period)
  if (k < 2) return period
  const centre = k * period
  // +-0.3 % (5 cents): the coarse estimate is closer than that. Less than a period, though, or a
  // high note's k periods could be taken for k - 1 or k + 1.
  const reach = Math.max(2, Math.min(Math.ceil(centre * 0.003), Math.floor(0.4 * period)))
  const lo = Math.max(1, Math.floor(centre - reach))
  const hi = Math.ceil(centre + reach)
  let bestLag = lo
  let bestScore = -Infinity
  const scores = new Map<number, number>()
  for (let lag = lo - 1; lag <= hi + 1; lag++) {
    const s = nsdf(x, from, span, lag)
    scores.set(lag, s)
    if (lag >= lo && lag <= hi && s > bestScore) {
      bestScore = s
      bestLag = lag
    }
  }
  const [off] = parabola(scores.get(bestLag - 1)!, bestScore, scores.get(bestLag + 1)!)
  return (bestLag + off) / k
}

/** The period near `period` (within 6 %) in a short stretch `x[from..from+length)`: for following vibrato. */
export function periodNear(x: Float32Array, period: number, from: number, length: number): number | null {
  const lo = Math.max(2, Math.floor(period * 0.94))
  const hi = Math.ceil(period * 1.06)
  if (from + length + hi + 1 > x.length || length <= hi + 1) return null
  let bestLag = lo
  let bestScore = -Infinity
  const n: number[] = []
  for (let lag = lo - 1; lag <= hi + 1; lag++) {
    const s = nsdf(x, from, length, lag)
    n[lag - lo + 1] = s
    if (lag >= lo && lag <= hi && s > bestScore) {
      bestScore = s
      bestLag = lag
    }
  }
  if (bestScore < 0.5) return null
  const i = bestLag - lo + 1
  return bestLag + parabola(n[i - 1], n[i], n[i + 1])[0]
}

/** The nearest MIDI note to `hz` and how far off it is (cents, -50..50). */
export function noteOf(hz: number): { midi: number; cents: number } {
  const exact = 69 + 12 * Math.log2(hz / 440)
  const midi = Math.round(exact)
  return { midi, cents: Math.round((exact - midi) * 100) }
}

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
/** "C4" for MIDI 60, as PITCHES in src/ui/waveSpeech.ts count (C2 = 65.41 Hz). */
export const noteName = (midi: number) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`
