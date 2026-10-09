// Speech in a wavelist, talk-box style: English words become a row of speech sounds (spelling
// rules plus a list of common words), and each sound becomes the wave whose harmonics, at the
// note it is tuned for, best show that sound's formants. Sweeping WaveScan through the eight slots
// then "says" the words. Single-cycle waves only hold steady spectra, so vowels and the voiced
// sounds between them carry it; hisses get the noisiest bright waves, stops a gap of Silence.
import { loadWaveCycles } from './waveCycles'
import { WAVE_FEATURES } from './waveFeatures.generated'

/** Notes speech can be tuned for: formants sit at fixed frequencies, harmonics move with the key. */
export const PITCHES = [
  { label: 'C2', hz: 65.41 },
  { label: 'C3', hz: 130.81 },
  { label: 'C4', hz: 261.63 },
]

let levels: Promise<(number[] | null)[]> | null = null
/** Each wave's harmonicLevels, measured once from the recorded cycles (public/wave-cycles.json). */
export const waveLevels = () => (levels ??= loadWaveCycles().then((cycles) => cycles.map((c) => (c ? harmonicLevels(c.cycle) : null))))

/** Harmonics measured per wave: up to ~8 kHz even for a note as low as C2. */
export const HARMONICS = 128
/** In a speech fill, a slot (2-8) left silent: the gap of a stop consonant or between words. */
export const SILENCE = -1

/** Each harmonic's level in dB (loudest 0, floor -100), from one recorded cycle. */
export function harmonicLevels(cycle: Float32Array): number[] {
  const n = cycle.length
  const cos = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * i) / n))
  const sin = Float64Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * i) / n))
  const mags: number[] = []
  for (let k = 1; k <= HARMONICS && k < n / 2; k++) {
    let re = 0
    let im = 0
    for (let i = 0; i < n; i++) {
      const j = (k * i) % n
      re += cycle[i] * cos[j]
      im -= cycle[i] * sin[j]
    }
    mags.push(Math.hypot(re, im))
  }
  const peak = Math.max(...mags) || 1
  return mags.map((m) => 20 * Math.log10(m / peak + 1e-5))
}

type Kind = 'vowel' | 'glide' | 'nasal' | 'hiss' | 'stop'

/** Formants (Hz) of the vowels and glides, adult male averages (Hillenbrand et al., Peterson & Barney). */
export const FORMANTS: Record<string, [number, number, number]> = {
  iy: [300, 2300, 3000],
  ih: [430, 2030, 2680],
  eh: [580, 1800, 2600],
  ae: [660, 1720, 2410],
  aa: [750, 1200, 2500],
  ao: [620, 920, 2500],
  ow: [500, 910, 2460],
  uh: [470, 1120, 2430],
  uw: [320, 900, 2340],
  ah: [620, 1200, 2550],
  er: [480, 1380, 1710],
  w: [290, 610, 2150],
  y: [260, 2070, 3020],
  r: [310, 1060, 1380],
  l: [360, 1000, 2700],
}

/** Diphthongs glide between two of the vowels above. */
const DIPHTHONGS: Record<string, string[]> = { ey: ['eh', 'iy'], ay: ['aa', 'iy'], aw: ['aa', 'uw'], ow: ['ow', 'uw'], oy: ['ao', 'iy'] }

/** Hisses by where their noise sits; voiced ones share the voiceless one's wave. */
const HISSES: Record<string, (hz: number) => number> = {
  s: (hz) => -30 * Math.abs(Math.log2(hz / 6000)),
  sh: (hz) => -25 * Math.abs(Math.log2(hz / 3000)),
  f: (hz) => -3 * Math.log2(hz / 1000),
}
const HISS_OF: Record<string, string> = { s: 's', z: 's', sh: 'sh', zh: 'sh', ch: 'sh', jh: 'sh', f: 'f', v: 'f', th: 'f', dh: 'f' }
const NASALS: Record<string, number> = { m: 36, n: 30, ng: 30 }
const STOPS = new Set(['p', 'b', 't', 'd', 'k', 'g'])

