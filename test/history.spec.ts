import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeNrpn } from '../src/params/nrpn'
import { param } from '../src/params/patch'
import { HydrasynthSession } from '../src/sysex/session'
import { COALESCE_MS, History, type Snapshot } from '../src/sync/history'
import { PatchSync } from '../src/sync/patchSync'
import { FakeHydrasynth } from './fakeSynth'

const snap = (n: number): Snapshot => ({ bytes: Uint8Array.of(n), inactive: [] })

describe('History', () => {
  it('coalesces changes to the same param close together, not to different ones', () => {
    let t = 0
    const h = new History(200, () => t)
    h.record(() => snap(0), 'a', 'A')
    t += 100
    h.record(() => snap(1), 'a', 'A')
    t += 100
    h.record(() => snap(2), 'b', 'B')
    t += COALESCE_MS + 1
    h.record(() => snap(3), 'b', 'B')
    expect(h.undo(snap(4))!.bytes[0]).toBe(3)
    expect(h.undo(snap(3))!.bytes[0]).toBe(2)
    expect(h.undo(snap(2))!.bytes[0]).toBe(0)
    expect(h.undo(snap(0))).toBeNull()
  })

  it('makes a group one step, redoes, and drops the redo branch on a new change', () => {
    const h = new History()
    h.grouped('Fill', () => {
      h.record(() => snap(0), 'x', 'X')
      h.record(() => snap(1), 'y', 'Y')
    })
    expect(h.undoLabel).toBe('Fill')
    expect(h.undo(snap(2))!.bytes[0]).toBe(0)
    expect(h.redoLabel).toBe('Fill')
    expect(h.redo(snap(0))!.bytes[0]).toBe(2)
    h.undo(snap(2))
    h.record(() => snap(5), 'z', 'Z')
    expect(h.redoLabel).toBeNull()
  })

  it('makes a pointer gesture one step, however many params it moves, named after the first', () => {
    let t = 0
    const h = new History(200, () => (t += 2000))
    h.beginGesture()
    for (let i = 0; i < 20; i++) h.record(() => snap(i), i % 2 ? 'res' : 'cutoff', i % 2 ? 'Resonance' : 'Cutoff')
    h.endGesture()
    expect(h.undoLabel).toBe('Cutoff')
    expect(h.undo(snap(99))!.bytes[0]).toBe(0)
    expect(h.undoLabel).toBeNull()
  })

  it('keeps at most `limit` steps', () => {
    let t = 0
    const h = new History(3, () => (t += 10_000))
    for (let i = 0; i < 5; i++) h.record(() => snap(i), 'k', 'K')
    expect([h.undo(snap(9)), h.undo(snap(9)), h.undo(snap(9)), h.undo(snap(9))].map((s) => s?.bytes[0] ?? null)).toEqual([4, 3, 2, null])
  })
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false
  const out = p.finally(() => (done = true))
  while (!done) await vi.advanceTimersByTimeAsync(20)
  return out
}

describe('PatchSync undo/redo', () => {
  const setup = async () => {
    const synth = new FakeHydrasynth()
    const sync = new PatchSync({ session: new HydrasynthSession(synth), channel: 1 })
    await settle(sync.open({ bank: 0, patch: 0 }))
    synth.channelMessages.length = 0
    return { synth, sync }
  }

  it('undoes a dial drag in one step, sends the old value back and is clean again', async () => {
    const { synth, sync } = await setup()
    const original = sync.get().patch!.get('filter1cutoff')
    for (const v of [600, 650, 700]) sync.set('filter1cutoff', v)
    expect(sync.get()).toMatchObject({ dirty: true, undoLabel: 'FILTER 1 Cutoff' })
    synth.channelMessages.length = 0
    sync.undo()
    await settle(sync.settled())
    expect(sync.get().patch!.get('filter1cutoff')).toBe(original)
    expect(synth.nrpns()).toEqual([[encodeNrpn(param('filter1cutoff'), original)!.param, encodeNrpn(param('filter1cutoff'), original)!.value]])
    expect(sync.get()).toMatchObject({ dirty: false, undoLabel: null, redoLabel: 'FILTER 1 Cutoff' })
    sync.redo()
    expect(sync.get().patch!.get('filter1cutoff')).toBe(700)
    expect(sync.get().dirty).toBe(true)
  })

  it('undoes a mode switch with its dependents, keeping each mode’s values', async () => {
    const { sync } = await setup()
    sync.set('env1bpmsync', 0)
    vi.advanceTimersByTime(COALESCE_MS + 1)
    sync.set('env1attacksyncoff', 625)
    vi.advanceTimersByTime(COALESCE_MS + 1)
    sync.set('env1bpmsync', 1)
    expect(sync.get().patch!.get('env1attacksyncon')).toBe(0)
    sync.undo()
    expect(sync.get().patch!.get('env1bpmsync')).toBe(0)
    expect(sync.get().patch!.get('env1attacksyncoff')).toBe(625)
  })

  it('makes a group one step, and sends a name change back as a whole patch', async () => {
    const { synth, sync } = await setup()
    sync.grouped('Fill OSC 1 wavelist', () => {
      for (let s = 2; s <= 8; s++) sync.set(`osc1wavscanwave${s}`, 10 + s)
    })
    expect(sync.get().undoLabel).toBe('Fill OSC 1 wavelist')
    sync.undo()
    expect(sync.get().undoLabel).toBeNull()

    sync.setName('Shelf Pad')
    await settle(sync.settled())
    sync.undo()
    expect(sync.get().patch!.name).toBe('Sawpressive GD')
    expect(sync.get().pendingFullSend).toBe(true)
    await settle(sync.settled())
    expect(String.fromCharCode(...synth.slots.get('7:127')!.subarray(9, 23))).toBe('Sawpressive GD')
  })
})
