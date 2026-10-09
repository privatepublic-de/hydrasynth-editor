// Measures on the synth what src/ui/speechPatch.ts relies on (its CALIBRATION): per experiment,
// a patch from Init into H128's working memory (no flash write), one held note, NRPN changes at
// set times, recorded from the default audio input (the synth on inputs 1/2 of an X18) with sox.
//   vowel [control]  Saw through the Vowel filter, Cutoff swept 0..1024: formant peaks per value (env ORDER: Vowel Order)
//   step             a Step LFO on Filter 1 Cutoff: when each step starts, and where it lands
//   level            Step LFO on Osc 1 Vol and Noise Vol from 0, against static volumes
//   noise            noise through Filter 2 alone (BP), Cutoff swept: band centre per value
//   pitch            Step LFO on Osc 1 Pitch at depth 128: semitones per step unit
//   envpitch         ENV 3 (decaying from full) on Osc 1 Pitch at depth 32: semitones at full envelope
//   control          Saw through the Vowel filter at Cutoffs 0..192 (A to between A and E) and Formant
//                    Controls 384..896: formant peaks per pair, to find the a of cat (F1 ~680, F2 ~1800)
//   controlroute     a Step LFO on Filt 1 Control (depth 128) at A: steps 0, 16, 32, 64, one second each
//   macrorate        Macro 1 on LFO 1 Rate (depth 32) at knob 0, 64 and 128: how fast a step LFO
//                    then runs (a Sine stepped up and down in pitch), from steps per second
//   macrodepth       Macro 1 on a route's depth (Matrix 1 Depth, macro depth 64): a full-level Step
//                    LFO into Osc 1 Vol at route depth 0, knob 0, 64 and 128, against static volumes
//   morphs           the Vowel filter's sound between every pair of its vowels (four orders cover
//                    all ten pairs), Cutoff in steps of 32: src/ui/vowelMorphs.generated.ts
//   positions        Saw through the Vowel filter, Cutoff in steps of 32: the best Cutoff per vowel
//   scan             six waves in the WaveScan list, a Step LFO on Osc 1 WaveScan to slot 0..5: which wave sounds
//   speak <words> [waves]  the speech patch (src/ui/speechPatch.ts) at C3, saved to local/speech-samples
//   sources          each vowel at C2/C3/C4 from a Saw or from its matched wave (src/ui/waveSpeech.ts),
//                    through the Vowel filter or not: how often it reads as the right vowel
// The patches carry the ETCD marker, without which the synth ignores LFO steps 9-64.
// Usage: npx vite-node tools/calibrateSpeech.ts <experiment> [args]
import { formatValue } from '../src/params/display'
import { initPatchBytes } from '../src/params/initPatch'
import { Patch, param } from '../src/params/patch'
import { buildSpeechPatch, CALIBRATION, VOWEL_POS } from '../src/ui/speechPatch'
import { FORMANTS, formantLevels, harmonicLevels, parsePronunciations, similarity, waveFor } from '../src/ui/waveSpeech'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { melShape, shapeLike } from './speechScore'
import { openSynth } from './synthTake'
import { RATE } from './waveAudio'

const FILE = 'local/wave-recordings/calibrate-speech.wav'
const C2 = 65.406

function initPatch(): Patch {
  const p = new Patch(initPatchBytes())
  const { offset, text } = CALIBRATION.extendedMarker
  for (let i = 0; i < text.length; i++) p.bytes[offset + i] = text.charCodeAt(i)
  return p
}

/** A Step LFO 1 routed to `target` (mod matrix slot 1) at `depth` (raw). */
function stepLfo(p: Patch, steps: number[], target: number, depth: number, rateRaw = 449 /* 1.00 Hz */) {
  p.set('lfo1wave', 10)
  p.set('lfo1steps', steps.length)
  steps.forEach((v, i) => p.set(`lfo1step${i + 1}`, 512 + v * 8))
  p.set('lfo1ratesyncoff', rateRaw)
  p.set('lfo1oneshot', 1)
  p.set('modmatrix1modsource', 6)
  p.set('modmatrix1modtarget', target)
  p.set('modmatrix1depth', depth)
}

