// Node-side transport through logue-patcher's CoreMIDI helper (a JSON-lines bridge),
// for tools that talk to the synth from the shell. Set LOGUE_MIDI_HELPER to override the path.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { MidiTransport } from '../src/midi/transport'

const DEFAULT_HELPER = `${process.env.HOME}/Documents/GitHub/logue-patcher/resources/bin/logue-midi-helper`

export interface HelperTransport extends MidiTransport {
  close(): void
}

export async function connectHelper(portPattern = /hydrasynth/i): Promise<HelperTransport> {
  const proc = spawn(process.env.LOGUE_MIDI_HELPER ?? DEFAULT_HELPER, [], { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = createInterface({ input: proc.stdout })
  const listeners = new Set<(m: Uint8Array) => void>()
  const replies = new Map<number, (r: any) => void>()
  let nextId = 1
  let pending: number[] = []
  let running = 0
  const emit = (bytes: number[]) => {
    const m = Uint8Array.from(bytes)
    for (const l of listeners) l(m)
  }
  /** Bytes in a channel message by status: program change and channel pressure have one data byte. */
  const channelLength = (status: number) => ((status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 2 : 3)

  lines.on('line', (line) => {
    const msg = JSON.parse(line)
    if (msg.event === 'data') {
      // The helper passes raw byte runs; reassemble whole messages: SysEx, and channel messages
      // (with running status), as Web MIDI delivers them. Real-time bytes are dropped.
      for (const b of Buffer.from(msg.data, 'base64')) {
        if (b >= 0xf8) continue
        if (b === 0xf0) {
          pending = [b]
          continue
        }
        if (pending[0] === 0xf0) {
          pending.push(b)
          if (b === 0xf7) {
            emit(pending)
            pending = []
          }
          continue
        }
        if (b & 0x80) {
          running = b < 0xf0 ? b : 0
          pending = [b]
        } else if (!pending.length && running) pending = [running, b]
        else if (pending.length) pending.push(b)
        else continue
        if (pending.length === channelLength(pending[0])) {
          emit(pending)
          pending = []
        }
      }
    } else if (msg.id != null && replies.has(msg.id)) {
      replies.get(msg.id)!(msg)
      replies.delete(msg.id)
    }
  })

  const call = (cmd: object): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      replies.set(id, (r) => (r.ok ? resolve(r) : reject(new Error(r.error))))
      proc.stdin.write(JSON.stringify({ id, ...cmd }) + '\n')
    })

  await new Promise<void>((resolve) => lines.once('line', () => resolve()))
  const { sources, destinations } = await call({ cmd: 'list' })
  const source = sources.find((p: any) => portPattern.test(p.name))
  const dest = destinations.find((p: any) => portPattern.test(p.name))
  if (!source || !dest) throw new Error(`no MIDI port matching ${portPattern}`)
  await call({ cmd: 'connect', source: source.id })

  return {
    send: (m) => void call({ cmd: 'send', dest: dest.id, data: Buffer.from(m).toString('base64') }),
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    close: () => proc.stdin.end(),
  }
}
