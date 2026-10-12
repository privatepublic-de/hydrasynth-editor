// Slow movement in a held note, the way a pad lives: an LFO under 3 Hz on its pitch, its level or
// its timbre (a filter or a pulse width swinging back and forth). Vibrato and tremolo, 3-9 Hz, are
// src/audio/analyse.ts `wobble`'s; this reads what is slower, over the whole held part.
import { fft } from './fft'
import { periodNear } from './pitch'
import { harmonicBands, harmonicCount, harmonicsAt } from './spectrum'

/** A slow swing: its rate, and how far it goes to either side (cents, or dB). */
export interface Swing {
  rateHz: number
  depth: number
}

export interface Movement {
  /** `centre`: where it swings around, cents from `f0`. */
  pitch: (Swing & { centre: number }) | null
  /**
   * Two oscillators a few cents apart beating, not an LFO: harmonic k swells and fades at k times
   * the fundamental's rate, where an LFO swings them all at its own; `depth` the fundamental's
   * swing, dB RMS (as src/audio/dirt.ts reads a detune's). Level and timbre then read no swing: the
   * beat is theirs.
   */
  beat: { rateHz: number; depth: number } | null
  level: Swing | null
  /** The timbre swinging: the harmonics (dB, loudest 0; NaN where another oscillator's lie) at either end of the swing. */
  timbre: { rateHz: number; low: number[]; high: number[] } | null
}

const HOP_S = 0.05
/** Slower than vibrato and tremolo, and at least two swings in the stretch read. */
const RATES = { lo: 0.1, hi: 3 }
/** How clearly a track has to repeat (its autocorrelation at the swing's period). */
const CLEAR = 0.8
/** Less than this is no swing to play: cents, dB, and dB between the timbre's two ends. */
const LEAST = { cents: 5, db: 1.5, timbre: 2 }
/** How near (share) a harmonic's rate has to be to k times the fundamental's to count as beating. */
const NEAR = 0.12
/** A timbre swing's ends: the frames where its sine is this far (share) to either side. */
const END = 0.85
const FLOOR = -60

/** A sinusoid's fit to `y` at `rateHz` (one value per HOP_S): amplitude and phase per sample. */
function sine(y: number[], rateHz: number): { amp: number; at: (i: number) => number } {
  let ss = 0
  let sc = 0
  let s2 = 0
  let c2 = 0
  let sxc = 0
  y.forEach((v, i) => {
    const s = Math.sin(2 * Math.PI * rateHz * i * HOP_S)
    const c = Math.cos(2 * Math.PI * rateHz * i * HOP_S)
    ss += v * s
    sc += v * c
    s2 += s * s
    c2 += c * c
    sxc += s * c
  })
  const det = s2 * c2 - sxc * sxc || 1
  const a = (ss * c2 - sc * sxc) / det
  const b = (sc * s2 - ss * sxc) / det
  return { amp: Math.hypot(a, b), at: (i) => a * Math.sin(2 * Math.PI * rateHz * i * HOP_S) + b * Math.cos(2 * Math.PI * rateHz * i * HOP_S) }
}

/**
 * The slow swing in `track` (one value per HOP_S): smoothed over 0.2 s (vibrato out), its line
 * taken out (a slow fade or rise isn't a swing), then the strongest repeat between RATES.
 */
function swingOf(track: number[]): { rateHz: number; fit: ReturnType<typeof sine>; y: number[]; mean: number } | null {
  const n = track.length
  const w = Math.round(0.1 / HOP_S)
  const smooth = track.map((_, i) => {
    let s = 0
    let c = 0
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++, c++) s += track[j]
    return s / c
  })
  const mean = smooth.reduce((s, v) => s + v, 0) / n
  const mid = (n - 1) / 2
  let sxy = 0
  let sxx = 0
  smooth.forEach((v, i) => {
    sxy += (i - mid) * (v - mean)
    sxx += (i - mid) ** 2
  })
  const y = smooth.map((v, i) => v - mean - (sxy / sxx) * (i - mid))
  const energy = y.reduce((s, v) => s + v * v, 0)
  if (!energy) return null
  const r = (lag: number) => {
    let s = 0
    for (let i = 0; i + lag < n; i++) s += y[i] * y[i + lag]
    return (s / (n - lag)) * (n / energy)
  }
  // Peaks, the first nearly as high as the highest: a swing repeating every cycle repeats every two.
  const peaks: number[] = []
  const hi = Math.min(Math.floor(n / 2), Math.round(1 / (RATES.lo * HOP_S)))
  for (let l = Math.max(2, Math.ceil(1 / (RATES.hi * HOP_S))); l <= hi; l++) if (r(l) >= r(l - 1) && r(l) >= r(l + 1)) peaks.push(l)
  const highest = Math.max(0, ...peaks.map(r))
  if (highest < CLEAR) return null
  const lag = peaks.find((l) => r(l) >= 0.9 * highest)!
  const [a, b, c] = [r(lag - 1), r(lag), r(lag + 1)]
  const d = a - 2 * b + c
  const rateHz = 1 / ((lag + (d < 0 ? (0.5 * (a - c)) / d : 0)) * HOP_S)
  // The smoothing takes some of a faster swing too (a third at 1.5 Hz): its depth as before it.
  const fit = sine(y, rateHz)
  const width = 2 * w + 1
  const kept = Math.abs(Math.sin(Math.PI * rateHz * width * HOP_S) / (width * Math.sin(Math.PI * rateHz * HOP_S)))
  return { rateHz, fit: { amp: fit.amp / kept, at: fit.at }, y, mean }
}

