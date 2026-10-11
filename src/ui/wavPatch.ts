// A patch that plays the note recorded in a WAV file (its analysis: src/audio/analyse.ts), from
// the synth's waves or from Mutant FM (or whichever fits better):
//   OSC 1      the wave whose harmonics best match the note's at its peak; following how the
//              sound changes (`overTime`), a WaveScan list of the waves along the note when they
//              differ enough to play it closer, swept by ENV 3 (mod matrix route 1 to Osc 1 WaveScan)
//   OSC 2      a Sine at the note when the wave's fundamental falls more than 6 dB short of the
//              note's (a sub oscillator, as on a Minimoog), at the level that makes it up
//   Mutant 1   FM: a Sine on OSC 1, FM-Linear at the Ratio and Depth whose harmonics best match
//              the peak (src/ui/fmModel.ts); following how the sound changes, ENV 3 moves the
//              Depth with the note's (mod matrix route 1 to Mut 1 Depth), and no WaveScan
//   Filter 1   LP Ladder 12, keytrack 100 % (open with FM): the cutoff (and Resonance, as measured:
//              src/ui/ladderResponse.generated.ts) that, with the wave, best matches the
//              peak; following how the sound changes, ENV 1 (its own Env 1 Amount) follows the
//              note's brightness when that moves more than half an octave (not with FM: the
//              cutoff stays at the peak's, and ENV 3 moves the Depth instead)
//   ENV 2      the Amp: the note's attack, decay, sustain and release, or a Pluck/Keys/Pad preset
//   LFO 1      vibrato found in the note (route 2 to Osc 1 Pitch), else the Voice's own vibrato,
//              which plays with the Mod Wheel up
//   LFO 2      tremolo found in the note (the Amp's own LFO 2 Amount)
//   ENV 4      a pitch that drops or slides into the note (a kick, a tom, a zap): route 7 to All Osc
//              Pitch, its Decay and curve shaped like the drop
//   Dirt       as recorded (src/audio/dirt.ts): noise between the harmonics on the noise source in
//              the nearest colour through Filter 1, a little under the recording's, on a Noise macro; a pitch that wanders on a Random LFO 3 (route 6, All Osc Pitch);
//              a second voice some cents off on OSC 3, the same wave, OSC 1 as far the other way;
//              a string machine's ensemble on the two FX: a Chorus at 0.6 Hz before, one at 6 Hz after
//   Macros     1 Bright (Filt 1 Cutoff), 2 Timbre (FM Depth, WaveScan, or Resonance on one wave),
//              3 Attack and 4 Release (ENV 2), Movement (how far ENV 1 or 3 moves things) and Dirt
//              (Filter 1 Drive, from none: a recording's saturation is in its harmonics already), each
//              knob in its middle (or at an end) where the patch is as generated: a starting point
//   Playing    velocity scales the Amp envelope and opens the filter (ENV 1's amount, or route 3
//              to Filt 1 Cutoff); aftertouch, channel or poly (routes 4 and 5), opens it further
// A recording with no note in it (little in harmonics, no clear repeat: a hi-hat, a crash, a clap)
// gets the noise source instead, in the nearest colour through Filter 1 at the cutoff that shapes
// its octave bands, ENV 1 following its brightness (buildNoisePatch).
// Harmonic k of a wave sits at k times the note whatever note plays, so the waves' harmonics,
// measured once at C2 (src/ui/waveSpeech.ts waveLevels), compare with the note's at its own pitch.
// Measured on a Hydrasynth Desktop (fw 2.x) with tools/calibrateWavPatch.ts; see CALIBRATION.
import type { Adsr, SoundAnalysis, Wobble } from '../audio/analyse'
import { detuneLevel } from '../audio/dirt'
import { BAND_HZ } from '../audio/bands'
import { noteName } from '../audio/pitch'
import { formatValue } from '../params/display'
import { initPatchBytes } from '../params/initPatch'
import { Patch, param } from '../params/patch'
import { FM_CALIBRATION, FM_DEPTHS, FM_RATIOS, fmLevels } from './fmModel'
import { LADDER_RESPONSE } from './ladderResponse.generated'
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
   * ENV 1 on the cutoff falls linearly in octaves, from full to 0 in the Decay it shows, and so
   * does ENV 3 through a mod matrix route (filterenv: 896 ms shown, ~900 either way; speech's
   * 2x was heard on pitch); Release taken to run the same (not measured on its own).
   */
  envDecayFactor: 1,
  /** A mod matrix route at depth d of 128 moves its target by d * 8 raw (filterenv: +48 moved Cutoff 384). */
  routeRawPerDepth: 8,
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
  /**
   * The noise source against a Saw on OSC 1, both at Vol 128 (dirt): its level (dB) and slope
   * (dB an octave) per Noise Type, through src/audio/dirt.ts; Noise Vol sets the amplitude as its
   * square, as the oscillators' (64: 11.4 dB under 128, 32: 23.5).
   */
  noise: [
    { type: 0, slope: 0, db: -1.9 }, // White
    { type: 1, slope: -3.0, db: -1.7 }, // Pink
    { type: 2, slope: -5.9, db: -5.8 }, // Brown
    { type: 4, slope: 1.7, db: -3.3 }, // Blue
    { type: 5, slope: 5.6, db: -0.2 }, // Violet
  ],
  /**
   * A string machine's two sweeps on the FX: Pre-FX Chorus at 0.6 Hz and Post-FX Chorus at 6 Hz at
   * half the depth, both Feedback 0 and the same wet; what src/audio/dirt.ts reads of each (ensemble,
   * two takes each; recordings read 5-13 cents, beating 5-6 dB).
   */
  ensemble: [
    { depth: 512, wet: 512, cents: 3.4 },
    { depth: 512, wet: 640, cents: 5.6 },
    { depth: 512, wet: 768, cents: 7.8 },
    { depth: 768, wet: 768, cents: 10.8 },
    { depth: 512, wet: 896, cents: 14.5 },
    { depth: 768, wet: 896, cents: 18.5 },
  ],
  /**
   * ENV 4 on All Osc Pitch (pitchenv): 0.1 semitone per route depth (0.8, 1.6, 3.2 at 8, 16, 32),
   * falling from full in the Decay shown (896 ms: at 0 by 880, linear). Per Decay curve, where it
   * is half way down (share of the Decay shown) and how much later nine tenths (x the half way).
   */
  pitchSemitonesPerDepth: 0.1,
  pitchCurves: [
    { curve: 64, half: 0.5, tenth: 1.8 }, // Linear
    { curve: 96, half: 0.29, tenth: 2.3 }, // Exp 32
    { curve: 128, half: 0.04, tenth: 3.3 }, // Exp 64
  ],
  /** A Random LFO (1.5 Hz, Smooth 127) on All Osc Pitch: cents of drift per route depth (drift: 4.9 at 4, 8.9 at 8; Analog Feel drifts none within a note). */
  driftCentsPerDepth: 1.15,
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