const { take, close } = await openSynth(FILE)

/** Magnitude spectrum (dB) of x[from, from + n) with a Hann window; bin k is k * RATE / n Hz. */
function spectrum(x: Float64Array, from: number, n = 8192): number[] {
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i++) re[i] = (x[from + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n))
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len
    for (let i = 0; i < n; i += len)
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
  return Array.from({ length: n / 2 }, (_, k) => 20 * Math.log10(Math.hypot(re[k], im[k]) + 1e-9))
}

/** The Saw's harmonics of C2 with its -6 dB/octave taken out: formants stand out as peaks. */
function formants(x: Float64Array, from: number, n = 8192): string {
  const spec = spectrum(x, from, n)
  const h = Array.from({ length: 60 }, (_, k) => {
    const b = Math.round(((k + 1) * C2 * n) / RATE)
    return Math.max(spec[b - 1], spec[b], spec[b + 1]) + 20 * Math.log10(k + 1)
  })
  const s = h.map((v, i) => (h[i - 1] ?? v) * 0.25 + v * 0.5 + (h[i + 1] ?? v) * 0.25)
  const top = Math.max(...s)
  const peaks: [number, number][] = []
  for (let i = 1; i < s.length - 1; i++) if (s[i] >= s[i - 1] && s[i] > s[i + 1] && s[i] > top - 30) peaks.push([(i + 1) * C2, s[i] - top])
  return peaks
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .sort((a, b) => a[0] - b[0])
    .map(([f, d]) => `${Math.round(f)}(${d.toFixed(0)})`)
    .join(' ')
}

const rmsDb = (x: Float64Array, from: number, to: number) => {
  let s = 0
  for (let i = from; i < to; i++) s += x[i] * x[i]
  return 20 * Math.log10(Math.sqrt(s / (to - from)) + 1e-9)
}

/** Frequency of a sine in x[from, from + n): rising zero crossings, interpolated, first to last. */
function frequency(x: Float64Array, from: number, n = 19200): number {
  const ups: number[] = []
  for (let i = from; i < from + n; i++) if (x[i] <= 0 && x[i + 1] > 0) ups.push(i + x[i] / (x[i] - x[i + 1]))
  return (RATE * (ups.length - 1)) / (ups.at(-1)! - ups[0])
}

/** Third-octave bands 200 Hz..5 kHz. */
const BANDS = Array.from({ length: 14 }, (_, i) => 200 * 2 ** (i / 3))
/** Each band's level against the loudest, as a bar of characters (' ' -36 dB .. '@' 0 dB). */
function bandBar(x: Float64Array, from: number): string {
  const spec = spectrum(x, from, 4096)
  const lv = BANDS.map((f) => {
    const [a, b] = [Math.round((f * 4096) / RATE / 2 ** (1 / 6)), Math.round(((f * 4096) / RATE) * 2 ** (1 / 6))]
    let e = 0
    for (let j = a; j <= b; j++) e += 10 ** (spec[j] / 10)
    return 10 * Math.log10(e)
  })
  const top = Math.max(...lv)
  return '|' + lv.map((v) => ' .:-=+*#%@'[Math.max(0, Math.min(9, Math.round((v - top + 36) / 4)))]).join('') + '|'
}

const vowelFilter = (p: Patch, control: number) => {
  p.set('filter1type', 10)
  p.set('filter1keytrack', 512)
  p.set('filter1resonance', 512)
  p.set('filter1special', control)
}

