// Records each Hydrasynth wave from the synth's audio output, for tools/extractCycles.ts.
// Puts the Init patch into H128's working memory (no flash write; only OSC 1 sounds, filter
// open, no FX), then per wave: sets OSC 1 to it over NRPN, holds C2 and records the default
// audio input (the synth on inputs 1/2) with sox. One WAV per wave in local/wave-recordings.
// Usage: npx vite-node tools/recordWaves.ts [first] [last]   (wave numbers 0..218)
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { noteOff, noteOn, sleep } from '../src/midi/channel'
import { initPatchBytes } from '../src/params/initPatch'
import { encodeNrpn, nrpnBytes } from '../src/params/nrpn'
import { param } from '../src/params/patch'
import { HydrasynthSession } from '../src/sysex/session'
import { connectHelper } from './coremidiTransport'

const CHANNEL = 1
const NOTE = 36 // C2, ~65.4 Hz: ~734 samples a cycle at 48 kHz
const RATE = 48000
const RECORD_S = 1.6
const NOTE_START_MS = 250 // after the recorder starts
const NOTE_MS = 1100
const OUT = 'local/wave-recordings'

const first = Number(process.argv[2] ?? 0)
const last = Number(process.argv[3] ?? first)

function record(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // The X18 delivers all 18 inputs; keep 1 and 2.
    const input = ['-t', 'coreaudio', '-c', '18', '-r', String(RATE), 'default']
    const output = ['-c', '2', '-b', '24', file]
    const rec = spawn('sox', ['-q', ...input, ...output, 'remix', '1', '2', 'trim', '0', String(RECORD_S)], { stdio: 'inherit' })
    rec.on('error', reject)
    rec.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`rec exited with ${code}`))))
  })
}

mkdirSync(OUT, { recursive: true })
const transport = await connectHelper()
const session = new HydrasynthSession(transport, { timeoutMs: 3000 })
const send = (bytes: number[]) => session.sendRaw(bytes)
try {
  await session.uploadToRam(7, 127, initPatchBytes())
  await session.reloadSlot(CHANNEL, 7, 127)
  const def = param('osc1type')
  for (let wave = first; wave <= last; wave++) {
    const nrpn = encodeNrpn(def, wave)
    if (!nrpn) throw new Error(`no NRPN for wave ${wave}`)
    send(nrpnBytes(CHANNEL, nrpn))
    await sleep(150)
    const done = record(`${OUT}/${wave}.wav`)
    await sleep(NOTE_START_MS)
    send(noteOn(CHANNEL, NOTE, 100))
    await sleep(NOTE_MS)
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