export type Source = 'waves' | 'fm' | 'auto'
export const SOURCES: { value: Source; label: string }[] = [
  { value: 'waves', label: 'The synth’s waves' },
  { value: 'fm', label: 'Mutant FM' },
  { value: 'auto', label: 'Whichever fits better' },
]
/** Auto takes FM only when it fits this much better (dB): the waves are measured, FM is a model. */
const FM_MARGIN = 0.5

export interface WavPatchOptions {
  /** Each wave's harmonicLevels (src/ui/waveSpeech.ts waveLevels). */
  levels: (number[] | null)[]
  /** Each wave's loudest harmonic as played (src/ui/waveSpeech.ts wavePeaks): without them, no OSC 2 Sine. */
  peaks?: (number | null)[]
  source?: Source
  envelope?: Envelope
  /** WaveScan and a filter envelope following how the note changes. */
  overTime?: boolean
  /** Vibrato and tremolo as found in the note. */
  wobble?: boolean
  /** Drift, detune and noise as recorded (dirt). */
  dirt?: boolean
  name?: string
}

export interface WavPatch {
  patch: Patch
  /** The note to play for the recorded pitch: "C3", "C3 +12 cents". */
  note: string
  /** The waves played, in WaveScan order (one: no WaveScan; none with FM). */
  waves: number[]
  /** What of the recording's dirt the patch plays: its noise's colour, drift and detune (cents). */
  dirt: { noise: string | null; drift: number | null; detune: number | null; ensemble: boolean }
  /** OSC 2 plays a Sine under the wave. */
  sub: boolean
  /** Noise instead of a note: the noise source's colour through a low-pass at `cutoffHz` (as at middle C). */
  noise: { colour: string; cutoffHz: number } | null
  /** Filter 1's Resonance (raw), for a resonant peak the recording has. */
  resonance: number
  /** A pitch that drops (or rises, negative) this many semitones into the note, on ENV 4. */
  glide: number | null
  /** Mutant FM instead: its Ratio, Depth (raw) and whether ENV 3 moves the Depth. */
  fm: { ratio: number; depth: number; envelope: boolean } | null
  filterEnvelope: boolean
  vibrato: Wobble | null
  tremolo: Wobble | null
  /** How far the wave and filter are from the note's harmonics at its peak (dB, weighted RMS). */
  fit: number
  /** The macros' names, in order. */
  macros: string[]
  warnings: string[]
}

/** Cutoffs tried, as multiples of the note's pitch: open, then quarter octaves from 128x down to 1x. */
const RATIOS = [Infinity, ...Array.from({ length: 29 }, (_, i) => 2 ** ((28 - i) / 4))]
/** A lower cutoff has to fit this much better (dB): a sine needs no filter, though one at its pitch fits as well. */
const CLOSER = 0.05
const FLOOR = -60

const clamp = (v: number, lo = 0, hi = 1024) => Math.max(lo, Math.min(hi, v))

/**
 * LP Ladder 12 at `ratio` times its cutoff and `resonance` (raw, one of LADDER_RESPONSE's): dB. Without
 * resonance a two-pole low-pass (within 0.7 dB of the synth's); with it as measured (ladder).
 */
export function filterDb(ratio: number, resonance = 0): number {
  if (!resonance || !Number.isFinite(ratio)) return lpDb(ratio)
  const { firstRatio, perOctave, resonances, db } = LADDER_RESPONSE
  const row = db[resonances.indexOf(resonance)]
  const at = Math.log2(ratio / firstRatio) * perOctave
  if (at <= 0) return row[0]
  // Past the last measured point, falling as a two-pole low-pass does: 12 dB an octave.
  if (at >= row.length - 1) return row[row.length - 1] - ((at - (row.length - 1)) / perOctave) * 12
  const i = Math.floor(at)
  return row[i] + (row[i + 1] - row[i]) * (at - i)
}

/** LP Ladder 12 at `ratio` times the cutoff: dB (a two-pole low-pass, Q ~0.54 without resonance). */
export function lpDb(ratio: number, q = 0.54): number {
  if (!Number.isFinite(ratio)) return 0
  return -10 * Math.log10((1 - ratio * ratio) ** 2 + (ratio / q) ** 2)
}

/**
 * How far `levels` (dB per harmonic, from 0) are from `target`, through LP Ladder 12 at `cutoff`
 * times the pitch and `resonance` (raw): RMS of the dB difference, both floored at -60 dB, low harmonics weighted more,
 * any overall level difference taken out.
 */
export function distance(target: number[], levels: number[], cutoff = Infinity, resonance = 0): number {
  const n = Math.min(target.length, levels.length)
  const filter = filterCurve(cutoff, resonance)
  let top = -Infinity
  for (let k = 0; k < n; k++) top = Math.max(top, levels[k] + filter[k])
  let sw = 0
  let sd = 0
  let sdd = 0
  for (let k = 0; k < n; k++) {
    const d = Math.max(target[k], FLOOR) - Math.max(levels[k] + filter[k] - top, FLOOR)
    const w = WEIGHTS[k]
    sw += w
    sd += w * d
    sdd += w * d * d
  }
  const mean = sd / sw
  return Math.sqrt(Math.max(0, sdd / sw - mean * mean))
}