function kindOf(sound: string): Kind | null {
  if (['w', 'y', 'r', 'l'].includes(sound)) return 'glide'
  if (sound in FORMANTS || sound in DIPHTHONGS) return 'vowel'
  if (sound in NASALS) return 'nasal'
  if (sound in HISS_OF) return 'hiss'
  if (STOPS.has(sound)) return 'stop'
  return null // h, and anything unknown: not voiced, left out
}

/** Common words the spelling rules would get wrong. */
const WORDS: Record<string, string> = {
  a: 'ah', the: 'dh ah', of: 'ah v', to: 't uw', do: 'd uw', you: 'y uw', your: 'y ao r', i: 'ay', is: 'ih z', was: 'w ah z',
  are: 'aa r', be: 'b iy', he: 'h iy', me: 'm iy', we: 'w iy', she: 'sh iy', my: 'm ay', by: 'b ay', hello: 'h ah l ow',
  one: 'w ah n', two: 't uw', who: 'h uw', what: 'w ah t', says: 's eh z', said: 's eh d', have: 'h ae v', give: 'g ih v',
  live: 'l ih v', love: 'l ah v', come: 'k ah m', some: 's ah m', done: 'd ah n', none: 'n ah n', gone: 'g ao n',
  there: 'dh eh r', where: 'w eh r', here: 'h ih r', were: 'w er', they: 'dh ey', their: 'dh eh r', this: 'dh ih s',
  that: 'dh ae t', them: 'dh eh m', then: 'dh eh n', these: 'dh iy z', those: 'dh ow z', with: 'w ih dh', how: 'h aw',
  now: 'n aw', cow: 'k aw', wow: 'w aw', eye: 'ay', no: 'n ow', go: 'g ow', so: 's ow', oh: 'ow', robot: 'r ow b aa t',
  synth: 's ih n th', synthesizer: 's ih n th ah s ay z er', hydrasynth: 'h ay d r ah s ih n th', computer: 'k ah m p y uw t er',
  music: 'm y uw z ih k', water: 'w ao t er', people: 'p iy p ah l', good: 'g uh d', book: 'b uh k', look: 'l uh k',
  put: 'p uh t', could: 'k uh d', would: 'w uh d', should: 'sh uh d', world: 'w er l d', work: 'w er k', word: 'w er d',
  four: 'f ao r', our: 'aw r', hour: 'aw r', great: 'g r ey t', break: 'b r ey k', friend: 'f r eh n d', head: 'h eh d',
  dead: 'd eh d', bread: 'b r eh d', ready: 'r eh d iy', any: 'eh n iy', many: 'm eh n iy', only: 'ow n l iy',
  ah: 'aa', aah: 'aa', ahh: 'aa', ooh: 'uw', oo: 'uw', eee: 'iy', ee: 'iy', mmm: 'm', hmm: 'h m', la: 'l aa',
  very: 'v eh r iy', machine: 'm ah sh iy n', voice: 'v oy s', yeah: 'y eh', okay: 'ow k ey', ok: 'ow k ey',
}

const VOWELS = 'aeiou'
const isVowel = (c: string | undefined) => !!c && VOWELS.includes(c)
const isConsonant = (c: string | undefined) => !!c && /[a-z]/.test(c) && !VOWELS.includes(c)
const LONG: Record<string, string> = { a: 'ey', e: 'iy', i: 'ay', o: 'ow', u: 'uw' }
const SHORT: Record<string, string> = { a: 'ae', e: 'eh', i: 'ih', o: 'aa', u: 'ah' }

