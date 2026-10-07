import { describe, expect, it } from 'vitest'
import type { MidiTransport } from '../src/midi/transport'
import { decodeMessage, encodeMessage } from '../src/sysex/codec'
import { CHUNK_KIND, CMD, NAMES_BYTES, chunkMessage, parseChunk } from '../src/sysex/protocol'
import { HydrasynthSession, SysexTimeoutError } from '../src/sysex/session'
import { loadFixtureMessages } from './fixtures'

/** A synth that follows SysexEncoding.txt: each chunk only after the previous one's ack. */
class FakeHydrasynth implements MidiTransport {
  private listener?: (m: Uint8Array) => void
  readonly received: number[][] = []
  readonly channelMessages: number[][] = []
  readonly uploaded: Uint8Array[] = []
  private pending: Uint8Array[] = []
  private pendingKind = 0
  private index = 0
  silent = false

  constructor(private readonly patchChunks: Uint8Array[]) {}

  subscribe(listener: (m: Uint8Array) => void) {
    this.listener = listener
    return () => (this.listener = undefined)
  }

  send(raw: Uint8Array) {
    if (raw[0] !== 0xf0) {
      this.channelMessages.push([...raw])
      return
    }
    const { info } = decodeMessage(raw)
    this.received.push([...info])
    if (this.silent) return
    switch (info[0]) {
      case CMD.header:
        return this.reply([CMD.headerReply, 0])
      case CMD.footer:
        return this.reply([CMD.footerReply, 0])
      case CMD.versionRequest:
        return this.reply([CMD.versionReply, 0, 0xdc, 0, 1])
      case CMD.patchRequest:
        return this.stream(this.patchChunks, CHUNK_KIND.patch)
      case CMD.namesRequest:
        return this.stream(namesDump(info[2]), CHUNK_KIND.names)
      case CMD.chunkAck:
        return this.next()
      case CMD.chunk: {
        const chunk = parseChunk(Uint8Array.from(info))!
        this.uploaded[chunk.index] = chunk.data.slice()
        if (chunk.index === 21) {
          const head = this.uploaded[0]
          this.reply([CMD.patchSavedAck, 0, head[2], head[3]])
        }
        return this.reply([CMD.chunkAck, 0, chunk.index, chunk.kind])
      }
    }
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
    queueMicrotask(() => this.listener?.(encodeMessage(info)))
  }
}

function namesDump(bank: number): Uint8Array[] {
  const bytes = [CMD.namesReply, 0, bank]
  for (let i = 0; i < 128; i++) {
    const name = `Patch ${i + 1}`.padEnd(16, ' ')
    bytes.push(...[...name].map((c) => c.charCodeAt(0)), 0)
    if (i < 127) bytes.push(0x3a)
  }
  expect(bytes.length).toBe(NAMES_BYTES)
  const chunks: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += 128) chunks.push(Uint8Array.from(bytes.slice(i, i + 128)))
  return chunks
}

const fixtureChunks = () => loadFixtureMessages().map((m) => parseChunk(decodeMessage(m).info)!.data)

describe('HydrasynthSession', () => {
  it('downloads a patch with header, 22 acks and footer', async () => {
    const synth = new FakeHydrasynth(fixtureChunks())
    const session = new HydrasynthSession(synth)
    const patch = await session.downloadPatch(0, 0)
    expect(patch.length).toBe(2790)
    const cmds = synth.received.map((m) => m[0])
    expect(cmds[0]).toBe(CMD.header)
    expect(synth.received[1]).toEqual([CMD.patchRequest, 0, 0, 0])
    expect(cmds.filter((c) => c === CMD.chunkAck)).toHaveLength(22)
    expect(cmds.at(-1)).toBe(CMD.footer)
  })

  it('downloads bank names', async () => {
    const session = new HydrasynthSession(new FakeHydrasynth(fixtureChunks()))
    const { bank, names } = await session.downloadBankNames(3)
    expect(bank).toBe(3)
    expect(names[0]).toBe('Patch 1')
    expect(names[127]).toBe('Patch 128')
  })

  it('sends the footer even when the dump times out', async () => {
    const synth = new FakeHydrasynth([])
    const session = new HydrasynthSession(synth, { timeoutMs: 20 })
    await expect(session.downloadPatch(0, 5)).rejects.toBeInstanceOf(SysexTimeoutError)
    expect(synth.received.at(-1)?.[0]).toBe(CMD.footer)
  })

  it('uploads a patch to RAM as 06 00 BANK PATCH, one chunk per ack, without a write request', async () => {
    const synth = new FakeHydrasynth([])
    const session = new HydrasynthSession(synth)
    const patch = Uint8Array.from(fixtureChunks().flatMap((c) => [...c]))
    const { savedAck } = await session.uploadToRam(7, 127, patch)
    expect(savedAck).toBe(true)
    expect([...synth.uploaded[0].subarray(0, 4)]).toEqual([0x06, 0x00, 7, 127])
    expect(synth.uploaded).toHaveLength(22)
    expect(synth.uploaded.slice(1).map((c) => [...c])).toEqual(fixtureChunks().slice(1).map((c) => [...c]))
    const cmds = synth.received.map((m) => m[0])
    expect(cmds).not.toContain(CMD.writeRequest)
    expect(cmds.at(-1)).toBe(CMD.footer)
    expect(patch[0]).toBe(0x05)
  })

  it('writes the block the synth normalizes (2390-2399) as five -100s', async () => {
    const synth = new FakeHydrasynth([])
    const patch = Uint8Array.from(fixtureChunks().flatMap((c) => [...c]))
    patch.fill(0, 2390, 2400)
    await new HydrasynthSession(synth).uploadToRam(7, 127, patch)
    const sent = Uint8Array.from(synth.uploaded.flatMap((c) => [...c]))
    expect([...sent.subarray(2390, 2400)]).toEqual([0x9c, 0xff, 0x9c, 0xff, 0x9c, 0xff, 0x9c, 0xff, 0x9c, 0xff])
  })

  it('reloads a slot with bank select and a program change away and back', async () => {
    const synth = new FakeHydrasynth([])
    await new HydrasynthSession(synth).reloadSlot(2, 7, 127)
    expect(synth.channelMessages).toEqual([
      [0xb1, 0, 0],
      [0xb1, 32, 7],
      [0xc1, 0],
      [0xc1, 127],
    ])
  })

  it('reads the version', async () => {
    const session = new HydrasynthSession(new FakeHydrasynth([]))
    expect([...(await session.version())]).toEqual([CMD.versionReply, 0, 0xdc, 0, 1])
  })
})
