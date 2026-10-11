// What a recorded note is made of, for building a patch that plays it (src/ui/wavPatch.ts): its
// pitch, its harmonics at its loudest and how they change, its level's shape (attack, decay,
// sustain, release) and any vibrato or tremolo. Pure: samples in, numbers out.
import { centroidTrack, octaveBands } from './bands'
import { type Dirt, measureDirt } from './dirt'
import { crossingPeriods, detectPeriod, followPitch, noteOf, periodNear, refinePeriod } from './pitch'
import { harmonicCount, harmonicsAt, type Harmonics } from './spectrum'
import type { Audio } from './wav'

export interface Adsr {
  /** Seconds from silence to the peak, as a linear rise. */
  attackS: number
  /** Seconds from the peak to the sustain level (to -40 dB without one). */
  decayS: number
  /** Sustain level, 0..1 of the peak's amplitude. */
  sustain: number
  /** Seconds from the sustain level to -40 dB below it, once the note ends. */
  releaseS: number
}

/** A periodic wobble: vibrato (depth in cents, to either side) or tremolo (depth in dB, to either side). */
export interface Wobble {
  rateHz: number
  depth: number
}

/** The harmonics at one moment of the note. */
export interface Snapshot {
  t: number
  /** Level then, dB relative to the peak. */
  db: number
  harmonics: Harmonics
}

export interface SoundAnalysis {
  sampleRate: number
  f0: number
  /** How clearly it repeats (0..1); under ~0.8 it's no single note. */
  clarity: number
  midi: number
  cents: number
  /** Where it starts, peaks and fades to -50 dB (seconds into the file). */
  onsetS: number
  peakS: number
  endS: number
  /** Still sounding where the file ends: its release wasn't recorded. */
  held: boolean
  /** The harmonics around the peak. */
  spectrum: Harmonics
  /** Power density per octave band (src/audio/bands.ts BAND_HZ) around the peak, loudest 0: a noise's colour. */
  bands: number[]
  /** Its spectral centroid (Hz) and level (dB, loudest 0) over time: how a noise brightens or darkens. */
  brightness: { t: number; hz: number; db: number }[]
  /** The harmonics every FRAME_S from onset to end (at most MAX_FRAMES_S of it). */
  frames: Snapshot[]
  adsr: Adsr
  vibrato: Wobble | null
  tremolo: Wobble | null
  /**
   * A pitch that drops or slides into the note (`semitones` above it at the onset, negative from
   * under it), half the way there after `halfS`, nine tenths after `tenthS` (seconds from the onset).
   */
  glide: { semitones: number; halfS: number; tenthS: number } | null
  /** Drift, detune, chorus and noise: what makes it less clean than a wave played still. */
  dirt: Dirt
  /** Why the result may not be close, for the status line. */
  warnings: string[]
}

const HOP_S = 0.005
/** What a sound with no repeat in it gets as its note: middle C. */
const NO_NOTE_HZ = 261.63
const FRAME_S = 0.04
/** Timbre over time is followed for the first few seconds: WaveScan and the filter's envelope settle by then. */
const MAX_FRAMES_S = 4
const WOBBLE_HOP_S = 0.02
const MAX_FILE_S = 12

const db = (v: number) => 20 * Math.log10(Math.max(v, 1e-9))