/** Spelling rules, tried longest first at each letter: [letters, sounds, applies here?]. */
type Rule = [string, string, ((w: string, i: number) => boolean)?]
const end = (w: string, i: number, len: number) => i + len === w.length
const notBeforeVowel = (len: number) => (w: string, i: number) => !isVowel(w[i + len]) && w[i + len] !== 'y'
const RULES: Rule[] = [
  ['tion', 'sh ah n'],
  ['sion', 'zh ah n'],
  ['ture', 'ch er'],
  ['ough', 'ao'],
  ['augh', 'ao'],
  ['eigh', 'ey'],
  ['tch', 'ch'],
  ['igh', 'ay'],
  ['sch', 's k'],
  ['air', 'eh r'],
  ['ear', 'ih r', notBeforeVowel(3)],
  ['eer', 'ih r'],
  ['oor', 'ao r'],
  ['our', 'aw r'],
  ['wor', 'w er', (w, i) => i === 0 && isConsonant(w[3])],
  ['le', 'ah l', (w, i) => end(w, i, 2) && isConsonant(w[i - 1]) && i > 1],
  ['ed', 'ih d', (w, i) => end(w, i, 2) && i > 1 && 'td'.includes(w[i - 1])],
  ['ed', 'd', (w, i) => end(w, i, 2) && i > 2],
  ['es', 'ih z', (w, i) => end(w, i, 2) && /(s|x|z|ch|sh)$/.test(w.slice(0, i))],
  ['ar', 'aa r', notBeforeVowel(2)],
  ['or', 'ao r', notBeforeVowel(2)],
  ['er', 'er', notBeforeVowel(2)],
  ['ir', 'er', notBeforeVowel(2)],
  ['ur', 'er', notBeforeVowel(2)],
  ['ee', 'iy'],
  ['ea', 'iy'],
  ['ai', 'ey'],
  ['ay', 'ey'],
  ['ei', 'ey'],
  ['ey', 'iy', (w, i) => end(w, i, 2) && i > 1],
  ['ey', 'ey'],
  ['ie', 'ay', (w, i) => end(w, i, 2) && w.length <= 4],
  ['ie', 'iy'],
  ['oa', 'ow'],
  ['oe', 'ow'],
  ['oo', 'uw'],
  ['ou', 'aw'],
  ['ow', 'aw', (w, i) => 'nl'.includes(w[i + 2] ?? '')],
  ['ow', 'ow'],
  ['oi', 'oy'],
  ['oy', 'oy'],
  ['au', 'ao'],
  ['aw', 'ao'],
  ['ew', 'uw'],
  ['ue', 'uw'],
  ['ui', 'uw'],
  ['ch', 'ch'],
  ['sh', 'sh'],
  ['th', 'th'],
  ['ph', 'f'],
  ['wh', 'w'],
  ['ck', 'k'],
  ['ng', 'ng'],
  ['nk', 'ng k'],
  ['qu', 'k w'],
  ['kn', 'n', (_, i) => i === 0],
  ['wr', 'r', (_, i) => i === 0],
  ['gn', 'n', (_, i) => i === 0],
  ['mb', 'm', (w, i) => end(w, i, 2)],
  ['gh', ''],
  ['wa', 'w aa', (w, i) => !isVowel(w[i + 2]) || end(w, i, 2)],
  ['al', 'ao l', (w, i) => isConsonant(w[i + 2]) && w[i + 2] !== 'e'],
  ['x', 'z', (_, i) => i === 0],
  ['x', 'k s'],
  ['c', 's', (w, i) => 'eiy'.includes(w[i + 1] ?? '-')],
  ['c', 'k'],
  ['g', 'jh', (w, i) => w[i + 1] === 'e' && end(w, i, 2)],
  ['j', 'jh'],
  ['y', 'y', (w, i) => i === 0 && isVowel(w[1])],
  ['y', 'ay', (w, i) => end(w, i, 1) && !/[aeiou]/.test(w.slice(0, i))],
  ['y', 'iy', (w, i) => end(w, i, 1)],
  ['y', 'ih', (w, i) => i > 0 && !isVowel(w[i - 1])],
  ['e', '', (w, i) => end(w, i, 1) && /[aeiouy]/.test(w.slice(0, i - 1)) && isConsonant(w[i - 1])],
  ['e', 'iy', (w, i) => end(w, i, 1)],
]

