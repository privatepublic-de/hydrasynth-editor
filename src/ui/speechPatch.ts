// A whole patch that speaks a few English words, formant-synthesiser style: a Saw (the voice)
// through Filter 1's Vowel filter, white noise (breath and hiss) through Filter 2 as a band-pass,
// both run by five one-shot Step LFOs started by the note, one step every few tens of ms:
//   LFO 1 -> Filt 1 Cutoff   which vowel (the Vowel filter's Cutoff sweeps A E I O U)
//   LFO 2 -> Osc 1 Vol       voicing: on for vowels and voiced consonants, off for s, t, gaps
//   LFO 3 -> Noise Vol       hiss, bursts of stops, h
//   LFO 4 -> Filt 2 Cutoff   where the hiss sits: s high, sh lower, p/t/k bursts by place
//   LFO 5 -> Osc 1 Pitch     intonation: stressed syllables up, the phrase falling
// ENV 2 (the Amp's) just gates the note; the last step is silent and a one-shot LFO holds it.
//
// Measured on a Hydrasynth Desktop (fw 2.x) with tools/calibrateSpeech.ts; see CALIBRATION.
import { formatValue } from '../params/display'
import { initPatchBytes } from '../params/initPatch'
import { Patch, param } from '../params/patch'
import { spellSounds } from './waveSpeech'

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
  /** Osc 1 Pitch route at depth 128: step units per semitone (pitch). */
  perSemitone: 5,
  /** Steps 9-64 only play when the patch carries this marker at byte 1766 (factory patches do, Init doesn't). */
  extendedMarker: { offset: 1766, text: 'ETCD' },
}

const STEPS = 64
const PER_SEMITONE = CALIBRATION.perSemitone

/** Filter 1 Cutoff (raw) for each vowel and glide: the five anchors, and points between them. */
const { A, E, I, O, U } = CALIBRATION.vowelAt
const between = (a: number, b: number, t: number) => Math.round(a + (b - a) * t)
const VOWEL_POS: Record<string, number> = {
  aa: A, ah: between(A, E, 0.27), ae: between(A, E, 0.6), eh: E, ih: between(E, I, 0.6), iy: I,
  er: between(I, O, 0.42), ao: between(I, O, 0.9), ow: between(O, U, 0.09), uh: between(O, U, 0.44), uw: U,
  w: U, y: I, r: between(I, O, 0.5), l: between(O, U, 0.52),
}
const DIPHTHONGS: Record<string, [string, string]> = { ey: ['eh', 'iy'], ay: ['aa', 'iy'], aw: ['aa', 'uw'], ow: ['ow', 'uw'], oy: ['ao', 'iy'] }
const bandRaw = (hz: number) => Math.round(512 + CALIBRATION.bandOctaveRaw * Math.log2(hz / CALIBRATION.bandAt512Hz))
/** Hisses: noise level (0..128) and band centre. Voiced ones keep some voice. */
const HISS: Record<string, { noise: number; hz: number; voice: number }> = {
  s: { noise: 110, hz: 6000, voice: 0 },
  z: { noise: 80, hz: 6000, voice: 70 },
  sh: { noise: 110, hz: 2800, voice: 0 },
  zh: { noise: 80, hz: 2800, voice: 70 },
  f: { noise: 60, hz: 7000, voice: 0 },
  v: { noise: 45, hz: 7000, voice: 70 },
  th: { noise: 55, hz: 6500, voice: 0 },
  dh: { noise: 40, hz: 6500, voice: 70 },
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
}

