// A whole patch that speaks a few English words, formant-synthesiser style: a Saw (the voice)
// through Filter 1's Vowel filter, white noise (breath and hiss) through Filter 2 as a band-pass,
// both run by five one-shot Step LFOs started by the note, one step every few tens of ms:
//   LFO 1 -> Filt 1 Cutoff   which vowel (the Vowel filter's Cutoff sweeps A E I O U)
//   LFO 2 -> Osc 1 Vol       voicing: on for vowels and voiced consonants, off for s, t, gaps
//   LFO 3 -> Noise Vol       hiss, bursts of stops, h
//   LFO 4 -> Filt 2 Cutoff   where the hiss sits: s high, sh lower, p/t/k bursts by place
//   LFO 5 -> Osc 1 Pitch     intonation: stressed syllables up, the phrase falling
// ENV 2 (the Amp's) just gates the note; the last step is silent and a one-shot LFO holds it.
// With `waves`, OSC 1 plays a WaveScan list of waves whose harmonics already show each sound's
// formants at the note it's tuned for (src/ui/waveSpeech.ts) instead of the Saw; LFO 5 then steps
// WaveScan, and ENV 3 lets the phrase fall in pitch (stressed syllables no longer rise).
//
// Measured on a Hydrasynth Desktop (fw 2.x) with tools/calibrateSpeech.ts; see CALIBRATION.
import { formatValue } from '../params/display'
import { initPatchBytes } from '../params/initPatch'
import { Patch, param } from '../params/patch'
import { VOWEL_MORPHS } from './vowelMorphs.generated'
import { pronounce, waveFor, type Pronunciations } from './waveSpeech'

/** What the synth showed when measured (tools/calibrateSpeech.ts), so the numbers can be checked again. */
export const CALIBRATION = {
  /** Vowel filter, Formant Control 64, keytrack 0 %: Cutoff (raw) of each vowel, evenly spaced (vowel). */
  vowelAt: { A: 0, E: 256, I: 512, O: 768, U: 1024 },
  /** A route moves its target by step/64 * depth/128 of the target's full raw range (step, level). */
  routeScale: 'linear',
  /** One-shot Step LFOs run each step 1/rate s (the rate table's Hz is per step), then hold the last step (step). */
  stepHolds: true,
  /** Filter 2 BP (Morph 64), resonance 64: band centre ~516 Hz at raw 512, an octave per ~115 raw (noise). */
  bandAt512Hz: 516,
  bandOctaveRaw: 115,
  /** Osc 1 Pitch route at depth 128: step units per semitone; a full envelope is 64 units, too (pitch, envpitch). */
  perSemitone: 5,
  /** An envelope's Decay from full to 0 takes about twice the time it shows (envpitch). */
  decayFactor: 2,
  /**
   * LFO Smooth glides each step change over smooth/127 of a step (smooth: 18 -> 30 ms at 4 steps a
   * second, 115 ms at one): at most one step, so longer glides are ramps written into the steps.
   */
  smoothShareOfStep: true,
  /** Steps 9-64 only play when the patch carries this marker at byte 1766 (factory patches do, Init doesn't). */
  extendedMarker: { offset: 1766, text: 'ETCD' },
}

const STEPS = 64
const PER_SEMITONE = CALIBRATION.perSemitone

/**
 * Filter 1 Cutoff (raw) for each vowel and glide: the five anchors, and points between them. The
 * front vowels, uh, r and l where the synth's sweep best matched textbook formants at C2, C3 and
 * C4 alike (tools/calibrateSpeech.ts positions); ee, the o of hot, oo and er moved where their
 * steady middle came closest to reference speech (tools/tuneSpeech.ts vowels) and sounded better;
 * the rest by ear. The a of cat isn't right anywhere on this sweep.
 */