/** Vowel, one consonant, then a silent e (at the end, or before a final s): the vowel says its name. */
const magicE = (w: string, i: number) =>
  isConsonant(w[i + 1]) && w[i + 1] !== 'x' && w[i + 2] === 'e' && (i + 3 === w.length || (w[i + 3] === 's' && i + 4 === w.length))

function spellWord(w: string): string[] {
  if (WORDS[w]) return WORDS[w].split(' ')
  const out: string[] = []
  let i = 0
  while (i < w.length) {
    const c = w[i]
    // A doubled consonant sounds once.
    if (isConsonant(c) && c === w[i - 1]) {
      i++
      continue
    }
    const rule = RULES.find(([letters, , applies]) => w.startsWith(letters, i) && (!applies || applies(w, i)))
    if (rule) {
      out.push(...rule[1].split(' ').filter(Boolean))
      i += rule[0].length
    } else if (isVowel(c)) {
      if (magicE(w, i)) out.push(LONG[c])
      else if (end(w, i, 1)) out.push(c === 'a' ? 'ah' : c === 'i' ? 'iy' : LONG[c])
      else out.push(SHORT[c])
      i++
    } else {
      out.push(c === 's' && i > 0 && end(w, i, 1) && /[bdgvmnlr]$/.test(w.slice(0, i)) ? 'z' : c)
      i++
    }
  }
  return out
}

/** The speech sounds (ARPAbet-like codes) of some English words, '' between words. */
export function spellSounds(text: string, dictionary?: Pronunciations | null): string[] {
  return pronounce(text, dictionary).map((s) => s.sound)
}

/** A speech sound and whether it carries the word's stress (only vowels do). */
export interface Sound {
  sound: string
  stressed: boolean
}

/**
 * One character per sound in public/pronunciations.txt (tools/buildPronunciations.ts): vowels as
 * a..o, in capitals when stressed; consonants as the rest.
 */
export const PRONUNCIATION_CODES: Record<string, string> = Object.fromEntries(
  [
    ...['aa', 'ae', 'ah', 'ao', 'aw', 'ay', 'eh', 'er', 'ey', 'ih', 'iy', 'ow', 'oy', 'uh', 'uw'].map((v, i) => [v, 'abcdefghijklmno'[i]]),
    ...['b', 'ch', 'd', 'dh', 'f', 'g', 'h', 'jh', 'k', 'l', 'm', 'n', 'ng', 'p', 'r', 's', 'sh', 't', 'th', 'v', 'w', 'y', 'z', 'zh'].map((c, i) => [
      c,
      'pqrstuvwxyz0123456789#%&'[i],
    ]),
  ],
)
const SOUND_OF = new Map(Object.entries(PRONUNCIATION_CODES).map(([sound, c]) => [c, sound]))

/** Word -> its sounds as coded in public/pronunciations.txt. */
export type Pronunciations = Map<string, string>

/** Reads public/pronunciations.txt: front-coded lines, a digit of letters shared with the line before. */
export function parsePronunciations(text: string): Pronunciations {
  const out: Pronunciations = new Map()
  let previous = ''
  for (const line of text.split('\n')) {
    if (!line) continue
    const space = line.indexOf(' ')
    const word = previous.slice(0, Number(line[0])) + line.slice(1, space)
    out.set(word, line.slice(space + 1))
    previous = word
  }
  return out
}

let pronunciations: Promise<Pronunciations | null> | null = null
/** The CMU Pronouncing Dictionary (see NOTICE), loaded once on first use; null if it didn't load. */
export const loadPronunciations = () =>
  (pronunciations ??= fetch(`${import.meta.env.BASE_URL}pronunciations.txt`)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
    .then(parsePronunciations)
    .catch(() => null))

const decode = (code: string): Sound[] =>
  [...code].map((c) => ({ sound: SOUND_OF.get(c.toLowerCase())!, stressed: /[A-O]/.test(c) }))

/**
 * The sounds of some English words, '' between words: from the dictionary where it has the word,
 * else from the spelling rules above (stress on the word's first vowel).
 */
