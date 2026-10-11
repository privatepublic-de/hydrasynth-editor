// A patch that plays the note recorded in a WAV file (its analysis: src/audio/analyse.ts):
//   OSC 1      the wave whose harmonics best match the note's at its peak; following how the
//              sound changes (`overTime`), a WaveScan list of the waves along the note when they
//              differ, swept by ENV 3 (mod matrix route 1 to Osc 1 WaveScan)
//   Filter 1   LP Ladder 12, keytrack 100 %: the cutoff that, with the wave, best matches the
//              peak; following how the sound changes, ENV 1 (its own Env 1 Amount) follows the
//              note's brightness when that moves more than half an octave
//   ENV 2      the Amp: the note's attack, decay, sustain and release, or a Pluck/Keys/Pad preset
//   LFO 1      vibrato found in the note (route 2 to Osc 1 Pitch), else the Voice's own vibrato,
//              which plays with the Mod Wheel up
//   LFO 2      tremolo found in the note (the Amp's own LFO 2 Amount)
// Harmonic k of a wave sits at k times the note whatever note plays, so the waves' harmonics,
// measured once at C2 (src/ui/waveSpeech.ts waveLevels), compare with the note's at its own pitch.
// Measured on a Hydrasynth Desktop (fw 2.x) with tools/calibrateWavPatch.ts; see CALIBRATION.
import type { Adsr, SoundAnalysis, Wobble } from '../audio/analyse'
import { noteName } from '../audio/pitch'
import { initPatchBytes } from '../params/initPatch'
import { Patch } from '../params/patch'
import { destinationOf } from './modDestinations'
import { rawFor } from './timeTables'
import { WAVE_FEATURES } from './waveFeatures.generated'

/** What the synth showed when measured (tools/calibrateWavPatch.ts, 2026-10-11), so the numbers can be checked again. */
export const CALIBRATION = {
  /**
   * LP Ladder 12, resonance 0, keytrack 100 %: a two-pole low-pass (within 0.7 dB of a Saw's
   * harmonics) at `hzAt512` Hz for raw 512 at MIDI `pivotNote`, an octave per `octaveRaw` raw
   * (from 384 up; lower it closes more slowly), moving `keytrack` octaves per octave played (cutoff:
   * 9.2x, 9.8x and 11x the pitch at 512 for C2, C3, C4; 1.42-1.46 octaves per 128 raw).
   */
  cutoff: { hzAt512: 1288, octaveRaw: 89.5, pivotNote: 48, keytrack: 1.125 },
  /** Env 1 Amount (512 = 0): cutoff raw moved by a full envelope per raw of amount (envamount: +256 moved 256 to 640). */
  envAmountCutoffRaw: 1.5,
  /**
   * ENV 1 on the cutoff falls linearly in octaves, from full to 0 in the Decay it shows (filterenv:
   * 896 ms shown, ~900); its Release taken to run the same (not measured on its own).
   */
  filterDecayFactor: 1,
  /**
   * The Amp envelope (amp): Attack rises linearly in the time it shows; Decay and Release reach
   * -40 dB in the time they show (x0.85-1.2), and Decay reaches a Sustain in that time too (x0.88
   * at -6 dB, x1.0 at -18 dB); Sustain is linear amplitude (raw 512: -6.0 dB).
   */
  ampDecayFactor: 1,
  ampReleaseFactor: 1,
  /** A Sine LFO at full level into Osc 1 Pitch at route depth 128: cents to either side (vibrato: 71 at depth 8). */
  lfoPitchCents: 1142,
  /** Amp LFO 2 Amount: a full Sine LFO 2 swings the amplitude by this share at +64, linearly (tremolo: +16 1.5 dB, +32 3.5 dB). */
  tremoloSwing: 0.75,
  /** The Voice's own vibrato only plays with the Mod Wheel up: cents to either side per Amount raw (vibrato: 0.5 47, 2.0 186). */
  voiceVibratoCentsPerRaw: 9.3,
}

