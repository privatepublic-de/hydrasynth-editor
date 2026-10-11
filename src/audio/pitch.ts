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
  // A true peak lies within half a step of the middle point; a near-flat curve would throw it far.
  const off = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d))
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

/** How clearly a step has to repeat to be followed: a short, dropping kick reads 0.6-0.8. */
const FOLLOW_CLARITY = 0.6

/** The period between `lo` and `hi` samples in `x[from..from+length)`, and how clearly it repeats (NSDF). */
function periodBetween(x: Float32Array, from: number, length: number, lo: number, hi: number): { period: number; clarity: number } {
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
  const i = bestLag - lo + 1
  const [off, clarity] = parabola(n[i - 1], n[i], n[i + 1])
  return { period: bestLag + off, clarity }
}

/**
 * The period along a note, from `start` (where it's `period`) back to `from` and on to `to`: each
 * step searched within 2.4 semitones of the last (an 808's octave drop in 50 ms is 2.4 a 10 ms
 * step), so a glide of octaves is followed; NaN
 * where it doesn't clearly repeat (an attack's noise); each at the middle of its window. Every 10 ms over the first half second,
 * every 50 ms after; forward only until it has held still for 0.3 s.
 */
export function followPitch(x: Float32Array, sampleRate: number, period: number, start: number, from: number, to: number): { t: number; period: number }[] {
  const out: { t: number; period: number }[] = []
  const step = (t: number) => Math.round((t - from < 0.5 * sampleRate ? 0.01 : 0.05) * sampleRate)
  const walk = (dir: 1 | -1) => {
    let last = period
    // Forward, only while it keeps moving: 0.3 s within a quarter semitone, and it has settled.
    let anchor = { t: start, period }
    for (let t = dir > 0 ? start : start - step(start); dir > 0 ? t < to : t >= from; t += dir * step(t)) {
      if (dir > 0 && t - anchor.t > 0.3 * sampleRate) break
      const lo = Math.max(2, Math.floor(last / 1.15))
      const hi = Math.ceil(last * 1.15)
      // Two periods: over more, a fast drop smears its own repeat.
      const length = Math.max(2 * hi, Math.round(0.01 * sampleRate))
      if (t + length + hi + 2 > x.length) break
      const { period: p, clarity } = periodBetween(x, t, length, lo, hi)
      if (clarity >= FOLLOW_CLARITY) {
        last = p
        if (Math.abs(12 * Math.log2(p / anchor.period)) > 0.25) anchor = { t, period: p }
      }
      out.push({ t: (t + length / 2) / sampleRate, period: clarity >= FOLLOW_CLARITY ? p : NaN })
    }
  }
  walk(1)
  walk(-1)
  return out.sort((a, b) => a.t - b.t)
}

/**
 * The period from one rising zero crossing to the next in `x[from..to)`, after a low-pass at
 * `lowPassHz` (twice, one pole) keeps upper harmonics from crossing too: for a sound that's mostly
 * its fundamental (a kick, a tom) dropping too fast for the period search to follow.
 */
export function crossingPeriods(x: Float32Array, sampleRate: number, from: number, to: number, lowPassHz: number): { t: number; period: number }[] {
  const a = 1 - Math.exp((-2 * Math.PI * lowPassHz) / sampleRate)
  let y1 = 0
  let y2 = 0
  let prev = 0
  let lastCross = NaN
  const out: { t: number; period: number }[] = []
  for (let i = Math.max(0, from); i < Math.min(to, x.length); i++) {
    y1 += a * (x[i] - y1)
    y2 += a * (y1 - y2)
    if (prev < 0 && y2 >= 0) {
      const cross = i - 1 + prev / (prev - y2)
      if (Number.isFinite(lastCross)) out.push({ t: (cross + lastCross) / 2 / sampleRate, period: cross - lastCross })
      lastCross = cross
    }
    prev = y2
  }
  return out
}