const { A, E, I, O, U } = CALIBRATION.vowelAt
const between = (a: number, b: number, t: number) => Math.round(a + (b - a) * t)
export const VOWEL_POS: Record<string, number> = {
  aa: between(A, E, 0.25), ah: between(A, E, 0.19), ae: between(A, E, 0.5), eh: between(A, E, 0.625), ih: E, iy: between(I, O, 0.125),
  er: between(I, O, 0.67), ao: between(I, O, 0.9), ow: between(O, U, 0.09), uh: between(I, O, 0.875), uw: between(O, U, 0.75),
  w: U, y: between(I, E, 0.375), r: between(I, O, 0.875), l: between(I, O, 0.875),
}
const DIPHTHONGS: Record<string, [string, string]> = { ey: ['eh', 'iy'], ay: ['aa', 'iy'], aw: ['aa', 'uw'], ow: ['ow', 'uw'], oy: ['ao', 'iy'] }
const bandRaw = (hz: number) => Math.round(512 + CALIBRATION.bandOctaveRaw * Math.log2(hz / CALIBRATION.bandAt512Hz))
/** Hisses: noise level (0..128) and band centre. Voiced ones keep some voice; v and dh are mostly that. */
const HISS: Record<string, { noise: number; hz: number; voice: number }> = {
  s: { noise: 110, hz: 6000, voice: 0 },
  z: { noise: 80, hz: 6000, voice: 70 },
  sh: { noise: 110, hz: 2800, voice: 0 },
  zh: { noise: 80, hz: 2800, voice: 70 },
  f: { noise: 60, hz: 7000, voice: 0 },
  v: { noise: 25, hz: 7000, voice: 70 },
  th: { noise: 55, hz: 6500, voice: 0 },
  dh: { noise: 20, hz: 6500, voice: 70 },
}
/** Stops: a closure (voiced ones murmur through it), then a burst of noise at their place. */
const STOP: Record<string, { voiced: boolean; hz: number; then?: string }> = {
  p: { voiced: false, hz: 1000 },
  b: { voiced: true, hz: 1000 },
  t: { voiced: false, hz: 4500 },
  d: { voiced: true, hz: 4500 },
  k: { voiced: false, hz: 2200 },
  g: { voiced: true, hz: 2200 },
  ch: { voiced: false, hz: 4000, then: 'sh' },
  jh: { voiced: true, hz: 4000, then: 'zh' },
}

/** One stretch of the phrase: how long, and what each of the five curves does during it. */
interface Segment {
  sound: string
  ms: number
  /** Filter 1 Cutoff (raw); null: take the next vowel's (consonants lean into it). */
  pos: number | null
  voice: number
  noise: number
  band: number
  pitch: number
  /** The voiced sound whose wave OSC 1 plays (null: the next one's, like `pos`). */
  shape: string | null
  /** Formant Control above its 64 (raw), for vowels the sweep can't make at 64 (the a of cat). */
  control: number
}

/**
 * How long eSpeak NG says each sound (ms; tools/espeak.ts durations, over 3,500 words of the
 * CMU dictionary), vowels as [unstressed, stressed]. The synth needs longer than eSpeak to be
 * understood, so all of it is stretched by the tuning's tempo (set by ear: "voice" ~0.6 s at 1.4).
 */
const LENGTHS: Record<string, number | [number, number]> = {
  aa: [81, 152], ae: [76, 152], ah: [54, 134], ao: [73, 133], aw: [104, 188], ay: [89, 169], eh: [83, 148], er: [93, 171],
  ey: [91, 160], ih: [66, 119], iy: [77, 134], ow: [96, 174], oy: [105, 205], uh: [48, 100], uw: [58, 129],
  b: 41, ch: 70, d: 48, dh: 60, f: 79, g: 48, h: 60, jh: 63, k: 51, l: 56, m: 88, n: 83, ng: 98, p: 43, r: 71, s: 80,
  sh: 94, t: 46, th: 83, v: 69, w: 105, y: 84, z: 87, zh: 64,
}
/**
 * What tools/tuneSpeech.ts adjusts, against recordings of the synth scored by tools/speechScore.ts:
 * how long sounds last, how fast the curves glide between steps (a curve that holds still between
 * jumps sounds choppy), and the slight unsteadiness of a real voice.
 */