export function pronounce(text: string, dictionary?: Pronunciations | null): Sound[] {
  const words = text.toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/).map((w) => w.replace(/^'+|'+$/g, '')).filter(Boolean)
  return words.flatMap((w, n) => {
    const known = dictionary?.get(w)
    let sounds: Sound[]
    if (known) sounds = decode(known)
    else {
      let first = true
      sounds = spellWord(w.replace(/'/g, '')).map((sound) => {
        const vowel = /^[aeiou]/.test(sound)
        const stressed = vowel && first
        if (vowel) first = false
        return { sound, stressed }
      })
    }
    return [...(n ? [{ sound: '', stressed: false }] : []), ...sounds]
  })
}

/** Correlation of two level curves; `flat` first takes out each one's overall tilt, leaving its peaks. */
export function similarity(a: number[], b: number[], flat: boolean): number {
  const fit = (v: number[]) => {
    const x = v.map((_, i) => Math.log2(i + 1))
    const n = v.length
    const mx = x.reduce((s, t) => s + t, 0) / n
    const my = v.reduce((s, t) => s + t, 0) / n
    let sxy = 0
    let sxx = 0
    x.forEach((xi, i) => {
      sxy += (xi - mx) * (v[i] - my)
      sxx += (xi - mx) ** 2
    })
    const slope = flat && sxx ? sxy / sxx : 0
    return v.map((y, i) => y - my - slope * (x[i] - mx))
  }
  const fa = fit(a)
  const fb = fit(b)
  let ab = 0
  let aa = 0
  let bb = 0
  fa.forEach((v, i) => {
    ab += v * fb[i]
    aa += v * v
    bb += fb[i] * fb[i]
  })
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0
}

/**
 * Levels (dB) at the harmonics of `f0` through the resonances at `formants`, plus F4 and F5 at
 * fixed places: without them the highs come out ~8 dB too weak (an "ee" F2 at -32 dB instead of
 * the voice's ~-24), and front vowels match dark waves.
 */
export function formantLevels(formants: number[], f0: number, count: number): number[] {
  const all = [...formants, 3500, 4500]
  const bandwidths = [90, 110, 160, 250, 300]
  const out: number[] = []
  for (let k = 1; k <= count; k++) {
    const hz = k * f0
    let gain = 100 / hz // the voice's -6 dB/octave
    all.forEach((F, j) => (gain *= (F * F) / Math.hypot(F * F - hz * hz, bandwidths[j] * hz)))
    out.push(20 * Math.log10(gain))
  }
  return out
}

/** The wave that best plays `sound` at `f0`; `levels` are each wave's harmonicLevels. */
export function waveFor(sound: string, levels: (number[] | null)[], f0: number): number {
  const scores = waveScores(sound, levels, f0)
  return scores.indexOf(Math.max(...scores))
}

/**
 * How well each wave plays `sound` at `f0` (-Infinity for waves left out): vowels and glides by
 * their formants up to 3.5 kHz; nasals and hisses by their overall shape to 8 kHz, hisses only
 * from the noisiest waves, so they sound like breath rather than a bright tone.
 */
function waveScores(sound: string, levels: (number[] | null)[], f0: number): number[] {
  const kind = kindOf(sound)!
  const top = Math.min(HARMONICS, Math.floor((kind === 'vowel' || kind === 'glide' ? 3500 : 8000) / f0))
  const count = Math.max(top, 4)
  let target: number[]
  if (kind === 'nasal') {
    target = Array.from({ length: count }, (_, k) => -NASALS[sound] * Math.log2(Math.max((k + 1) * f0, 250) / 250))
  } else if (kind === 'hiss') {
    const shape = HISSES[HISS_OF[sound]]
    target = Array.from({ length: count }, (_, k) => shape((k + 1) * f0))
  } else {
    target = formantLevels(FORMANTS[sound], f0, count)
  }
  const peak = Math.max(...target)
  target = target.map((v) => Math.max(v - peak, -40))
  const pool = new Set(kind === 'hiss' ? [...WAVE_FEATURES.keys()].sort((a, b) => WAVE_FEATURES[b].jagged - WAVE_FEATURES[a].jagged).slice(0, 40) : WAVE_FEATURES.keys())
  return levels.map((l, w) =>
    l && pool.has(w) ? similarity(target, l.slice(0, count).map((v) => Math.max(v, -40)), kind === 'vowel' || kind === 'glide') : -Infinity,
  )
}

