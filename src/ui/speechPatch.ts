// A whole patch that speaks a few English words, formant-synthesiser style: a Saw (the voice)
// through Filter 1's Vowel filter, white noise (breath and hiss) through Filter 2 as a band-pass,
// both run by five one-shot Step LFOs started by the note, one step every few tens of ms:
//   LFO 1 -> Filt 1 Cutoff   which vowel (the Vowel filter's Cutoff sweeps A E I O U)
//   LFO 2 -> Osc 1 Vol       voicing: on for vowels and voiced consonants, off for s, t, gaps
//   LFO 3 -> Noise Vol       hiss, bursts of stops, h
//   LFO 4 -> Filt 2 Cutoff   where the hiss sits: s high, sh lower, p/t/k bursts by place
//   LFO 5 -> Osc 1 Pitch     the melody: a peak on the main stress and a fall, or a yes/no rise
// Macro 1 (Speed) moves all five LFOs' rates together, from ~0.43x to ~2.3x, normal in the middle;
// Macro 2 (Fundamental) fades in OSC 3, a Saw at the note played that follows the voicing, for
// melodic speech and chords. Macro 3 (Voice) scales all formants (Formant Control): the middle is
// the voice as tuned, up a smaller (female, child) one, down a larger one. Macro 4 (Whisper)
// turns the voice into breath: noise through the Vowel filter instead of OSC 1.
// ENV 2 (the Amp's) just gates the note; the last step is silent and a one-shot LFO holds it.
// With `waves`, OSC 1 plays a WaveScan list of waves whose harmonics already show each sound's
// formants at the note it's tuned for (src/ui/waveSpeech.ts) instead of the Saw; LFO 5 then steps
// WaveScan, and ENV 3 lets the phrase fall (or a yes/no question rise) in pitch: no melody on its syllables.
//
// Measured on a Hydrasynth Desktop (fw 2.x) with tools/calibrateSpeech.ts; see CALIBRATION.
import { formatValue } from '../params/display'
import { initPatchBytes } from '../params/initPatch'
import { Patch, param } from '../params/patch'
import { VOWEL_MORPHS } from './vowelMorphs.generated'
import { pronounce, waveFor, waveForAll, type Pronunciations } from './waveSpeech'

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
 * the rest by ear. The a of cat isn't right anywhere on this sweep (it gets Formant Control +64,
 * TUNING vowelControls). er, by ear, toward a non-rhotic "ö"-like vowel: a little darker, with
 * Formant Control +64 (which lifts F1 to ~458 Hz and the harsh ~3.5 kHz peak out of the way) and
 * quieter; the filter can't make the American er's low F3 anyway.
 */
const { A, E, I, O, U } = CALIBRATION.vowelAt
const between = (a: number, b: number, t: number) => Math.round(a + (b - a) * t)
export const VOWEL_POS: Record<string, number> = {
  aa: between(A, E, 0.25), ah: between(A, E, 0.19), ae: between(A, E, 0.5), eh: between(A, E, 0.625), ih: E, iy: between(I, O, 0.125),
  er: between(I, O, 0.75), ao: between(I, O, 0.9), ow: between(O, U, 0.09), uh: between(I, O, 0.875), uw: between(O, U, 0.75),
  w: U, y: between(I, E, 0.375), r: between(I, O, 0.875), l: between(I, O, 0.875),
}
const DIPHTHONGS: Record<string, [string, string]> = { ey: ['eh', 'iy'], ay: ['aa', 'iy'], aw: ['aa', 'uw'], ow: ['ow', 'uw'], oy: ['ao', 'iy'] }
const bandRaw = (hz: number) => Math.round(512 + CALIBRATION.bandOctaveRaw * Math.log2(hz / CALIBRATION.bandAt512Hz))
/** Hisses: noise level (0..128) and band centre. Voiced ones keep some voice; v is mostly that. */
const HISS: Record<string, { noise: number; hz: number; voice: number }> = {
  s: { noise: 110, hz: 7000, voice: 0 },
  z: { noise: 80, hz: 7000, voice: 70 },
  sh: { noise: 120, hz: 2300, voice: 0 },
  zh: { noise: 80, hz: 2300, voice: 70 },
  f: { noise: 60, hz: 7000, voice: 0 },
  v: { noise: 25, hz: 7000, voice: 70 },
  th: { noise: 55, hz: 6500, voice: 0 },
  dh: { noise: 35, hz: 6500, voice: 45 },
}
/** The words of `text` as pronounce() splits them. */
const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z' ]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean)
/** Words that carry no accent in a phrase's melody, though the dictionary stresses some of them. */
const FUNCTION_WORDS = new Set(
  ('a an the and or but of to in on at for with from by as if so not no is are am was were be been being do does did have has had ' +
    'can could will would shall should may might must i you he she it we they me him her us them my your his its our their this that these those')
    .split(' '),
)
/** Words that start a question that falls (how are you?) rather than rises (are you ready?). */
const WH_WORDS = new Set(['what', 'why', 'where', 'when', 'who', 'whom', 'whose', 'which', 'how'])

/**
 * The kinds of phrase by how they end, and their melody (semitones; see melody): the nucleus's
 * peak (times stressLift), earlier accents (times the peak), where the end lands, how much longer
 * the nucleus is said, and the fall on ENV 3 where LFO 5 draws no melody (a wave per sound).
 */