/** Low harmonics weigh more in `distance`: harmonic k by 1/sqrt(k). */
const WEIGHTS = Float64Array.from({ length: 128 }, (_, k) => 1 / Math.sqrt(k + 1))
const curves = new Map<string, Float64Array>()
/** filterDb at harmonics 1..128 of a cutoff `cutoff` times the pitch: the same few, asked for again and again. */
function filterCurve(cutoff: number, resonance: number): Float64Array {
  const key = `${cutoff}/${resonance}`
  let curve = curves.get(key)
  if (!curve) {
    curve = Float64Array.from({ length: 128 }, (_, k) => filterDb((k + 1) / cutoff, resonance))
    if (curves.size < 4096) curves.set(key, curve)
  }
  return curve
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
function bestCutoff(target: number[], levels: number[], ratios = RATIOS, resonance = 0): { cutoff: number; fit: number } {
  let best = { cutoff: Infinity, fit: Infinity }
  for (const c of ratios) {
    const fit = distance(target, levels, c, resonance)
    if (fit < best.fit - CLOSER) best = { cutoff: c, fit }
  }
  return best
}

/** Every wave with the cutoff (x pitch) that fits `target` best, the closest first; `cutoff` fixes the cutoff. */
function rankWaves(target: number[], levels: (number[] | null)[], cutoff?: number, resonance = 0): { wave: number; cutoff: number; fit: number }[] {
  return candidates(levels)
    .map(({ wave, l }) => ({ wave, ...bestCutoff(target, l, cutoff === undefined ? RATIOS : [cutoff], resonance) }))
    .sort((x, y) => x.fit - y.fit)
}

/** The wave and cutoff (x pitch) closest to `target`; `cutoff` fixes the cutoff. */
export function fitWave(target: number[], levels: (number[] | null)[], cutoff?: number, resonance = 0): { wave: number; cutoff: number; fit: number } {
  let best = { wave: 0, cutoff: Infinity, fit: Infinity }
  for (const { wave, l } of candidates(levels)) {
    const here = bestCutoff(target, l, cutoff === undefined ? RATIOS : [cutoff], resonance)
    if (here.fit < best.fit) best = { wave, ...here }
  }
  return best
}

/** The sources a resonant filter is nearly always on: Triangle, TriSaw, Saw, Square, Pulse 1-6. */
const SIMPLE_WAVES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

/**
 * The Resonance (raw, of LADDER_RESPONSE's) a recording's filter has, or 0. A resonant peak alone
 * looks like any bump in a spectrum (a wave's, a formant, FM's): it's only taken where
 *  - the harmonics swell one after another from the top down, as the peak sweeps through them
 *    (a filter envelope closing; RESONANT.sweep), or
 *  - a simple source (SIMPLE_WAVES) fits the frames RESONANT.gain dB closer through the filter with
 *    resonance than without, and no more than RESONANT.near dB worse than the best of all the waves
 *    (a saw through a resonant low-pass, not a bell, a sine or FM that a peak happens to fit).
 * Tested on a Saw and a Square recorded through LP Ladder 12 at known Resonance (tools/
 * calibrateWavPatch.ts resonanceset): 31 of 32 at 704 and 832 found, none at 0; one false find
 * among 38 recordings without, a DX marimba played as FM anyway.
 */
export function resonanceOf(a: SoundAnalysis, levels: (number[] | null)[]): number {
  const all = sounding(a)
  // Every fourth frame (at most 25): enough to judge, a fraction of the time.
  const frames = all.filter((_, i) => i % Math.max(1, Math.ceil(all.length / 25)) === 0)
  if (!frames.length) return 0
  const resonances = LADDER_RESPONSE.resonances.filter((r) => r > 0)
  // A peak at the fundamental itself turns any wave into a sine: from the second harmonic up.
  const finite = RATIOS.filter((r) => Number.isFinite(r) && r >= 2)
  const sources = SIMPLE_WAVES.filter((w) => levels[w])
  if (!sources.length) return 0
  /** The best simple source's mean distance over the frames, the cutoff free in each, at `resonance`. */
  const simple = (resonance: number) =>
    Math.min(...sources.map((w) => frames.reduce((sum, f) => sum + bestCutoff(f.harmonics.levels, levels[w]!, resonance ? finite : RATIOS, resonance).fit, 0) / frames.length))
  const plain = simple(0)
  const byResonance = resonances.map((r) => ({ r, fit: simple(r) })).reduce((x, y) => (y.fit < x.fit ? y : x))
  if (sweepScore(all) >= RESONANT.sweep) return byResonance.r
  if (plain - byResonance.fit < RESONANT.gain) return 0
  // Only now all the waves (the costly part): is a filtered simple source as good as any?
  const general = frames.reduce((sum, f) => sum + fitWave(f.harmonics.levels, levels).fit, 0) / frames.length
  return byResonance.fit <= general + RESONANT.near ? byResonance.r : 0
}

const RESONANT = { sweep: 6, gain: 1, near: 0.3 }

/**
 * How clearly the harmonics (2-24) swell one after another from the top down, as a resonant peak
 * sweeping down passes each: the number swelling 6 dB or more over where they start and end (against
 * the fundamental), times how strongly their swells come in order (the correlation of harmonic and
 * time, negated). 0 for a note without such a sweep; long resonant sweeps read 7-21.
 */
function sweepScore(frames: SoundAnalysis['frames']): number {
  if (frames.length < 5) return 0
  const swells: { k: number; t: number }[] = []
  for (let k = 2; k <= Math.min(24, frames[0].harmonics.amps.length); k++) {
    const rel = frames.map((f) => 20 * Math.log10((f.harmonics.amps[k - 1] + 1e-9) / (f.harmonics.amps[0] + 1e-9)))
    const top = Math.max(...rel)
    if (Math.min(top - rel[0], top - rel[rel.length - 1]) >= 6) swells.push({ k, t: frames[rel.indexOf(top)].t })
  }
  const n = swells.length
  if (n < 3) return 0
  const mk = swells.reduce((sum, s) => sum + s.k, 0) / n
  const mt = swells.reduce((sum, s) => sum + s.t, 0) / n
  const cov = swells.reduce((sum, s) => sum + (s.k - mk) * (s.t - mt), 0)
  const vk = swells.reduce((sum, s) => sum + (s.k - mk) ** 2, 0)
  const vt = swells.reduce((sum, s) => sum + (s.t - mt) ** 2, 0)
  return vk && vt ? n * Math.max(0, -cov / Math.sqrt(vk * vt)) : 0
}

const octaves = (ratio: number) => Math.log2(Math.min(ratio, 2 ** 7.5))

/** Filter 1 Cutoff (raw) putting the cutoff at `ratio` times the pitch of `midi` (keytrack 100 %). */
export function cutoffRaw(ratio: number, f0: number, midi: number): number {
  if (!Number.isFinite(ratio)) return 1024
  const { hzAt512, octaveRaw, pivotNote, keytrack } = CALIBRATION.cutoff
  const hz = ratio * f0
  return clamp(Math.round(512 + octaveRaw * Math.log2(hz / (hzAt512 * 2 ** ((keytrack * (midi - pivotNote)) / 12)))))
}

/**
 * The frames timbre over time follows: within 24 dB of the peak. Quieter tails (a release, a
 * room) are heard little, yet would set where the filter and Depth settle.
 */
const sounding = (a: SoundAnalysis) => a.frames.filter((f) => f.db > -24)

/**
 * How the note's brightness moves: the cutoff (octaves over the pitch) at each sounding frame with
 * the wave `levels`, and an envelope from the end's cutoff up to the brightest and back: null when
 * it moves less than half an octave.
 */
function brightness(a: SoundAnalysis, levels: number[], resonance = 0) {
  return envelopeOf(a, (f) => octaves(bestCutoff(f.harmonics.levels, levels, RATIOS, resonance).cutoff), 0.5)
}

/**
 * An envelope following `value` over the sounding frames, linear (ENV 1 and 3 run so): from its
 * lower end (where it starts or where it ends) up to its top, then down to where it ends, timed
 * by the halfway point (exact for a linear fall, half as far off for an exponential one); with
 * the track (a three-frame median: single frames jump between neighbouring values). Null when it
 * moves less than `least`.
 */
function envelopeOf(a: SoundAnalysis, value: (f: SoundAnalysis['frames'][number]) => number, least: number) {
  const frames = sounding(a)
  return envelopeOfTrack(
    frames.map((f) => f.t),
    frames.map(value),
    a.onsetS,
    least,
  )
}

/** envelopeOf for any track: `values` at `times` (s), the note starting at `startS`. */
function envelopeOfTrack(times: number[], raw: number[], startS: number, least: number) {
  if (raw.length < 3) return null
  const track = raw.map((_, i) => [raw[i - 1] ?? raw[i], raw[i], raw[i + 1] ?? raw[i]].sort((x, y) => x - y)[1])
  const top = track.indexOf(Math.max(...track))
  const end = track[track.length - 1]
  const base = Math.min(track[0], end)
  const span = track[top] - base
  if (span < least) return null
  const fall = track[top] - end
  const half = track.findIndex((v, i) => i > top && track[top] - v >= 0.5 * fall)
  const decayS = fall > 0 && half > 0 ? 2 * (times[half] - times[top]) : 0
  return { track, base, span, attackS: times[top] - startS, decayS, sustain: (end - base) / span }
}

/** The FM Ratio, Depth and cutoff (x pitch) closest to `target`; `ratio` and `cutoff` fix those. */
export function fitFm(target: number[], ratio?: number, cutoff?: number): { ratio: number; ratioRaw: number; depth: number; cutoff: number; fit: number } {
  let best = { ratio: 1, ratioRaw: 512, depth: 0, cutoff: Infinity, fit: Infinity }
  for (const r of FM_RATIOS) {
    if (ratio !== undefined && r.ratio !== ratio) continue
    for (const depth of FM_DEPTHS) {
      const here = bestCutoff(target, fmLevels(r.ratio, depth), cutoff === undefined ? RATIOS : [cutoff])
      if (here.fit < best.fit) best = { ratio: r.ratio, ratioRaw: r.raw, depth, ...here }
    }
  }
  return best
}

/**
 * The waves along the note for WaveScan: the span over which the best wave keeps changing (from
 * the onset, at most 3 s), cut into equal parts, each part's best wave; null when it's one wave.
 * `cutoffs`: the cutoff (x pitch) at each sounding frame.
 */
function scanWaves(a: SoundAnalysis, levels: (number[] | null)[], cutoffs: number[], main: number, resonance = 0) {
  const frames = sounding(a)
  const best = frames.map((f, i) => fitWave(f.harmonics.levels, levels, cutoffs[i], resonance).wave)
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
      const fit = pool.reduce((sum, f) => sum + distance(frames[f].harmonics.levels, l, cutoffs[f], resonance), 0)
      if (fit < pick.fit) pick = { wave, fit }
    }
    return pick.wave
  })
  if (waves.every((w) => w === waves[0])) return null
  // Worth it only if it plays the note closer than the one wave does: on a steady note, near-equal
  // waves trade places frame by frame, and a sweep through them sounds like nothing but a wobble.
  const at = (f: number) => waves[Math.min(n - 1, Math.round((frames[f].t - a.onsetS) / step))]
  const gain = frames.reduce(
    (sum, f, i) => sum + distance(f.harmonics.levels, levels[main]!, cutoffs[i], resonance) - distance(f.harmonics.levels, levels[at(i)]!, cutoffs[i], resonance),
    0,
  )
  return gain / frames.length >= SCAN_GAIN ? { waves, spanS } : null
}