export interface Tuning {
  /** All sound lengths times this. */
  tempo: number
  /** Glide (ms) of the vowel (Filter 1 Cutoff) and wave (WaveScan) curves between steps. */
  vowelGlideMs: number
  /** Glide (ms) of the voicing (Osc 1 Vol) curve. */
  voiceGlideMs: number
  /** Glide (ms) of the hiss curves (Noise Vol, Filter 2 Cutoff). */
  noiseGlideMs: number
  /** Glide (ms) of the pitch curve. */
  pitchGlideMs: number
  /** Voice vibrato amount (raw 0..120) and rate (raw 0..127). */
  vibrato: number
  vibratoRate: number
  /** Voice Analog Feel (raw 0..127): slow random drift of pitch. */
  drift: number
  /** Lengths, times eSpeak's (and tempo): stressed and unstressed vowels, stops, hisses (and h), m n ng l r w y. */
  stressedLength: number
  unstressedLength: number
  stopLength: number
  hissLength: number
  sonorantLength: number
  /** Silence between words (ms), and how much longer (ms) a vowel rings on before a voiceless hiss. */
  gapMs: number
  hissDelayMs: number
  /** Noise level (0..128) of a voiceless stop's burst (p t k) and of a voiced one's (b d g). */
  burst: number
  voicedBurst: number
  /** Voice level (0..128) through a voiced stop's closure. */
  closureVoice: number
  /** All hisses' noise levels times this; and h's noise level (0..128). */
  hissLevel: number
  breath: number
  /** Filter 1 Cutoff (raw) of r: close to the vowels around it, it melts into them. */
  rPosition: number
  /**
   * Formant Control raised (raw, over 512) for the a of cat: on its place between A and E it is
   * too low (F1 589, F2 1635 Hz); +64 raises both to ~654 / 1830 (tools/calibrateSpeech.ts control).
   */
  aeControl: number
  /** Filter 1 Cutoff (raw) per vowel, where it differs from VOWEL_POS. */
  vowelPositions: Partial<Record<string, number>>
}
/**
 * Chosen by ear from tools/tuneSpeech.ts runs: longer vowel glides scored smoother still (160 ms:
 * 10 % of frames still against 40 % before), but blur the vowels; 70 ms sounded better. Longer
 * m n l r w y, stops, word gaps and hiss delays scored closer to the references and sounded
 * better; shorter vowels scored better only by holding still less. r by ear between I and O.
 */
export const TUNING: Tuning = {
  tempo: 1.4,
  vowelGlideMs: 70,
  voiceGlideMs: 40,
  noiseGlideMs: 0,
  pitchGlideMs: 120,
  vibrato: 0,
  vibratoRate: 100,
  drift: 60,
  stressedLength: 1,
  unstressedLength: 1,
  stopLength: 1.2,
  hissLength: 1,
  sonorantLength: 1.4,
  gapMs: 80,
  hissDelayMs: 60,
  burst: 85,
  voicedBurst: 45,
  closureVoice: 45,
  hissLevel: 1,
  breath: 55,
  rPosition: between(I, O, 0.5),
  aeControl: 64,
  vowelPositions: {},
}

