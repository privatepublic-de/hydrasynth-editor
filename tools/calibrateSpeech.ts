// Measures on the synth what src/ui/speechPatch.ts relies on (its CALIBRATION): per experiment,
// a patch from Init into H128's working memory (no flash write), one held note, NRPN changes at
// set times, recorded from the default audio input (the synth on inputs 1/2 of an X18) with sox.
//   vowel [control]  Saw through the Vowel filter, Cutoff swept 0..1024: formant peaks per value
//   step             a Step LFO on Filter 1 Cutoff: when each step starts, and where it lands
//   level            Step LFO on Osc 1 Vol and Noise Vol from 0, against static volumes
//   noise            noise through Filter 2 alone (BP), Cutoff swept: band centre per value
//   pitch            Step LFO on Osc 1 Pitch at depth 128: semitones per step unit
// The patches carry the ETCD marker, without which the synth ignores LFO steps 9-64.
// Usage: npx vite-node tools/calibrateSpeech.ts <experiment> [args]
import { spawn } from 'node:child_process'
import { noteOff, noteOn, sleep } from '../src/midi/channel'
import { formatValue } from '../src/params/display'
import { initPatchBytes } from '../src/params/initPatch'
import { encodeNrpn, nrpnBytes } from '../src/params/nrpn'
import { Patch, param } from '../src/params/patch'
import { HydrasynthSession } from '../src/sysex/session'
import { CALIBRATION } from '../src/ui/speechPatch'
import { connectHelper } from './coremidiTransport'
import { RATE, readWav } from './waveAudio'

const CHANNEL = 1
const FILE = 'local/wave-recordings/calibrate-speech.wav'
const C2 = 65.406

function record(seconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const input = ['-t', 'coreaudio', '-c', '18', '-r', String(RATE), 'default']
    const rec = spawn('sox', ['-q', ...input, '-c', '2', '-b', '24', FILE, 'remix', '1', '2', 'trim', '0', String(seconds)], { stdio: 'inherit' })
    rec.on('error', reject)
    rec.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`sox exited with ${code}`))))
  })
}

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

const transport = await connectHelper()
const session = new HydrasynthSession(transport, { timeoutMs: 3000 })
const nrpn = (key: string, value: number) => session.sendRaw(nrpnBytes(CHANNEL, encodeNrpn(param(key), value)!))

/** Plays `patch` with `note` held `holdS`, sending `changes` [s after note-on, key, value]; the recording from note-on. */
async function take(patch: Patch, note: number, holdS: number, changes: [number, string, number][] = []): Promise<Float64Array> {
  await session.uploadToRam(7, 127, patch.bytes)
  await session.reloadSlot(CHANNEL, 7, 127)
  await sleep(200)
  const done = record(holdS + 0.9)
  await sleep(300)
  const t0 = Date.now()
  session.sendRaw(noteOn(CHANNEL, note, 100))
  for (const [at, key, value] of [...changes].sort((a, b) => a[0] - b[0])) {
    await sleep(Math.max(0, at * 1000 - (Date.now() - t0)))
    nrpn(key, value)
  }
  await sleep(Math.max(0, holdS * 1000 - (Date.now() - t0)))
  session.sendRaw(noteOff(CHANNEL, note))
  await done
  const x = readWav(FILE)
  let on = 0
  while (on < x.length && Math.abs(x[on]) < 0.01) on++
  return x.subarray(on)
}

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
  } else {
    console.log('Usage: npx vite-node tools/calibrateSpeech.ts vowel [control raw] | step | level | noise | pitch')
  }
  console.log(`(LFO rate ${formatValue(param('lfo1ratesyncoff'), 449)} Hz per step in these runs)`)
} finally {
  session.sendRaw(noteOff(CHANNEL, 36))
  session.sendRaw(noteOff(CHANNEL, 48))
  session.dispose()
  transport.close()
}