export type Envelope = 'detect' | 'pluck' | 'keys' | 'pad'
export const ENVELOPES: { value: Envelope; label: string; adsr?: Adsr }[] = [
  { value: 'detect', label: 'As recorded' },
  { value: 'pluck', label: 'Pluck', adsr: { attackS: 0.002, decayS: 0.8, sustain: 0, releaseS: 0.2 } },
  { value: 'keys', label: 'Keyboard', adsr: { attackS: 0.004, decayS: 1.5, sustain: 0.45, releaseS: 0.35 } },
  { value: 'pad', label: 'Pad', adsr: { attackS: 0.8, decayS: 2, sustain: 0.8, releaseS: 1.5 } },
]

export interface WavPatchOptions {
  /** Each wave's harmonicLevels (src/ui/waveSpeech.ts waveLevels). */
  levels: (number[] | null)[]
  envelope?: Envelope
  /** WaveScan and a filter envelope following how the note changes. */
  overTime?: boolean
  /** Vibrato and tremolo as found in the note. */
  wobble?: boolean
  name?: string
}

export interface WavPatch {
  patch: Patch
  /** The note to play for the recorded pitch: "C3", "C3 +12 cents". */
  note: string
  /** The waves played, in WaveScan order (one: no WaveScan). */
  waves: number[]
  filterEnvelope: boolean
  vibrato: Wobble | null
  tremolo: Wobble | null
  /** How far the wave and filter are from the note's harmonics at its peak (dB, weighted RMS). */
  fit: number
  warnings: string[]
}

/** Cutoffs tried, as multiples of the note's pitch: open, then quarter octaves from 128x down to 1x. */
const RATIOS = [Infinity, ...Array.from({ length: 29 }, (_, i) => 2 ** ((28 - i) / 4))]
/** A lower cutoff has to fit this much better (dB): a sine needs no filter, though one at its pitch fits as well. */
const CLOSER = 0.05
const FLOOR = -60

const clamp = (v: number, lo = 0, hi = 1024) => Math.max(lo, Math.min(hi, v))

/** LP Ladder 12 without resonance at `ratio` times the cutoff: dB (a two-pole low-pass, Q ~0.54). */
export function lpDb(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0
  return -10 * Math.log10((1 - ratio * ratio) ** 2 + (ratio / 0.54) ** 2)
}

/**
 * How far `levels` (dB per harmonic, from 0) are from `target`, through a low-pass at `cutoff`
 * times the pitch: RMS of the dB difference, both floored at -60 dB, low harmonics weighted more,
 * any overall level difference taken out.
 */
