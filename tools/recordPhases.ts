// Records every wave against the same reference, so tools/extractCycles.ts can store them in
// the phase and sign the synth plays them in (which mixing two waves, as WaveScan does, needs).
// Puts a patch into H128's working memory (no flash write) with OSC 1 in WaveScan over Sine
// (slot 1) and the wave (slot 2). Per wave: sets slot 2 over NRPN, holds C2 with the scan on the
// Sine, then moves it to the wave without letting go: one running oscillator, so the wave's
// phase is measured against the Sine's. One WAV per wave: local/wave-recordings/phase-<n>.wav.
// Usage: npx vite-node tools/recordPhases.ts [first] [last]   (wave numbers 0..218)
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { noteOff, noteOn, sleep } from '../src/midi/channel'
import { initPatchBytes } from '../src/params/initPatch'
import { encodeNrpn, nrpnBytes } from '../src/params/nrpn'
import { Patch, param } from '../src/params/patch'
import { HydrasynthSession } from '../src/sysex/session'
import { connectHelper } from './coremidiTransport'
import { PHASE_TIMING, RATE } from './waveAudio'

const CHANNEL = 1
const NOTE = 36 // C2
const SINE = 0
/** A scan position fully on slot 2 (with two waves, slot 2 is at 1/7 of the range: 146.3). */
const SLOT2 = 147
const OUT = 'local/wave-recordings'

const first = Number(process.argv[2] ?? 0)
const last = Number(process.argv[3] ?? 218)

function record(file: string, seconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const input = ['-t', 'coreaudio', '-c', '18', '-r', String(RATE), 'default']
    const rec = spawn('sox', ['-q', ...input, '-c', '2', '-b', '24', file, 'remix', '1', '2', 'trim', '0', String(seconds)], { stdio: 'inherit' })
    rec.on('error', reject)
    rec.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`sox exited with ${code}`))))
  })
}

mkdirSync(OUT, { recursive: true })
const transport = await connectHelper()
const session = new HydrasynthSession(transport, { timeoutMs: 3000 })
const send = (bytes: number[]) => session.sendRaw(bytes)
const nrpn = (key: string, value: number) => send(nrpnBytes(CHANNEL, encodeNrpn(param(key), value)!))
try {
  const patch = new Patch(initPatchBytes())
  patch.set('osc1mode', 1)
  patch.set('osc1wavscanwave1', SINE)
  for (let s = 2; s <= 8; s++) patch.set(`osc1wavscanwave${s}`, 0)
  patch.set('osc1wavscan', 0)
  await session.uploadToRam(7, 127, patch.bytes)
  await session.reloadSlot(CHANNEL, 7, 127)
  for (let wave = first; wave <= last; wave++) {
    nrpn('osc1wavscanwave2', wave + 2) // slots 2-8 put Off and Silence first
    nrpn('osc1wavscan', 0)
    await sleep(150)
    const done = record(`${OUT}/phase-${wave}.wav`, PHASE_TIMING.sineS + PHASE_TIMING.waveS + 0.6)
    await sleep(250)
    send(noteOn(CHANNEL, NOTE, 100))
    await sleep(PHASE_TIMING.sineS * 1000)
    nrpn('osc1wavscan', SLOT2)
    await sleep(PHASE_TIMING.waveS * 1000)
    send(noteOff(CHANNEL, NOTE))
    await done
    process.stdout.write(`${wave} `)
  }
  console.log('\ndone')
} finally {
  send(noteOff(CHANNEL, NOTE))
  session.dispose()
  transport.close()
}
