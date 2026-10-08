// Checks the editor's WaveScan display (mixCycles over public/wave-cycles.json) against the synth.
// Per pair of waves A, B: a patch in H128's working memory (no flash write) with OSC 1 in
// WaveScan over just A and B; one held C2, the scan position moved from A to halfway to B over
// NRPN, recorded. One note means one running oscillator, so the three parts share their phase:
//  - A's and B's offsets against the stored cycles say whether those are lined up as the synth
//    plays them (the stored ones were lined up with the pictures, one wave at a time);
//  - the halfway part against mixCycles(A, B, 0.5) says whether WaveScan is a plain crossfade.
// Usage: npx vite-node tools/verifyMorph.ts
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { noteOff, noteOn, sleep } from '../src/midi/channel'
import { initPatchBytes } from '../src/params/initPatch'
import { encodeNrpn, nrpnBytes } from '../src/params/nrpn'
import { Patch, param } from '../src/params/patch'
import { HydrasynthSession } from '../src/sysex/session'
import { mixCycles, type WaveCycle } from '../src/ui/waveCycles'
import { connectHelper } from './coremidiTransport'
import { CYCLE, RATE, cycleAt, onsetOf, period, readWav } from './waveAudio'

const CHANNEL = 1
const NOTE = 36
const PAIRS: [number, number][] = [
  [3, 0], // Saw -> Sine
  [4, 57], // Square -> Scorpio 2
  [125, 202], // Duotone 5 -> Harmon 7
  [30, 150], // a loud and a quiet one
]
/** Where the scan sits, from the note's start: A, halfway, B (seconds). */
const PARTS = [
  { at: 0, value: 0, label: 'A' },
  { at: 0.7, value: 73, label: 'half' },
  { at: 1.4, value: 147, label: 'B' },
]
const PART_S = 0.7
const FILE = 'local/wave-recordings/morph.wav'

const stored = JSON.parse(readFileSync('public/wave-cycles.json', 'utf8')).waves.map(
  (w: { cycle: string; level: number }): WaveCycle => ({
    cycle: Float32Array.from(new Int16Array(new Uint8Array(Buffer.from(w.cycle, 'base64')).buffer), (v) => v / 32767),
    level: w.level,
    line: '',
    bars: [],
  }),
)

function record(seconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const input = ['-t', 'coreaudio', '-c', '18', '-r', String(RATE), 'default']
    const rec = spawn('sox', ['-q', ...input, '-c', '2', '-b', '24', FILE, 'remix', '1', '2', 'trim', '0', String(seconds)], { stdio: 'inherit' })
    rec.on('error', reject)
    rec.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`sox exited with ${code}`))))
  })
}

/** The rotation (and sign) that best maps `recorded` onto `reference`, and how well. */
function offset(recorded: number[], reference: ArrayLike<number>) {
  let best = { shift: 0, sign: 1, score: -Infinity }
  for (let shift = 0; shift < CYCLE; shift++) {
    let s = 0
    for (let k = 0; k < CYCLE; k++) s += recorded[(k + shift) % CYCLE] * reference[k]
    for (const sign of [1, -1]) if (sign * s > best.score) best = { shift, sign, score: sign * s }
  }
  const norm = (v: ArrayLike<number>) => Math.sqrt(Array.from(v).reduce((a, b) => a + b * b, 0))
  return { ...best, match: best.score / (norm(recorded) * norm(reference)) }
}

const transport = await connectHelper()
const session = new HydrasynthSession(transport, { timeoutMs: 3000 })
const send = (bytes: number[]) => session.sendRaw(bytes)
const scan = (value: number) => send(nrpnBytes(CHANNEL, encodeNrpn(param('osc1wavscan'), value)!))
try {
  for (const [a, b] of PAIRS) {
    const patch = new Patch(initPatchBytes())
    patch.set('osc1mode', 1)
    patch.set('osc1wavscanwave1', a)
    patch.set('osc1wavscanwave2', b + 2) // slots 2-8 put Off and Silence first
    for (let s = 3; s <= 8; s++) patch.set(`osc1wavscanwave${s}`, 0)
    patch.set('osc1wavscan', 0)
    await session.uploadToRam(7, 127, patch.bytes)
    await session.reloadSlot(CHANNEL, 7, 127)

    const total = PARTS.length * PART_S + 0.6
    const done = record(total)
    await sleep(250)
    const t0 = Date.now()
    send(noteOn(CHANNEL, NOTE, 100))
    for (const part of PARTS) {
      await sleep(Math.max(0, part.at * 1000 - (Date.now() - t0)))
      scan(part.value)
    }
    await sleep(PART_S * 1000)
    send(noteOff(CHANNEL, NOTE))
    await done

    const x = readWav(FILE)
    const onset = onsetOf(x)
    const p = period(x.subarray(onset + 4800, onset + 4800 + 24000))
    // Each part's middle, clear of the moment the scan moved (and of MIDI timing).
    const parts = PARTS.map((part) => {
      const from = onset + Math.round((part.at + 0.2) * RATE)
      return cycleAt(x, p, from, from + Math.round((PART_S - 0.35) * RATE))
    })
    const oa = offset(parts[0], stored[a].cycle)
    const ob = offset(parts[2], stored[b].cycle)
    const relative = (((ob.shift - oa.shift) % CYCLE) + CYCLE) % CYCLE
    // The halfway part, turned as A was, against the editor's mix.
    const half = parts[1].map((_, k) => oa.sign * parts[1][(k + oa.shift) % CYCLE])
    const mix = mixCycles(stored[a], stored[b], 0.5)
    const om = offset(half, mix)
    const peak = (v: ArrayLike<number>) => Math.max(...Array.from(v, Math.abs))
    console.log(
      `${a} -> ${b}: A matches ${oa.match.toFixed(3)}, B ${ob.match.toFixed(3)}; B's offset from A ${relative} of ${CYCLE} points` +
        `${ob.sign === oa.sign ? '' : ', sign flipped'}; halfway vs the editor's mix ${om.match.toFixed(3)}` +
        ` (best at shift ${om.shift}${om.sign < 0 ? ', flipped' : ''}); halfway size ${(peak(parts[1]) / peak(parts[0])).toFixed(2)} of A`,
    )
  }
} finally {
  send(noteOff(CHANNEL, NOTE))
  session.dispose()
  transport.close()
}