/** The note in `audio`; throws an Error to show as it is when there's no note to find. */
export function analyse(audio: Audio): SoundAnalysis {
  const { sampleRate: sr } = audio
  const x = dcBlocked(audio.samples.subarray(0, Math.round(MAX_FILE_S * sr)), sr)
  const warnings: string[] = []

  // Level every 5 ms: RMS over 10 ms to find the note, then over two of its periods (over less,
  // a low note's own cycle ripples it).
  const hop = Math.max(1, Math.round(HOP_S * sr))
  if (x.length < 0.02 * sr) throw new Error('The file is too short')
  const first = levelCurve(x, hop, hop)
  if (first.peak < 1e-4) throw new Error('The file is silent')
  const at = (i: number) => i * hop
  // Clipping in the file as it is (the DC blocker moves the flat tops).
  let clipped = 0
  for (let i = 0; i < x.length; i++) if (Math.abs(audio.samples[i]) >= 0.999) clipped++
  if (clipped > x.length * 0.001) warnings.push('clipped')

  // Pitch: past the attack's transient, over up to half a second of the note.
  let from = Math.min(at(first.ip) + Math.round(0.02 * sr), at(first.iEnd))
  let to = Math.min(at(first.iEnd), from + Math.round(0.5 * sr))
  if (to - from < 0.04 * sr) [from, to] = [at(first.onset), at(first.iEnd)]
  // No repeat at all (a hi-hat, a crash): middle C stands in, and the note's clarity says 0.
  const found = detectPeriod(x, sr, from, to)
  const coarse = found.period ? found : { period: sr / NO_NOTE_HZ, clarity: 0 }
  const steady = found.period ? refinePeriod(x, sr, coarse.period, from, to) : coarse.period
  if (coarse.clarity < 0.8) warnings.push('no clear single note')
  // A pitch that drops or slides into place (a kick, a tom, a zap, a slide): the note is where it
  // settles, and the timbre is read at the pitch it has at each moment.
  // Zero crossings measure the pitch only of a sound that's mostly its fundamental (a kick, a tom):
  // the other harmonics together under half of it, or they cross zero too.
  const body = harmonicsAt(x, sr, sr / steady, from, Math.min(x.length, from + Math.max(4 * steady, 0.04 * sr)), 8).amps
  const sineLike = body.slice(1).reduce((sum, v) => sum + v, 0) < 0.5 * body[0]
  const glide =
    coarse.clarity >= 0.5
      ? glideOf(
          followPitch(x, sr, steady, from, at(first.onset), at(first.iEnd)),
          sineLike ? crossingPeriods(x, sr, at(first.onset), Math.min(at(first.iEnd), at(first.onset) + Math.round(0.3 * sr)), (3 * sr) / steady) : [],
          steady,
          at(first.onset) / sr,
          sr,
        )
      : null
  const period = glide ? sr / glide.settledHz : steady
  const f0 = sr / period
  const f0At = (sample: number) => (glide ? glide.hzAt(sample / sr) : f0)
  const { midi, cents } = noteOf(f0)
  const { rel, peak, ip, onset, iEnd, held } = levelCurve(x, hop, Math.max(hop, Math.round(period)))
  if ((iEnd - onset) * HOP_S < 0.1) warnings.push('very short')

  // Harmonics at the peak: over 0.1 s (eight periods of a low note), so a sound that changes
  // isn't averaged into one it never makes.
  const count = harmonicCount(f0, sr)
  const length = Math.max(8 * period, Math.min(0.1 * sr, 0.4 * (at(iEnd) - at(ip))))
  let start = at(ip)
  if (start + length > x.length) start = Math.max(0, x.length - length)
  const spectrum = harmonicsAt(x, sr, f0At(start + length / 2), start, start + length, harmonicCount(f0At(start + length / 2), sr))
  if (spectrum.share < 0.5) warnings.push('inharmonic or noisy')
  // Nothing in the first three harmonics, yet a repeat: notes a chord apart (A C# E repeat as 4:5:6).
  else if (coarse.clarity >= 0.8 && spectrum.levels.length > 3 && Math.max(...spectrum.levels.slice(0, 3)) < -20) warnings.push('no clear single note')

  // Harmonics over time.
  const frames: Snapshot[] = []
  const window = Math.max(8 * period, 0.04 * sr)
  const last = Math.min(at(iEnd), at(onset) + MAX_FRAMES_S * sr)
  // Every FRAME_S, or half a window where one is longer than 0.25 s (eight periods under 32 Hz).
  const frameHop = window > 0.25 * sr ? window / 2 : FRAME_S * sr
  for (let t = at(onset); t <= last; t += frameHop) {
    const a = Math.max(0, Math.round(t - window / 2))
    const b = Math.min(x.length, a + window)
    if (b - a < 4 * period) continue
    frames.push({ t: t / sr, db: rel[Math.min(rel.length - 1, Math.round(t / hop))], harmonics: harmonicsAt(x, sr, f0At(t), a, b, harmonicCount(f0At(t), sr)) })
  }

  // Vibrato and tremolo, over the body of the note (past the peak, above -24 dB).
  let bodyEnd = ip
  while (bodyEnd < iEnd && rel[bodyEnd + 1] >= -24) bodyEnd++
  // Past where a glide settles: its slide would read as vibrato, drift or chorus.
  const bodyFrom = Math.max(at(ip) + Math.round(0.05 * sr), glide ? Math.round(glide.settledS * sr) : 0)
  const bodyTo = Math.min(at(bodyEnd), bodyFrom + 4 * sr)
  const pitchTrack: number[] = []
  const levelTrack: number[] = []
  const wobbleHop = Math.round(WOBBLE_HOP_S * sr)
  const span = Math.max(Math.round(3 * period), Math.round(0.03 * sr))
  for (let t = bodyFrom; t + span < bodyTo; t += wobbleHop) {
    const p = periodNear(x, period, t, span)
    if (p === null) break
    pitchTrack.push(1200 * Math.log2(period / p))
    // Level over whole periods: over less, a low note's own cycle ripples it.
    const cycles = Math.max(1, Math.round(span / period)) * period
    let s = 0
    for (let i = Math.round(t); i < Math.round(t + cycles); i++) s += x[i] * x[i]
    levelTrack.push(db(Math.sqrt(s / cycles) / peak))
  }

  const vibrato = wobble(pitchTrack, WOBBLE_HOP_S, 8)
  return {
    sampleRate: sr,
    f0,
    clarity: coarse.clarity,
    midi,
    cents,
    onsetS: at(onset) / sr,
    peakS: at(ip) / sr,
    endS: at(iEnd) / sr,
    held,
    glide: glide && { semitones: glide.semitones, halfS: glide.halfS, tenthS: glide.tenthS },
    spectrum,
    bands: octaveBands(x, sr, at(ip)),
    brightness: centroidTrack(x, sr, at(onset), Math.min(at(iEnd), at(onset) + MAX_FRAMES_S * sr)),
    frames,
    // The attack on the finer curve: two periods of a low note would smear a fast one.
    adsr: adsrOf(rel, ip, iEnd, held, attackOf(first)),
    vibrato,
    tremolo: wobble(levelTrack, WOBBLE_HOP_S, 1),
    dirt: measureDirt(x, sr, f0, spectrum.amps, bodyFrom, bodyTo, vibrato?.rateHz ?? null),
    // A glide is why its note repeats less clearly and spreads between the harmonics: not a warning.
    warnings: glide ? warnings.filter((w) => w !== 'no clear single note' && w !== 'inharmonic or noisy') : warnings,
  }
}