const TUNES = {
  /** No end mark: a plain statement. */
  statement: { peak: 1, accents: 0.6, end: -2, nucleusLength: 1, fall: 2 },
  /** ".": a definite close. */
  period: { peak: 1, accents: 0.6, end: -3, nucleusLength: 1, fall: 2.5 },
  /** "!": a higher peak, livelier accents, a deeper fall, the nucleus held longer. */
  exclamation: { peak: 1.6, accents: 0.8, end: -3.5, nucleusLength: 1.25, fall: 3 },
  /** "?" after how, what, ...: falls like a statement. */
  wh: { peak: 1, accents: 0.6, end: -2, nucleusLength: 1, fall: 2 },
  /** "?" otherwise: dips on the nucleus and rises (questionRise). */
  yesNo: { peak: 0, accents: 0.6, end: 0, nucleusLength: 1, fall: 0 },
}
type Tune = keyof typeof TUNES

/** The kind of phrase `text` is, by its end mark and, for a question, its first word. */
function tuneOf(text: string): Tune {
  const end = text.trim().slice(-1)
  if (end === '?') return WH_WORDS.has(wordsOf(text)[0] ?? '') ? 'wh' : 'yesNo'
  return end === '!' ? 'exclamation' : end === '.' ? 'period' : 'statement'
}

/** The nucleus: the last accented syllable (a content word's stress), else the last vowel; its first segment and how many (a diphthong is two). */
function nucleusOf(segments: Segment[]): [number, number] | null {
  const last = (f: (s: Segment) => boolean | undefined) => segments.map((s) => !!f(s)).lastIndexOf(true)
  let nucleus = last((s) => s.accent)
  if (nucleus < 0) nucleus = last((s) => s.vowel)
  if (nucleus < 0) return null
  if (nucleus > 0 && isDiphthongPair(segments[nucleus - 1].sound, segments[nucleus].sound)) nucleus--
  return [nucleus, isDiphthongPair(segments[nucleus].sound, segments[nucleus + 1]?.sound) ? 2 : 1]
}

/**
 * The phrase's melody, semitones per LFO step (0 = the note played). Its nucleus carries the
 * tune: statements, exclamations and wh-questions peak there and fall to their end (TUNES); a
 * yes/no question dips there and rises by questionRise. Accented syllables before it get smaller
 * peaks on a line gently falling from +1.
 */
function melody(segments: Segment[], counts: number[], tune: Tune, tuning: Tuning): (step: number) => number {
  const starts = counts.map((_, i) => counts.slice(0, i).reduce((a, b) => a + b, 0))
  const total = counts.reduce((a, b) => a + b, 0)
  const found = nucleusOf(segments)
  if (!found) return () => 0
  const [nucleus, halves] = found
  const [from, to] = [starts[nucleus], starts[nucleus] + counts.slice(nucleus, nucleus + halves).reduce((a, b) => a + b, 0)]
  const shape = TUNES[tune]
  const peak = tune === 'yesNo' ? -0.5 : shape.peak * tuning.stressLift
  const end = tune === 'yesNo' ? tuning.questionRise : shape.end
  const segmentAt = (step: number) => starts.filter((st) => st <= step).length - 1
  return (step) => {
    if (step < from) {
      const s = segments[segmentAt(step)]
      return 1 - step / Math.max(1, from) + (s?.accent ? shape.accents * peak : 0)
    }
    // After the nucleus, glide to the end; a nucleus at the very end does it within itself.
    if (to < total) return step < to ? peak : peak + ((end - peak) * (step - to)) / (total - to)
    return peak + ((end - peak) * (step - from)) / Math.max(1, total - from)
  }
}

/** Whether `a` then `b` are the two halves of one diphthong. */
const isDiphthongPair = (a?: string, b?: string) =>
  !!a && !!b && (Object.values(DIPHTHONGS).some(([x, y]) => x === a && y === b) || (a === 'eh' && b === 'ih'))

/** Where in the mouth a consonant is made: it bends the formants of the vowels next to it. */
type Place = 'lips' | 'teeth' | 'ridge' | 'palate' | 'velum'
const PLACE: Record<string, Place> = {
  b: 'lips', p: 'lips', m: 'lips', f: 'lips', v: 'lips',
  th: 'teeth', dh: 'teeth',
  d: 'ridge', t: 'ridge', n: 'ridge', s: 'ridge', z: 'ridge',
  sh: 'palate', zh: 'palate', ch: 'palate', jh: 'palate',
  k: 'velum', g: 'velum', ng: 'velum',
}
const NASAL_PLACES = { m: 1, n: 1, ng: 1 }
/** Consonants without voice: a vowel before one in its word is said shorter. */
const VOICELESS = new Set(['p', 't', 'k', 'ch', 'f', 'th', 's', 'sh'])
/** Formant Control (raw, from 512) on the voiced parts of b and m next to a vowel: lips lower every formant. */
const LIPS_CONTROL = -64
/** A stop's burst strength by place (times the tuning's burst level). */
const BURST_BY_PLACE: Record<Place, number> = { lips: 0.7, teeth: 1, ridge: 1.2, palate: 1.1, velum: 1.2 }
/** Where F2 heads at each place (Hz, the "locus" of acoustic phonetics); the velum's depends on the vowel. */
const LOCUS_F2: Record<Exclude<Place, 'velum'>, number> = { lips: 800, teeth: 1400, ridge: 1800, palate: 2100 }

