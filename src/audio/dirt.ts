// What makes a recorded note less clean than a synth's waves played still: its pitch wandering
// (drift), a second oscillator a few cents off (detune: harmonic k beats at k times the offset),
// chorus or an ensemble (every harmonic beating at about one rate), and noise between the
// harmonics. Read on the steady part of the note, so a filter sweep, a decay or vibrato isn't
// taken for any of them.
import { fft } from './fft'

export interface Dirt {
  /** How far the pitch wanders (cents RMS), vibrato and any glide taken out. */
  drift: number
  /** A second voice `cents` off, beating `depth` dB (RMS) at harmonic k by k times that. */
  detune: { cents: number; depth: number } | null
  /** Harmonics beating at about one rate whatever their number: chorus, an ensemble. */
  ensemble: { rateHz: number; depth: number } | null
  /** Noise between the harmonics: dB under them, and its slope (dB per octave: white 0, pink -3). */
  noise: { db: number; slope: number } | null
}

/** Each harmonic's amplitude and phase over `x[from..from+n)` (Hann). */
function phasor(x: Float32Array, sampleRate: number, hz: number, from: number, n: number): [number, number] {
  const step = (2 * Math.PI * hz) / sampleRate
  const c = Math.cos(step)
  const s = Math.sin(step)
  let pr = 1
  let pi = 0
  let re = 0
  let im = 0
  let wSum = 0
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    const v = w * x[from + i]
    wSum += w
    re += v * pr
    im -= v * pi
    const t = pr * c - pi * s
    pi = pr * s + pi * c
    pr = t
  }
  return [(2 * re) / wSum, (2 * im) / wSum]
}

const HOP_S = 0.01
const rms = (v: number[]) => Math.sqrt(v.reduce((s, a) => s + a * a, 0) / Math.max(1, v.length))

/** `v` (one value per HOP_S) less its least-squares polynomial of `order` (1: a line, 2: a curve). */
function detrend(v: number[], order: 1 | 2): number[] {
  const n = v.length
  const t = v.map((_, i) => (2 * i) / Math.max(1, n - 1) - 1)
  // Normal equations for 1, t (and t^2).
  const cols = order === 2 ? [t.map(() => 1), t, t.map((x) => x * x)] : [t.map(() => 1), t]
  const m = cols.length
  const a = cols.map((ci) => cols.map((cj) => ci.reduce((s, x, k) => s + x * cj[k], 0)))
  const b = cols.map((ci) => ci.reduce((s, x, k) => s + x * v[k], 0))
  for (let i = 0; i < m; i++)
    for (let j = i + 1; j < m; j++) {
      const f = a[j][i] / a[i][i]
      for (let k = i; k < m; k++) a[j][k] -= f * a[i][k]
      b[j] -= f * b[i]
    }
  const c = new Array(m).fill(0)
  for (let i = m - 1; i >= 0; i--) c[i] = (b[i] - a[i].slice(i + 1).reduce((s, x, k) => s + x * c[i + 1 + k], 0)) / a[i][i]
  return v.map((y, k) => y - cols.reduce((s, col, j) => s + c[j] * col[k], 0))
}

/** `v` without the sinusoid at `rateHz` that fits it best (vibrato). */
function withoutSine(v: number[], rateHz: number): number[] {
  let ss = 0
  let sc = 0
  let s2 = 0
  let c2 = 0
  let s1c1 = 0
  v.forEach((y, i) => {
    const s = Math.sin(2 * Math.PI * rateHz * i * HOP_S)
    const c = Math.cos(2 * Math.PI * rateHz * i * HOP_S)
    ss += y * s
    sc += y * c
    s2 += s * s
    c2 += c * c
    s1c1 += s * c
  })
  const det = s2 * c2 - s1c1 * s1c1 || 1
  const a = (ss * c2 - sc * s1c1) / det
  const b = (sc * s2 - ss * s1c1) / det
  return v.map((y, i) => y - a * Math.sin(2 * Math.PI * rateHz * i * HOP_S) - b * Math.cos(2 * Math.PI * rateHz * i * HOP_S))
}

