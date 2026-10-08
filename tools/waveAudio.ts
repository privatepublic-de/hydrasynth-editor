// Shared by the wave recording tools: reading the recordings, finding the note's steady part and
// period, averaging cycles and undoing the recording chain's DC blocking.
import { readFileSync } from 'node:fs'

export const CYCLE = 512
export const RATE = 48000
export const EXPECTED_PERIOD = RATE / 65.406 // C2
/** The recording chain's DC blocking: HIGHPASS_ORDERS first-order high-passes at HIGHPASS_HZ. */
export const HIGHPASS_HZ = 6
export const HIGHPASS_ORDERS = 2
/** tools/recordPhases.ts: seconds on the reference Sine, then on the wave, in one held note. */
export const PHASE_TIMING = { sineS: 0.7, waveS: 1.2 }

/** A 24-bit stereo WAV as mono floats. */
export function readWav(file: string): Float64Array {
  const buf = readFileSync(file)
  let pos = 12
  let channels = 2
  let bits = 24
  while (pos < buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(pos + 10)
      bits = buf.readUInt16LE(pos + 22)
    } else if (id === 'data') {
      const bytes = bits / 8
      const frames = Math.floor(size / (bytes * channels))
      const out = new Float64Array(frames)
      for (let f = 0; f < frames; f++) {
        let sum = 0
        for (let c = 0; c < channels; c++) sum += buf.readIntLE(pos + 8 + (f * channels + c) * bytes, bytes) / 2 ** (bits - 1)
        out[f] = sum / channels
      }
      return out
    }
    pos += 8 + size + (size & 1)
  }
  throw new Error(`${file}: no data`)
}

/** Where the note sounds steadily: past its start, before its end. */
export function steadyPart(x: Float64Array): Float64Array {
  const block = 480
  const rms: number[] = []
  for (let i = 0; i + block <= x.length; i += block) {
    let s = 0
    for (let j = i; j < i + block; j++) s += x[j] * x[j]
    rms.push(Math.sqrt(s / block))
  }
  const peak = Math.max(...rms)
  const on = rms.findIndex((r) => r > peak * 0.3)
  let off = rms.length - 1
  while (off > on && rms[off] < peak * 0.3) off--
  // Skip 150 ms after the start, stop 100 ms before the end.
  return x.subarray((on + 15) * block, (off - 10) * block)
}

/** The period in samples (fractional), searched around the expected one. */
export function period(x: Float64Array): number {
  // Narrow: the synth is in tune, and the Harmon waves (a sine at harmonic up to 23) also
  // repeat every 1/23 of a period, so a wide search finds a wrong multiple of that.
  const lo = Math.floor(EXPECTED_PERIOD * 0.99)
  const hi = Math.ceil(EXPECTED_PERIOD * 1.01)
  const n = x.length - hi
  const score = (lag: number) => {
    let s = 0
    for (let i = 0; i < n; i++) s += x[i] * x[i + lag]
    return s
  }
  let best = lo
  let bestScore = -Infinity
  const scores = new Map<number, number>()
  for (let lag = lo; lag <= hi; lag++) {
    const s = score(lag)
    scores.set(lag, s)
    if (s > bestScore) {
      bestScore = s
      best = lag
    }
  }
  // Over many cycles: the lag of k periods pins it down far finer than one.
  const k = Math.floor((x.length * 0.5) / best)
  let p = best
  let bestK = -Infinity
  for (let lag = Math.floor(best * k - k); lag <= Math.ceil(best * k + k); lag++) {
    let s = 0
    for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag]
    s /= x.length - lag
    if (s > bestK) {
      bestK = s
      p = lag / k
    }
  }
  return p
}

export const sampleAt = (x: Float64Array, t: number) => {
  const i = Math.floor(t)
  const f = t - i
  // Cubic (Catmull-Rom) between i and i + 1.
  const p0 = x[i - 1] ?? x[i]
  const p1 = x[i]
  const p2 = x[i + 1] ?? x[i]
  const p3 = x[i + 2] ?? p2
  return p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)))
}

export function averageCycle(x: Float64Array, p: number): number[] {
  const cycles = Math.floor((x.length - 3) / p) - 1
  const out = new Array(CYCLE).fill(0)
  for (let c = 0; c < cycles; c++) {
    for (let k = 0; k < CYCLE; k++) out[k] += sampleAt(x, 1 + c * p + (k * p) / CYCLE)
  }
  return out.map((v) => v / cycles)
}

/** Undo the high-passes: each harmonic k divided by their response at k times the note's frequency. */
export function unHighpass(x: number[], f0: number): number[] {
  const n = x.length
  const out = new Array(n).fill(0)
  for (let k = 1; k < n / 2; k++) {
    let re = 0
    let im = 0
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * k * i) / n
      re += x[i] * Math.cos(a)
      im -= x[i] * Math.sin(a)
    }
    // One stage: H = jw / (1 + jw) with w = f / fc, so 1 / H = 1 - j / w.
    const w = (k * f0) / HIGHPASS_HZ
    let cr = 1
    let ci = 0
    // (cr + j ci) * (1 - j / w), once per stage.
    for (let o = 0; o < HIGHPASS_ORDERS; o++) [cr, ci] = [cr + ci / w, ci - cr / w]
    const r = re * cr - im * ci
    const j = re * ci + im * cr
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * k * i) / n
      out[i] += (2 / n) * (r * Math.cos(a) - j * Math.sin(a))
    }
  }
  return out
}

/** One averaged cycle from samples from..to, its cycles counted from sample 0 (a shared phase). */
export function cycleAt(x: Float64Array, p: number, from: number, to: number): number[] {
  const out = new Array(CYCLE).fill(0)
  let n = 0
  for (let c = Math.ceil(from / p); (c + 1) * p < to; c++, n++) {
    for (let k = 0; k < CYCLE; k++) out[k] += sampleAt(x, c * p + (k * p) / CYCLE)
  }
  return unHighpass(
    out.map((v) => v / n),
    RATE / p,
  )
}

/** The note's start: the first sample well above the noise. */
export function onsetOf(x: Float64Array): number {
  let i = 0
  while (i < x.length && Math.abs(x[i]) < 0.01) i++
  return i
}