/**
 * Where a vowel at AEIOU Cutoff `vowel` starts or ends next to a consonant made at `place`: its
 * F1 lower (every closure lowers it) and F2 `pull` of the way toward the place's locus (the velum's: up
 * toward ~2300 Hz before front vowels, unchanged before back ones). The nearest point of the
 * AEIOU sweep that a glide from the vowel reaches without passing another vowel (offPath).
 */
export function locusPos(vowel: number, place: Place, pull = 0.5): number {
  const [f1, f2] = formantsAt('AEIOU', vowel)
  const toward = place === 'velum' ? (f2 > Math.log(1500) ? Math.log(2300) : f2) : Math.log(LOCUS_F2[place])
  const [t1, t2] = [f1 + Math.log(0.7), f2 + pull * (toward - f2)]
  let best = vowel
  let bestD = Infinity
  for (let c = 0; c <= 1024; c += 16) {
    if (offPath('AEIOU', vowel, c)) continue
    // Closed lips lower F1 too: a point that raises it (toward A, from a front vowel) is no help.
    if (place === 'lips' && formantsAt('AEIOU', c)[0] > f1 + 1e-9) continue
    // F2 moves toward the locus, not away (a t after "ay" pulled it up toward "ee").
    const g = formantsAt('AEIOU', c)[1]
    if ((g - f2) * (t2 - f2) < -1e-9) continue
    const [g1, g2] = formantsAt('AEIOU', c)
    // F2 tells the places apart; F1 (lowered at every closure) counts a quarter.
    const d = 0.25 * (g1 - t1) ** 2 + (g2 - t2) ** 2
    if (d < bestD) [bestD, best] = [d, c]
  }
  return best
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
  /** The voiced sound whose wave OSC 1 plays (null: the next one's, like `pos`). */
  shape: string | null
  /** Formant Control above its 64 (raw), for vowels the sweep can't make at 64 (the a of cat). */
  control: number
  /** A vowel (or half of a diphthong). */
  vowel: boolean
  /** A stressed vowel of a content word (not the, you, are, ...): where the melody's accents go. */
  accent?: boolean
  /**
   * A consonant's part that leans on its vowel (the one before or after, in the same word): its
   * place is where that vowel's formants start or end next to this consonant (locusPos).
   */
  locus?: { place: Place; side: 'prev' | 'next' }
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
  /** Formant Control (raw, from 512) on r: rounded lips lower every formant. */
  rControl: number
  /** r's length (factor): long at a word's start it sounded like a vowel of its own ("red" as "alert"). */
  rLength: number
  /** Whether r always glides into its vowel (1) or jumps past a vowel on the way like other sounds (0). */
  rGlides: number
  /**
   * Voice (0..128) of the first half of an r that starts a word (100: as the rest), and r's glide
   * (below): "red" sounded like "a-errr-t" (with an "er" wave, since chosen by the vowels alone).
   */
  rOnsetVoice: number
  /** r's glide (ms) into and out of its vowel (0: the vowel glide). */
  rGlideMs: number
  /** How much shorter (factor) a vowel is said before a voiceless consonant in its word. */
  voicelessClip: number
  /** Aspiration (ms) after a voiceless stop's burst: a breath, without which a final t sounds like d. */
  aspirationMs: number
  /** Filter 1 Cutoff (raw) per vowel, where it differs from VOWEL_POS. */
  vowelPositions: Partial<Record<string, number>>
  /**
   * Formant Control moved (raw, from 512) per vowel. The a of cat: on its place between A and E it
   * is too low (F1 589, F2 1635 Hz); +64 raises both to ~654 / 1830 (tools/calibrateSpeech.ts
   * control). er: +64 makes it mellower (see VOWEL_POS).
   */
  vowelControls: Partial<Record<string, number>>
  /** Voice level (0..128) per vowel, where it isn't the full 128. */
  vowelLevels: Partial<Record<string, number>>
  /** How far (0..1) a vowel's F2 bends toward a consonant's locus next to it (locusPos). */
  locusPull: number
  /** The same for a vowel before its consonant, as a share of locusPull. */
  locusPullBefore: number
  /**
   * The ay of "bay" (Filter 1 Cutoff, raw): from a close e (E itself) a short way toward i. Built
   * from eh to ee, it slid across the whole front of the filter and slurred after a stop.
   */
  eyStart: number
  eyEnd: number
  /** Filter 2 (the noise's band-pass) for every hiss: Morph (512 band-pass, toward 1024 high-pass) and resonance (raw). */
  hissMorph: number
  hissResonance: number
  /**
   * How far (semitones) a yes/no question rises after its nucleus (see melody); 4 over its whole
   * last part sounded like a patronising teacher.
   */
  questionRise: number
  /** How high (semitones) the nucleus of a statement or wh-question peaks (melody; only without waves, where LFO 5 draws pitch). */
  stressLift: number
}
/**
 * Chosen by ear from tools/tuneSpeech.ts runs: longer vowel glides scored smoother still (160 ms:
 * 10 % of frames still against 40 % before), but blur the vowels; 70 ms sounded better. Longer
 * m n l r w y, stops, word gaps and hiss delays scored closer to the references and sounded
 * better; shorter vowels scored better only by holding still less. r by ear between I and O.
 * No Analog Feel drift: it scored as livelier, but its pitch wander made speech sound slurred.
 */
