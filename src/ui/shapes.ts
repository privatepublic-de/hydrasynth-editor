// What the synth's Left display draws for envelopes and LFOs, computed from patch values.
// Pictures, not a model of the synth's DSP: times come from the display strings and the
// curves are a plausible family, close enough to read a patch at a glance.
import { formatValue } from '../params/display'
import { param, type Patch } from '../params/patch'

/** BPM-synced times are drawn as if at this tempo. */
export const DRAW_BPM = 120

/** A displayed time in seconds: "0ms", "448ms", "2,17s", or a synced "1/16 D", "1/2 T", "64" (whole notes). */
export function displayedSeconds(text: string): number {
  const t = text.trim().replace(',', '.')
  let m: RegExpMatchArray | null
  if ((m = t.match(/^([\d.]+)\s*ms$/))) return Number(m[1]) / 1000
  if ((m = t.match(/^([\d.]+)\s*s$/))) return Number(m[1])
  const beat = 60 / DRAW_BPM
  if ((m = t.match(/^(\d+)\/(\d+)\s*([DT])?$/))) {
    const wholeNotes = Number(m[1]) / Number(m[2])
    const dotted = m[3] === 'D' ? 1.5 : m[3] === 'T' ? 2 / 3 : 1
    return wholeNotes * 4 * beat * dotted
  }
  if ((m = t.match(/^(\d+)$/))) return Number(m[1]) * 4 * beat
  return 0
}

/** The seconds a time param shows, whichever of its sync-off / sync-on keys is active. */
function seconds(patch: Patch, prefix: string, name: string): number {
  const key = patch.get(`${prefix}bpmsync`) ? `${prefix}${name}syncon` : `${prefix}${name}syncoff`
  return displayedSeconds(formatValue(param(key), patch.get(key)))
}

/**
 * Fraction of a segment's travel at time fraction x. `curve` is the stored 0..128 (64 =
 * linear); above 64 bends towards a fast start for every stage. Edisyn notes the synth labels
 * the attack's two sides the other way round from decay/release, but they behave alike.
 */
export function curveAt(x: number, curve: number): number {
  const a = -(curve - 64) / 12
  if (Math.abs(a) < 1e-3) return x
  return (Math.exp(a * x) - 1) / (Math.exp(a) - 1)
}

export interface Point {
  x: number
  y: number
}

export interface EnvelopeShape {
  points: Point[]
  /** x positions where the stages start: delay, attack, hold, decay, sustain, release, end. */
  marks: number[]
  sustain: number
}

/**
 * Points in 0..1 on both axes. Stage widths follow the square root of their times, so a 30 s
 * release doesn't flatten a 5 ms attack to nothing; the sustain gets a fixed share.
 */
export function envelopeShape(patch: Patch, env: number, steps = 24): EnvelopeShape {
  const p = `env${env}`
  const t = {
    delay: seconds(patch, p, 'delay'),
    attack: seconds(patch, p, 'attack'),
    hold: seconds(patch, p, 'hold'),
    decay: seconds(patch, p, 'decay'),
    release: seconds(patch, p, 'release'),
  }
  const sustain = Math.min(1, patch.get(`${p}sustain`) / 1024)
  const w = (s: number) => Math.sqrt(s) + 0.04
  const SUSTAIN_WIDTH = 0.18
  const widths = [w(t.delay) - 0.04, w(t.attack), w(t.hold) - 0.04, w(t.decay), 0, w(t.release)]
  const total = widths.reduce((a, b) => a + b, 0)
  const scale = (1 - SUSTAIN_WIDTH) / total
  const xs = [0]
  for (const [i, width] of widths.entries()) xs.push(xs[i] + (i === 4 ? SUSTAIN_WIDTH : width * scale))

  const points: Point[] = [{ x: 0, y: 0 }, { x: xs[1], y: 0 }]
  const segment = (x0: number, x1: number, y0: number, y1: number, curve: number) => {
    for (let i = 1; i <= steps; i++) {
      const f = i / steps
      points.push({ x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * curveAt(f, curve) })
    }
  }
  segment(xs[1], xs[2], 0, 1, patch.get(`${p}atkcurve`))
  points.push({ x: xs[3], y: 1 })
  segment(xs[3], xs[4], 1, sustain, patch.get(`${p}deccurve`))
  points.push({ x: xs[5], y: sustain })
  segment(xs[5], xs[6], sustain, 0, patch.get(`${p}relcurve`))
  return { points, marks: xs, sustain }
}

/** LFO waves in the synth's order (lfoNwave). */
const SINE = 0, TRIANGLE = 1, SAW_UP = 2, SAW_DOWN = 3, SQUARE = 4, PULSE_27 = 5, PULSE_13 = 6
const SAMPLE_HOLD = 7, NOISE = 8, RANDOM = 9, STEP = 10

/** Deterministic "random" so the picture doesn't change on every render. */
function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return (s - Math.floor(s)) * 2 - 1
}

/** One value (-1..1) of LFO `lfo`'s wave at cycle position c (any real; 1 = one cycle). */
export function lfoAt(patch: Patch, lfo: number, c: number): number {
  const p = `lfo${lfo}`
  const wave = patch.get(`${p}wave`)
  const phase = c + patch.get(`${p}phase`) / 360
  const u = phase - Math.floor(phase)
  switch (wave) {
    case SINE:
      return Math.sin(2 * Math.PI * u)
    case TRIANGLE:
      return u < 0.25 ? 4 * u : u < 0.75 ? 2 - 4 * u : 4 * u - 4
    case SAW_UP:
      return 2 * u - 1
    case SAW_DOWN:
      return 1 - 2 * u
    case SQUARE:
      return u < 0.5 ? 1 : -1
    case PULSE_27:
      return u < 0.27 ? 1 : -1
    case PULSE_13:
      return u < 0.13 ? 1 : -1
    case SAMPLE_HOLD:
      return hash(Math.floor(phase * 4))
    case NOISE:
      return hash(Math.floor(phase * 64))
    case RANDOM: {
      const i = Math.floor(phase * 4)
      const f = phase * 4 - i
      const s = (1 - Math.cos(Math.PI * f)) / 2
      return hash(i) * (1 - s) + hash(i + 1) * s
    }
    case STEP: {
      const count = Math.max(2, Math.min(64, patch.get(`${p}steps`)))
      const at = (i: number) => (patch.get(`${p}step${(((i % count) + count) % count) + 1}`) - 512) / 512
      const pos = u * count
      const i = Math.floor(pos)
      // Smooth (0..127) glides from one step into the next over that share of the step.
      const glide = patch.get(`${p}smooth`) / 127
      const f = pos - i
      if (glide <= 0 || f < 1 - glide) return at(i)
      const g = (f - (1 - glide)) / glide
      return at(i) + (at(i + 1) - at(i)) * g
    }
    default:
      return 0
  }
}

/** The LFO's level as 0..1 of full depth (lfoNlevel 0..1024). */
export const lfoLevel = (patch: Patch, lfo: number) => Math.min(1, patch.get(`lfo${lfo}level`) / 1024)