function segmentsOf(text: string, dictionary: Pronunciations | null | undefined, tune: Tuning): Segment[] {
  const lengthOf = (sound: string, stressed = false) => {
    const l = LENGTHS[sound] ?? 60
    const factor =
      typeof l !== 'number'
        ? stressed
          ? tune.stressedLength
          : tune.unstressedLength
        : sound in STOP
          ? tune.stopLength
          : sound in HISS || sound === 'h'
            ? tune.hissLength
            : tune.sonorantLength
    return tune.tempo * factor * (typeof l === 'number' ? l : l[stressed ? 1 : 0])
  }
  const posOf = (v: string) => tune.vowelPositions[v] ?? VOWEL_POS[v]
  const hiss = (s: string) => ({
    noise: HISS[s].noise * tune.hissLevel,
    band: bandRaw(HISS[s].hz),
    voice: HISS[s].voice,
    // v and dh buzz through nearly closed lips or teeth: dark, like a stop's closure.
    ...(s === 'v' || s === 'dh' ? { pos: VOWEL_POS.uw } : {}),
  })
  const out: Segment[] = []
  const seg = (sound: string, ms: number, s: Partial<Segment> = {}) =>
    out.push({ sound, ms, pos: null, voice: 0, noise: 0, band: 512, pitch: 0, shape: null, control: 0, ...s })
  for (const { sound: s, stressed } of pronounce(text, dictionary)) {
    if (s === '') {
      seg('', tune.gapMs)
    } else if (s in DIPHTHONGS || s in VOWEL_POS) {
      const glide = ['w', 'y', 'r', 'l'].includes(s)
      if (glide) {
        seg(s, lengthOf(s), { pos: s === 'r' ? tune.rPosition : posOf(s), voice: 100, shape: s })
        continue
      }
      const pitch = stressed ? 1.5 : 0
      const ms = lengthOf(s, stressed)
      // A diphthong has time on both ends, a little more where it glides to: either is easily lost.
      const control = (v: string) => (v === 'ae' ? tune.aeControl : 0)
      if (s in DIPHTHONGS) DIPHTHONGS[s].forEach((v, i) => seg(v, ms * (i ? 0.55 : 0.45), { pos: posOf(v), voice: 128, pitch, shape: v, control: control(v) }))
      else seg(s, ms, { pos: posOf(s), voice: 128, pitch, shape: s, control: control(s) })
    } else if (s === 'm' || s === 'n' || s === 'ng') {
      seg(s, lengthOf(s), { pos: VOWEL_POS.uw, voice: 70, shape: s })
    } else if (s === 'h') {
      seg(s, lengthOf(s), { noise: tune.breath, band: bandRaw(1500) })
    } else if (s in HISS) {
      seg(s, lengthOf(s), hiss(s))
    } else if (s in STOP) {
      const st = STOP[s]
      const ms = lengthOf(s)
      // Voiced stops murmur on through the closure, dark with the mouth shut, and release softly into
      // the vowel; voiceless ones go quiet, then pop. Affricates end in their hiss.
      const [closure, burst] = st.then ? [0.4, 0.15] : [0.7, 0.3]
      seg(s, ms * closure, st.voiced ? { voice: tune.closureVoice, pos: VOWEL_POS.uw } : {})
      seg(s, Math.max(15, ms * burst), { noise: st.voiced ? tune.voicedBurst : tune.burst, band: bandRaw(st.hz), voice: st.voiced ? 80 : 0 })
      if (st.then) seg(st.then, ms * 0.45, hiss(st.then))
    }
  }
  // Nothing sounds before the first or after the last voiced or hissed segment.
  while (out.length && out[0].sound === '') out.shift()
  while (out.length && out.at(-1)!.sound === '') out.pop()
  // A voiceless hiss after a vowel starts a little late: the vowel rings on into it.
  for (let i = 1; i < out.length; i++) if (out[i].noise && !out[i].voice && out[i].sound in HISS && out[i - 1].voice === 128) out[i - 1].ms += tune.hissDelayMs
  // A phrase's last vowel lasts longer, stressed or not ("very": its ee was gone in the glides).
  const lastVowel = out.map((s) => s.voice).lastIndexOf(128)
  if (lastVowel >= 0) out[lastVowel].ms = Math.max(out[lastVowel].ms, lengthOf(out[lastVowel].sound, true)) * 1.3
  // Consonants take the formants of the vowel after them (or before, at the end).
  let next = VOWEL_POS.ah
  for (let i = out.length - 1; i >= 0; i--) if (out[i].pos === null) out[i].pos = next; else next = out[i].pos!
  let shape = [...out].reverse().find((s) => s.shape)?.shape ?? null
  for (let i = out.length - 1; i >= 0; i--) if (out[i].shape === null) out[i].shape = shape; else shape = out[i].shape
  return out
}

/** The LFO rates (raw -> Hz) the synth offers, read from its own display table. */
const RATES: [number, number][] = (() => {
  const def = param('lfo1ratesyncoff')
  const out: [number, number][] = []
  for (let v = def.min; v <= def.max; v++) {
    const hz = parseFloat(formatValue(def, v).replace(',', '.'))
    if (hz > 0) out.push([v, hz])
  }
  return out
})()

/** Steps per segment and the rate that fits the phrase into 64 steps, as fine as it can. */
function timing(segments: Segment[], speed: number) {
  // Fastest first: the first rate where every segment gets a step and all fit.
  for (let r = RATES.length - 1; r >= 0; r--) {
    const [raw, hz] = RATES[r]
    const stepMs = 1000 / hz
    const counts = segments.map((s) => Math.max(1, Math.round((s.ms * speed) / stepMs)))
    if (counts.reduce((a, b) => a + b, 0) <= STEPS - 1) return { raw, hz, stepMs, counts }
  }
  return null
}

export interface SpeechPatch {
  patch: Patch
  /** The sounds in order, as said. */
  sounds: string[]
  /** How long the phrase takes (ms). */
  ms: number
  /** Sounds left out: more than the 63 steps hold. */
  dropped: number
  /** The Vowel filter's order for this phrase (see chooseOrder). */
  order: string
}

