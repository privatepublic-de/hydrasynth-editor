// A note's harmonics, read at exact multiples of its pitch rather than on an FFT's bin grid, so
// harmonic k of any note compares with harmonic k of the synth's waves (src/ui/waveSpeech.ts
// harmonicLevels: one cycle, so its harmonics sit at k times whatever note plays).

/** Harmonics of a note: levels as harmonicLevels gives them, plus what they're made of. */
export interface Harmonics {
  /** dB per harmonic 1..K, loudest 0, floor -100. */
  levels: number[]
  /** Amplitude per harmonic 1..K (full scale 1). */
  amps: number[]
  /** Brightness: the amplitude-weighted mean harmonic number (1 for a sine). */
  centroid: number
  /** Share of the stretch's power in its harmonics (0..1): low for noise, chords, inharmonic sounds. */
  share: number
}

/** Harmonics compared per note: to 10 kHz (the waves were measured to ~8 kHz at C2), at most 128. */
export const harmonicCount = (f0: number, sampleRate: number) => Math.max(1, Math.min(128, Math.floor(Math.min(10000, 0.45 * sampleRate) / f0)))

/**
 * The harmonics of `f0` in `x[from..to)` (Hann window, which should span six periods or more to
 * keep neighbouring harmonics apart), `count` of them.
 */
export function harmonicsAt(x: Float32Array, sampleRate: number, f0: number, from: number, to: number, count: number): Harmonics {
  from = Math.max(0, Math.floor(from))
  to = Math.min(x.length, Math.floor(to))
  const n = to - from
  const w = new Float64Array(n)
  let wSum = 0
  let power = 0
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1))
    wSum += w[i]
    power += w[i] * x[from + i] * x[from + i]
  }
  power /= wSum || 1
  const amps: number[] = []
  for (let k = 1; k <= count; k++) {
    const step = (2 * Math.PI * k * f0) / sampleRate
    const c = Math.cos(step)
    const s = Math.sin(step)
    let pr = 1
    let pi = 0
    let re = 0
    let im = 0
    for (let i = 0; i < n; i++) {
      const v = w[i] * x[from + i]
      re += v * pr
      im -= v * pi
      const t = pr * c - pi * s
      pi = pr * s + pi * c
      pr = t
    }
    amps.push((2 * Math.hypot(re, im)) / (wSum || 1))
  }
  const peak = Math.max(...amps) || 1
  const levels = amps.map((a) => 20 * Math.log10(a / peak + 1e-5))
  const total = amps.reduce((s, a) => s + a, 0)
  const centroid = total ? amps.reduce((s, a, i) => s + (i + 1) * a, 0) / total : 1
  const harmonic = amps.reduce((s, a) => s + (a * a) / 2, 0)
  return { levels, amps, centroid, share: power ? Math.min(1, harmonic / power) : 0 }
}
