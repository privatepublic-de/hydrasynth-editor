// Scores a recording of the speech patch against reference speech of the same words (eSpeak NG
// and two macOS voices, made once into local/speech-refs/), for tuning the patch automatically:
//   distance   how far apart the two sound, sound by sound: MFCCs (as speech recognisers hear
//              speech, each recording normalised to its own mean and spread, so pitch, level
//              and voice matter less), aligned in time by dynamic time warping, mean cost per step
//   stillness  the share of 10 ms frames whose MFCCs barely change from the one before: real
//              speech is always moving (1-3 %), a voice that holds each sound and then jumps
//              sounds choppy (the speech patch's step curves: 40-56 % before tuning)
// Usage: npx vite-node tools/speechScore.ts score <recording.wav> <words>
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { RATE, readWav } from './waveAudio'

const REFS = 'local/speech-refs'
const VOICES = ['espeak', 'Fred', 'Eddy (English (US))']

/** Reference recordings of `words`, one per voice, as 48 kHz 24-bit WAVs. */
export function references(words: string): string[] {
  mkdirSync(REFS, { recursive: true })
  return VOICES.map((voice) => {
    const base = `${REFS}/${words.replace(/\W+/g, '-')}-${voice.replace(/\W+/g, '')}`
    const wav = `${base}.wav`
    if (!existsSync(wav)) {
      const raw = `${base}.raw.${voice === 'espeak' ? 'wav' : 'aiff'}`
      if (voice === 'espeak') execFileSync('espeak-ng', ['-v', 'en-us', '-w', raw, words])
      else execFileSync('say', ['-v', voice, '-o', raw, words])
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', raw, '-ar', String(RATE), '-ac', '1', '-c:a', 'pcm_s24le', wav])
    }
    return wav
  })
}

const FRAME = Math.round(0.025 * RATE)
const HOP = Math.round(0.01 * RATE)
const N = 2048
const MELS = 26
const CEPS = 12

/** Mel filterbank weights, 100 Hz..7 kHz. */
const FILTERS: number[][] = (() => {
  const mel = (f: number) => 2595 * Math.log10(1 + f / 700)
  const hz = (m: number) => 700 * (10 ** (m / 2595) - 1)
  const edges = Array.from({ length: MELS + 2 }, (_, i) => hz(mel(100) + ((mel(7000) - mel(100)) * i) / (MELS + 1)))
  return Array.from({ length: MELS }, (_, m) =>
    Array.from({ length: N / 2 }, (_, k) => {
      const f = (k * RATE) / N
      const [a, b, c] = [edges[m], edges[m + 1], edges[m + 2]]
      return f > a && f < c ? (f <= b ? (f - a) / (b - a) : (c - f) / (c - b)) : 0
    }),
  )
})()

function power(x: Float64Array, from: number): Float64Array {
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  for (let i = 0; i < FRAME; i++) re[i] = (x[from + i] ?? 0) * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME - 1)))
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const a = (-2 * Math.PI) / len
    for (let i = 0; i < N; i += len)
      for (let k = 0; k < len / 2; k++) {
        const [wr, wi] = [Math.cos(a * k), Math.sin(a * k)]
        const [u, v] = [i + k, i + k + len / 2]
        const xr = re[v] * wr - im[v] * wi
        const xi = re[v] * wi + im[v] * wr
        re[v] = re[u] - xr
        im[v] = im[u] - xi
        re[u] += xr
        im[u] += xi
      }
  }
  const out = new Float64Array(N / 2)
  for (let k = 0; k < N / 2; k++) out[k] = re[k] * re[k] + im[k] * im[k]
  return out
}

interface Frames {
  /** Per 10 ms frame while sounding: the MFCCs (normalised over the recording) and the level in dB. */
  mfcc: number[][]
  level: number[]
}

/** The sounding part of a recording (frames within 45 dB of its loudest), as frames. */
export function frames(file: string): Frames {
  const x = readWav(file)
  const all: { mfcc: number[]; level: number }[] = []
  for (let from = 0; from + FRAME < x.length; from += HOP) {
    const p = power(x, from)
    const energy = p.reduce((a, b) => a + b, 0)
    const logMel = FILTERS.map((w) => Math.log(w.reduce((s, wk, k) => s + wk * p[k], 0) + 1e-10))
    const mfcc = Array.from({ length: CEPS }, (_, c) => logMel.reduce((s, v, m) => s + v * Math.cos((Math.PI * (c + 1) * (m + 0.5)) / MELS), 0))
    all.push({ mfcc, level: 10 * Math.log10(energy + 1e-12) })
  }
  const top = Math.max(...all.map((f) => f.level))
  const first = all.findIndex((f) => f.level > top - 45)
  const last = all.length - 1 - [...all].reverse().findIndex((f) => f.level > top - 45)
  const sounding = all.slice(first, last + 1)
  // Each coefficient to zero mean and unit spread over the recording.
  const mfcc = sounding.map((f) => f.mfcc)
  for (let c = 0; c < CEPS; c++) {
    const values = mfcc.map((m) => m[c])
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) || 1
    for (const m of mfcc) m[c] = (m[c] - mean) / sd
  }
  return { mfcc, level: sounding.map((f) => f.level) }
}