export interface SpeechPatchOptions {
  /** 1 normal, above 1 slower. */
  speed?: number
  /** Shape the voice with waves instead of the Saw: each wave's harmonicLevels, and the note (Hz) to tune them for. */
  waves?: { levels: (number[] | null)[]; f0: number }
  /** How words are said (loadPronunciations); without it, or for words it lacks, the spelling rules. */
  dictionary?: Pronunciations | null
  /** Overrides of TUNING. */
  tuning?: Partial<Tuning>
}

/** Envelope times (raw -> ms) the synth offers, read from its own display table. */
const DECAYS: [number, number][] = (() => {
  const def = param('env3decaysyncoff')
  const out: [number, number][] = []
  for (let v = def.min; v <= def.max; v++) {
    const label = formatValue(def, v)
    const n = parseFloat(label.replace(',', '.'))
    out.push([v, label.endsWith('ms') ? n : n * 1000])
  }
  return out
})()

/**
 * The WaveScan list for the voiced sounds, in order of first use, and each sound's slot: a wave
 * per sound, shared when two sounds pick the same one; past eight waves, a sound takes the slot
 * of the sound with the nearest vowel position.
 */
function waveList(segments: Segment[], levels: (number[] | null)[], f0: number) {
  const waves: number[] = []
  const slotOf = new Map<string, number>()
  for (const s of segments) {
    if (!s.shape || slotOf.has(s.shape)) continue
    const w = waveFor(s.shape, levels, f0)
    if (waves.includes(w)) slotOf.set(s.shape, waves.indexOf(w))
    else if (waves.length < 8) slotOf.set(s.shape, waves.push(w) - 1)
    else {
      const pos = VOWEL_POS[s.shape] ?? VOWEL_POS.uw
      const near = [...slotOf].sort((a, b) => Math.abs((VOWEL_POS[a[0]] ?? U) - pos) - Math.abs((VOWEL_POS[b[0]] ?? U) - pos))[0]
      slotOf.set(s.shape, near[1])
    }
  }
  return { waves, slotOf }
}