try {
  const [experiment, arg] = process.argv.slice(2)
  if (experiment === 'vowel') {
    const p = initPatch()
    vowelFilter(p, Number(arg ?? 512))
    // ORDER: the Vowel Order (0 AEIOU .. 7 UIEAO).
    p.set('filter1vowelorder', Number(process.env.ORDER ?? 0))
    const values = Array.from({ length: 17 }, (_, i) => Math.min(1024, i * 64))
    const x = await take(p, 36, values.length * 0.6, values.map((v, i) => [i * 0.6, 'filter1cutoff', v]))
    values.forEach((v, i) => console.log(`cutoff ${String(v).padStart(4)}: ${formants(x, Math.round((i * 0.6 + 0.25) * RATE))}`))
  } else if (experiment === 'step') {
    // From E (256), depth +64: +64 -> O, +32 -> I, 0 -> E, -32 -> A; one second each, then held.
    const p = initPatch()
    vowelFilter(p, 512)
    p.set('filter1cutoff', 256)
    stepLfo(p, [64, 32, 0, -32], 88, 768)
    const x = await take(p, 36, 5.5)
    for (let t = 0.1; t < 5.4; t += 0.25) console.log(`${t.toFixed(2)} s: ${formants(x, Math.round(t * RATE), 4096)}`)
  } else if (experiment === 'level') {
    const steps = [0, 16, 32, 48, 64]
    for (const [target, key, label] of [
      [73, 'mixerosc1vol', 'Osc 1 Vol'],
      [77, 'mixernoisevol', 'Noise Vol'],
    ] as const) {
      const p = initPatch()
      p.set('mixerosc1vol', 0)
      p.set(key, 0)
      stepLfo(p, steps, target, 1024)
      const x = await take(p, 48, steps.length)
      console.log(label, steps.map((v, i) => `${v}: ${rmsDb(x, Math.round((i + 0.3) * RATE), Math.round((i + 0.8) * RATE)).toFixed(1)} dB`).join('  '))
    }
    for (const v of [1024, 512, 256]) {
      const p = initPatch()
      p.set('mixerosc1vol', v)
      const x = await take(p, 48, 1)
      console.log(`static Osc 1 Vol ${v / 8}: ${rmsDb(x, Math.round(0.3 * RATE), Math.round(0.8 * RATE)).toFixed(1)} dB`)
    }
  } else if (experiment === 'noise') {
    const p = initPatch()
    p.set('mixerosc1vol', 0)
    p.set('mixernoisevol', 1024)
    p.set('mixerfilterrouting', 1)
    p.set('mixernoisefilterratio', 1024)
    p.set('filter2morph', 512)
    p.set('filter2resonance', 512)
    const values = Array.from({ length: 9 }, (_, i) => Math.min(1024, i * 128))
    const x = await take(p, 48, values.length * 0.6, values.map((v, i) => [i * 0.6, 'filter2cutoff', v]))
    const N = 4096
    for (const [i, v] of values.entries()) {
      const from = Math.round((i * 0.6 + 0.15) * RATE)
      const power = new Array(N / 2).fill(0)
      for (let k = 0; k < 4; k++) spectrum(x, from + k * 2048, N).forEach((d, j) => (power[j] += 10 ** (d / 10)))
      // Smoothed over ~1/4 octave, then the loudest band.
      const db = power.map((e) => 10 * Math.log10(e))
      const smooth = db.map((_, j) => {
        const w = Math.max(1, Math.round(j * 0.12))
        const near = db.slice(Math.max(0, j - w), j + w + 1)
        return near.reduce((a, b) => a + b, 0) / near.length
      })
      const peak = smooth.indexOf(Math.max(...smooth.slice(4)))
      console.log(`cutoff ${String(v).padStart(4)}: band centre ${Math.round((peak * RATE) / N)} Hz`)
    }
  } else if (experiment === 'pitch') {
    // A Sine, LFO steps 0, +10, -10, +20 at depth +128.
    const p = initPatch()
    p.set('osc1type', 0)
    const steps = [0, 10, -10, 20]
    stepLfo(p, steps, 11, 1024)
    const x = await take(p, 48, steps.length)
    const base = frequency(x, Math.round(0.3 * RATE), 9600)
    steps.forEach((v, i) => {
      const f = frequency(x, Math.round((i + 0.3) * RATE), 9600)
      const semis = 12 * Math.log2(f / base)
      console.log(`step ${String(v).padStart(3)}: ${f.toFixed(2)} Hz, ${semis.toFixed(2)} semitones${v ? `, ${(v / semis).toFixed(2)} units per semitone` : ''}`)
    })
  } else if (experiment === 'envpitch') {
    const p = initPatch()
    p.set('osc1type', 0)
    p.set('env3bpmsync', 0)
    p.set('env3attacksyncoff', 0)
    p.set('env3holdsyncoff', 0)
    p.set('env3decaysyncoff', Number(arg ?? 704)) // 704: 2.30 s
    p.set('env3sustain', 0)
    p.set('modmatrix1modsource', 3) // Env 3
    p.set('modmatrix1modtarget', 11)
    p.set('modmatrix1depth', 512 + 32 * 4) // +32
    const x = await take(p, 48, 3)
    for (const t of [0.02, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.6]) {
      const f = frequency(x, Math.round(t * RATE), 2400)
      console.log(`${t.toFixed(2)} s: ${f.toFixed(2)} Hz, ${(12 * Math.log2(f / 130.81)).toFixed(2)} semitones`)
    }
  } else if (experiment === 'control') {
    const cutoffs = [0, 64, 128, 192]
    const controls = [384, 512, 640, 768, 896]
    const p = initPatch()
    vowelFilter(p, 512)
    p.set('filter1resonance', 576)
    const SEG = 0.4
    const grid = cutoffs.flatMap((c) => controls.map((k) => [c, k]))
    const x = await take(
      p,
      36,
      grid.length * SEG,
      grid.flatMap(([c, k], i) => [
        [i * SEG, 'filter1cutoff', c] as [number, string, number],
        [i * SEG, 'filter1special', k] as [number, string, number],
      ]),
    )
    grid.forEach(([c, k], i) => console.log(`cutoff ${String(c).padStart(4)} control ${String(k).padStart(4)} (${k / 8}): ${formants(x, Math.round((i * SEG + 0.15) * RATE))}`))
  } else if (experiment === 'controlroute') {
    const p = initPatch()
    vowelFilter(p, 512)
    p.set('filter1resonance', 576)
    p.set('filter1cutoff', 0)
    const steps = [0, 16, 32, 64]
    stepLfo(p, steps, 91, 1024)
    const x = await take(p, 36, steps.length)
    steps.forEach((v, i) => console.log(`step ${String(v).padStart(3)}: ${formants(x, Math.round((i + 0.3) * RATE))}`))
  } else if (experiment === 'macrorate') {
    for (const knob of [0, 512, 1024]) {
      const p = initPatch()
      p.set('osc1type', 0)
      p.set('lfo1wave', 10)
      p.set('lfo1steps', 2)
      p.set('lfo1step1', 512)
      p.set('lfo1step2', 512 + 20 * 8)
      p.set('lfo1ratesyncoff', 640) // 5.28 Hz
      p.set('lfo1oneshot', 0)
      p.set('modmatrix1modsource', 6)
      p.set('modmatrix1modtarget', 11)
      p.set('modmatrix1depth', 1024)
      p.set('macro1target1', 144) // LFO 1 Rate
      p.set('macro1depth1', 512 + 32 * 4)
      p.set('macro1panelvalue', knob)
      const x = await take(p, 72, 3)
      // Pitch every 5 ms; a step change is a jump of the frequency up or down.
      let changes = 0
      let last = frequency(x, Math.round(0.3 * RATE), 240)
      for (let t = 0.305; t < 2.8; t += 0.005) {
        const f = frequency(x, Math.round(t * RATE), 240)
        if (Math.abs(12 * Math.log2(f / last)) > 2) changes++
        last = f
      }
      console.log(`knob ${knob / 8}: ${(changes / 2.5).toFixed(2)} steps a second (unmodulated: 5.28)`)
    }
  } else if (experiment === 'macrodepth') {
    const level = (x: Float64Array) => {
      let e = 0
      const [a, b] = [Math.round(0.4 * RATE), Math.round(1.2 * RATE)]
      for (let i = a; i < b; i++) e += x[i] * x[i]
      return 20 * Math.log10(Math.sqrt(e / (b - a)) + 1e-9)
    }
    for (const knob of [0, 512, 1024]) {
      const p = initPatch()
      p.set('mixerosc1vol', 0)
      stepLfo(p, [64, 64], 73, 512) // full level into Osc 1 Vol, route at depth 0
      p.set('lfo1oneshot', 0)
      p.set('macro1target1', 154) // Matrix 1 Depth
      p.set('macro1depth1', 512 + 64 * 4)
      p.set('macro1panelvalue', knob)
      const x = await take(p, 48, 1.4)
      console.log(`knob ${knob / 8}: ${level(x).toFixed(1)} dB`)
    }
    for (const v of [1024, 512]) {
      const p = initPatch()
      p.set('mixerosc1vol', v)
      const x = await take(p, 48, 1.4)
      console.log(`static Osc 1 Vol ${v / 8}: ${level(x).toFixed(1)} dB`)
    }
  } else if (experiment === 'morphs') {
    // Each order puts the same five vowels at 0, 256, .. 1024 in its own sequence; between two
    // neighbours the filter morphs. AEIOU, AIUEO, AUIOE and AOUIE have all ten pairs between them.
    const ORDERS: [number, string][] = [
      [0, 'AEIOU'],
      [1, 'AIUEO'],
      [2, 'AUIOE'],
      [3, 'AOUIE'],
    ]
    const SEG = 0.4
    const pairs: Record<string, number[][]> = {}
    for (const [order, name] of ORDERS) {
      const p = initPatch()
      vowelFilter(p, 512)
      p.set('filter1resonance', 576)
      p.set('filter1vowelorder', order)
      const values = Array.from({ length: 33 }, (_, i) => Math.min(1024, i * 32))
      const x = await take(p, 36, values.length * SEG, values.map((v, i) => [i * SEG, 'filter1cutoff', v]))
      const shapes = values.map((_, i) => melShape(x, Math.round((i * SEG + 0.12) * RATE), Math.round((i * SEG + 0.36) * RATE)))
      for (let k = 0; k < 4; k++) {
        const [a, b] = [name[k], name[k + 1]]
        const run = shapes.slice(8 * k, 8 * k + 9)
        // Stored from the alphabetically first vowel to the other.
        const key = a < b ? a + b : b + a
        const ordered = a < b ? run : [...run].reverse()
        if (pairs[key]) console.log(`${key} measured twice: first and second agree ${ordered.map((sh, i) => shapeLike(sh, pairs[key][i]).toFixed(2)).join(' ')}`)
        else pairs[key] = ordered
      }
      console.log(`${name} done`)
    }
    const src = `// GENERATED by tools/calibrateSpeech.ts morphs -- do not edit.
// The synth's Vowel filter (Formant Control 64, Resonance 72, keytrack 0 %, a Saw at C2) between
// each pair of its five vowels, measured at 9 points from the alphabetically first vowel to the
// other (Cutoff steps of 32 in an order where they are neighbours): each point's log-mel spectrum
// (26 bands, 100 Hz..7 kHz, dB, tilt removed; tools/speechScore.ts melShape).
export const VOWEL_MORPHS: Record<string, number[][]> = {
${Object.keys(pairs)
  .sort()
  .map((k) => `  ${k}: [\n${pairs[k].map((sh) => `    [${sh.map((v) => v.toFixed(1)).join(', ')}],`).join('\n')}\n  ],`)
  .join('\n')}
}
`
    writeFileSync('src/ui/vowelMorphs.generated.ts', src)
    console.log(`${Object.keys(pairs).length} pairs written to src/ui/vowelMorphs.generated.ts`)
  } else if (experiment === 'positions') {
    const vowels = ['iy', 'ih', 'eh', 'ae', 'aa', 'ah', 'ao', 'ow', 'uh', 'uw', 'er', 'w', 'y', 'r', 'l']
    const values = Array.from({ length: 33 }, (_, i) => Math.min(1024, i * 32))
    const SEG = 0.35
    for (const [name, note, f0] of [['C2', 36, 65.41], ['C3', 48, 130.81], ['C4', 60, 261.63]] as const) {
      const count = Math.floor(3500 / f0)
      const p = initPatch()
      vowelFilter(p, 512)
      const x = await take(p, note, values.length * SEG, values.map((v, i) => [i * SEG, 'filter1cutoff', v]))
      const heard = values.map((_, i) => {
        const spec = spectrum(x, Math.round((i * SEG + 0.15) * RATE))
        const h = Array.from({ length: count }, (_, k) => {
          const b = Math.round(((k + 1) * f0 * 8192) / RATE)
          return Math.max(spec[b - 1], spec[b], spec[b + 1])
        })
        const top = Math.max(...h)
        return h.map((d) => Math.max(d - top, -40))
      })
      const line = vowels.map((v) => {
        const t = formantLevels(FORMANTS[v], f0, count)
        const tt = t.map((d) => Math.max(d - Math.max(...t), -40))
        const scores = heard.map((h) => similarity(tt, h, true))
        const best = scores.indexOf(Math.max(...scores))
        return `${v} ${values[best]} (${scores[best].toFixed(2)}, now ${VOWEL_POS[v]})`
      })
      console.log(name, line.join(' | '))
    }
  } else if (experiment === 'scan') {
    const levels = JSON.parse(readFileSync('public/wave-cycles.json', 'utf8')).waves.map((w: { cycle: string }) =>
      harmonicLevels(Float32Array.from(new Int16Array(new Uint8Array(Buffer.from(w.cycle, 'base64')).buffer), (v) => v / 32767)),
    )
    const list = [3, 0, 4, 98, 150, 57] // Saw, Sine, Square, Vokz 3, Micoten 5, Scorpio 2
    const p = initPatch()
    p.set('osc1mode', 1)
    p.set('osc1wavscan', 0)
    list.forEach((w, i) => p.set(`osc1wavscanwave${i + 1}`, i ? w + 2 : w))
    for (let n = list.length + 1; n <= 8; n++) p.set(`osc1wavscanwave${n}`, 0)
    stepLfo(p, list.map((_, i) => (i * 64) / 7), 13, 1024)
    const x = await take(p, 36, list.length)
    list.forEach((_, i) => {
      const spec = spectrum(x, Math.round((i + 0.3) * RATE))
      const h = Array.from({ length: 40 }, (_, k) => {
        const b = Math.round(((k + 1) * C2 * 8192) / RATE)
        return Math.max(spec[b - 1], spec[b], spec[b + 1])
      })
      const top = Math.max(...h)
      const heard = h.map((d) => Math.max(d - top, -50))
      const scores = list.map((w) => similarity(heard, levels[w].slice(0, 40).map((d: number) => Math.max(d, -50)), false))
      const best = scores.indexOf(Math.max(...scores))
      console.log(`slot ${i}: sounds like slot ${best} (${formatValue(param('osc1type'), list[best])}, ${scores[best].toFixed(2)}; own ${scores[i].toFixed(2)})`)
    })
  } else if (experiment === 'smooth') {
    // A Sine at C5, LFO 1 stepping pitch up 10 semitones at 1 s: how long the step takes per Smooth value.
    for (const smooth of (arg ?? '0,9,18,36,64').split(',').map(Number)) {
      const p = initPatch()
      p.set('osc1type', 0)
      // RATE_RAW/PER_SECOND: the LFO rate as raw value and steps per second (default 449, 1 Hz);
      // the pitch steps up at 1 s either way.
      const rateRaw = Number(process.env.RATE_RAW ?? 449)
      const perSecond = Number(process.env.PER_SECOND ?? 1)
      stepLfo(p, [...Array(perSecond).fill(0), ...Array(3 * perSecond).fill(50)], 11, 1024, rateRaw)
      p.set('lfo1smooth', smooth)
      const x = await take(p, 72, 2.2)
      const before = frequency(x, Math.round(0.5 * RATE), 4800)
      const after = frequency(x, Math.round(1.7 * RATE), 4800)
      // From 0.9 s on, every 5 ms: the share of the way (in semitones) the pitch has gone.
      const way: string[] = []
      let t90 = NaN
      for (let t = 0.9; t < 1.6; t += 0.005) {
        const f = frequency(x, Math.round(t * RATE), 480)
        const share = Math.log2(f / before) / Math.log2(after / before)
        if (Number.isNaN(t90) && share > 0.9) t90 = t
        if (Math.round(t * 1000) % 25 === 0) way.push(`${Math.round(share * 100)}`)
      }
      // When it starts: first time past 10 %.
      let t10 = NaN
      for (let t = 0.9; t < 1.6 && Number.isNaN(t10); t += 0.005) {
        const f = frequency(x, Math.round(t * RATE), 480)
        if (Math.log2(f / before) / Math.log2(after / before) > 0.1) t10 = t
      }
      console.log(`smooth ${String(smooth).padStart(3)}: 10->90 % in ${Math.round((t90 - t10) * 1000)} ms   (% every 25 ms from 0.9 s: ${way.join(' ')})`)
    }
  } else if (experiment === 'bands') {
    // Saw through the Vowel filter at C3, Cutoff held at each value given (default the I region): third-octave levels.
    const values = (arg ?? '320,384,448,512,576').split(',').map(Number)
    const p = initPatch()
    vowelFilter(p, 512)
    p.set('filter1resonance', 576)
    const x = await take(p, 48, values.length * 0.5, values.map((v, i) => [i * 0.5, 'filter1cutoff', v]))
    values.forEach((v, i) => console.log(`cutoff ${String(v).padStart(4)}: ${bandBar(x, Math.round((i * 0.5 + 0.2) * RATE))}`))
    console.log(`bands ${BANDS.map((f) => Math.round(f)).join(' ')}`)
  } else if (experiment === 'speak') {
    const withWaves = process.argv[4] === 'waves'
    const levels = withWaves
      ? JSON.parse(readFileSync('public/wave-cycles.json', 'utf8')).waves.map((w: { cycle: string }) =>
          harmonicLevels(Float32Array.from(new Int16Array(new Uint8Array(Buffer.from(w.cycle, 'base64')).buffer), (v) => v / 32767)),
        )
      : null
    const dictionary = parsePronunciations(readFileSync('public/pronunciations.txt', 'utf8'))
    // TUNING='{"vowelGlideMs":70}': overrides of the patch's tuning; SUFFIX: added to the file name.
    const tuning = process.env.TUNING ? JSON.parse(process.env.TUNING) : undefined
    const s = buildSpeechPatch(arg, { dictionary, tuning, ...(levels ? { waves: { levels, f0: 130.81 } } : {}) })!
    console.log(`${arg}: ${s.sounds.join(' ')}, ${s.ms} ms${withWaves ? `, waves ${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => formatValue(param(`osc1wavscanwave${n}`), s.patch.get(`osc1wavscanwave${n}`))).join(', ')}` : ''}`)
    const x = await take(s.patch, 48, s.ms / 1000 + 0.4)
    // What each 20 ms sounds like, against the planned Filter 1 Cutoff of that step.
    const steps = s.patch.get('lfo1steps')
    const stepMs = s.ms / (steps - 1)
    for (let t = 0; t < s.ms + 40; t += 20) {
      const n = Math.min(steps, Math.floor(t / stepMs) + 1)
      const plan = (k: number) => (s.patch.get(`lfo${k}step${n}`) - 512) / 8
      console.log(`${String(t).padStart(4)} ms ${bandBar(x, Math.round((t / 1000) * RATE))} cutoff ${512 + plan(1) * 8} voice ${plan(2) * 2} noise ${plan(3) * 2}`)
    }
    mkdirSync('local/speech-samples', { recursive: true })
    const out = `local/speech-samples/${arg.replace(/\W+/g, '-')}${withWaves ? '-waves' : '-saw'}${process.env.SUFFIX ?? ''}.wav`
    copyFileSync(FILE, out)
    console.log('saved', out)
  } else if (experiment === 'sources') {
    const levels = JSON.parse(readFileSync('public/wave-cycles.json', 'utf8')).waves.map((w: { cycle: string }) =>
      harmonicLevels(Float32Array.from(new Int16Array(new Uint8Array(Buffer.from(w.cycle, 'base64')).buffer), (v) => v / 32767)),
    )
    const vowels = ['iy', 'ih', 'eh', 'ae', 'aa', 'ah', 'ao', 'ow', 'uh', 'uw', 'er']
    // TUNED=1: the positions 'positions' found best for these targets (where they agree across notes).
    const TUNED: Record<string, number> = { iy: 448, ih: 256, eh: 160, ae: 128, aa: 0, ah: 0, ao: 768, ow: 768, uh: 736, uw: 768, er: 96 }
    const pos = (v: string) => (process.env.TUNED ? TUNED[v] : VOWEL_POS[v])
    const SEG = 0.5
    for (const [note, f0] of [[36, 65.41], [48, 130.81], [60, 261.63]] as const) {
      const count = Math.floor(3500 / f0)
      const target = (v: string) => formantLevels(FORMANTS[v], f0, count).map((d, _, all) => Math.max(d - Math.max(...all), -40))
      const conditions = [
        { label: 'Saw + Vowel filter', wave: () => 3, filter: true },
        { label: 'wave + Vowel filter', wave: (v: string) => waveFor(v, levels, f0), filter: true },
        { label: 'wave alone', wave: (v: string) => waveFor(v, levels, f0), filter: false },
      ]
      // One take per note: every vowel in every condition, half a second each.
      const changes: [number, string, number][] = []
      let at = 0
      for (const c of conditions)
        for (const v of vowels) {
          changes.push([at, 'osc1type', c.wave(v)], [at, 'filter1type', c.filter ? 10 : 0], [at, 'filter1cutoff', c.filter ? pos(v) : 1024])
          at += SEG
        }
      const p = initPatch()
      vowelFilter(p, 512)
      const x = await take(p, note, at, changes)
      let n = 0
      for (const c of conditions) {
        const heard: number[][] = []
        let right = 0
        const wrong: string[] = []
        for (const v of vowels) {
          const spec = spectrum(x, Math.round((n++ * SEG + 0.2) * RATE))
          const h = Array.from({ length: count }, (_, k) => {
            const b = Math.round(((k + 1) * f0 * 8192) / RATE)
            return Math.max(spec[b - 1], spec[b], spec[b + 1])
          })
          const top = Math.max(...h)
          heard.push(h.map((d) => Math.max(d - top, -40)))
          // Which vowel it is closest to, by the same measure the waves were picked by.
          const scores = vowels.map((u) => similarity(target(u), heard.at(-1)!, true))
          const best = vowels[scores.indexOf(Math.max(...scores))]
          if (best === v) right++
          else wrong.push(`${v}->${best}`)
        }
        // How far apart the vowels are: 1 - mean correlation between every pair.
        let sum = 0
        let pairs = 0
        for (let i = 0; i < heard.length; i++) for (let j = i + 1; j < heard.length; j++, pairs++) sum += similarity(heard[i], heard[j], true)
        console.log(`${['C2', 'C3', 'C4'][[36, 48, 60].indexOf(note)]} ${c.label.padEnd(20)} right ${right}/${vowels.length}, apart ${(1 - sum / pairs).toFixed(2)}  ${wrong.join(' ')}`)
      }
    }
  } else {
    console.log('Usage: npx vite-node tools/calibrateSpeech.ts vowel [control raw] | step | level | noise | pitch | sources')
  }
  console.log(`(LFO rate ${formatValue(param('lfo1ratesyncoff'), 449)} Hz per step in these runs)`)
} finally {
  close()
}