/** The one wave that best plays all of `sounds` at `f0`: the highest mean of their waveScores. */
export function waveForAll(sounds: string[], levels: (number[] | null)[], f0: number): number {
  const scores = sounds.map((s) => waveScores(s, levels, f0))
  const mean = levels.map((_, w) => scores.reduce((sum, sc) => sum + sc[w], 0) / scores.length)
  return mean.indexOf(Math.max(...mean))
}

export interface Speech {
  /** Eight waves for slots 1-8; SILENCE for a gap (never slot 1). */
  waves: number[]
  /** What each slot says: a sound code, or '' for a gap. */
  sounds: string[]
  /** Sounds left out to fit the eight slots. */
  dropped: number
}

const LIST = 8
const PRIORITY: Record<Kind | 'gap', number> = { vowel: 3, glide: 2, nasal: 2, hiss: 2, stop: 1, gap: 0 }

/**
 * Eight slots that say `text` when WaveScan sweeps through them, tuned for notes around `f0` Hz.
 * `levels`: harmonicLevels per wave. Null if the text has nothing to say.
 */
export function speakWavelist(text: string, levels: (number[] | null)[], f0 = 130.81, dictionary?: Pronunciations | null): Speech | null {
  // The voiced sounds in order; stops and word gaps both become Silence.
  let units: { sound: string; priority: number }[] = []
  for (const s of spellSounds(text, dictionary)) {
    if (s === '') units.push({ sound: '', priority: PRIORITY.gap })
    else if (s in DIPHTHONGS) DIPHTHONGS[s].forEach((v, n) => units.push({ sound: v, priority: n ? 2.5 : 3 }))
    else {
      const kind = kindOf(s)
      if (kind) units.push({ sound: kind === 'stop' ? '' : s, priority: PRIORITY[kind] })
    }
  }
  const waves = new Map<string, number>()
  const waveOf = (sound: string) => {
    if (sound === '') return SILENCE
    if (!waves.has(sound)) waves.set(sound, waveFor(sound, levels, f0))
    return waves.get(sound)!
  }
  // Slot 1 can't be Silence and a gap at the end says nothing; a sound followed by one that
  // plays the same wave just holds it.
  const tidy = () => {
    const out: typeof units = []
    for (const u of units) {
      const last = out.at(-1)
      if (!last && u.sound === '') continue
      if (last && waveOf(last.sound) === waveOf(u.sound)) last.priority = Math.max(last.priority, u.priority)
      else out.push({ ...u })
    }
    while (out.at(-1)?.sound === '') out.pop()
    units = out
  }
  tidy()
  if (!units.length) return null
  // Too many: leave out the least important sounds, the last of equals first.
  let dropped = 0
  while (units.length > LIST) {
    const least = Math.min(...units.map((u) => u.priority))
    const at = units.map((u) => u.priority).lastIndexOf(least)
    units.splice(at, 1)
    dropped++
    tidy()
  }
  // Too few: vowels hold longer, each in turn, first to last.
  const holds = units.map(() => 0)
  while (units.length < LIST) {
    const candidates = units.map((u, i) => i).filter((i) => units[i].sound !== '' && units[i].priority >= 2.5)
    const pool = candidates.length ? candidates : units.map((_, i) => i).filter((i) => units[i].sound !== '')
    const i = pool.reduce((a, b) => (holds[b] < holds[a] ? b : a))
    holds[i]++
    units.splice(i + 1, 0, { ...units[i] })
    holds.splice(i + 1, 0, holds[i])
  }
  return { waves: units.map((u) => waveOf(u.sound)), sounds: units.map((u) => u.sound), dropped }
}
