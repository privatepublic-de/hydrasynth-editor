// A sound's spectrum in octave bands, and its brightness over time: for sounds with no note in
// them (a hi-hat, a crash, a clap), where harmonics mean nothing.
import { fft } from './fft'

/** Octave band centres (Hz): 62.5 Hz to 16 kHz. */
export const BAND_HZ = Array.from({ length: 9 }, (_, i) => 62.5 * 2 ** i)

/** Power per bin of `x[from..from+n)` (Hann), n a power of two, padded with silence past the end. */
function powerSpectrum(x: Float32Array, from: number, n: number): Float64Array {
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i++) re[i] = (x[from + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)))
  fft(re, im)
  const power = new Float64Array(n / 2)
  for (let b = 0; b < n / 2; b++) power[b] = re[b] * re[b] + im[b] * im[b]
  return power
}

/**
 * The power density (dB per bin, the loudest band 0) in each octave around BAND_HZ, from `from`:
 * white noise reads flat, pink falls 3 dB an octave. Averaged over up to eight half-overlapping
 * windows of 4096 (a single one scatters noise by +-3 dB a band, more in the lowest).
 */
export function octaveBands(x: Float32Array, sampleRate: number, from: number): number[] {
  const n = 4096
  from = Math.max(0, Math.min(from, x.length - n))
  const power = new Float64Array(n / 2)
  let windows = 0
  for (let start = from; windows < 8 && (windows === 0 || start + n <= x.length); start += n / 2, windows++) {
    const p = powerSpectrum(x, start, n)
    for (let b = 0; b < power.length; b++) power[b] += p[b]
  }
  const bin = sampleRate / n
  const bands = BAND_HZ.map((hz) => {
    const lo = Math.max(1, Math.ceil(hz / Math.SQRT2 / bin))
    const hi = Math.min(power.length - 1, Math.floor((hz * Math.SQRT2) / bin))
    let sum = 0
    for (let b = lo; b <= hi; b++) sum += power[b]
    return hi >= lo ? 10 * Math.log10(sum / (hi - lo + 1) + 1e-30) : -300
  })
  const top = Math.max(...bands)
  return bands.map((v) => v - top)
}

/** The spectral centroid (Hz) and level (dB, the loudest 0) every `hopS` of `x[from..to)`, 1024-sample windows. */
export function centroidTrack(x: Float32Array, sampleRate: number, from: number, to: number, hopS = 0.02): { t: number; hz: number; db: number }[] {
  const n = 1024
  const out: { t: number; hz: number; db: number }[] = []
  for (let t = from; t + n <= Math.min(to, x.length); t += Math.round(hopS * sampleRate)) {
    const power = powerSpectrum(x, t, n)
    let sum = 0
    let weighted = 0
    for (let b = 1; b < power.length; b++) {
      sum += power[b]
      weighted += power[b] * ((b * sampleRate) / n)
    }
    if (sum > 0) out.push({ t: (t + n / 2) / sampleRate, hz: weighted / sum, db: 10 * Math.log10(sum) })
  }
  const top = Math.max(...out.map((f) => f.db))
  return out.map((f) => ({ ...f, db: f.db - top }))
}
