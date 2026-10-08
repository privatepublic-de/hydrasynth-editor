import { describe, expect, it } from 'vitest'
import { CMD } from '../src/sysex/protocol'
import { HydrasynthSession, SysexTimeoutError } from '../src/sysex/session'
import { FakeHydrasynth, fixtureChunks } from './fakeSynth'

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