/** The Init patch turned into a patch that says `text` on each note; null if there's nothing to say. */
export function buildSpeechPatch(text: string, { speed = 1, waves, dictionary, tuning }: SpeechPatchOptions = {}): SpeechPatch | null {
  const tune = { ...TUNING, ...tuning }
  const all = segmentsOf(text, dictionary, tune)
  // More segments than steps: say less (the end goes).
  const segments = all.slice(0, STEPS - 1)
  const dropped = all.length - segments.length
  if (!segments.length) return null
  const t = timing(segments, speed)!

  const p = new Patch(initPatchBytes())
  const { offset, text: marker } = CALIBRATION.extendedMarker
  for (let i = 0; i < marker.length; i++) p.bytes[offset + i] = marker.charCodeAt(i)
  p.name = text.trim().slice(0, 16)

  // The voice: OSC 1's Saw into the Vowel filter; noise into Filter 2 alone.
  p.set('osc1mode', 0)
  p.set('osc1type', 3)
  p.set('mixerosc1vol', 0)
  p.set('mixernoisevol', 0)
  p.set('noisetype', 0)
  p.set('mixerfilterrouting', 1)
  p.set('mixerosc1filterratio', 0)
  p.set('mixernoisefilterratio', 1024)
  p.set('filter1type', 10)
  p.set('filter1special', 512)
  p.set('filter1resonance', 576)
  p.set('filter1keytrack', 512)
  p.set('filter1cutoff', 512)
  p.set('filter2type', 0)
  p.set('filter2morph', 512)
  p.set('filter2resonance', 384)
  p.set('filter2keytrack', 512)
  p.set('filter2cutoff', 512)
  // The Amp's envelope opens at once and holds while the key is down; the phrase itself ends silent.
  p.set('env2bpmsync', 0)
  p.set('env2attacksyncoff', 24)
  p.set('env2decaysyncoff', 0)
  p.set('env2sustain', 1024)
  p.set('env2releasesyncoff', 320)
  p.set('amplevel', 768)
  p.set('voicevibratobpmsync', 0)
  p.set('voicevibratoamount', tune.vibrato)
  p.set('voicevibratoratesyncoff', tune.vibratoRate)
  p.set('voiceanalogfeel', tune.drift)

  // The five curves, one value per segment, then a silent hold.
  const total = t.counts.reduce((a, b) => a + b, 0)
  // The vowel order that lets this phrase glide where it should; positions move into it.
  const order = chooseOrder(
    segments.map((s) => s.pos!),
    segments.map((s) => s.voice >= 100),
  )
  for (const s of segments) s.pos = order.place.get(s.pos!)!
  p.set('filter1vowelorder', ORDERS.indexOf(order.name))
  const list = waves ? waveList(segments, waves.levels, waves.f0) : null
  /**
   * Each curve moves between sounds in a ramp `glideMs` long, written into the steps (a moving
   * average over that many steps), and glides straight from step to step (Smooth 127): a curve
   * that holds each sound and then jumps sounds choppy. A glide of 0 jumps.
   */
  const curves: {
    target: number
    depth: number
    value: (s: Segment, at: number) => number
    glideMs: number
    end: number
    /** Changes from a to b that jump (in one step) instead of gliding. */
    jump?: (a: number, b: number) => boolean
  }[] = [
    // Filt 1 Cutoff. The Vowel filter morphs only along its order's vowels: a glide that passes one
    // off its way says it ("very" as "ve-ee-ry"), so such a change jumps.
    { target: 88, depth: 768, value: (s) => (s.pos! - 512) / 8, glideMs: tune.vowelGlideMs, end: 0, jump: (a, b) => offPath(order.name, 512 + 8 * a, 512 + 8 * b) },
    { target: 73, depth: 1024, value: (s) => s.voice / 2, glideMs: tune.voiceGlideMs, end: 0 }, // Osc 1 Vol
    { target: 77, depth: 1024, value: (s) => s.noise / 2, glideMs: tune.noiseGlideMs, end: 0 }, // Noise Vol
    // Filt 2 Cutoff while noise sounds; while it doesn't, Filter 2 hears nothing and the same curve
    // carries Formant Control (slot 7, depth CONTROL_DEPTH) for the vowels that need it.
    { target: 96, depth: 768, value: (s) => (s.noise ? (s.band - 512) / 8 : (s.control * 8) / CONTROL_DEPTH), glideMs: tune.noiseGlideMs, end: 0 },
    list
      ? // Osc 1 WaveScan: the sound's slot (slot i of 8 sits at i/7 of the range). One step's glide
        // at most: a longer ramp would play the slots between, other sounds' waves.
        { target: 13, depth: 1024, value: (s) => ((list.slotOf.get(s.shape ?? '') ?? 0) * 64) / 7, glideMs: Math.min(tune.vowelGlideMs, t.stepMs), end: ((list.slotOf.get(segments.at(-1)!.shape ?? '') ?? 0) * 64) / 7 }
      : // Osc 1 Pitch: stress, and the phrase falling by 2 semitones.
        { target: 11, depth: 1024, value: (s, at) => (s.pitch + 1 - (3 * at) / total) * PER_SEMITONE, glideMs: tune.pitchGlideMs, end: -2 * PER_SEMITONE },
  ]
  curves.forEach((c, i) => {
    const lfo = `lfo${i + 1}`
    p.set(`${lfo}wave`, 10)
    p.set(`${lfo}steps`, total + 1)
    p.set(`${lfo}bpmsync`, 0)
    p.set(`${lfo}ratesyncoff`, t.raw)
    p.set(`${lfo}oneshot`, 1)
    p.set(`${lfo}trigsync`, 0)
    p.set(`${lfo}level`, 1024)
    p.set(`${lfo}smooth`, c.glideMs > 0 ? 127 : 0)
    // One value per step, then the end; ramps between sounds over `width` steps (the end stays exact).
    const values: number[] = []
    segments.forEach((s, n) => {
      for (let k = 0; k < t.counts[n]; k++) values.push(c.value(s, values.length))
    })
    values.push(c.end)
    const width = Math.max(1, Math.round(c.glideMs / t.stepMs))
    const ramped = values.map((_, k) => {
      if (k === values.length - 1 || width === 1) return values[k]
      const from = Math.max(0, k - Math.floor((width - 1) / 2))
      const to = Math.min(values.length - 1, k + Math.ceil((width - 1) / 2))
      let sum = 0
      for (let j = from; j <= to; j++) sum += values[j]
      return sum / (to - from + 1)
    })
    if (c.jump)
      for (let b = 1; b < values.length - 1; b++)
        if (values[b] !== values[b - 1] && c.jump(values[b - 1], values[b]))
          for (let k = Math.max(0, b - Math.ceil((width - 1) / 2)); k <= Math.min(values.length - 2, b + Math.floor((width - 1) / 2)); k++) ramped[k] = values[k]
    ramped.forEach((v, k) => p.set(`${lfo}step${k + 1}`, stepRaw(v)))
    for (let step = ramped.length + 1; step <= STEPS; step++) p.set(`${lfo}step${step}`, 512)
    p.set(`modmatrix${i + 1}modsource`, 6 + i) // LFO 1..5
    p.set(`modmatrix${i + 1}modtarget`, c.target)
    p.set(`modmatrix${i + 1}depth`, c.depth)
  })
  // LFO 4 also moves Formant Control: by step * CONTROL_DEPTH / 8 (raw), so +-64 steps is +-128.
  p.set('modmatrix7modsource', 9) // LFO 4
  p.set('modmatrix7modtarget', 91) // Filt 1 Control
  p.set('modmatrix7depth', 512 + CONTROL_DEPTH * 4)

  if (list) {
    // OSC 1 scans the waves (slots 2-8 store Off and Silence ahead of them; unused ones Off).
    p.set('osc1mode', 1)
    p.set('osc1wavscan', 0)
    for (let slot = 1; slot <= 8; slot++) {
      const w = list.waves[slot - 1]
      p.set(`osc1wavscanwave${slot}`, w === undefined ? (slot === 1 ? 3 : 0) : slot === 1 ? w : w + 2)
    }
    // The phrase falls 2 semitones on ENV 3 instead: full envelope at depth +20 (of 128) is 2 semitones.
    const fall = 2
    p.set('env3bpmsync', 0)
    p.set('env3attacksyncoff', 0)
    p.set('env3holdsyncoff', 0)
    p.set('env3sustain', 0)
    const decayMs = (total * t.stepMs) / CALIBRATION.decayFactor
    p.set('env3decaysyncoff', DECAYS.reduce((a, b) => (Math.abs(b[1] - decayMs) < Math.abs(a[1] - decayMs) ? b : a))[0])
    p.set('modmatrix6modsource', 3) // Env 3
    p.set('modmatrix6modtarget', 11) // Osc 1 Pitch
    p.set('modmatrix6depth', Math.round(512 + ((fall * PER_SEMITONE * 128) / 64) * 4))
  }

  // A stop's closure and burst are one sound.
  const sounds = segments.map((s) => s.sound).filter((s, i, all) => !(s in STOP && all[i - 1] === s))
  return { patch: p, sounds, ms: Math.round(total * t.stepMs), dropped, order: order.name }
}