export function distance(target: number[], levels: number[], cutoff = Infinity): number {
  const n = Math.min(target.length, levels.length)
  let sw = 0
  let sd = 0
  let sdd = 0
  const shaped = levels.slice(0, n).map((v, k) => v + lpDb((k + 1) / cutoff))
  const top = Math.max(...shaped)
  for (let k = 0; k < n; k++) {
    const d = Math.max(target[k], FLOOR) - Math.max(shaped[k] - top, FLOOR)
    const w = 1 / Math.sqrt(k + 1)
    sw += w
    sd += w * d
    sdd += w * d * d
  }
  const mean = sd / sw
  return Math.sqrt(Math.max(0, sdd / sw - mean * mean))
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
const atPitch = new WeakMap<number[], boolean>()
/**
 * Whether a wave sounds at the note played: its audible harmonics (over -30 dB) share no divisor.
 * A Harmon wave is one harmonic alone, and a wave of even harmonics repeats an octave up: they
 * play higher than the note, so the note they'd match isn't the one heard.
 */
export function playsAtPitch(levels: number[]): boolean {
  let v = atPitch.get(levels)
  if (v === undefined) {
    v = levels.reduce((g, l, k) => (l > -30 ? gcd(g, k + 1) : g), 0) === 1
    atPitch.set(levels, v)
  }
  return v
}

const pools = new WeakMap<(number[] | null)[], { wave: number; l: number[] }[]>()
/** The waves that can play a note, with their levels. */
function candidates(levels: (number[] | null)[]) {
  let pool = pools.get(levels)
  if (!pool) {
    pool = levels.flatMap((l, wave) => (l && wave < WAVE_FEATURES.length && playsAtPitch(l) ? [{ wave, l }] : []))
    pools.set(levels, pool)
  }
  return pool
}

/** The cutoff (x pitch, of `ratios`) that best turns `levels` into `target`, a lower one only if CLOSER. */
function bestCutoff(target: number[], levels: number[], ratios = RATIOS): { cutoff: number; fit: number } {
  let best = { cutoff: Infinity, fit: Infinity }
  for (const c of ratios) {
    const fit = distance(target, levels, c)
    if (fit < best.fit - CLOSER) best = { cutoff: c, fit }
  }
  return best
}

/** The wave and cutoff (x pitch) closest to `target`; `cutoff` fixes the cutoff. */
export function fitWave(target: number[], levels: (number[] | null)[], cutoff?: number): { wave: number; cutoff: number; fit: number } {
  let best = { wave: 0, cutoff: Infinity, fit: Infinity }
  for (const { wave, l } of candidates(levels)) {
    const here = bestCutoff(target, l, cutoff === undefined ? RATIOS : [cutoff])
    if (here.fit < best.fit) best = { wave, ...here }
  }
  return best
}

const octaves = (ratio: number) => Math.log2(Math.min(ratio, 2 ** 7.5))

/** Filter 1 Cutoff (raw) putting the cutoff at `ratio` times the pitch of `midi` (keytrack 100 %). */
export function cutoffRaw(ratio: number, f0: number, midi: number): number {
  if (!Number.isFinite(ratio)) return 1024
  const { hzAt512, octaveRaw, pivotNote, keytrack } = CALIBRATION.cutoff
  const hz = ratio * f0
  return clamp(Math.round(512 + octaveRaw * Math.log2(hz / (hzAt512 * 2 ** ((keytrack * (midi - pivotNote)) / 12)))))
}

/** The frames that sound (above -40 dB): what timbre over time follows. */
const sounding = (a: SoundAnalysis) => a.frames.filter((f) => f.db > -40)

/**
 * How the note's brightness moves: the cutoff (octaves over the pitch) at each sounding frame with
 * the wave `levels`, and an envelope from the end's cutoff up to the brightest and back: null when
 * it moves less than half an octave.
 */
function brightness(a: SoundAnalysis, levels: number[]) {
  const frames = sounding(a)
  if (frames.length < 3) return null
  const raw = frames.map((f) => octaves(bestCutoff(f.harmonics.levels, levels).cutoff))
  // A three-frame median: single frames jump between neighbouring cutoffs.
  const track = raw.map((_, i) => [raw[i - 1] ?? raw[i], raw[i], raw[i + 1] ?? raw[i]].sort((x, y) => x - y)[1])
  const top = track.indexOf(Math.max(...track))
  const end = track[track.length - 1]
  const span = track[top] - end
  if (span < 0.5) return null
  const fallTo = track.findIndex((v, i) => i > top && v - end <= 0.1 * span)
  const tTop = frames[top].t - a.onsetS
  const tFall = (fallTo < 0 ? frames[frames.length - 1].t : frames[fallTo].t) - frames[top].t
  return { track, endOctaves: end, span, attackS: tTop, decayS: tFall / 0.9 }
}

/**
 * The waves along the note for WaveScan: the span over which the best wave keeps changing (from
 * the onset, at most 3 s), cut into equal parts, each part's best wave; null when it's one wave.
 * `cutoffs`: the cutoff (x pitch) at each sounding frame.
 */
function scanWaves(a: SoundAnalysis, levels: (number[] | null)[], cutoffs: number[]) {
  const frames = sounding(a)
  const best = frames.map((f, i) => fitWave(f.harmonics.levels, levels, cutoffs[i]).wave)
  // The last frame whose best wave differs from the one before.
  let last = best.length - 1
  while (last > 0 && best[last] === best[last - 1]) last--
  if (last <= 0) return null
  const spanS = Math.min(3, frames[last].t - a.onsetS)
  if (spanS < 0.05) return null
  const n = Math.max(2, Math.min(8, Math.round(spanS / 0.15) + 1))
  const step = spanS / (n - 1)
  const waves = Array.from({ length: n }, (_, position) => {
    // The wave closest over the frames within half a step of this position (or the nearest one).
    const t = a.onsetS + position * step
    const offset = (f: number) => Math.abs(frames[f].t - t)
    const indices = frames.map((_, f) => f)
    const near = indices.filter((f) => offset(f) <= step / 2 + 1e-9)
    const pool = near.length ? near : [indices.reduce((x, f) => (offset(f) < offset(x) ? f : x))]
    let pick = { wave: 0, fit: Infinity }
    for (const { wave, l } of candidates(levels)) {
      const fit = pool.reduce((sum, f) => sum + distance(frames[f].harmonics.levels, l, cutoffs[f]), 0)
      if (fit < pick.fit) pick = { wave, fit }
    }
    return pick.wave
  })
  return waves.every((w) => w === waves[0]) ? null : { waves, spanS }
}

/** ENV n's times and sustain for `adsr`: on the Amp (`amp`) or the filter, as measured on each. */
function setEnvelope(p: Patch, n: number, adsr: Adsr, amp: boolean) {
  const env = `env${n}`
  p.set(`${env}bpmsync`, 0)
  p.set(`${env}attacksyncoff`, rawFor(`${env}attacksyncoff`, adsr.attackS * 1000))
  p.set(`${env}holdsyncoff`, 0)
  const decay = amp ? CALIBRATION.ampDecayFactor : CALIBRATION.filterDecayFactor
  p.set(`${env}decaysyncoff`, rawFor(`${env}decaysyncoff`, (adsr.decayS * 1000) / decay))
  p.set(`${env}sustain`, clamp(Math.round(adsr.sustain * 1024)))
  const release = amp ? CALIBRATION.ampReleaseFactor : CALIBRATION.filterDecayFactor
  p.set(`${env}releasesyncoff`, rawFor(`${env}releasesyncoff`, (adsr.releaseS * 1000) / release))
}

/** The Init patch turned into one that plays the note in `a`. */
export function buildWavPatch(a: SoundAnalysis, { levels, envelope = 'detect', overTime = true, wobble = true, name = '' }: WavPatchOptions): WavPatch {
  const p = new Patch(initPatchBytes())
  p.name = name.slice(0, 16)
  const { wave, cutoff, fit } = fitWave(a.spectrum.levels, levels)

  // OSC 1, Filter 1 (keytrack 100 %, so the cutoff keeps its place among the harmonics).
  p.set('osc1mode', 0)
  p.set('osc1type', wave)
  p.set('filter1type', 0) // LP Ladder 12
  p.set('filter1resonance', 0)
  p.set('filter1keytrack', 768) // 100 %
  p.set('filter1cutoff', cutoffRaw(cutoff, a.f0, a.midi))

  let waves = [wave]
  let filterEnvelope = false
  if (overTime) {
    const bright = brightness(a, levels[wave]!)
    if (bright) {
      // ENV 1 from the end's cutoff up by the span; Env 1 Amount scales a full envelope.
      filterEnvelope = true
      const base = 2 ** bright.endOctaves
      p.set('filter1cutoff', cutoffRaw(base, a.f0, a.midi))
      const lift = (bright.span * CALIBRATION.cutoff.octaveRaw) / CALIBRATION.envAmountCutoffRaw
      p.set('filter1env1amount', clamp(Math.round(512 + lift), 512))
      setEnvelope(p, 1, { attackS: bright.attackS, decayS: bright.decayS, sustain: 0, releaseS: 0.1 }, false)
    }
    const cutoffs = bright ? bright.track.map((o) => 2 ** o) : sounding(a).map(() => cutoff)
    const scan = scanWaves(a, levels, cutoffs)
    if (scan) {
      // OSC 1 scans the waves (positions 2-8 store Off and Silence ahead of them; unused ones Off),
      // ENV 3 rising through them over the span: position i of 8 at i/7 of the range.
      waves = scan.waves
      p.set('osc1mode', 1)
      p.set('osc1wavscan', 0)
      for (let slot = 1; slot <= 8; slot++) {
        const w = waves[slot - 1]
        p.set(`osc1wavscanwave${slot}`, w === undefined ? (slot === 1 ? 3 : 0) : slot === 1 ? w : w + 2)
      }
      setEnvelope(p, 3, { attackS: scan.spanS, decayS: 0, sustain: 1, releaseS: 0 }, false)
      p.set('env3atkcurve', 64) // Linear
      route(p, 1, 3 /* Env 3 */, 'osc1wavscan', (128 * (waves.length - 1)) / 7)
    }
  }

  // ENV 2, the Amp.
  const adsr = ENVELOPES.find((e) => e.value === envelope)?.adsr ?? a.adsr
  setEnvelope(p, 2, adsr, true)

  const vibrato = wobble ? a.vibrato : null
  const tremolo = wobble ? a.tremolo : null
  p.set('voicevibratoamount', 0)
  if (vibrato) {
    p.set('lfo1wave', 0) // Sine
    p.set('lfo1bpmsync', 0)
    p.set('lfo1ratesyncoff', rawFor('lfo1ratesyncoff', vibrato.rateHz))
    p.set('lfo1level', 1024)
    route(p, 2, 6 /* LFO 1 */, 'osc1semi', (128 * vibrato.depth) / CALIBRATION.lfoPitchCents)
  } else {
    // A gentle vibrato for the Mod Wheel to bring in (the Voice's own plays only with it up): 20 cents at 5.5 Hz.
    p.set('voicevibratoratesyncoff', rawFor('voicevibratoratesyncoff', 5.5))
    p.set('voicevibratoamount', Math.round(20 / CALIBRATION.voiceVibratoCentsPerRaw))
  }
  if (tremolo) {
    p.set('lfo2wave', 0) // Sine
    p.set('lfo2bpmsync', 0)
    p.set('lfo2ratesyncoff', rawFor('lfo2ratesyncoff', tremolo.rateHz))
    p.set('lfo2level', 1024)
    // The swing m that takes the level 1 + m and 1 - m apart by the depth to either side.
    const ratio = 10 ** (tremolo.depth / 10)
    const swing = (ratio - 1) / (ratio + 1)
    p.set('amplfo2amount', clamp(Math.round(512 + (512 * swing) / CALIBRATION.tremoloSwing), 512))
  }

  return {
    patch: p,
    note: noteName(a.midi) + (Math.abs(a.cents) >= 5 ? ` ${a.cents > 0 ? '+' : '−'}${Math.abs(a.cents)} cents` : ''),
    waves,
    filterEnvelope,
    vibrato,
    tremolo,
    fit,
    warnings: a.warnings,
  }
}

/** Mod matrix route `n`: `source` to the destination of `key`, at `depth` of -128..128. */
function route(p: Patch, n: number, source: number, key: string, depth: number) {
  p.set(`modmatrix${n}modsource`, source)
  p.set(`modmatrix${n}modtarget`, destinationOf(key)!)
  p.set(`modmatrix${n}depth`, Math.round(512 + 4 * clamp(depth, -128, 128)))
}

/**
 * What the patch plays and how to play it: "Play C3: Saw, 3 waves by WaveScan, filter envelope,
 * vibrato 5.4 Hz; fit 2.1 dB (inharmonic or noisy: best effort)".
 */
export function wavStatus(w: Pick<WavPatch, 'note' | 'waves' | 'filterEnvelope' | 'vibrato' | 'tremolo' | 'fit' | 'warnings'>): string {
  const parts = [WAVE_FEATURES[w.waves[0]]?.name ?? `Wave ${w.waves[0]}`]
  if (w.waves.length > 1) parts.push(`${w.waves.length} waves by WaveScan`)
  if (w.filterEnvelope) parts.push('filter envelope')
  parts.push(w.vibrato ? `vibrato ${w.vibrato.rateHz.toFixed(1)} Hz` : 'vibrato on the Mod Wheel')
  if (w.tremolo) parts.push(`tremolo ${w.tremolo.rateHz.toFixed(1)} Hz`)
  const warn = w.warnings.length ? ` (${w.warnings.join(', ')}: best effort)` : ''
  return `Play ${w.note}: ${parts.join(', ')}; fit ${w.fit.toFixed(1)} dB${warn}`
}