/**
 * A glide into the note (where the followed pitch `track` settles; its steady `period`, as read past
 * the peak, for a note too short to settle) in `track`:
 * how far from it the note starts (from the first clear steps, within 60 ms of the onset; where
 * the follower found nothing in the first 20 ms, `crossings` fill in), and when it gets half and nine
 * tenths of the way. Null under a semitone (vibrato, a wobble), with nothing clear at the start,
 * or for two notes (one held, then a jump to the next, or the follower slipping).
 */
function glideOf(track: { t: number; period: number }[], crossings: { t: number; period: number }[], period: number, onsetS: number, sampleRate: number) {
  let clear = track.filter((s) => Number.isFinite(s.period))
  if (!clear.length || clear[0].t > onsetS + 0.02)
    clear = [...crossings.filter((c) => c.t < (clear[0]?.t ?? Infinity) && c.period > period / 4 && c.period < period * 1.5), ...clear]
  if (clear.length < 4) return null
  // Where it settles: the last stretch of 0.15 s or more within a third of a semitone (a slide's end,
  // not the middle of it where its level peaked); for a note too short to hold that long, `period`.
  for (let end = clear.length - 1, i = end; i >= 0; i--) {
    if (Math.abs(12 * Math.log2(clear[i].period / clear[end].period)) > 0.33) end = i
    else if (clear[end].t - clear[i].t >= 0.15) {
      const stretch = clear.slice(i, end + 1).map((s) => s.period).sort((a, b) => a - b)
      period = stretch[Math.floor(stretch.length / 2)]
      break
    }
  }
  const semis = clear.map((s) => ({ t: s.t, st: 12 * Math.log2(period / s.period) }))
  const head = semis.slice(0, 3)
  if (head[0].t > onsetS + 0.06) return null
  // The first reading, if the next is already on its way from it to the note (a kick is half way
  // down within a few periods); else the middle of the first three, steadier.
  const first = head[0].st
  const start = head.length > 1 && Math.sign(head[1].st) === Math.sign(first) && Math.abs(head[1].st) < Math.abs(first) ? first : head.map((s) => s.st).sort((a, b) => a - b)[1]
  // Still on its way at the second reading: one stray first reading isn't a glide.
  if (Math.abs(start) < 1 || Math.abs(start) > 24 || head.length < 2 || Math.sign(head[1].st) !== Math.sign(start) || Math.abs(head[1].st) < 1) return null
  const after = (share: number) => (semis.find((s) => s.t > head[0].t && Math.abs(s.st) <= share * Math.abs(start)) ?? semis[semis.length - 1]).t - onsetS
  const halfS = after(0.5)
  const tenthS = after(0.1)
  // Two notes, not a glide: the first held a while (15 ms within a semitone), then one jump more
  // than half the way. A kick drops most of the way in a period, but never holds first; a slow
  // slide holds, but never jumps.
  const holds = semis.filter((s) => s.t <= head[0].t + 0.015).every((s) => Math.abs(s.st - start) < 1) && semis.some((s) => s.t > head[0].t + 0.015)
  const jumps = semis.some((s, i) => i > 0 && Math.abs(s.st - semis[i - 1].st) > 0.5 * Math.abs(start))
  if (holds && jumps) return null
  const periodAt = (t: number) => {
    if (t >= onsetS + tenthS) return period
    const i = clear.findIndex((s) => s.t >= t)
    if (i <= 0) return clear[Math.max(0, i)].period
    const [a, b] = [clear[i - 1], clear[i]]
    return a.period + ((b.period - a.period) * (t - a.t)) / (b.t - a.t)
  }
  return { semitones: start, halfS, tenthS, settledS: onsetS + tenthS, settledHz: sampleRate / period, hzAt: (t: number) => sampleRate / periodAt(t) }
}