/** The first principal component of `rows` (each a frame's levels): each frame's score along it. */
function mainComponent(rows: number[][]): number[] {
  const k = rows[0].length
  const mean = rows[0].map((_, j) => rows.reduce((s, r) => s + r[j], 0) / rows.length)
  const centred = rows.map((r) => r.map((v, j) => v - mean[j]))
  let v = mean.map(() => 1 / Math.sqrt(k))
  for (let iteration = 0; iteration < 40; iteration++) {
    const scores = centred.map((r) => r.reduce((s, x, j) => s + x * v[j], 0))
    const next = v.map((_, j) => centred.reduce((s, r, i) => s + r[j] * scores[i], 0))
    const norm = Math.hypot(...next) || 1
    v = next.map((x) => x / norm)
  }
  return centred.map((r) => r.reduce((s, x, j) => s + x * v[j], 0))
}

/**
 * The slow movement of the note at `f0` over `x[from..to)`: null where the stretch is too short
 * for two swings of the slowest it could hold (under a second). With another oscillator beside it
 * at `other` Hz, the period search follows their sum: each is read at its own steady pitch, its
 * harmonics on or beside the other's left out.
 */
export function measureMovement(x: Float32Array, sampleRate: number, f0: number, from: number, to: number, other?: number): Movement | null {
  const follow = other === undefined
  const period = sampleRate / f0
  const window = Math.max(8 * period, 0.08 * sampleRate)
  // Harmonics the other oscillator's lie on or beside (within the window's reach) move with it: left out.
  const reach = (1.5 * sampleRate) / window
  const mine = (k: number) => other === undefined || Math.abs((k + 1) * f0 - Math.round(((k + 1) * f0) / other) * other) >= reach
  const span = Math.round(Math.max(3 * period, 0.03 * sampleRate))
  const count = harmonicCount(f0, sampleRate)
  const level: number[] = []
  const pitch: number[] = []
  const timbre: number[][] = []
  const each: number[][] = [[], [], [], []]
  for (let t = from; t + window < to; t += HOP_S * sampleRate) {
    const p = follow ? periodNear(x, period, Math.round(t + (window - span) / 2), span) : null
    pitch.push(p === null ? NaN : 1200 * Math.log2(period / p))
    // At the pitch it has then: 20 cents off, the 24th harmonic is read 70 Hz off, and darkens.
    const hz = p === null ? f0 : sampleRate / p
    const h = harmonicsAt(x, sampleRate, hz, t, t + window, count)
    level.push(10 * Math.log10(h.amps.reduce((s, a, k) => s + (mine(k) ? a * a : 0), 0) + 1e-12))
    // The timbre as each harmonic's band's power: within the window, vibrato, a beat or a chorus
    // moves the upper harmonics off their exact frequencies (the ends would read dark). Beside
    // another oscillator, exactly: its harmonics would fall in the bands.
    const heard = other === undefined ? harmonicBands(x, h, hz, t, t + window, sampleRate) : h
    timbre.push(heard.levels.map((l, k) => (mine(k) ? Math.max(l, FLOOR) : FLOOR)))
    each.forEach((track, k) => track.push(mine(k) ? 20 * Math.log10((h.amps[k] ?? 0) + 1e-9) : 0))
  }
  if (level.length * HOP_S < 1) return null

  // Pitch: only where it's followed nearly all along (gaps bridged).
  let pitchSwing: Movement['pitch'] = null
  const followed = pitch.filter(Number.isFinite).length
  if (follow && followed >= 0.9 * pitch.length) {
    const filled = pitch.map((v, i) => (Number.isFinite(v) ? v : (pitch.slice(0, i).reverse().find(Number.isFinite) ?? pitch.find(Number.isFinite)!)))
    const s = swingOf(filled)
    if (s && s.fit.amp >= LEAST.cents) pitchSwing = { rateHz: s.rateHz, depth: s.fit.amp, centre: s.mean }
  }
  // Beating: harmonics 2-4 swell at 2-4 times the fundamental's rate, most of them.
  const swings = each.map((track) => swingOf(track))
  const first = swings[0]
  const beats = first ? swings.slice(1).filter((w, i) => w && Math.abs(w.rateHz / ((i + 2) * first.rateHz) - 1) < NEAR).length : 0
  if (first && beats >= 2) return { pitch: pitchSwing, beat: { rateHz: first.rateHz, depth: first.fit.amp / Math.SQRT2 }, level: null, timbre: null }

  const l = swingOf(level)
  const levelSwing = l && l.fit.amp >= LEAST.db ? { rateHz: l.rateHz, depth: l.fit.amp } : null

  // Timbre: the main way the harmonics change together; its two ends, where the swing's sine is
  // near its top and its bottom.
  let timbreSwing: Movement['timbre'] = null
  const t = swingOf(mainComponent(timbre))
  if (t) {
    // NaN for the harmonics left out (another oscillator's).
    const ends = (sign: 1 | -1) => {
      const frames = timbre.filter((_, i) => sign * t.fit.at(i) >= END * t.fit.amp)
      const mean = timbre[0].map((_, j) => (mine(j) ? frames.reduce((s, f) => s + f[j], 0) / Math.max(1, frames.length) : NaN))
      const top = Math.max(...mean.filter((v) => v === v))
      return mean.map((v) => v - top)
    }
    const [low, high] = [ends(-1), ends(1)]
    // Apart over the harmonics either end has within 40 dB of its loudest.
    const heard = low.flatMap((v, j) => (Math.max(v, high[j]) > -40 ? [v - high[j]] : []))
    const apart = Math.sqrt(heard.reduce((s, d) => s + d * d, 0) / Math.max(1, heard.length))
    if (apart >= LEAST.timbre) timbreSwing = { rateHz: t.rateHz, low, high }
  }
  return pitchSwing || levelSwing || timbreSwing ? { pitch: pitchSwing, beat: null, level: levelSwing, timbre: timbreSwing } : null
}