/** Mean cost per step of the cheapest time alignment of a onto b. */
function dtw(a: number[][], b: number[][]): number {
  const cost = (i: number, j: number) => Math.sqrt(a[i].reduce((s, v, c) => s + (v - b[j][c]) ** 2, 0))
  const [n, m] = [a.length, b.length]
  let prev = new Float64Array(m + 1).fill(Infinity)
  let prevLen = new Float64Array(m + 1)
  prev[0] = 0
  for (let i = 1; i <= n; i++) {
    const cur = new Float64Array(m + 1).fill(Infinity)
    const curLen = new Float64Array(m + 1)
    for (let j = 1; j <= m; j++) {
      const options: [number, number][] = [
        [prev[j - 1], prevLen[j - 1]],
        [prev[j], prevLen[j]],
        [cur[j - 1], curLen[j - 1]],
      ]
      const [best, len] = options.reduce((x, y) => (y[0] < x[0] ? y : x))
      cur[j] = best + cost(i - 1, j - 1)
      curLen[j] = len + 1
    }
    prev = cur
    prevLen = curLen
  }
  return prev[m] / prevLen[m]
}

/** Share of frames whose MFCCs moved less than 0.3 (normalised units) from the frame before. */
function stillness(mfcc: number[][]): number {
  let still = 0
  for (let i = 1; i < mfcc.length; i++) if (Math.sqrt(mfcc[i].reduce((s, v, c) => s + (v - mfcc[i - 1][c]) ** 2, 0)) < 0.3) still++
  return still / Math.max(1, mfcc.length - 1)
}

export interface Score {
  distance: number
  stillness: number
  /** What tools/tuneSpeech.ts minimises: distance plus stillness weighted to matter about as much. */
  cost: number
  perVoice: { voice: string; distance: number }[]
}

export function score(recording: string, words: string): Score {
  const ours = frames(recording)
  const refs = references(words).map(frames)
  const perVoice = refs.map((r, i) => ({ voice: VOICES[i], distance: dtw(ours.mfcc, r.mfcc) }))
  const distance = perVoice.reduce((a, v) => a + v.distance, 0) / perVoice.length
  const still = stillness(ours.mfcc)
  return { distance, stillness: still, cost: distance + 2 * still, perVoice }
}

// Run directly (vite-node passes only the arguments).
if (process.argv[2] === 'score') {
  const [file, ...words] = process.argv.slice(3)
  const s = score(file, words.join(' '))
  console.log(
    `cost ${s.cost.toFixed(2)}: distance ${s.distance.toFixed(2)} (${s.perVoice.map((v) => `${v.voice} ${v.distance.toFixed(2)}`).join(', ')}), stillness ${(s.stillness * 100).toFixed(0)} %`,
  )
}

/**
 * The colour of a word's vowel: the mean log-mel spectrum (dB) over its steady middle (frames
 * within 6 dB of the loudest, around it), with the overall tilt taken out. Not normalised per
 * recording: in a one-vowel word that would take out the vowel itself.
 */
export function vowelColour(file: string): number[] {
  const x = readWav(file)
  const rows: { level: number; mel: number[] }[] = []
  for (let from = 0; from + FRAME < x.length; from += HOP) {
    const p = power(x, from)
    rows.push({ level: 10 * Math.log10(p.reduce((a, b) => a + b, 0) + 1e-12), mel: FILTERS.map((w) => 10 * Math.log10(w.reduce((s, wk, k) => s + wk * p[k], 0) + 1e-12)) })
  }
  const peak = rows.reduce((b, r, i) => (r.level > rows[b].level ? i : b), 0)
  let [from, to] = [peak, peak]
  while (from > 0 && rows[from - 1].level > rows[peak].level - 6) from--
  while (to < rows.length - 1 && rows[to + 1].level > rows[peak].level - 6) to++
  const mean = FILTERS.map((_, m) => rows.slice(from, to + 1).reduce((s, r) => s + r.mel[m], 0) / (to - from + 1))
  // Take out a straight-line tilt over the bands.
  const n = mean.length
  const mx = (n - 1) / 2
  const my = mean.reduce((a, b) => a + b, 0) / n
  const slope = mean.reduce((s, v, i) => s + (i - mx) * (v - my), 0) / mean.reduce((s, _, i) => s + (i - mx) ** 2, 0)
  return mean.map((v, i) => v - my - slope * (i - mx))
}

/** How unlike the references' vowel `recording`'s is: 1 - the mean correlation of their colours (0 = same). */
export function vowelScore(recording: string, words: string): number {
  const ours = vowelColour(recording)
  const corr = (a: number[], b: number[]) => {
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
  const refs = references(words).map(vowelColour)
  return 1 - refs.reduce((s, r) => s + corr(ours, r), 0) / refs.length
}
