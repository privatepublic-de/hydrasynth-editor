import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inSlotOrder, runBackup, slotKey } from '../src/library/backup'
import { BackupFileError, backupFileName, decodeBackup, encodeBackup, type StoredPatch } from '../src/library/backupFile'
import { decodeMessage } from '../src/sysex/codec'
import { HydrasynthSession } from '../src/sysex/session'
import { FakeHydrasynth, fixtureBytes } from './fakeSynth'
import { loadFixtureMessages } from './fixtures'

describe('backup file', () => {
  it('writes a patch as the synth sends it, byte for byte, and reads it back', () => {
    const bytes = fixtureBytes()
    const file = encodeBackup([{ bank: 0, patch: 0, bytes }])
    const dump = loadFixtureMessages()
    expect(file.length).toBe(dump.reduce((n, m) => n + m.length, 0))
    let at = 0
    for (const m of dump) {
      expect([...file.subarray(at, at + m.length)]).toEqual([...m])
      at += m.length
    }
    const [back] = decodeBackup(file)
    expect(back.bytes).toEqual(bytes)
  })

  it('keeps several patches in order with their slots', () => {
    const a = fixtureBytes()
    const b = fixtureBytes()
    b[2] = 3
    b[3] = 17
    const patches = decodeBackup(encodeBackup([{ bank: 0, patch: 0, bytes: a }, { bank: 3, patch: 17, bytes: b }]))
    expect(patches.map((p) => [p.bank, p.patch])).toEqual([
      [0, 0],
      [3, 17],
    ])
  })

  it('refuses a damaged file', () => {
    const file = encodeBackup([{ bank: 0, patch: 0, bytes: fixtureBytes() }])
    expect(() => decodeBackup(file.subarray(0, file.length - 100))).toThrow(BackupFileError)
    const bad = new Uint8Array(file)
    bad[20] = bad[20] === 0x41 ? 0x42 : 0x41
    expect(() => decodeBackup(bad)).toThrow(/checksum/)
  })

  it('names files by date', () => {
    expect(backupFileName(new Date(2026, 9, 8, 15, 30))).toBe('hydrasynth-backup-2026-10-08-1530.syx')
  })
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false
  const out = p.finally(() => (done = true))
  while (!done) await vi.advanceTimersByTimeAsync(50)
  return out
}

/** A synth whose dump requests fail for the given slots `failures` times each. */
class FlakySynth extends FakeHydrasynth {
  constructor(private failing: Map<string, number>) {
    super()
  }
  override send(raw: Uint8Array) {
    // Swallow a patch request (no chunks come back) while it is meant to fail.
    if (raw[0] === 0xf0) {
      const info = decodeMessage(raw).info
      if (info[0] === 0x04) {
        const k = slotKey(info[2], info[3])
        const left = this.failing.get(k) ?? 0
        if (left > 0) {
          this.failing.set(k, left - 1)
          this.received.push([...info])
          return
        }
      }
    }
    super.send(raw)
  }
}

describe('runBackup', () => {
  it('reads every patch of the chosen banks, in slot order', async () => {
    const synth = new FakeHydrasynth()
    const have = new Map<string, StoredPatch>()
    const progress: number[] = []
    const result = await settle(
      runBackup({ session: new HydrasynthSession(synth), banks: [0, 2], have, onProgress: (p) => progress.push(p.done), bankPauseMs: 10 }),
    )
    expect(result.stopped).toBeUndefined()
    expect(have.size).toBe(256)
    expect(progress.at(-1)).toBe(256)
    expect(inSlotOrder(have, [0, 2]).map((p) => [p.bank, p.patch]).slice(126, 130)).toEqual([
      [0, 126],
      [0, 127],
      [2, 0],
      [2, 1],
    ])
  })

  it('retries a patch that times out, and stops after the last try keeping what it has', async () => {
    const flaky = new FlakySynth(new Map([['0:3', 1], ['0:5', 5]]))
    const session = new HydrasynthSession(flaky, { timeoutMs: 50 })
    const have = new Map<string, StoredPatch>()
    const result = await settle(runBackup({ session, banks: [0], have, onProgress: () => undefined, retryPauseMs: 10 }))
    expect(result.retries).toBe(3)
    expect(result.stopped).toMatch(/^A6 didn't come through after 3 tries/)
    expect([...have.keys()]).toEqual(['0:0', '0:1', '0:2', '0:3', '0:4'])

    // Continuing reads only what is missing.
    const again = await settle(runBackup({ session: new HydrasynthSession(new FakeHydrasynth()), banks: [0], have, onProgress: () => undefined }))
    expect(again.stopped).toBeUndefined()
    expect(have.size).toBe(128)
  })

  it('stops when cancelled', async () => {
    const controller = new AbortController()
    const have = new Map<string, StoredPatch>()
    const result = await settle(
      runBackup({
        session: new HydrasynthSession(new FakeHydrasynth()),
        banks: [0],
        have,
        signal: controller.signal,
        onProgress: (p) => p.done === 10 && controller.abort(),
      }),
    )
    expect(result.stopped).toBe('Cancelled.')
    expect(have.size).toBe(10)
  })
})