/**
 * Harmonic `k` of the note at `f0` followed over `x[from..to)`: how far (cents) its frequency is
 * off k * f0 every HOP_S, from its phase moving across 4 ms (unambiguous to 125 Hz off), and its
 * level (the mean power).
 */
function harmonicTrack(x: Float32Array, sampleRate: number, f0: number, k: number, from: number, to: number) {
  const n = Math.round(Math.max((8 * sampleRate) / f0, 0.06 * sampleRate))
  const lag = Math.round(0.004 * sampleRate)
  const hz = k * f0
  const step = (2 * Math.PI * hz) / sampleRate
  const at = (start: number): [number, number] => {
    let re = 0
    let im = 0
    for (let i = 0; i < n; i++) {
      const v = (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))) * x[start + i]
      re += v * Math.cos(step * (start + i))
      im -= v * Math.sin(step * (start + i))
    }
    return [re, im]
  }
  const cents: number[] = []
  let power = 0
  for (let t = from; t + n + lag < to; t += Math.round(HOP_S * sampleRate)) {
    const [r1, i1] = at(t)
    const [r2, i2] = at(t + lag)
    const turn = Math.atan2(i2, r2) - Math.atan2(i1, r1)
    const off = Math.atan2(Math.sin(turn), Math.cos(turn)) / ((2 * Math.PI * lag) / sampleRate)
    cents.push(1200 * Math.log2(1 + off / hz))
    power += r1 * r1 + i1 * i1
  }
  return { cents, power: power / Math.max(1, cents.length) }
}

/**
 * The loudest peak within 60 cents of `hz` but not at `not` cents from it (within 1.5; null: any),
 * in up to 4 s of `x[from..to)`: cents from `hz`, or null for none 30 dB or less under the one at
 * `hz`.
 */
