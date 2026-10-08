import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initPatchBytes } from '../src/params/initPatch'
import { Patch } from '../src/params/patch'
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
})