/**
 * `x` without its DC (a first-order high-pass at 10 Hz, -0.5 dB at 30 Hz): FM at ratio 1 puts a
 * sideband at 0 Hz, and a note riding on it never crosses zero for its pitch to be found.
 */
function dcBlocked(x: Float32Array, sampleRate: number): Float32Array {
  const r = 1 - (2 * Math.PI * 10) / sampleRate
  const out = new Float32Array(x.length)
  let prevIn = x[0] ?? 0
  let prevOut = 0
  for (let i = 0; i < x.length; i++) {
    prevOut = x[i] - prevIn + r * prevOut
    prevIn = x[i]
    out[i] = prevOut
  }
  return out
}

/**
 * The level every `hop` samples (RMS over `half` to either side) relative to the loudest, in dB;
 * the peak (where the attack first comes within 1 dB of the loudest: a steady note's loudest
 * moment can be anywhere along it), the onset (-20 dB), the end (the last moment above -50 dB),
 * and whether it's still sounding where the file ends.
 */
function levelCurve(x: Float32Array, hop: number, half: number) {
  const env = new Float32Array(Math.floor(x.length / hop))
  for (let i = 0; i < env.length; i++) {
    const c = i * hop
    let s = 0
    let n = 0
    for (let j = Math.max(0, c - half); j < Math.min(x.length, c + half); j++, n++) s += x[j] * x[j]
    env[i] = Math.sqrt(s / Math.max(1, n))
  }
  const peak = env.reduce((m, v) => Math.max(m, v), 0)
  const rel = Array.from(env, (v) => db(v / (peak || 1)))
  const ip = Math.max(0, rel.findIndex((v) => v >= -1))
  const onset = Math.max(0, rel.findIndex((v) => v >= -20))
  let iEnd = rel.length - 1
  while (iEnd > ip && rel[iEnd] < -50) iEnd--
  const held = Math.max(...rel.slice(Math.max(ip, rel.length - Math.round(0.03 / HOP_S)))) > -30
  return { rel, peak, ip, onset, iEnd, held }
}

/** The value `q` (0..1) of the way up `v` sorted. */
const quantile = (v: number[], q: number) => {
  const s = [...v].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length * q)] : 0
}
/** dB per second, least squares. */
function slope(v: number[], hopS: number): number {
  const n = v.length
  if (n < 2) return 0
  const mx = (n - 1) / 2
  const my = v.reduce((s, y) => s + y, 0) / n
  let sxy = 0
  let sxx = 0
  v.forEach((y, i) => {
    sxy += (i - mx) * (y - my)
    sxx += (i - mx) ** 2
  })
  return sxy / sxx / hopS
}

/** Seconds of a linear rise to the peak, from 10 % to 90 % of it on the level curve `c`. */
function attackOf(c: ReturnType<typeof levelCurve>): number {
  let t90 = c.onset
  while (t90 < c.ip && c.rel[t90] < -0.9) t90++
  return ((t90 - c.onset) * HOP_S) / 0.8
}