export const TUNING: Tuning = {
  tempo: 1.4,
  vowelGlideMs: 70,
  voiceGlideMs: 40,
  noiseGlideMs: 0,
  pitchGlideMs: 120,
  vibrato: 0,
  vibratoRate: 100,
  drift: 0,
  stressedLength: 1,
  unstressedLength: 1,
  stopLength: 1.2,
  hissLength: 1,
  sonorantLength: 1.4,
  gapMs: 80,
  hissDelayMs: 60,
  burst: 85,
  voicedBurst: 70,
  closureVoice: 30,
  hissLevel: 1,
  breath: 55,
  rPosition: between(I, O, 0.75),
  rControl: -128,
  rLength: 0.6,
  rGlides: 1,
  rOnsetVoice: 50,
  rGlideMs: 30,
  voicelessClip: 0.6,
  aspirationMs: 50,
  vowelControls: { ae: 64, er: 64 },
  vowelLevels: { er: 96 },
  locusPull: 0.75,
  locusPullBefore: 0.6,
  eyStart: E,
  eyEnd: between(E, I, 0.5),
  hissMorph: 512,
  hissResonance: 128,
  questionRise: 1.2,
  stressLift: 2.5,
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
    // v buzzes through nearly closed lips: dark, like a stop's closure. dh at the teeth: dark it
    // sounded like a glottal stop or an l before ee and i ("this" as "gliss").
    ...(s === 'v' ? { pos: VOWEL_POS.uw } : s === 'dh' ? { locus: { place: 'teeth' as const, side: 'next' as const } } : {}),
  })
  const out: Segment[] = []
  const seg = (sound: string, ms: number, s: Partial<Segment> = {}) =>
    out.push({ sound, ms, pos: null, voice: 0, noise: 0, band: 512, shape: null, control: 0, vowel: false, ...s })
  const sounds = pronounce(text, dictionary)
  const words = wordsOf(text)
  let word = 0
  for (const [n, { sound: s, stressed }] of sounds.entries()) {
    const accent = stressed && !FUNCTION_WORDS.has(words[word])
    if (s === '') {
      word++
      // No pause before an h: silence and then a puff of noise is how a k sounds ("the whole" as
      // "thu-k-ole").
      if (sounds[n + 1]?.sound !== 'h') seg('', tune.gapMs)
    } else if (s in DIPHTHONGS || s in VOWEL_POS) {
      const glide = ['w', 'y', 'r', 'l'].includes(s)
      if (glide) {
        // r rounds the lips, lowering every formant (a Formant Control dip): it set "gr" apart from "gl".
        const ms = lengthOf(s) * (s === 'r' ? tune.rLength : 1)
        const at = { pos: s === 'r' ? tune.rPosition : posOf(s), voice: 100, shape: s, control: s === 'r' ? tune.rControl : 0 }
        // An r starting a word builds up: at full voice at once it sounded like a vowel ("red" as "alert").
        if (s === 'r' && (n === 0 || sounds[n - 1].sound === '') && tune.rOnsetVoice !== 100) {
          seg(s, ms / 2, { ...at, voice: tune.rOnsetVoice })
          seg(s, ms / 2, at)
        } else seg(s, ms, at)
        continue
      }
      const ms = lengthOf(s, stressed)
      // A diphthong has time on both ends, a little more where it glides to: either is easily lost.
      const control = (v: string) => tune.vowelControls[v] ?? 0
      const voice = (v: string) => tune.vowelLevels[v] ?? 128
      if (s === 'ey')
        // Its own narrow glide, mostly on the start (waves: those of eh and ih).
        (['eh', 'ih'] as const).forEach((v, i) =>
          seg(v, ms * (i ? 0.4 : 0.6), { pos: i ? tune.eyEnd : tune.eyStart, voice: voice(v), shape: v, control: control(v), vowel: true, accent }),
        )
      else if (s in DIPHTHONGS) DIPHTHONGS[s].forEach((v, i) => seg(v, ms * (i ? 0.55 : 0.45), { pos: posOf(v), voice: voice(v), shape: v, control: control(v), vowel: true, accent }))
      else seg(s, ms, { pos: posOf(s), voice: voice(s), shape: s, control: control(s), vowel: true, accent })
    } else if (s === 'm' || s === 'n' || s === 'ng') {
      // A dark murmur, its edges where the vowels next to it start and end (m, n and ng differ there).
      const ms = lengthOf(s)
      seg(s, ms * 0.25, { voice: 70, shape: s, locus: { place: PLACE[s], side: 'prev' } })
      seg(s, ms * 0.5, { pos: VOWEL_POS.uw, voice: 70, shape: s })
      seg(s, ms * 0.25, { voice: 70, shape: s, locus: { place: PLACE[s], side: 'next' } })
    } else if (s === 'h') {
      // Breath fading in, not a burst; after a voiced sound still a little voiced, as between vowels.
      // It sounds through the mouth already shaped for the next vowel, so its band sits at that
      // vowel's F2: a fixed 1.5 kHz before a dark o made "whole" sound like "kole".
      const ms = lengthOf(s)
      const voice = (out.at(-1)?.voice ?? 0) >= 70 ? 40 : 0
      const next = sounds.slice(n + 1).find((x) => x.sound in DIPHTHONGS || x.sound in VOWEL_POS)?.sound
      const vowel = next ? (DIPHTHONGS[next]?.[0] ?? next) : 'ah'
      const band = bandRaw(Math.exp(formantsAt('AEIOU', vowel === 'r' ? tune.rPosition : posOf(vowel))[1]))
      seg(s, ms * 0.4, { noise: tune.breath * 0.35, band, voice })
      seg(s, ms * 0.6, { noise: tune.breath, band, voice: voice / 2 })
    } else if (s in HISS) {
      // A voiceless one is silent in Filter 1, but the vowel after it glides out of its place.
      seg(s, lengthOf(s), { ...hiss(s), ...(HISS[s].voice ? {} : { locus: { place: PLACE[s], side: 'next' } }) })
    } else if (s in STOP) {
      const st = STOP[s]
      const ms = lengthOf(s)
      // Voiced stops murmur on through the closure and release softly into the vowel; voiceless
      // ones go quiet, then pop. Affricates end in their hiss.
      // The vowel before ends, and the one after starts, where this stop's place puts them.
      const [closure, burst] = st.then ? [0.4, 0.15] : [0.7, 0.3]
      const place = PLACE[s]
      seg(s, ms * closure * 0.5, st.voiced ? { voice: tune.closureVoice, locus: { place, side: 'prev' } } : { locus: { place, side: 'prev' } })
      // A voiced stop's murmur leads into the vowel from the stop's own place, not from a dark U for
      // all: b, d and g sounded alike.
      seg(s, ms * closure * 0.5, st.voiced ? { voice: tune.closureVoice, locus: { place, side: 'next' } } : { locus: { place, side: 'next' } })
      // A velar's burst sits near the next vowel's F2: high before front vowels, low before back ones.
      let hz = st.hz
      if (place === 'velum') {
        const next = sounds.slice(n + 1).find((x) => x.sound in DIPHTHONGS || x.sound in VOWEL_POS)?.sound
        const v = next ? (DIPHTHONGS[next]?.[0] ?? next) : 'ah'
        hz = Math.exp(formantsAt('AEIOU', posOf(v))[1]) > 1500 ? 2500 : 1400
      }
      // Bursts differ by place: weak at the lips, strong at the ridge and the velum.
      const strength = (st.voiced ? tune.voicedBurst : tune.burst) * BURST_BY_PLACE[place]
      seg(s, Math.max(st.voiced ? 25 : 15, ms * burst), { noise: Math.min(128, strength), band: bandRaw(hz), voice: st.voiced ? 80 : 0, locus: { place, side: 'next' } })
      if (st.then) seg(st.then, ms * 0.45, { ...hiss(st.then), locus: { place, side: 'next' } })
      // A voiceless stop breathes out after its burst (h-like noise at the next vowel's place).
      else if (!st.voiced && tune.aspirationMs > 0) seg(s, tune.aspirationMs, { noise: tune.breath, band: bandRaw(1800), locus: { place, side: 'next' } })
    }
  }
  // Nothing sounds before the first or after the last voiced or hissed segment.
  while (out.length && out[0].sound === '') out.shift()
  while (out.length && out.at(-1)!.sound === '') out.pop()
  // A voiceless hiss after a vowel starts a little late: the vowel rings on into it.
  for (let i = 1; i < out.length; i++) if (out[i].noise && !out[i].voice && out[i].sound in HISS && out[i - 1].vowel) out[i - 1].ms += tune.hissDelayMs
  // A phrase's last vowel lasts longer, stressed or not ("very": its ee was gone in the glides);
  // a diphthong as a whole, its halves in proportion (stretching only its end made "great" "greet").
  let lastVowel = out.map((s) => s.vowel).lastIndexOf(true)
  if (lastVowel >= 0) {
    const first = lastVowel > 0 && isDiphthongPair(out[lastVowel - 1].sound, out[lastVowel].sound) ? lastVowel - 1 : lastVowel
    const length = out.slice(first, lastVowel + 1).reduce((a, x) => a + x.ms, 0)
    const factor = (Math.max(length, lengthOf(out[lastVowel].sound, true)) * 1.3) / length
    for (let i = first; i <= lastVowel; i++) out[i].ms *= factor
  }
  // A vowel before a voiceless consonant in its word is said shorter (a long one makes "great" "greed").
  for (let i = 0; i < out.length; i++) {
    if (!out[i].vowel) continue
    const next = out.slice(i + 1).find((x) => !x.vowel || x.sound === '')
    if (next && VOICELESS.has(next.sound)) out[i].ms *= tune.voicelessClip
  }
  // Consonant parts that lean on a vowel of their word go where its formants start or end next to them.
  out.forEach((c, i) => {
    if (!c.locus) return
    const step = c.locus.side === 'next' ? 1 : -1
    for (let j = i + step; j >= 0 && j < out.length && out[j].sound !== ''; j += step)
      if (out[j].vowel) {
        // A consonant bends the vowel after it more than the one before it ("robot" sounded like
        // "robert": the t pulled the o toward er).
        c.pos = locusPos(out[j].pos!, c.locus.place, tune.locusPull * (c.locus.side === 'prev' ? tune.locusPullBefore : 1))
        // Closed lips lower all formants: where no noise needs LFO 4 (a b's closure, an m's
        // edges), Formant Control dips too.
        if (c.locus.place === 'lips' && !c.noise) c.control = LIPS_CONTROL
        return
      }
    // No vowel that side: a nasal stays dark; the rest take the vowel after them, as before.
    if (c.sound in NASAL_PLACES) c.pos = VOWEL_POS.uw
  })
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
  /**
   * Shape the voice with waves instead of the Saw: each wave's harmonicLevels, and the note (Hz) to
   * tune them for. `fixed`: one wave for the whole phrase (the one fitting all its voiced sounds
   * best), so LFO 5 stays free for the melody; else a wave per voiced sound, scanned by LFO 5.
   */
  waves?: { levels: (number[] | null)[]; f0: number; fixed?: boolean }
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
  // Statement, ".", "!", wh- or yes/no question: the phrase's melody (TUNES).
  const kind = tuneOf(text)
  const yesNo = kind === 'yesNo'
  const all = segmentsOf(text, dictionary, tune)
  // An exclamation holds its nucleus longer.
  const nucleus = nucleusOf(all)
  if (nucleus) for (let i = nucleus[0]; i < nucleus[0] + nucleus[1]; i++) all[i].ms *= TUNES[kind].nucleusLength
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
  // Formant Control 64, the place every vowel is tuned at, with the Voice macro in its middle.
  p.set('filter1special', 512 - VOICE_CENTER)
  p.set('filter1resonance', 576)
  p.set('filter1keytrack', 512)
  p.set('filter1cutoff', 512)
  p.set('filter2type', 0)
  p.set('filter2morph', tune.hissMorph)
  p.set('filter2resonance', tune.hissResonance)
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
  const pitchAt = melody(segments, t.counts, kind, tune)
  // The vowel order that lets this phrase glide where it should; positions move into it.
  const keys = segments.map((s) => String(s.pos))
  const order = chooseOrder(
    keys,
    segments.map((s) => s.vowel || s.voice >= 100),
  )
  segments.forEach((s, i) => (s.pos = order.place.get(keys[i])!))
  p.set('filter1vowelorder', ORDERS.indexOf(order.name))
  const list = waves && !waves.fixed ? waveList(segments, waves.levels, waves.f0) : null
  if (waves?.fixed) {
    // Chosen by the vowels: a short word's r or n otherwise weighs as much ("red" got an "er" wave).
    const vowels = segments.filter((s) => s.vowel)
    const voiced = [...new Set((vowels.length ? vowels : segments).map((s) => s.shape).filter((x): x is string => !!x))]
    if (voiced.length) p.set('osc1type', waveForAll(voiced, waves.levels, waves.f0))
  }
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
    /** Changes into or out of a stop glide in one step: a stop is crisp, a long glide slurs it. */
    crisp?: boolean
  }[] = [
    // Filt 1 Cutoff. The Vowel filter morphs only along its order's vowels: a glide that passes one
    // off its way says it ("very" as "ve-ee-ry"), so such a change jumps.
    { target: 88, depth: 768, value: (s) => (s.pos! - 512) / 8, glideMs: tune.vowelGlideMs, end: 0, jump: (a, b) => offPath(order.name, 512 + 8 * a, 512 + 8 * b), crisp: true },
    { target: 73, depth: 1024, value: (s) => s.voice / 2, glideMs: tune.voiceGlideMs, end: 0, crisp: true }, // Osc 1 Vol
    { target: 77, depth: 1024, value: (s) => s.noise / 2, glideMs: tune.noiseGlideMs, end: 0 }, // Noise Vol
    // Filt 2 Cutoff while noise sounds; while it doesn't, Filter 2 hears nothing and the same curve
    // carries Formant Control (slot 7, depth CONTROL_DEPTH) for the vowels that need it.
    { target: 96, depth: 768, value: (s) => (s.noise ? (s.band - 512) / 8 : (s.control * 8) / CONTROL_DEPTH), glideMs: Math.max(tune.noiseGlideMs, 1), end: 0 },
    list
      ? // Osc 1 WaveScan: the sound's slot (slot i of 8 sits at i/7 of the range). One step's glide
        // at most: a longer ramp would play the slots between, other sounds' waves.
        { target: 13, depth: 1024, value: (s) => ((list.slotOf.get(s.shape ?? '') ?? 0) * 64) / 7, glideMs: Math.min(tune.vowelGlideMs, t.stepMs), end: ((list.slotOf.get(segments.at(-1)!.shape ?? '') ?? 0) * 64) / 7 }
      : // Osc 1 Pitch: stress, and the phrase falling by 2 semitones.
        { target: 11, depth: 1024, value: (_, at) => pitchAt(at) * PER_SEMITONE, glideMs: tune.pitchGlideMs, end: pitchAt(total) * PER_SEMITONE },
  ]
  curves.forEach((c, i) => {
    const lfo = `lfo${i + 1}`
    p.set(`${lfo}wave`, 10)
    p.set(`${lfo}steps`, total + 1)
    p.set(`${lfo}bpmsync`, 0)
    // The Speed macro adds SPEED_CENTER back in its middle.
    p.set(`${lfo}ratesyncoff`, Math.max(0, t.raw - SPEED_CENTER))
    p.set(`${lfo}oneshot`, 1)
    p.set(`${lfo}trigsync`, 0)
    p.set(`${lfo}level`, 1024)
    p.set(`${lfo}smooth`, c.glideMs > 0 ? 127 : 0)
    // One value per step, then the end; ramps between sounds over `width` steps (the end stays exact).
    const values: number[] = []
    const atStop: boolean[] = []
    const atR: boolean[] = []
    segments.forEach((s, n) => {
      for (let k = 0; k < t.counts[n]; k++) {
        values.push(c.value(s, values.length))
        atStop.push(s.sound in STOP)
        atR.push(s.sound === 'r')
      }
    })
    values.push(c.end)
    atStop.push(false)
    atR.push(false)
    const width = Math.max(1, Math.round(c.glideMs / t.stepMs))
    /** The mean of `w` values around step k (a ramp `w` steps wide across a change). */
    const around = (k: number, w: number) => {
      if (k === values.length - 1 || w === 1) return values[k]
      const from = Math.max(0, k - Math.floor((w - 1) / 2))
      const to = Math.min(values.length - 1, k + Math.ceil((w - 1) / 2))
      let sum = 0
      for (let j = from; j <= to; j++) sum += values[j]
      return sum / (to - from + 1)
    }
    const ramped = values.map((_, k) => around(k, width))
    // r's own, shorter glide into and out of its vowel on the vowel curve.
    if (c.jump && tune.rGlideMs > 0) {
      const w = Math.max(1, Math.round(tune.rGlideMs / t.stepMs))
      for (let b = 1; b < values.length - 1; b++)
        if (values[b] !== values[b - 1] && (atR[b - 1] || atR[b]))
          for (let k = Math.max(0, b - Math.ceil((width - 1) / 2)); k <= Math.min(values.length - 2, b + Math.floor((width - 1) / 2)); k++) ramped[k] = around(k, w)
    }
    if (c.jump || c.crisp)
      for (let b = 1; b < values.length - 1; b++)
        if (
          values[b] !== values[b - 1] &&
          // An r glides into its vowel even past another vowel: jumping, "great" sounded like "glayd".
          ((!(tune.rGlides && (atR[b - 1] || atR[b])) && c.jump?.(values[b - 1], values[b])) || (c.crisp && (atStop[b - 1] || atStop[b])))
        )
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
    // The phrase's pitch on ENV 3 instead (a full envelope at depth d of 128 is d * 64/128 / 5
    // semitones). A statement falls (TUNES fall: 2, 2.5 after ".", 3 after "!") over its Decay (which takes ~2x the time shown); a
    // question rises by questionRise over an Attack as long as the phrase (shown time; curve Exp
    // -48: flat, then up toward the end; tools/calibrateSpeech.ts envattack). The Speed macro shortens it as it
    // speeds the phrase up (the time table goes ~x1.7 per 64 raw, like the LFO rates).
    const phraseMs = total * t.stepMs
    const nearest = (ms: number) => DECAYS.reduce((a, b) => (Math.abs(b[1] - ms) < Math.abs(a[1] - ms) ? b : a))[0]
    p.set('env3bpmsync', 0)
    p.set('env3holdsyncoff', 0)
    if (yesNo) {
      p.set('env3attacksyncoff', Math.min(1024, nearest(phraseMs) + SPEED_CENTER))
      p.set('env3atkcurve', 16)
      p.set('env3decaysyncoff', 0)
      p.set('env3sustain', 1024)
      p.set('macro1target6', 129) // Env 3 Attack
    } else {
      p.set('env3attacksyncoff', 0)
      p.set('env3sustain', 0)
      p.set('env3decaysyncoff', Math.min(1024, nearest(phraseMs / CALIBRATION.decayFactor) + SPEED_CENTER))
      p.set('macro1target6', 131) // Env 3 Decay
    }
    p.set('macro1depth6', 512 - SPEED_DEPTH * 4)
    p.set('modmatrix6modsource', 3) // Env 3
    p.set('modmatrix6modtarget', 11) // Osc 1 Pitch
    const semitones = yesNo ? tune.questionRise : TUNES[kind].fall
    p.set('modmatrix6depth', Math.round(512 + ((semitones * PER_SEMITONE * 128) / 64) * 4))
  }

  // Macro 1, Speed: every LFO's Rate by the same amount, so they stay together; the knob's middle
  // (its default) is the phrase as built. A route moves a target by knob/128 * depth/128 * 1024
  // raw (tools/calibrateSpeech.ts macrorate).
  p.setMacroName(1, 'Speed')
  p.set('macro1panelvalue', 512)
  for (let i = 1; i <= 5; i++) {
    p.set(`macro1target${i}`, 142 + 2 * i) // LFO i Rate
    p.set(`macro1depth${i}`, 512 + SPEED_DEPTH * 4)
  }
  // Macro 2, Fundamental: OSC 3, a Saw at the note played, through the Vowel filter with the voice
  // and following its voicing: the voicing curve (LFO 2) goes to Osc 3 Vol at depth 0 (slot 8),
  // and the macro turns that depth up, to +128 at the top (64 of 128 on a Matrix Depth, whose
  // range is twice that). Off at 0.
  p.setMacroName(2, 'Fundamental')
  p.set('osc3type', 3)
  p.set('osc3semi', 0)
  p.set('mixerosc3vol', 0)
  p.set('mixerosc3filterratio', 0)
  p.set('modmatrix8modsource', 7) // LFO 2
  p.set('modmatrix8modtarget', 75) // Osc 3 Vol
  p.set('modmatrix8depth', 512)
  p.set('macro2panelvalue', 0)
  p.set('macro2target1', 161) // Matrix 8 Depth
  p.set('macro2depth1', 512 + 64 * 4)

  // Macro 3, Voice: Formant Control from 48 (larger, deeper) through 64 (as tuned, the default) to
  // 80 (smaller: formants ~18-24 % higher, about a woman's; tools/calibrateSpeech.ts control).
  p.setMacroName(3, 'Voice')
  p.set('macro3panelvalue', 512)
  p.set('macro3target1', 91) // Filt 1 Control
  p.set('macro3depth1', 512 + VOICE_DEPTH * 4)

  // Macro 4, Whisper: the voice turns into breath. A second noise, the Ring Mod of the noise and
  // OSC 2 (noise times a sine is still noise), goes through the Vowel filter with its own level,
  // so it keeps the vowels while the plain noise keeps making the hisses in Filter 2. The voicing
  // curve (LFO 2) goes to Ring Mod Vol at depth 0 (slot 9); the macro turns that up to +128 and
  // the voicing's routes to OSC 1 (slot 2) and OSC 3 (slot 8, the Fundamental) down by 128, so 0
  // is the voice, 128 a whisper (64 of 128 on a Matrix Depth is 128; calibrateSpeech macrodepth).
  p.setMacroName(4, 'Whisper')
  p.set('osc2type', 0)
  p.set('osc2semi', 0)
  p.set('mixerosc2vol', 0)
  p.set('ringmodsource1', 3) // Noise
  p.set('ringmodsource2', 1) // Osc 2
  p.set('ringmoddepth', 1024)
  p.set('mixerringmodvol', 0)
  p.set('mixerringmodfilterratio', 0) // Filter 1
  p.set('modmatrix9modsource', 7) // LFO 2
  p.set('modmatrix9modtarget', 76) // Ring Mod Vol
  p.set('modmatrix9depth', 512)
  p.set('macro4panelvalue', 0)
  p.set('macro4target1', 162) // Matrix 9 Depth
  p.set('macro4depth1', 512 + 64 * 4)
  p.set('macro4target2', 155) // Matrix 2 Depth: voicing to Osc 1 Vol
  p.set('macro4depth2', 512 - 64 * 4)
  p.set('macro4target3', 161) // Matrix 8 Depth: voicing to Osc 3 Vol
  p.set('macro4depth3', 512 - 64 * 4)

  // A sound in several parts (a stop's closure and burst, an h or a nasal) is one sound.
  const sounds = segments.map((s) => s.sound).filter((s, i, all) => s === '' || all[i - 1] !== s)
  return { patch: p, sounds, ms: Math.round(total * t.stepMs), dropped, order: order.name }
}

