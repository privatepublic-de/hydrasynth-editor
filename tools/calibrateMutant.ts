// Measures on the synth how its Mutants' FM-Linear mode sounds, for src/ui/fmModel.ts: per
// experiment, a patch from Init into H128's working memory (no flash write), one held note at C3,
// recorded from the default audio input (the synth on inputs 1/2 of an X18) with sox.
//   routing    a Sine on OSC 1 (then OSC 2 alone), each Mutant in turn at FM-Linear, Sine source,
//              ratio 2, depth 64, wet 100 %: which Mutant changes which oscillator
//   fm         a Sine on OSC 1 through Mutant 1 (Sine source, wet 100 %) at ratios 1, 2, 3 and
//              depths 64..1024: the harmonics, and the modulation index (and modulator phase) that fits them best
//   feedback   the same at ratio 1, depth 256, Feedback 0..150 %
// Usage: npx vite-node tools/calibrateMutant.ts <experiment>
import { harmonicsAt } from '../src/audio/spectrum'
import { formatValue } from '../src/params/display'
import { initPatchBytes } from '../src/params/initPatch'
import { Patch, param } from '../src/params/patch'
import { openSynth } from './synthTake'
import { RATE } from './waveAudio'

const FILE = 'local/wave-recordings/calibrate-mutant.wav'
const NOTE = 48
const F0 = 440 * 2 ** ((NOTE - 69) / 12)
const COUNT = 48
const show = (key: string, v: number) => formatValue(param(key), v)
const RATIO_RAW: Record<number, number> = { 0.5: 192, 1: 512, 2: 576, 3: 640, 4: 704 }

/** Init with Sines on the oscillators (OSC `osc` alone in the mixer) and every Mutant dry. */
function sinePatch(osc = 1): Patch {
  const p = new Patch(initPatchBytes())
  for (const o of [1, 2, 3]) {
    p.set(`osc${o}type`, 0)
    p.set(`mixerosc${o}vol`, o === osc ? 1024 : 0)
  }
  for (const m of [1, 2, 3, 4]) p.set(`mutant${m}wet`, 0)
  p.set('voicevibratoamount', 0)
  return p
}

function fmMutant(p: Patch, m: number, ratioRaw: number, depth: number, feedback = 0) {
  p.set(`mutant${m}mode`, 0) // FM-Linear
  p.set(`mutant${m}sourcefmlin`, 0) // Sine
  p.set(`mutant${m}ratio`, ratioRaw)
  p.set(`mutant${m}depth`, depth)
  p.set(`mutant${m}feedback`, feedback)
  p.set(`mutant${m}wet`, 1024)
}

/** dB per harmonic from 0.3 s to 0.9 s, loudest 0. */
function levelsOf(x: Float64Array): number[] {
  return harmonicsAt(Float32Array.from(x), RATE, F0, 0.3 * RATE, 0.9 * RATE, COUNT).levels
}

const fmt = (l: number[], n = 12) => l.slice(0, n).map((v) => Math.max(-60, v).toFixed(0)).join(' ')

/**
 * One cycle of a Sine carrier phase-modulated by a Sine at `ratio` times it with index `index`
 * (radians), its modulator fed back on itself by `feedback`: harmonic levels in dB, loudest 0.
 */
export function fmCycleLevels(ratio: number, index: number, feedback: number, count: number, carrierAtRatio = false, phase = 0): number[] {
  const n = 2048
  const x = new Float64Array(n)
  // Two passes so feedback settles; the second is kept.
  let prev = 0
  for (let pass = 0; pass < 2; pass++)
    for (let i = 0; i < n; i++) {
      const ph = (2 * Math.PI * i) / n
      const mod = Math.sin((carrierAtRatio ? 1 : ratio) * ph + phase + feedback * prev)
      prev = mod
      x[i] = Math.sin((carrierAtRatio ? ratio : 1) * ph + index * mod)
    }
  const amps: number[] = []
  for (let k = 1; k <= count; k++) {
    let re = 0
    let im = 0
    for (let i = 0; i < n; i++) {
      re += x[i] * Math.cos((2 * Math.PI * k * i) / n)
      im -= x[i] * Math.sin((2 * Math.PI * k * i) / n)
    }
    amps.push(Math.hypot(re, im))
  }
  const peak = Math.max(...amps) || 1
  return amps.map((a) => 20 * Math.log10(a / peak + 1e-5))
}