/** Depth (of 128) of LFO 4's route to Formant Control. */
const CONTROL_DEPTH = 16

/** The Vowel Order choices (filter1vowelorder 0..7): the five vowels at Cutoff 0, 256, .. 1024 in this sequence. */
const ORDERS = ['AEIOU', 'AIUEO', 'AUIOE', 'AOUIE', 'IOUAE', 'UEAOI', 'IOEAU', 'UIEAO']
/** F1 and F2 (Hz) of the five vowels (tools/calibrateSpeech.ts vowel; between them they morph about straight). */
const VOWEL_FORMANTS: Record<string, [number, number]> = { A: [719, 1177], E: [458, 2093], I: [262, 2485], O: [458, 785], U: [262, 589] }

/** Where Cutoff `c` falls in `order`: its two neighbouring vowels and how far from the first (0..1). */
function between2(order: string, c: number): [string, string, number] {
  const k = Math.min(3, Math.floor(c / 256))
  return [order[k], order[k + 1], (c - 256 * k) / 256]
}

/** The filter's measured sound (src/ui/vowelMorphs.generated.ts) at Cutoff `c` in `order`, to the nearest 32. */
function shapeAt(order: string, c: number): number[] {
  const [a, b, t] = between2(order, c)
  const key = a < b ? a + b : b + a
  return VOWEL_MORPHS[key][Math.round((a < b ? t : 1 - t) * 8)]
}