/**
 * How much dirt a recording needs before the patch plays it: more than a clean synth recording
 * reads (noise -55..-70 dB, drift under 1 cent, 2-3 where a filter or WaveScan moves the phase).
 */
const DIRT = { noiseDb: -50, noiseUnderDb: 3, driftCents: 2.5, driftMaxCents: 8, detuneCents: 2 }

/**
 * How much (dB, 0 or less) LP Ladder 12 at `cutoffHz` takes off a noise of `slope` dB an octave,
 * over the octave bands its level was read in (250 Hz to 16 kHz, src/audio/dirt.ts).
 */
function noiseFilterLoss(slope: number, cutoffHz: number): number {
  const bands = BAND_HZ.filter((hz) => hz >= 250)
  const power = (filtered: boolean) => bands.reduce((sum, hz) => sum + hz * 10 ** ((slope * Math.log2(hz / 1000) + (filtered ? lpDb(hz / cutoffHz) : 0)) / 10), 0)
  return 10 * Math.log10(power(true) / power(false))
}

/** The Sine (wave 0), and how far (dB) a wave's fundamental may fall short before OSC 2 plays one under it. */
const SINE = 0
const SUB_GAP = 6

/** How much closer (dB, on average over the frames) WaveScan has to play the note than one wave. */
const SCAN_GAIN = 1.5