/** RMS dB difference over the first `n` harmonics, both floored at -50 dB. */
function rms(a: number[], b: number[], n = 24): number {
  let s = 0
  for (let k = 0; k < n; k++) s += (Math.max(a[k], -50) - Math.max(b[k], -50)) ** 2
  return Math.sqrt(s / n)
}

/** The index (radians) and modulator phase whose model levels are closest to `measured`. */
function fitIndex(measured: number[], ratio: number, feedback: number, carrierAtRatio = false, phases = [0]) {
  let best = { index: 0, phase: 0, err: Infinity }
  for (const phase of phases)
    for (let index = 0; index <= 12; index += 0.05) {
      const err = rms(measured, fmCycleLevels(ratio, index, feedback, COUNT, carrierAtRatio, phase))
      if (err < best.err) best = { index, phase, err }
    }
  return best
}
const PHASES = Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4)

async function main() {
  const experiment = process.argv[2]
  const synth = await openSynth(FILE)
  try {
    if (experiment === 'routing') {
      for (const osc of [1, 2]) {
        console.log(`OSC ${osc} alone, dry: ${fmt(levelsOf(await synth.take(sinePatch(osc), NOTE, 1)))}`)
        for (const m of [1, 2, 3, 4]) {
          const p = sinePatch(osc)
          fmMutant(p, m, RATIO_RAW[2], 512)
          console.log(`OSC ${osc} alone, Mutant ${m} FM: ${fmt(levelsOf(await synth.take(p, NOTE, 1)))}`)
        }
      }
    } else if (experiment === 'fm') {
      for (const ratio of [1, 2, 3])
        for (const depth of [64, 128, 256, 384, 512, 768, 1024]) {
          const p = sinePatch()
          fmMutant(p, 1, RATIO_RAW[ratio], depth)
          const l = levelsOf(await synth.take(p, NOTE, 1))
          const mod = fitIndex(l, ratio, 0)
          const phased = fitIndex(l, ratio, 0, false, PHASES)
          console.log(
            `ratio ${show('mutant1ratio', RATIO_RAW[ratio])} depth ${show('mutant1depth', depth)}: ${fmt(l)} | I ${mod.index.toFixed(2)} (${mod.err.toFixed(1)} dB) | with phase ${((phased.phase * 4) / Math.PI).toFixed(0)}/4 pi: I ${phased.index.toFixed(2)} (${phased.err.toFixed(1)} dB)`,
          )
        }
    } else if (experiment === 'feedback') {
      for (const feedback of [0, 64, 128, 256, 384, 512, 768, 1024]) {
        const p = sinePatch()
        fmMutant(p, 1, RATIO_RAW[1], 256, feedback)
        const l = levelsOf(await synth.take(p, NOTE, 1))
        let best = { index: 0, fb: 0, err: Infinity }
        for (let fb = 0; fb <= 3; fb += 0.1) {
          const f = fitIndex(l, 1, fb, false, [1.5 * Math.PI])
          if (f.err < best.err) best = { index: f.index, fb, err: f.err }
        }
        console.log(`feedback ${show('mutant1feedback', feedback)}: ${fmt(l)} | I ${best.index.toFixed(2)}, feedback ${best.fb.toFixed(1)} (${best.err.toFixed(1)} dB)`)
      }
    } else {
      console.log('Usage: npx vite-node tools/calibrateMutant.ts routing|fm|feedback')
    }
  } finally {
    synth.close()
  }
}

void main()