export function offsetNear(x: Float32Array, sampleRate: number, hz: number, from: number, to: number, not: number | null = 0): number | null {
  let n = 1
  while (n * 2 <= Math.min(to - from, 4 * sampleRate)) n *= 2
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i++) re[i] = x[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)))
  fft(re, im)
  const bin = sampleRate / n
  const power = (b: number) => re[b] * re[b] + im[b] * im[b]
  const on = Math.round(hz / bin)
  let best = -1
  for (let b = Math.floor((hz * 2 ** (-60 / 1200)) / bin); b <= Math.ceil((hz * 2 ** (60 / 1200)) / bin); b++) {
    const cents = 1200 * Math.log2((b * bin) / hz)
    if ((not !== null && Math.abs(cents - not) <= 1.5) || !(power(b) > power(b - 1) && power(b) >= power(b + 1))) continue
    if (best < 0 || power(b) > power(best)) best = b
  }
  if (best < 0 || power(best) < power(on) * 1e-3) return null
  const [l, m, r] = [Math.log(power(best - 1)), Math.log(power(best)), Math.log(power(best + 1))]
  const d = l - 2 * m + r
  return 1200 * Math.log2(((best + (d < 0 ? (0.5 * (l - r)) / d : 0)) * bin) / hz)
}

/** An octave oscillator's tell: the odd or the even harmonics moving this much (cents RMS), the others a quarter of that at most. */
const OCTAVE = { moving: 5, beating: 3, still: 0.25 }

/**
 * Two oscillators an octave apart that behave differently, in the note at `f0` over `x[from..to)`:
 * the even harmonics are the upper one's (the lower one's lie under them), the odd ones the lower
 * one's alone. Either the lower one swings in pitch and the upper one holds still (the odd
 * harmonics move, the even don't: `swing`, the lower one's), or the upper one is a few cents off
 * and beats against the lower one's even harmonics (they wobble, the odd don't: `cents`). Null
 * where all harmonics move alike: one oscillator, or two exactly an octave apart (a timbre).
 */
export function octaveApart(x: Float32Array, sampleRate: number, f0: number, from: number, to: number): { swing: Movement['pitch'] } | { cents: number; lower: number } | null {
  if ((to - from) / sampleRate < 1) return null
  const tracks = Array.from({ length: 8 }, (_, i) => harmonicTrack(x, sampleRate, f0, i + 1, from, to))
  const loudest = Math.max(...tracks.map((t) => t.power))
  const rms = (v: number[]) => {
    const m = v.reduce((s, a) => s + a, 0) / v.length
    return Math.sqrt(v.reduce((s, a) => s + (a - m) ** 2, 0) / v.length)
  }
  // Heard harmonics only (within 40 dB of the loudest), at least two of each.
  const heard = tracks.map((t, i) => ({ k: i + 1, ...t, moves: rms(t.cents) })).filter((t) => t.power >= loudest * 1e-4)
  const [odd, even] = [heard.filter((t) => t.k % 2), heard.filter((t) => t.k % 2 === 0)]
  if (odd.length < 2 || even.length < 2) return null
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
  const [oddMoves, evenMoves] = [median(odd.map((t) => t.moves)), median(even.map((t) => t.moves))]
  if (oddMoves >= OCTAVE.moving && evenMoves <= OCTAVE.still * oddMoves) {
    // The lower one's swing, from its loudest odd harmonic (in cents, as at the fundamental).
    const s = swingOf(odd.reduce((a, t) => (t.power > a.power ? t : a)).cents)
    return { swing: s && s.fit.amp >= LEAST.cents ? { rateHz: s.rateHz, depth: s.fit.amp, centre: s.mean } : null }
  }
  if (evenMoves >= OCTAVE.beating && oddMoves <= OCTAVE.still * evenMoves) {
    // The beat at the second harmonic: twice the upper one's offset from the octave.
    // Its own peak beside the note's second harmonic in a long spectrum, where the beat is too fast
    // and uneven to time (the two trade places in the track); closer than 10 cents, the peaks run
    // together, and the beat (its rate twice the offset at the second harmonic) is slow and even.
    // The lower one's own pitch, from its fundamental (where the upper one has none): `f0` may be
    // the upper one's, halved, where that is the louder.
    const lower = offsetNear(x, sampleRate, f0, from, to, null) ?? 0
    const upper = offsetNear(x, sampleRate, 2 * f0, from, to, lower)
    const apart = upper === null ? null : upper - lower
    const beat = apart === null || Math.abs(apart) < 10 ? swingOf(tracks[1].cents) : null
    const cents = beat ? Math.sign(apart ?? 1) * 1200 * Math.log2(1 + beat.rateHz / (2 * f0)) : apart
    return cents === null ? null : { cents, lower }
  }
  return null
}