/** The rate (Hz) `v` repeats at: its first strong autocorrelation peak, two repeats at least. */
function repeatRate(v: number[]): number | null {
  const n = v.length
  const energy = v.reduce((s, a) => s + a * a, 0)
  if (!energy) return null
  const r = (lag: number) => {
    let s = 0
    for (let i = 0; i + lag < n; i++) s += v[i] * v[i + lag]
    return (s / (n - lag)) * (n / energy)
  }
  const lo = Math.max(2, Math.ceil(1 / (15 * HOP_S)))
  for (let lag = lo; lag <= Math.floor(n / 2); lag++) {
    const here = r(lag)
    if (here > 0.25 && here >= r(lag - 1) && here >= r(lag + 1)) return 1 / (lag * HOP_S)
  }
  return null
}

/** The mean correlation of each pair of `tracks`. */
function meanCorrelation(tracks: number[][]): number {
  let sum = 0
  let pairs = 0
  for (let i = 0; i < tracks.length; i++)
    for (let j = i + 1; j < tracks.length; j++) {
      const [a, b] = [tracks[i], tracks[j]]
      let ab = 0
      let aa = 0
      let bb = 0
      a.forEach((v, k) => {
        ab += v * b[k]
        aa += v * v
        bb += b[k] * b[k]
      })
      sum += aa && bb ? ab / Math.sqrt(aa * bb) : 0
      pairs++
    }
  return pairs ? sum / pairs : 0
}

/** The RMS (dB) of the level of 1 + r e^(i theta) over a turn: how deep two voices beat. */
function beatDepth(r: number): number {
  const v = Array.from({ length: 64 }, (_, i) => 20 * Math.log10(Math.max(1e-6, Math.hypot(1 + r * Math.cos((2 * Math.PI * i) / 64), r * Math.sin((2 * Math.PI * i) / 64)))))
  const mean = v.reduce((s, a) => s + a, 0) / v.length
  return rms(v.map((a) => a - mean))
}

