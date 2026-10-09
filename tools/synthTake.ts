// Plays a patch on the synth and records it, for the speech tools: the patch into H128's working
// memory (no flash write), one held note, NRPN changes at set times, recorded from the default
// audio input (the synth on inputs 1/2 of an X18) with sox.
import { spawn } from 'node:child_process'
import { noteOff, noteOn, sleep } from '../src/midi/channel'
import { encodeNrpn, nrpnBytes } from '../src/params/nrpn'
import { type Patch, param } from '../src/params/patch'
import { HydrasynthSession } from '../src/sysex/session'
import { connectHelper } from './coremidiTransport'
import { RATE, readWav } from './waveAudio'

const CHANNEL = 1

function record(file: string, seconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const input = ['-t', 'coreaudio', '-c', '18', '-r', String(RATE), 'default']
    const rec = spawn('sox', ['-q', ...input, '-c', '2', '-b', '24', file, 'remix', '1', '2', 'trim', '0', String(seconds)], { stdio: 'inherit' })
    rec.on('error', reject)
    rec.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`sox exited with ${code}`))))
  })
}

export async function openSynth(file: string) {
  const transport = await connectHelper()
  const session = new HydrasynthSession(transport, { timeoutMs: 3000 })
  const nrpn = (key: string, value: number) => session.sendRaw(nrpnBytes(CHANNEL, encodeNrpn(param(key), value)!))
  let held = -1

  /** Plays `patch` with `note` held `holdS`, sending `changes` [s after note-on, key, value]; the recording (in `file`) from note-on. */
  async function take(patch: Patch, note: number, holdS: number, changes: [number, string, number][] = []): Promise<Float64Array> {
    await session.uploadToRam(7, 127, patch.bytes)
    await session.reloadSlot(CHANNEL, 7, 127)
    await sleep(200)
    const done = record(file, holdS + 0.9)
    await sleep(300)
    const t0 = Date.now()
    session.sendRaw(noteOn(CHANNEL, note, 100))
    held = note
    for (const [at, key, value] of [...changes].sort((a, b) => a[0] - b[0])) {
      await sleep(Math.max(0, at * 1000 - (Date.now() - t0)))
      nrpn(key, value)
    }
    await sleep(Math.max(0, holdS * 1000 - (Date.now() - t0)))
    session.sendRaw(noteOff(CHANNEL, note))
    held = -1
    await done
    const x = readWav(file)
    let on = 0
    while (on < x.length && Math.abs(x[on]) < 0.01) on++
    return x.subarray(on)
  }

  function close() {
    if (held >= 0) session.sendRaw(noteOff(CHANNEL, held))
    session.dispose()
    transport.close()
  }

  return { take, nrpn, close }
}
