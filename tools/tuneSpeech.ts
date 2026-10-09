// Tunes the speech patch (src/ui/speechPatch.ts TUNING) on the synth: each candidate is played for
// a few test phrases (tools/synthTake.ts, H128's working memory only), recorded, and scored
// against reference speech (tools/speechScore.ts); one setting at a time, the best value is kept
// (coordinate descent), for `passes` rounds. Every evaluation goes to local/tune/log.jsonl.
// Usage: npx vite-node tools/tuneSpeech.ts [passes] [saw|waves] [setting,setting,...]  (default: all settings)
import { appendFileSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { buildSpeechPatch, TUNING, type Tuning } from '../src/ui/speechPatch'
import { harmonicLevels, parsePronunciations } from '../src/ui/waveSpeech'
import { score } from './speechScore'
import { openSynth } from './synthTake'

const PHRASES = ['robot voice', 'hello world', 'make some noise', 'how are you', 'good morning']
const CANDIDATES: { [K in keyof Tuning]: number[] } = {
  stressedLength: [0.8, 0.9, 1.1, 1.25],
  unstressedLength: [0.8, 0.9, 1.1, 1.25],
  stopLength: [0.7, 0.85, 1.2, 1.4],
  hissLength: [0.7, 0.85, 1.2, 1.4],
  sonorantLength: [0.7, 0.85, 1.2, 1.4],
  gapMs: [0, 25, 80],
  hissDelayMs: [0, 20, 60],
  burst: [50, 70, 100, 120],
  voicedBurst: [20, 35, 60, 80],
  closureVoice: [20, 35, 60, 80],
  hissLevel: [0.6, 0.8, 1.15],
  breath: [30, 45, 70],
  rPosition: [640, 896, 1024],
  vowelGlideMs: [20, 40, 70, 110, 160],
  voiceGlideMs: [10, 22, 40, 70],
  pitchGlideMs: [30, 60, 120, 200],
  noiseGlideMs: [0, 10, 25],
  vibrato: [0, 4, 8, 15],
  vibratoRate: [70, 90, 105],
  drift: [0, 30, 60, 100],
  tempo: [1.2, 1.4, 1.6],
}
const DIR = 'local/tune'
const FILE = `${DIR}/take.wav`

const passes = Number(process.argv[2] ?? 1)
const withWaves = process.argv[3] !== 'saw'
const keys = (process.argv[4]?.split(',') ?? Object.keys(CANDIDATES)) as (keyof Tuning)[]
for (const k of keys) if (!(k in CANDIDATES)) throw new Error(`No setting ${k}`)
mkdirSync(DIR, { recursive: true })
const dictionary = parsePronunciations(readFileSync('public/pronunciations.txt', 'utf8'))
const levels = JSON.parse(readFileSync('public/wave-cycles.json', 'utf8')).waves.map((w: { cycle: string }) =>
  harmonicLevels(Float32Array.from(new Int16Array(new Uint8Array(Buffer.from(w.cycle, 'base64')).buffer), (v) => v / 32767)),
)
const { take, close } = await openSynth(FILE)

/** Mean cost over the phrases (and its parts), each recording kept as local/tune/<phrase>.wav. */
async function evaluate(tuning: Tuning, keep = false) {
  let cost = 0
  let distance = 0
  let stillness = 0
  for (const phrase of PHRASES) {
    const s = buildSpeechPatch(phrase, { dictionary, tuning, ...(withWaves ? { waves: { levels, f0: 130.81 } } : {}) })!
    await take(s.patch, 48, s.ms / 1000 + 0.4)
    const wav = `${DIR}/${phrase.replace(/\W+/g, '-')}${keep ? '-best' : ''}.wav`
    copyFileSync(FILE, wav)
    const sc = score(wav, phrase)
    cost += sc.cost / PHRASES.length
    distance += sc.distance / PHRASES.length
    stillness += sc.stillness / PHRASES.length
  }
  appendFileSync(`${DIR}/log.jsonl`, JSON.stringify({ tuning, cost, distance, stillness, waves: withWaves }) + '\n')
  return { cost, distance, stillness }
}

const show = (r: { cost: number; distance: number; stillness: number }) =>
  `cost ${r.cost.toFixed(3)} (distance ${r.distance.toFixed(3)}, stillness ${(r.stillness * 100).toFixed(0)} %)`

try {
  let best: Tuning = { ...TUNING }
  // Twice at the start: how much the same tuning varies between takes.
  const first = await evaluate(best)
  const again = await evaluate(best)
  let bestCost = (first.cost + again.cost) / 2
  console.log(`start ${show(first)}; again ${show(again)}`)
  for (let pass = 1; pass <= passes; pass++) {
    for (const key of keys) {
      for (const value of CANDIDATES[key]) {
        if (value === best[key]) continue
        const tuning = { ...best, [key]: value }
        const r = await evaluate(tuning)
        // Better by more than two takes of the same tuning differ (~0.01): not just luck.
        const better = r.cost < bestCost - 0.01
        console.log(`pass ${pass} ${key} = ${value}: ${show(r)}${better ? '  <- best' : ''}`)
        if (better) {
          best = tuning
          bestCost = r.cost
        }
      }
    }
  }
  console.log('\nbest tuning', JSON.stringify(best), `cost ${bestCost.toFixed(3)}`)
  console.log('final', show(await evaluate(best, true)))
} finally {
  close()
}