/** Depth (of 128) of the Speed macro on the LFO rates: 192 raw over the knob, 96 to either side of the middle. */
const SPEED_DEPTH = 24
const SPEED_CENTER = SPEED_DEPTH * 4

/** Depth (of 128) of the Voice macro on Formant Control: 256 raw over the knob, 128 to either side of the middle. */
const VOICE_DEPTH = 32
const VOICE_CENTER = VOICE_DEPTH * 4

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
 * The vowel order for a phrase whose sounds are at `places`: Filter 1 Cutoffs in AEIOU (where
 * VOWEL_POS is tuned). In each order every one goes to the point that sounds most like it (an order
 * where one matches under 0.6 is out). Each order costs a point per glide between `vocal`
 * neighbours (vowels, l r w y) that must jump, plus 1.5 x (1 - match) per vocal sound it moves
 * off its tuned sound; the cheapest wins, AEIOU when it ties, so phrases that glide fine keep
 * their tuned sound exactly. Changes into or out of consonants don't count: their places (v's
 * dark U, say) are tricks, not glides anyone hears.
 */
export function chooseOrder(places: string[], vocal: boolean[], report?: (order: string, cost: number, place: Map<string, number>) => void): { name: string; place: Map<string, number> } {
  const distinct = [...new Set(places)]
  let best: { name: string; place: Map<string, number>; cost: number } | null = null
  for (const name of ORDERS) {
    const place = new Map<string, number>()
    const match = new Map<string, number>()
    let ok = true
    for (const key of distinct) {
      const exact = exactCutoff(name, key)
      if (exact !== null) {
        place.set(key, exact)
        match.set(key, 1)
        continue
      }
      const target = shapeOf(key)
      let at = 0
      let closest = -2
      for (let x = 0; x <= 1024; x += 32) {
        const l = like(shapeAt(name, x), target)
        if (l > closest) [closest, at] = [l, x]
      }
      if (closest < 0.6) ok = false
      place.set(key, at)
      match.set(key, closest)
    }
    if (!ok) continue
    let cost = 0
    for (const key of new Set(places.filter((_, i) => vocal[i]))) cost += 1.5 * (1 - match.get(key)!)
    for (let i = 1; i < places.length; i++) {
      if (!vocal[i - 1] || !vocal[i]) continue
      const [a, b] = [place.get(places[i - 1])!, place.get(places[i])!]
      if (a !== b && offPath(name, a, b)) cost++
    }
    report?.(name, cost, place)
    if (!best || cost < best.cost - 1e-9) best = { name, place, cost }
  }
  return best!
}

/** The Cutoff of `key` in `order` if it stays as tuned there (AEIOU); else null. */
function exactCutoff(order: string, key: string): number | null {
  return order === 'AEIOU' ? Number(key) : null
}

/** The filter's measured sound at AEIOU Cutoff `key`. */
const shapeOf = (key: string) => shapeAt('AEIOU', Number(key))

/** A step value (-64..64) as stored. */
const stepRaw = (v: number) => Math.round(512 + Math.max(-64, Math.min(64, v)) * 8)