/**
 * The level's shape from its dB curve `rel` (peak 0, every HOP_S), after an attack of `attackS`:
 * a plateau after the decay is a sustain; without one the note decays to nothing (sustain 0,
 * decay to -40 dB). A held note's release wasn't recorded: then it's a default.
 */
function adsrOf(rel: number[], ip: number, iEnd: number, held: boolean, attackS: number): Adsr {
  const time = (from: number, cond: (v: number) => boolean, until = iEnd) => {
    let i = from
    while (i < until && !cond(rel[i])) i++
    return { i, s: (i - from) * HOP_S }
  }
  const spanAfter = iEnd - ip
  // Where to look for a plateau: the last quarter of a held note, the middle of one that ended.
  const look = held ? rel.slice(ip + Math.floor(0.75 * spanAfter), iEnd + 1) : rel.slice(ip + Math.floor(0.3 * spanAfter), ip + Math.floor(0.7 * spanAfter) + 1)
  const level = quantile(look, 0.5)
  const spread = quantile(look, 0.9) - quantile(look, 0.1)
  const flat = look.length >= 4 && Math.abs(slope(look, HOP_S)) < 6 && spread < 8 && level > -30
  const defaultRelease = 0.3
  if (flat) {
    const decay = time(ip, (v) => v <= level + 1)
    if (held) return { attackS, decayS: decay.s, sustain: 10 ** (level / 20), releaseS: defaultRelease }
    // The release: from the plateau's last moment to 40 dB under it.
    let r = iEnd
    while (r > decay.i && rel[r] < level - 1) r--
    const release = time(r, (v) => v <= level - 40)
    return { attackS, decayS: decay.s, sustain: 10 ** (level / 20), releaseS: Math.max(release.s, 0.01) }
  }
  // Decaying to nothing: to -40 dB, extrapolated by its last slope if the file ends first.
  const reach = time(ip, (v) => v <= -40)
  let decayS = reach.s
  if (reach.i >= iEnd && rel[iEnd] > -40) {
    const fall = slope(rel.slice(Math.max(ip, iEnd - Math.round(0.3 / HOP_S)), iEnd + 1), HOP_S)
    if (fall < -1) decayS += (rel[iEnd] + 40) / -fall
  }
  return { attackS, decayS, sustain: 0, releaseS: held ? defaultRelease : Math.min(decayS, 0.25) }
}

/**
 * A periodic wobble of 3-9 Hz in `track` (one value per `hopS`), at least `minDepth` to either
 * side: its trend taken out (a 0.4 s moving average), then the strongest repeat.
 */
export function wobble(track: number[], hopS: number, minDepth: number): Wobble | null {
  const n = track.length
  if (n * hopS < 0.6) return null
  const w = Math.round(0.2 / hopS)
  const y = track.map((_, i) => {
    let s = 0
    let c = 0
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++, c++) s += track[j]
    return track[i] - s / c
  })
  const energy = y.reduce((s, v) => s + v * v, 0)
  if (!energy) return null
  const r = (lag: number) => {
    let s = 0
    for (let i = 0; i + lag < n; i++) s += y[i] * y[i + lag]
    return (s / (n - lag)) * (n / energy)
  }
  const lo = Math.max(1, Math.ceil(1 / (9 * hopS)))
  const hi = Math.min(Math.ceil(1 / (3 * hopS)), Math.floor(n / 2))
  // Peaks, not the slope down from lag 0; the first nearly as high as the highest (a repeat
  // every cycle also repeats every two).
  const peaks: number[] = []
  for (let lag = lo; lag <= hi; lag++) if (r(lag) > 0.3 && r(lag) >= r(lag - 1) && r(lag) >= r(lag + 1)) peaks.push(lag)
  if (!peaks.length) return null
  const highest = Math.max(...peaks.map(r))
  const best = peaks.find((lag) => r(lag) >= 0.85 * highest)!
  const [a, b, c] = [r(best - 1), r(best), r(best + 1)]
  const d = a - 2 * b + c
  const lag = best + (d < 0 ? (0.5 * (a - c)) / d : 0)
  const depth = Math.SQRT2 * Math.sqrt(energy / n)
  return depth >= minDepth ? { rateHz: 1 / (lag * hopS), depth } : null
}
