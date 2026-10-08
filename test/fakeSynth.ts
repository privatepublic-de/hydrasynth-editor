import { expect } from 'vitest'
import type { MidiTransport } from '../src/midi/transport'
import { decodeMessage, encodeMessage } from '../src/sysex/codec'
import { CHUNK_KIND, CMD, NAMES_BYTES, chunkMessage, parseChunk } from '../src/sysex/protocol'
import { loadFixtureMessages } from './fixtures'

export const fixtureChunks = () => loadFixtureMessages().map((m) => parseChunk(decodeMessage(m).info)!.data)
export const fixtureBytes = () => Uint8Array.from(fixtureChunks().flatMap((c) => [...c]))

export type LogEntry = { sysex: number[] } | { channel: number[] }

/** A synth that follows SysexEncoding.txt: each chunk only after the previous one's ack. */
export class FakeHydrasynth implements MidiTransport {
  private listeners = new Set<(m: Uint8Array) => void>()
  readonly received: number[][] = []
  readonly channelMessages: number[][] = []
  /** Everything received, in order. */
  readonly log: LogEntry[] = []
  /** Chunk data of the latest patch received. */
  uploaded: Uint8Array[] = []
  /** Slots written to flash, in order ("bank:patch"). */
  readonly flashWrites: string[] = []
  /** Stored patches by "bank:patch" (RAM); any other slot answers with `defaultChunks`. */
  readonly slots = new Map<string, Uint8Array>()
  private pending: Uint8Array[] = []
  private pendingKind = 0
  private index = 0
  silent = false

  constructor(private readonly defaultChunks: Uint8Array[] = fixtureChunks()) {}

  subscribe(listener: (m: Uint8Array) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** What the synth's panel sends: a knob's NRPN, a patch change. */
  panel(...messages: number[][]) {
    for (const m of messages) for (const l of this.listeners) l(Uint8Array.from(m))
  }

  send(raw: Uint8Array) {
    if (raw[0] !== 0xf0) {
      // The session sends a whole NRPN (4 CCs) as one message; split it per CC.
      for (let i = 0; i < raw.length; i += (raw[i] & 0xf0) === 0xc0 ? 2 : 3) {
        const msg = [...raw.subarray(i, i + ((raw[i] & 0xf0) === 0xc0 ? 2 : 3))]
        this.channelMessages.push(msg)
        this.log.push({ channel: msg })
      }
      return
    }
    const { info } = decodeMessage(raw)
    this.received.push([...info])
    this.log.push({ sysex: [...info] })
    if (this.silent) return
    switch (info[0]) {
      case CMD.header:
        return this.reply([CMD.headerReply, 0])
      case CMD.footer:
        return this.reply([CMD.footerReply, 0])
      case CMD.versionRequest:
        return this.reply([CMD.versionReply, 0, 0xdc, 0, 1])
      case CMD.patchRequest: {
        const stored = this.slots.get(`${info[2]}:${info[3]}`)
        const chunks = stored ? split(stored) : this.defaultChunks
        return this.stream(chunks, CHUNK_KIND.patch)
      }
      case CMD.namesRequest:
        return this.stream(namesDump(info[2]), CHUNK_KIND.names)
      case CMD.chunkAck:
        return this.next()
      case CMD.writeRequest:
        this.flashWrites.push(this.lastUploadSlot())
        return this.reply([CMD.writeRequestReply, 0])
      case CMD.chunk: {
        const chunk = parseChunk(Uint8Array.from(info))!
        if (chunk.index === 0) this.uploaded = []
        this.uploaded[chunk.index] = chunk.data.slice()
        if (chunk.index === 21) {
          const head = this.uploaded[0]
          const bytes = Uint8Array.from(this.uploaded.flatMap((c) => [...c]))
          bytes[0] = 0x05
          this.slots.set(`${head[2]}:${head[3]}`, bytes)
          this.reply([CMD.patchSavedAck, 0, head[2], head[3]])
        }
        return this.reply([CMD.chunkAck, 0, chunk.index, chunk.kind])
      }
    }
  }

  /** NRPNs received, as [param, value] (from the CC 99/98/6/38 runs). */
  nrpns(): [number, number][] {
    const out: [number, number][] = []
    const cc: Record<number, number> = {}
    for (const m of this.channelMessages) {
      if ((m[0] & 0xf0) !== 0xb0) continue
      cc[m[1]] = m[2]
      if (m[1] === 38) out.push([(cc[99] << 7) | cc[98], (cc[6] << 7) | cc[38]])
    }
    return out
  }

  private lastUploadSlot() {
    const head = this.uploaded[0]
    return `${head[2]}:${head[3]}`
  }

  private stream(chunks: Uint8Array[], kind: number) {
    this.pending = chunks.slice()
    this.pendingKind = kind
    this.index = 0
    this.next()
  }

  private next() {
    const chunk = this.pending.shift()
    if (chunk) this.reply(chunkMessage(this.index++, this.pendingKind as 0x16, chunk))
  }

  private reply(info: number[]) {
    queueMicrotask(() => {
      const m = encodeMessage(info)
      for (const l of this.listeners) l(m)
    })
  }
}

function split(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += 128) out.push(bytes.slice(i, i + 128))
  return out
}

function namesDump(bank: number): Uint8Array[] {
  const bytes = [CMD.namesReply, 0, bank]
  for (let i = 0; i < 128; i++) {
    const name = `Patch ${i + 1}`.padEnd(16, ' ')
    bytes.push(...[...name].map((c) => c.charCodeAt(0)), 0)
    if (i < 127) bytes.push(0x3a)
  }
  expect(bytes.length).toBe(NAMES_BYTES)
  return split(Uint8Array.from(bytes))
}