/** log F1, log F2 at Cutoff `c` in `order`, between its neighbouring vowels' formants. */
function formantsAt(order: string, c: number): [number, number] {
  const [a, b, t] = between2(order, c)
  const [fa, fb] = [VOWEL_FORMANTS[a], VOWEL_FORMANTS[b]]
  return [Math.log(fa[0] + (fb[0] - fa[0]) * t), Math.log(fa[1] + (fb[1] - fa[1]) * t)]
}

/**
 * Whether a change of Cutoff from `a` to `b` in `order` passes a vowel off the way between them:
 * one further from the straight line between the two ends (log F1/F2) than 0.3 of its length.
 * eh -> r passes I (1.2: "ve-ee-ry"); A -> U in AOUIE passes O on the way (0.06: "how").
 */
function offPath(order: string, a: number, b: number): boolean {
  const [lo, hi] = [Math.min(a, b), Math.max(a, b)]
  const [p, q] = [formantsAt(order, a), formantsAt(order, b)]
  const d = [q[0] - p[0], q[1] - p[1]]
  const length = Math.hypot(d[0], d[1])
  for (let k = 1; k <= 3; k++) {
    const c = 256 * k
    if (c <= lo + 8 || c >= hi - 8) continue
    const x = formantsAt(order, c)
    const t = Math.max(0, Math.min(1, ((x[0] - p[0]) * d[0] + (x[1] - p[1]) * d[1]) / (length * length || 1)))
    if (Math.hypot(x[0] - p[0] - t * d[0], x[1] - p[1] - t * d[1]) > 0.3 * length) return true
  }
  return false
}

const like = (a: number[], b: number[]) => {
  let ab = 0
  let aa = 0
  let bb = 0
  a.forEach((v, i) => {
    ab += v * b[i]
    aa += v * v
    bb += b[i] * b[i]
  })
  return ab / Math.sqrt(aa * bb)
}

/**
 * The vowel order for a phrase whose Filter 1 Cutoffs (in AEIOU, where VOWEL_POS is tuned) are
 * `positions`: in each order every position moves to the point that sounds most like it (an order
 * where one matches under 0.6 is out). Each order costs a point per glide between `vocal`
 * neighbours (vowels, l r w y) that must jump, plus 1.5 x (1 - match) per vocal sound it moves
 * off its tuned sound; the cheapest wins, AEIOU when it ties, so phrases that glide fine keep
 * their tuned sound exactly. Changes into or out of consonants don't count: their places (v's
 * dark U, say) are tricks, not glides anyone hears.
 */
export function chooseOrder(positions: number[], vocal: boolean[], debug = false): { name: string; place: Map<number, number> } {
  const distinct = [...new Set(positions)]
  let best: { name: string; place: Map<number, number>; cost: number } | null = null
  for (const name of ORDERS) {
    const place = new Map<number, number>()
    const match = new Map<number, number>()
    let ok = true
    for (const c of distinct) {
      if (name === 'AEIOU') {
        place.set(c, c)
        match.set(c, 1)
        continue
      }
      const target = shapeAt('AEIOU', c)
      let at = 0
      let closest = -2
      for (let x = 0; x <= 1024; x += 32) {
        const l = like(shapeAt(name, x), target)
        if (l > closest) [closest, at] = [l, x]
      }
      if (closest < 0.6) ok = false
      place.set(c, at)
      match.set(c, closest)
    }
    if (debug) console.log(name, ok ? '' : '(out)', distinct.map((c) => `${c}->${place.get(c)}`).join(' '))
    if (!ok) continue
    let cost = 0
    for (const c of new Set(positions.filter((_, i) => vocal[i]))) cost += 1.5 * (1 - match.get(c)!)
    for (let i = 1; i < positions.length; i++) {
      if (!vocal[i - 1] || !vocal[i]) continue
      const [a, b] = [place.get(positions[i - 1])!, place.get(positions[i])!]
      if (a !== b && offPath(name, a, b)) cost++
    }
    if (debug) console.log('  cost', cost.toFixed(2))
    if (!best || cost < best.cost - 1e-9) best = { name, place, cost }
  }
  return best!
}

/** A step value (-64..64) as stored. */
const stepRaw = (v: number) => Math.round(512 + Math.max(-64, Math.min(64, v)) * 8)
