import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeNrpn } from '../src/params/nrpn'
import { param } from '../src/params/patch'
import { CMD } from '../src/sysex/protocol'
import { HydrasynthSession } from '../src/sysex/session'
import { NrpnQueue } from '../src/sync/nrpnQueue'
import { AUDITION_SLOT, PatchSync } from '../src/sync/patchSync'
import { FakeHydrasynth } from './fakeSynth'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** Lets timers run until `p` settles (the session sleeps between program changes, after writes...). */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false
  const out = p.finally(() => (done = true))
  while (!done) await vi.advanceTimersByTimeAsync(20)
  return out
}

describe('NrpnQueue', () => {
  const setup = (idle = () => Promise.resolve()) => {
    const sent: number[][] = []
    const q = new NrpnQueue({ send: (b) => sent.push([...b]), channel: () => 1, idle })
    return { q, sent }
  }

  it('sends a param changed several times once, with its latest value', async () => {
    const { q, sent } = setup()
    q.push('filter1cutoff', { param: 100, value: 1 })
    q.push('filter1cutoff', { param: 100, value: 2 })
    q.push('filter1cutoff', { param: 100, value: 3 })
    await settle(q.drained())
    expect(sent).toEqual([[0xb0, 99, 0, 0xb0, 98, 100, 0xb0, 6, 0, 0xb0, 38, 3]])
  })

  it('drops what is left when the port throws, so drained() and size settle', async () => {
    let calls = 0
    const q = new NrpnQueue({
      send: () => {
        if (calls++) throw new Error('port gone')
      },
      channel: () => 1,
      idle: () => Promise.resolve(),
    })
    q.push('a', { param: 1, value: 0 })
    q.push('b', { param: 2, value: 0 })
    q.push('c', { param: 3, value: 0 })
    await settle(q.drained())
    expect(calls).toBe(2)
    expect(q.size).toBe(0)
  })

  it('sends lead params (modes) before the values queued ahead of them', async () => {
    const { q, sent } = setup(() => new Promise((r) => setTimeout(r, 5)))
    q.push('a', { param: 1, value: 0 })
    q.push('b', { param: 2, value: 0 })
    q.push('mode', { param: 3, value: 0 }, true)
    await settle(q.drained())
    expect(sent.map((m) => m[5])).toEqual([3, 1, 2])
  })

  it('waits for the synth to be idle', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { q, sent } = setup(() => gate)
    q.push('a', { param: 1, value: 0 })
    await vi.advanceTimersByTimeAsync(50)
    expect(sent).toHaveLength(0)
    release()
    await settle(q.drained())
    expect(sent).toHaveLength(1)
  })
})