const VOWEL_MS = 140
function segmentsOf(text: string): Segment[] {
  const out: Segment[] = []
  const seg = (sound: string, ms: number, s: Partial<Segment> = {}) =>
    out.push({ sound, ms, pos: null, voice: 0, noise: 0, band: 512, pitch: 0, ...s })
  let stressed = true // the first vowel of each word
  for (const s of spellSounds(text)) {
    if (s === '') {
      seg('', 50)
      stressed = true
    } else if (s in DIPHTHONGS || s in VOWEL_POS) {
      const glide = ['w', 'y', 'r', 'l'].includes(s)
      if (glide) {
        seg(s, 65, { pos: VOWEL_POS[s], voice: 100 })
        continue
      }
      const pitch = stressed ? 1.5 : 0
      const ms = stressed ? VOWEL_MS * 1.25 : VOWEL_MS
      if (s in DIPHTHONGS) DIPHTHONGS[s].forEach((v, i) => seg(v, ms * (i ? 0.45 : 0.65), { pos: VOWEL_POS[v], voice: 128, pitch }))
      else seg(s, ms, { pos: VOWEL_POS[s], voice: 128, pitch })
      stressed = false
    } else if (s === 'm' || s === 'n' || s === 'ng') {
      seg(s, 75, { pos: VOWEL_POS.uw, voice: 70 })
    } else if (s === 'h') {
      seg(s, 55, { noise: 55, band: bandRaw(1500) })
    } else if (s in HISS) {
      const h = HISS[s]
      seg(s, h.voice ? 85 : 105, { noise: h.noise, band: bandRaw(h.hz), voice: h.voice })
    } else if (s in STOP) {
      const st = STOP[s]
      seg(s, 55, { voice: st.voiced ? 25 : 0 })
      seg(s, 20, { noise: 90, band: bandRaw(st.hz), voice: st.voiced ? 50 : 0 })
      if (st.then) seg(st.then, 60, { noise: HISS[st.then].noise, band: bandRaw(HISS[st.then].hz), voice: HISS[st.then].voice })
    }
  }
  // Nothing sounds before the first or after the last voiced or hissed segment.
  while (out.length && out[0].sound === '') out.shift()
  while (out.length && out.at(-1)!.sound === '') out.pop()
  // A phrase-final vowel lasts longer.
  const lastVowel = out.map((s) => s.voice).lastIndexOf(128)
  if (lastVowel >= 0) out[lastVowel].ms *= 1.3
  // Consonants take the formants of the vowel after them (or before, at the end).
  let next = VOWEL_POS.ah
  for (let i = out.length - 1; i >= 0; i--) if (out[i].pos === null) out[i].pos = next; else next = out[i].pos!
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
}

export interface SpeechPatchOptions {
  /** 1 normal, above 1 slower. */
  speed?: number
}

/** The Init patch turned into a patch that says `text` on each note; null if there's nothing to say. */
export function buildSpeechPatch(text: string, { speed = 1 }: SpeechPatchOptions = {}): SpeechPatch | null {
  const all = segmentsOf(text)
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
  p.set('filter1vowelorder', 0)
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

  // The five curves, one value per segment, then a silent hold.
  const total = t.counts.reduce((a, b) => a + b, 0)
  const curves: { target: number; depth: number; value: (s: Segment, at: number) => number; smooth: number; end: number }[] = [
    { target: 88, depth: 768, value: (s) => (s.pos! - 512) / 8, smooth: 18, end: 0 }, // Filt 1 Cutoff
    { target: 73, depth: 1024, value: (s) => s.voice / 2, smooth: 1, end: 0 }, // Osc 1 Vol
    { target: 77, depth: 1024, value: (s) => s.noise / 2, smooth: 0, end: 0 }, // Noise Vol
    { target: 96, depth: 768, value: (s) => (s.band - 512) / 8, smooth: 0, end: 0 }, // Filt 2 Cutoff
    // Osc 1 Pitch: stress, and the phrase falling by 2 semitones.
    { target: 11, depth: 1024, value: (s, at) => (s.pitch + 1 - (3 * at) / total) * PER_SEMITONE, smooth: 30, end: -2 * PER_SEMITONE },
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
    p.set(`${lfo}smooth`, c.smooth)
    let step = 1
    segments.forEach((s, n) => {
      for (let k = 0; k < t.counts[n]; k++, step++) p.set(`${lfo}step${step}`, stepRaw(c.value(s, step - 1)))
    })
    p.set(`${lfo}step${step}`, stepRaw(c.end))
    for (step++; step <= STEPS; step++) p.set(`${lfo}step${step}`, 512)
    p.set(`modmatrix${i + 1}modsource`, 6 + i) // LFO 1..5
    p.set(`modmatrix${i + 1}modtarget`, c.target)
    p.set(`modmatrix${i + 1}depth`, c.depth)
  })

  // A stop's closure and burst are one sound.
  const sounds = segments.map((s) => s.sound).filter((s, i, all) => !(s in STOP && all[i - 1] === s))
  return { patch: p, sounds, ms: Math.round(total * t.stepMs), dropped }
}

/** A step value (-64..64) as stored. */
const stepRaw = (v: number) => Math.round(512 + Math.max(-64, Math.min(64, v)) * 8)