/** ENV n's times and sustain for `adsr`: on the Amp (`amp`) or the filter, as measured on each. */
function setEnvelope(p: Patch, n: number, adsr: Adsr, amp: boolean) {
  const env = `env${n}`
  p.set(`${env}bpmsync`, 0)
  p.set(`${env}attacksyncoff`, rawFor(`${env}attacksyncoff`, adsr.attackS * 1000))
  p.set(`${env}holdsyncoff`, 0)
  const decay = amp ? CALIBRATION.ampDecayFactor : CALIBRATION.envDecayFactor
  p.set(`${env}decaysyncoff`, rawFor(`${env}decaysyncoff`, (adsr.decayS * 1000) / decay))
  p.set(`${env}sustain`, clamp(Math.round(adsr.sustain * 1024)))
  const release = amp ? CALIBRATION.ampReleaseFactor : CALIBRATION.envDecayFactor
  p.set(`${env}releasesyncoff`, rawFor(`${env}releasesyncoff`, (adsr.releaseS * 1000) / release))
}

/** The Init patch turned into one that plays the note in `a`. */
export function buildWavPatch(
  a: SoundAnalysis,
  { levels, peaks, source = 'waves', envelope = 'detect', overTime = true, wobble = true, dirt = true, name = '' }: WavPatchOptions,
): WavPatch {
  if (isNoise(a)) return buildNoisePatch(a, { levels, envelope, overTime, name })
  const p = new Patch(initPatchBytes())
  p.name = name.slice(0, 16)
  // A resonant filter where the recording shows one; the wave then chosen at that resonance, so
  // a wave's own bump doesn't stand in for the peak.
  const found = source === 'fm' ? 0 : resonanceOf(a, levels)
  const byWave = source === 'fm' ? null : { ...fitWave(a.spectrum.levels, levels, undefined, found), resonance: found }
  // FM through an open filter: its Depth carries the brightness, as on a DX; a cutoff fitted at the
  // peak trimmed the bright start of a falling Depth, and the level then swelled in as it fell.
  const byFm = source === 'waves' ? null : fitFm(a.spectrum.levels, undefined, Infinity)
  const useFm = !!byFm && (!byWave || byFm.fit < byWave.fit - FM_MARGIN)
  const { cutoff, fit } = useFm ? byFm! : byWave!

  // Filter 1 (keytrack 100 %, so the cutoff keeps its place among the harmonics).
  const resonance = useFm ? 0 : byWave!.resonance
  p.set('filter1type', 0) // LP Ladder 12
  p.set('filter1resonance', resonance)
  p.set('filter1keytrack', 768) // 100 %
  p.set('filter1cutoff', cutoffRaw(cutoff, a.f0, a.midi))
  p.set('osc1mode', 0)

  let waves: number[] = []
  let fm: WavPatch['fm'] = null
  let filterEnvelope = false
  if (useFm) {
    // A Sine on OSC 1 through Mutant 1 (OSC 1 runs through Mutants 1 and 2), all FM.
    const { ratio, ratioRaw, depth } = byFm!
    p.set('osc1type', 0) // Sine
    p.set('mutant1mode', 0) // FM-Linear
    p.set('mutant1sourcefmlin', 0) // Sine
    p.set('mutant1ratio', ratioRaw)
    p.set('mutant1feedback', FM_CALIBRATION.feedback)
    p.set('mutant1wet', 1024)
    p.set('mutant1depth', depth)
    fm = { ratio, depth, envelope: false }
    // ENV 3 from the lower end's Depth up by the span (a route at depth d moves it d * 8 raw).
    const moves = overTime ? envelopeOf(a, (f) => fitFm(f.harmonics.levels, ratio, cutoff).depth, 64) : null
    if (moves) {
      fm = { ratio, depth: moves.base, envelope: true }
      p.set('mutant1depth', moves.base)
      setEnvelope(p, 3, { attackS: moves.attackS, decayS: moves.decayS, sustain: moves.sustain, releaseS: 0.1 }, false)
      route(p, 1, 3 /* Env 3 */, 'mutant1depth', moves.span / CALIBRATION.routeRawPerDepth)
    }
  } else {
    p.set('osc1type', byWave!.wave)
    waves = [byWave!.wave]
  }

  // OSC 2: a Sine under a wave whose fundamental falls short of the note's, at the level that
  // makes up the difference (the levels set the wave's loudest harmonic against the note's).
  let sub = false
  const wave = waves[0]
  if (!useFm && peaks?.[wave] && peaks[SINE]) {
    const want = 10 ** (a.spectrum.levels[0] / 20)
    const has = 10 ** ((levels[wave]![0] + lpDb(1 / cutoff)) / 20)
    if (20 * Math.log10(want / has) > SUB_GAP) {
      const need = (peaks[wave]! * Math.sqrt(want * want - has * has)) / peaks[SINE]!
      sub = true
      p.set('osc2type', SINE)
      p.set('osc2semi', 0)
      p.set('osc2cent', 0)
      // Osc 2 Vol sets the amplitude as its square (mixer: 96 of 128 -5.0 dB, 64 -12.0).
      p.set('mixerosc2vol', clamp(Math.round(1024 * Math.sqrt(Math.min(1, need)))))
    }
  }

  if (overTime && !useFm) {
    const bright = brightness(a, levels[wave]!, resonance)
    if (bright) {
      // ENV 1 from the lower end's cutoff up by the span; Env 1 Amount scales a full envelope.
      filterEnvelope = true
      p.set('filter1cutoff', cutoffRaw(2 ** bright.base, a.f0, a.midi))
      const lift = (bright.span * CALIBRATION.cutoff.octaveRaw) / CALIBRATION.envAmountCutoffRaw
      p.set('filter1env1amount', clamp(Math.round(512 + lift), 512))
      setEnvelope(p, 1, { attackS: bright.attackS, decayS: bright.decayS, sustain: bright.sustain, releaseS: 0.1 }, false)
    }
    const cutoffs = bright ? bright.track.map((o) => 2 ** o) : sounding(a).map(() => cutoff)
    const scan = scanWaves(a, levels, cutoffs, wave, resonance)
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

  // ENV 4 on All Osc Pitch: the drop (or rise) into the note, its curve as the recording's shape.
  let glide: number | null = null
  if (a.glide) {
    const g = a.glide
    const shape = CALIBRATION.pitchCurves.reduce((x, c) => (Math.abs(c.tenth - g.tenthS / g.halfS) < Math.abs(x.tenth - g.tenthS / g.halfS) ? c : x))
    const depth = clamp(g.semitones / CALIBRATION.pitchSemitonesPerDepth, -128, 128)
    setEnvelope(p, 4, { attackS: 0, decayS: g.halfS / shape.half, sustain: 0, releaseS: 0 }, false)
    p.set('env4deccurve', shape.curve)
    route(p, 7, 4 /* Env 4 */, 'allosc', depth)
    glide = Math.round(depth * CALIBRATION.pitchSemitonesPerDepth)
  }

  // ENV 2, the Amp.
  const adsr = ENVELOPES.find((e) => e.value === envelope)?.adsr ?? a.adsr
  setEnvelope(p, 2, adsr, true)

  // An ensemble's fast sweep reads as vibrato and its beating as tremolo: its choruses play both.
  const ensemble = dirt && !!a.dirt.chorus && !a.warnings.includes('inharmonic or noisy')
  const vibrato = wobble && !ensemble ? a.vibrato : null
  const tremolo = wobble && !ensemble ? a.tremolo : null
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

  // Dirt, as recorded, where it's clearly more than a clean synth recording shows.
  const added: WavPatch['dirt'] = { noise: null, drift: null, detune: null, ensemble: false }
  if (dirt) {
    const { noise, drift, detune, chorus } = a.dirt
    // Not on inharmonic sounds: what lies between their harmonics is partials, not noise.
    if (noise && noise.db >= DIRT.noiseDb && !a.warnings.includes('inharmonic or noisy')) {
      // The colour nearest its slope, at the level that puts it as far under the harmonics.
      const colour = CALIBRATION.noise.reduce((x, c) => (Math.abs(c.slope - noise.slope) < Math.abs(x.slope - noise.slope) ? c : x))
      p.set('noisetype', colour.type)
      // Through Filter 1, so it darkens and fades with the note as a synth's own noise does (past it,
      // it stayed bright in a closing tail and stood out), raised by what the cutoff at the peak takes
      // away there; and DIRT.noiseUnderDb under the recording's: a start, the Noise macro adds more.
      const loss = noiseFilterLoss(colour.slope, cutoff * a.f0)
      p.set('mixernoisevol', clamp(Math.round(1024 * 10 ** ((noise.db - DIRT.noiseUnderDb - colour.db - loss) / 40))))
      added.noise = formatValue(param('noisetype'), colour.type)
    }
    if (detune && detune.cents >= DIRT.detuneCents && !useFm) {
      // OSC 3 the same wave, the two apart by the detune either side of the note.
      const half = Math.min(25, detune.cents / 2)
      p.set('osc3type', waves[0])
      p.set('osc3cent', Math.round(half))
      p.set('osc1cent', -Math.round(half))
      p.set('mixerosc3vol', clamp(Math.round(1024 * Math.sqrt(detuneLevel(detune.depth)))))
      added.detune = 2 * Math.round(half)
    }
    // An ensemble: the FX's two choruses, as wet as reads nearest the recording's wobble.
    if (chorus && ensemble) {
      const fx = CALIBRATION.ensemble.reduce((x, e) => (Math.abs(e.cents - chorus.cents) < Math.abs(x.cents - chorus.cents) ? e : x))
      for (const [side, rate, depth] of [['pre', 0.6, fx.depth], ['post', 6, fx.depth / 2]] as const) {
        p.set(`${side}fxtype`, 1) // Chorus
        p.set(`${side}fx1param1`, rawFor(`${side}fx1param1`, rate))
        p.set(`${side}fx1param2`, depth)
        p.set(`${side}fx1param4`, 64) // Feedback 0
        p.set(`${side}fxwet`, fx.wet)
      }
      added.ensemble = true
    }
    // A pitch that wanders: not where a second voice, a chorus or inharmonic partials make it look
    // so, nor past a few cents (a chorus's wobble, not an oscillator's drift).
    if (drift >= DIRT.driftCents && drift <= DIRT.driftMaxCents && !added.detune && !chorus && !a.warnings.includes('inharmonic or noisy')) {
      p.set('lfo3wave', 9) // Random
      p.set('lfo3bpmsync', 0)
      p.set('lfo3ratesyncoff', rawFor('lfo3ratesyncoff', 1.5))
      p.set('lfo3smooth', 127)
      p.set('lfo3level', 1024)
      route(p, 6, 8 /* LFO 3 */, 'allosc', Math.min(16, drift / CALIBRATION.driftCentsPerDepth))
      added.drift = Math.round(drift)
    }
  }

  const timbre: Timbre = fm ? ['mutant1depth', 'Timbre', 384, 'middle'] : waves.length > 1 ? ['osc1wavscan', 'Timbre', 512, 'bottom'] : RESONANCE
  const macros = finish(p, filterEnvelope, timbre, filterEnvelope ? 'filter1env1amount' : fm?.envelope || waves.length > 1 ? 'modmatrix1depth' : null, !!added.noise)

  return {
    patch: p,
    note: noteName(a.midi) + (Math.abs(a.cents) >= 5 ? ` ${a.cents > 0 ? '+' : '−'}${Math.abs(a.cents)} cents` : ''),
    waves,
    sub,
    dirt: added,
    resonance,
    glide,
    fm,
    noise: null,
    filterEnvelope,
    vibrato,
    tremolo,
    fit,
    macros,
    warnings: a.warnings,
  }
}

/** What macro 2 moves: key, name, span over the knob, where the knob starts. */
type Timbre = [string, string, number, 'middle' | 'bottom']
const RESONANCE: Timbre = ['filter1resonance', 'Resonance', 640, 'bottom']

/**
 * The same for every patch: velocity on the Amp envelope and the filter, aftertouch on the filter,
 * and the macros (`moving`: what Movement scales, if anything moves; `noise`: a Noise macro for the
 * noise the recording had). Returns the macros' names.
 */
function finish(p: Patch, filterEnvelope: boolean, timbre: Timbre, moving: string | null, noise = false): string[] {
  // Playing: velocity on the Amp envelope and the filter, aftertouch on the filter.
  p.set('ampvelenv', 512 + PLAYING.ampVelocity * 8)
  if (filterEnvelope) p.set('filter1velenv', 512 + PLAYING.filterVelocity * 8)
  else {
    // Velocity only adds: the cutoff as fitted at velocity 100, darker under, brighter over.
    route(p, 3, 19 /* Note-On Vel */, 'filter1cutoff', PLAYING.velocityCutoff)
    p.set('filter1cutoff', clamp(p.get('filter1cutoff') - Math.round((PLAYING.velocityCutoff * CALIBRATION.routeRawPerDepth * 100) / 127)))
  }
  route(p, 4, 16 /* Chan Aftertouch */, 'filter1cutoff', PLAYING.aftertouchCutoff)
  route(p, 5, 17 /* Poly Aftertouch */, 'filter1cutoff', PLAYING.aftertouchCutoff)

  // Macros: each knob starts where the patch as generated is.
  const macros: string[] = []
  const knob = (key: string, name: string, span: number, from: 'middle' | 'bottom' = 'middle') =>
    macros.push(setMacro(p, macros.length + 1, name, key, span, from))
  knob('filter1cutoff', 'Bright', 384)
  knob(...timbre)
  knob('env2attacksyncoff', 'Attack', 384)
  knob('env2releasesyncoff', 'Release', 384)
  knob('filter1drive', 'Dirt', 512, 'bottom')
  // Movement: none at the knob's bottom, as generated in its middle, twice as much at the top.
  if (moving) knob(moving, 'Movement', 2 * Math.min(512, p.get(moving) - 512))
  // Noise: none at the bottom, as generated in the middle (twice as loud at the top), so more or less is one knob.
  if (noise) {
    const v = p.get('mixernoisevol')
    knob('mixernoisevol', 'Noise', v <= 512 ? 2 * v : v)
  }
  return macros
}

/** Whether a recording is noise rather than a note: little of it in harmonics, no clear repeat. */
export const isNoise = (a: SoundAnalysis) => a.spectrum.share < NOISE.share && a.clarity < NOISE.clarity

/** The note a noise patch's cutoff is placed for (keytrack 100 %: other keys move it along). */
const NOISE_NOTE = { midi: 60, hz: 261.63 }
const NOISE = { share: 0.35, clarity: 0.5, lostDb: 15 }

/**
 * The noise colour and LP Ladder 12 cutoff (Hz) whose octave bands come closest to `bands` (power
 * density, dB): over the bands within 40 dB of the loudest, any overall level taken out, and not
 * filtering away so much of the noise that it plays near silent.
 */
export function fitNoise(bands: number[]): { type: number; cutoffHz: number; fit: number } {
  const used = BAND_HZ.map((hz, i) => ({ hz, db: bands[i] })).filter((b) => b.db > -40)
  let best = { type: 0, cutoffHz: Infinity, fit: Infinity }
  for (const colour of CALIBRATION.noise)
    for (const cutoffHz of [Infinity, ...Array.from({ length: 33 }, (_, i) => 20000 * 2 ** (-i / 4))]) {
      const d = used.map((b) => b.db - (colour.slope * Math.log2(b.hz / 1000) + lpDb(b.hz / cutoffHz)))
      const mean = d.reduce((sum, v) => sum + v, 0) / d.length
      // A peak made of a rising colour under a low cutoff is the right shape, but the filter throws
      // away most of the noise and the patch plays near silent: past 15 dB lost, it fits the worse.
      const power = (filtered: boolean) =>
        BAND_HZ.reduce((sum, hz) => sum + hz * 10 ** ((colour.slope * Math.log2(hz / 1000) + (filtered ? lpDb(hz / cutoffHz) : 0)) / 10), 0)
      const lost = 10 * Math.log10(power(false) / power(true))
      const fit = Math.sqrt(d.reduce((sum, v) => sum + (v - mean) ** 2, 0) / d.length) + Math.max(0, lost - NOISE.lostDb) / 2
      if (fit < best.fit - CLOSER) best = { type: colour.type, cutoffHz, fit }
    }
  return best
}

/**
 * A patch for a recording that's noise: the noise source in the nearest colour through LP Ladder 12
 * at the fitted cutoff (as at middle C, keytrack 100 %), ENV 1 following how its brightness moves,
 * the Amp envelope as recorded or a preset. No oscillator, no vibrato, no dirt: it's all dirt.
 */
function buildNoisePatch(a: SoundAnalysis, { envelope = 'detect', overTime = true, name = '' }: WavPatchOptions): WavPatch {
  const p = new Patch(initPatchBytes())
  p.name = name.slice(0, 16)
  const { type, cutoffHz, fit } = fitNoise(a.bands)
  p.set('mixerosc1vol', 0)
  p.set('noisetype', type)
  p.set('mixernoisevol', 1024)
  p.set('voicevibratoamount', 0)
  p.set('filter1type', 0) // LP Ladder 12
  p.set('filter1resonance', 0)
  p.set('filter1keytrack', 768) // 100 %
  const ratio = cutoffHz / NOISE_NOTE.hz
  p.set('filter1cutoff', cutoffRaw(ratio, NOISE_NOTE.hz, NOISE_NOTE.midi))

  // ENV 1 from the darkest the sound gets up to the brightest (its centroid moving as the cutoff).
  let filterEnvelope = false
  const loud = a.brightness.filter((f) => f.db > -24)
  const moves = overTime && Number.isFinite(cutoffHz) ? envelopeOfTrack(loud.map((f) => f.t), loud.map((f) => Math.log2(f.hz)), a.onsetS, 0.5) : null
  if (moves) {
    filterEnvelope = true
    // The fitted cutoff is the peak's; the envelope's lower end sits as far under it as the centroid does.
    const atPeak = Math.log2(loud.reduce((x, f) => (Math.abs(f.t - a.peakS) < Math.abs(x.t - a.peakS) ? f : x)).hz)
    p.set('filter1cutoff', clamp(Math.round(p.get('filter1cutoff') + (moves.base - atPeak) * CALIBRATION.cutoff.octaveRaw)))
    p.set('filter1env1amount', clamp(Math.round(512 + (moves.span * CALIBRATION.cutoff.octaveRaw) / CALIBRATION.envAmountCutoffRaw), 512))
    setEnvelope(p, 1, { attackS: moves.attackS, decayS: moves.decayS, sustain: moves.sustain, releaseS: 0.1 }, false)
  }
  setEnvelope(p, 2, ENVELOPES.find((e) => e.value === envelope)?.adsr ?? a.adsr, true)
  const macros = finish(p, filterEnvelope, RESONANCE, filterEnvelope ? 'filter1env1amount' : null)

  return {
    patch: p,
    note: `any key (the filter as at ${noteName(NOISE_NOTE.midi)})`,
    waves: [],
    sub: false,
    dirt: { noise: null, drift: null, detune: null, ensemble: false },
    resonance: 0,
    glide: null,
    fm: null,
    noise: { colour: formatValue(param('noisetype'), type), cutoffHz },
    filterEnvelope,
    vibrato: null,
    tremolo: null,
    fit,
    macros,
    warnings: a.warnings.filter((w) => w !== 'no clear single note' && w !== 'inharmonic or noisy'),
  }
}

/**
 * How a generated patch plays, beyond the recording (amounts of 64, route depths of 128), chosen
 * by taste: velocity to the Amp envelope (linear: +32 took velocity 30 4.4 dB under 127, so +48
 * ~7 dB) and the filter (route depth 16: ~1.4 octaves over the whole range; depth 8 moved it 0.58
 * from 127 to 30), aftertouch to the cutoff (~1 octave at full pressure). Measured with
 * tools/calibrateWavPatch.ts velocity.
 */
const PLAYING = { ampVelocity: 48, filterVelocity: 24, velocityCutoff: 16, aftertouchCutoff: 12 }

/**
 * Macro `n`, named `name`, on `key`: the knob moves it over `span` raw (a macro at depth d moves its
 * target d * 8 raw over the knob, a Matrix Depth too), set where it is now: in its middle, else
 * (`from` 'bottom', or no room either side) at the bottom or top. Only there does the knob land on
 * the value exactly: a WaveScan route an eighth of a step short of its last wave keeps 2 % of the
 * one before it, and that's heard. Returns the name.
 */
function setMacro(p: Patch, n: number, name: string, key: string, span: number, from: 'middle' | 'bottom'): string {
  const v = p.get(key)
  span = 2 * Math.round(span / 2) // the macro's depth (raw 512 + span / 2) stays whole
  let knob = 0
  if (from === 'middle' && v - span / 2 >= 0 && v + span / 2 <= 1024) knob = 512
  else if (v + span > 1024) {
    // From the top: the knob's range ends at the value, so it may reach no further down than 0.
    knob = 1024
    span = Math.min(span, 2 * Math.floor(v / 2))
  }
  p.set(key, v - (span * knob) / 1024)
  p.setMacroName(n, name)
  p.set(`macro${n}target1`, destinationOf(key)!)
  p.set(`macro${n}depth1`, 512 + span / 2)
  p.set(`macro${n}panelvalue`, knob)
  return name
}

/** The destination All Osc Pitch: no one param, so not in DESTINATION_KEYS. */
const ALL_OSC_PITCH = 19

/** Mod matrix route `n`: `source` to the destination of `key` ('allosc': All Osc Pitch), at `depth` of -128..128. */
function route(p: Patch, n: number, source: number, key: string, depth: number) {
  p.set(`modmatrix${n}modsource`, source)
  p.set(`modmatrix${n}modtarget`, key === 'allosc' ? ALL_OSC_PITCH : destinationOf(key)!)
  p.set(`modmatrix${n}depth`, Math.round(512 + 4 * clamp(depth, -128, 128)))
}

/**
 * What the patch is made of, to take it from there: "Play C3: Orland 6 → Scorpio 8 by WaveScan,
 * filter envelope, vibrato on the Mod Wheel", or with FM "Play C4: Mutant FM 3:1, its depth
 * moving, ..."; a recording that isn't one clear note says so: "(noisy: a rough start)".
 */
export function wavStatus(w: Pick<WavPatch, 'note' | 'waves' | 'sub' | 'dirt' | 'resonance' | 'glide' | 'noise' | 'fm' | 'filterEnvelope' | 'vibrato' | 'tremolo' | 'warnings'>): string {
  const name = (wave: number) => WAVE_FEATURES[wave]?.name ?? `Wave ${wave}`
  // The waves in the order they play, each once in a row; past three, the first and the last.
  const order = w.waves.filter((v, i) => v !== w.waves[i - 1]).map(name)
  const scan = order.length > 3 ? [order[0], '…', order[order.length - 1]] : order
  if (w.noise) {
    const hz = w.noise.cutoffHz
    const filter = Number.isFinite(hz) ? ` through a low-pass at ${hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`}` : ''
    return `Play ${w.note}: ${w.noise.colour.toLowerCase()} noise${filter}${w.filterEnvelope ? ', filter envelope' : ''}${w.warnings.length ? ` (${w.warnings.join(', ')}: a rough start)` : ''}`
  }
  const parts = w.fm
    ? [`Mutant FM ${w.fm.ratio}:1${w.fm.envelope ? ', its depth moving' : ''}`]
    : [`${scan.join(' → ')}${w.waves.length > 1 ? ' by WaveScan' : ''}${w.sub ? ' over a Sine' : ''}`]
  if (w.glide) parts.push(`pitch ${w.glide > 0 ? 'dropping' : 'rising'} ${Math.abs(w.glide)} semitones into it`)
  if (w.resonance) parts.push(w.filterEnvelope ? 'resonant filter envelope' : 'resonant filter')
  else if (w.filterEnvelope) parts.push('filter envelope')
  if (w.dirt.detune) parts.push(`OSC 3 ${w.dirt.detune} cents apart`)
  if (w.dirt.ensemble) parts.push('ensemble')
  if (w.dirt.drift) parts.push('drifting')
  if (w.dirt.noise) parts.push(`${w.dirt.noise.toLowerCase()} noise`)
  parts.push(w.vibrato ? `vibrato ${w.vibrato.rateHz.toFixed(1)} Hz` : 'vibrato on the Mod Wheel')
  if (w.tremolo) parts.push(`tremolo ${w.tremolo.rateHz.toFixed(1)} Hz`)
  const warn = w.warnings.length ? ` (${w.warnings.join(', ')}: a rough start)` : ''
  return `Play ${w.note}: ${parts.join(', ')}${warn}`
}
