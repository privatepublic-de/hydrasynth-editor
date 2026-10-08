import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initPatchBytes } from '../src/params/initPatch'
import { Patch } from '../src/params/patch'
import { EXTENDED_MARKER, normalizePatch } from '../src/sysex/protocol'
import { HydrasynthSession } from '../src/sysex/session'
import { PatchSync } from '../src/sync/patchSync'
import { FakeHydrasynth } from './fakeSynth'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('Init patch', () => {
  it('is a 2.0 patch named Init', () => {
    const p = new Patch(initPatchBytes())
    expect(p.name).toBe('Init')
    expect(p.version).toBe(0xc8)
  })

  it('loads into H128 as an unstored, unchanged patch', async () => {
    const synth = new FakeHydrasynth()
    const sync = new PatchSync({ session: new HydrasynthSession(synth), channel: 1 })
    const done = sync.load(new Patch(initPatchBytes()), { dirty: false })
    while (sync.get().busy !== null || sync.get().playing.kind !== 'audition') await vi.advanceTimersByTimeAsync(20)
    await done
    expect(sync.get()).toMatchObject({ origin: null, dirty: false, playing: { kind: 'audition' } })
    expect(String.fromCharCode(...synth.slots.get('7:127')!.subarray(9, 13))).toBe('Init')
    expect(synth.flashWrites).toEqual([])
  })

  const marker = (bytes: Uint8Array) => String.fromCharCode(...bytes.subarray(1766, 1770))

  it('goes out with the ETCD marker it lacks, so LFO steps 9+ play', async () => {
    expect(marker(initPatchBytes())).toBe('\0\0\0\0')
    const synth = new FakeHydrasynth()
    const session = new HydrasynthSession(synth)
    await session.uploadToRam(7, 127, initPatchBytes())
    expect(marker(synth.slots.get('7:127')!)).toBe('ETCD')
    const write = session.writePatch(7, 126, initPatchBytes())
    await vi.runAllTimersAsync()
    await write
    expect(marker(synth.slots.get('7:126')!)).toBe('ETCD')
  })

  it('marking leaves every other byte alone', () => {
    const bytes = initPatchBytes()
    const out = normalizePatch(bytes)
    expect(marker(out)).toBe('ETCD')
    for (let i = 0; i < bytes.length; i++) {
      if (i >= EXTENDED_MARKER.offset && i < EXTENDED_MARKER.offset + 4) continue
      if (i >= 2390 && i < 2400) continue
      expect(out[i], `byte ${i}`).toBe(bytes[i])
    }
    expect(normalizePatch(out)).toEqual(out)
  })
})