describe('PatchSync', () => {
  const setup = (opts: Partial<ConstructorParameters<typeof PatchSync>[0]> = {}) => {
    const synth = new FakeHydrasynth()
    const session = new HydrasynthSession(synth)
    const sync = new PatchSync({ session, channel: 1, ...opts })
    return { synth, session, sync }
  }

  it('opens a slot: downloads it and loads it on the synth', async () => {
    const { synth, sync } = setup()
    await settle(sync.open({ bank: 0, patch: 4 }))
    const s = sync.get()
    expect(s.patch?.name).toBe('Sawpressive GD')
    expect(s.origin).toEqual({ bank: 0, patch: 4 })
    expect(s.playing).toEqual({ kind: 'slot', slot: { bank: 0, patch: 4 } })
    expect(s.dirty).toBe(false)
    expect(synth.received[1]).toEqual([CMD.patchRequest, 0, 0, 4])
    expect(synth.channelMessages.slice(-2)).toEqual([[0xc0, 0], [0xc0, 4]])
  })

  it('drops edits made while a slot is loading, so none reach the new patch', async () => {
    const { synth, sync } = setup()
    await settle(sync.open({ bank: 0, patch: 0 }))
    const before = sync.get().patch!.get('filter1cutoff')
    const opening = sync.open({ bank: 0, patch: 4 })
    sync.set('filter1cutoff', before === 700 ? 600 : 700)
    sync.setName('Typed meanwhile')
    await settle(opening)
    await settle(sync.settled())
    expect(synth.nrpns()).toEqual([])
    expect(sync.get().patch!.get('filter1cutoff')).toBe(before)
    expect(sync.get().patch!.name).toBe('Sawpressive GD')
    expect(sync.get().dirty).toBe(false)
  })

  it('sends a live param as one NRPN, no whole-patch send', async () => {
    const { synth, sync } = setup()
    await settle(sync.open({ bank: 0, patch: 0 }))
    const before = synth.received.length
    sync.set('filter1cutoff', 700)
    await settle(sync.settled())
    const want = encodeNrpn(param('filter1cutoff'), 700)!
    expect(synth.nrpns()).toEqual([[want.param, want.value]])
    expect(synth.received.length).toBe(before)
    expect(sync.get().dirty).toBe(true)
  })

  it('sends what NRPN cannot carry as a whole patch to the audition slot, after a pause', async () => {
    const { synth, sync } = setup()
    await settle(sync.open({ bank: 0, patch: 0 }))
    sync.setName('Shelf Pad')
    sync.set('arptempo', 1200)
    expect(sync.get().pendingFullSend).toBe(true)
    await vi.advanceTimersByTimeAsync(900)
    expect(synth.slots.has('7:127')).toBe(false)
    await settle(sync.settled())
    const stored = synth.slots.get(`${AUDITION_SLOT.bank}:${AUDITION_SLOT.patch}`)!
    expect(String.fromCharCode(...stored.subarray(9, 18))).toBe('Shelf Pad')
    expect(sync.get().playing).toEqual({ kind: 'audition' })
    expect(synth.channelMessages.slice(-2)).toEqual([[0xc0, 0], [0xc0, 127]])
    expect(synth.flashWrites).toEqual([])
  })

  it('switching a mode keeps each mode\u2019s values apart, as the synth does', async () => {
    const { synth, sync } = setup()
    await settle(sync.open({ bank: 0, patch: 0 }))
    sync.set('env1bpmsync', 0)
    sync.set('env1attacksyncoff', 625)
    await settle(sync.settled())
    synth.channelMessages.length = 0

    sync.set('env1bpmsync', 1)
    await settle(sync.settled())
    const sent = synth.nrpns()
    expect(sent[0][0]).toBe(encodeNrpn(param('env1bpmsync'), 1)!.param)
    expect(sent).toContainEqual([encodeNrpn(param('env1attacksyncon'), 0)!.param, 0])
    expect(sync.get().patch!.get('env1attacksyncon')).toBe(0)

    sync.set('env1attacksyncon', 5)
    sync.set('env1bpmsync', 0)
    expect(sync.get().patch!.get('env1attacksyncoff')).toBe(625)
    sync.set('env1bpmsync', 1)
    expect(sync.get().patch!.get('env1attacksyncon')).toBe(5)
  })

  it('sends FX params live, on the per-slot FX param numbers x8', async () => {
    const { synth, sync } = setup()
    await settle(sync.open({ bank: 0, patch: 0 }))
    sync.set('prefxtype', 7)
    sync.set('prefx7param1', 300)
    await settle(sync.settled())
    expect(synth.nrpns()).toContainEqual([8431, 2400])
    expect(sync.get().playing).toEqual({ kind: 'slot', slot: { bank: 0, patch: 0 } })
  })

  it('writes to a slot and flash, then plays it from there', async () => {
    const { synth, sync } = setup()
    await settle(sync.open({ bank: 0, patch: 0 }))
    sync.set('filter1cutoff', 700)
    await settle(sync.write({ bank: 2, patch: 9 }))
    expect(synth.flashWrites).toEqual(['2:9'])
    expect(sync.get()).toMatchObject({ origin: { bank: 2, patch: 9 }, dirty: false, playing: { kind: 'slot' } })
    const p = synth.slots.get('2:9')!
    expect(p[9 + 0]).toBe('S'.charCodeAt(0))
  })

  it('keeps the patch being edited across a reconnect, sending nothing', async () => {
    const { sync } = setup()
    await settle(sync.open({ bank: 2, patch: 5 }))
    sync.set('filter1cutoff', 700)
    const synth2 = new FakeHydrasynth()
    const sync2 = new PatchSync({ session: new HydrasynthSession(synth2), channel: 1 })
    sync2.adopt(sync.get())
    expect(sync2.get()).toMatchObject({ origin: { bank: 2, patch: 5 }, dirty: true, playing: { kind: 'unknown' } })
    expect(sync2.get().patch!.get('filter1cutoff')).toBe(700)
    expect(synth2.received).toEqual([])
    expect(synth2.channelMessages).toEqual([])
  })

  it('does not send anything for a value that did not change', async () => {
    const { synth, sync } = setup()
    await settle(sync.open({ bank: 0, patch: 0 }))
    const v = sync.get().patch!.get('filter1cutoff')
    sync.set('filter1cutoff', v)
    await settle(sync.settled())
    expect(synth.nrpns()).toEqual([])
    expect(sync.get().dirty).toBe(false)
  })
})