/** The second voice's level (0..1 of the first) that beats `depth` dB RMS. */
export function detuneLevel(depth: number): number {
  let lo = 0
  let hi = 0.99
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (beatDepth(mid) < depth) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * The dirt in the steady stretch `x[from..to)` of a note at `f0` whose harmonics' amplitudes are
 * `amps`; `vibrato` (Hz), if found, is taken out of the pitch first.
 */
export function measureDirt(x: Float32Array, sampleRate: number, f0: number, amps: number[], from: number, to: number, vibratoHz: number | null): Dirt {
  const period = sampleRate / f0
  const window = Math.round(Math.max(4 * period, 0.04 * sampleRate))
  const hop = Math.round(HOP_S * sampleRate)
  to = Math.min(to, from + 3 * sampleRate, x.length - window)
  const starts: number[] = []
  for (let t = from; t < to; t += hop) starts.push(t)

  // Drift: the frequency of the loudest of the first six harmonics, from how its phase advances
  // hop to hop (a change of timbre moves its level, not its frequency).
  const k = 1 + amps.slice(0, 6).indexOf(Math.max(...amps.slice(0, 6)))
  const hz = k * f0
  const expected = (2 * Math.PI * hz * hop) / sampleRate
  const track: number[] = []
  let prev: [number, number] | null = null
  let top = 0
  const frames = starts.map((t) => phasor(x, sampleRate, hz, t, window))
  for (const [re, im] of frames) top = Math.max(top, Math.hypot(re, im))
  for (const [re, im] of frames) {
    if (Math.hypot(re, im) < top * 0.03) break // 30 dB down: too faint to follow
    if (prev) {
      let d = Math.atan2(im * prev[0] - re * prev[1], re * prev[0] + im * prev[1]) - expected
      d -= 2 * Math.PI * Math.round(d / (2 * Math.PI))
      track.push(1200 * Math.log2(1 + (d * sampleRate) / (2 * Math.PI * hop) / hz))
    }
    prev = [re, im]
  }
  const pitch = track.length >= 20 ? detrend(vibratoHz ? withoutSine(track, vibratoHz) : track, 1) : []
  const drift = rms(pitch)

  // Beating: each harmonic's level (dB), its slow course (a decay, a sweep) taken out.
  const rates: { k: number; rate: number; depth: number; wobble: number[] }[] = []
  for (let h = 1; h <= 8 && h * f0 < 5000; h++) {
    const levels = starts.map((t) => 20 * Math.log10(Math.hypot(...phasor(x, sampleRate, h * f0, t, window)) + 1e-9))
    if (levels.length < 50 || Math.max(...levels) < 20 * Math.log10(Math.max(...amps)) - 40) continue
    const wobble = detrend(levels, 2)
    const depth = rms(wobble)
    const rate = repeatRate(wobble)
    // Two beats in the stretch at least (repeatRate sees to that), fast enough not to be a sweep's leftover.
    if (rate !== null && depth >= 0.4 && rate >= 0.3) rates.push({ k: h, rate, depth, wobble })
  }
  let detune: Dirt['detune'] = null
  let ensemble: Dirt['ensemble'] = null
  // Tremolo moves every harmonic together; voices apart or a chorus move each its own way.
  const together = meanCorrelation(rates.map((r) => r.wobble))
  if (rates.length >= 3 && together < 0.6) {
    const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
    const offset = med(rates.map((r) => r.rate / r.k))
    const scaling = rates.filter((r) => Math.abs(r.rate / r.k - offset) <= 0.35 * offset).length / rates.length
    const rate = med(rates.map((r) => r.rate))
    const same = rates.filter((r) => Math.abs(r.rate - rate) <= 0.35 * rate).length / rates.length
    const depth = med(rates.map((r) => r.depth))
    // Harmonics beating faster the higher they are: two voices apart; at one rate: a chorus.
    if (scaling >= 0.6 && scaling > same) detune = { cents: 1200 * Math.log2(1 + offset / f0), depth }
    else if (same >= 0.6) ensemble = { rateHz: rate, depth }
  }

  return { drift, detune, ensemble, noise: noiseBetween(x, sampleRate, f0, from, to) }
}

/**
 * Noise between the harmonics, in octave bands from 250 Hz: only where what lies between them is
 * flat (inharmonic partials stand out as peaks, a detuned voice or chorus as skirts close to each
 * harmonic, kept out by looking only at the middle of each gap).
 */
function noiseBetween(x: Float32Array, sampleRate: number, f0: number, from: number, to: number): Dirt['noise'] {
  let n = 8192
  while ((12 * sampleRate) / n > f0 && n < 32768) n *= 2
  if ((12 * sampleRate) / n > f0 || to - from < n) return null
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i++) re[i] = x[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)))
  fft(re, im)
  const bin = sampleRate / n
  let harmonic = 0
  const bands: number[][] = []
  for (let b = 1; b < n / 2; b++) {
    const hz = b * bin
    const power = re[b] * re[b] + im[b] * im[b]
    const off = Math.abs(hz / f0 - Math.round(hz / f0))
    if (off * f0 < 3 * bin) harmonic += power
    else if (off > 0.3 && hz >= 250 && hz < 16000) (bands[Math.floor(Math.log2(hz / 250))] ??= []).push(power)
  }
  const flat: { octave: number; density: number }[] = []
  bands.forEach((powers, octave) => {
    if (!powers || powers.length < 8) return
    const mean = powers.reduce((s, p) => s + p, 0) / powers.length
    const geo = Math.exp(powers.reduce((s, p) => s + Math.log(p + 1e-30), 0) / powers.length)
    if (geo / mean > 0.25) flat.push({ octave, density: mean })
  })
  if (flat.length < 2 || !harmonic) return null
  // Power over the noise's own octaves (density times their width), against the harmonics.
  const total = flat.reduce((s, f) => s + f.density * ((250 * 2 ** f.octave) / bin), 0)
  const db = 10 * Math.log10(total / harmonic)
  const xs = flat.map((f) => f.octave)
  const ys = flat.map((f) => 10 * Math.log10(f.density))
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length
  const my = ys.reduce((s, v) => s + v, 0) / ys.length
  const slope = xs.reduce((s, v, i) => s + (v - mx) * (ys[i] - my), 0) / (xs.reduce((s, v) => s + (v - mx) ** 2, 0) || 1)
  return { db, slope }
}
