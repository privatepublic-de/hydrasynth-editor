import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeNrpn, encodeNrpn, nrpnBytes } from '../src/params/nrpn'
import { PARAM_BY_KEY, param } from '../src/params/patch'
import { HydrasynthSession } from '../src/sysex/session'
import { PatchSync } from '../src/sync/patchSync'
import { FakeHydrasynth } from './fakeSynth'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false
  const out = p.finally(() => (done = true))
  while (!done) await vi.advanceTimersByTimeAsync(20)
  return out
}

/** A knob turned on the synth: its NRPN as the panel sends it (CC 99/98/6/38). */
const knob = (number: number, value: number) => {
  const b = nrpnBytes(1, { param: number, value })
  return [b.slice(0, 3), b.slice(3, 6), b.slice(6, 9), b.slice(9, 12)]
}

describe('decodeNrpn', () => {
  it('reads back what encodeNrpn sends, for every param, with its mode active', () => {
    const wrong: string[] = []
    for (const def of PARAM_BY_KEY.values()) {
      if (!def.nrpn) continue
      for (const v of new Set([def.min, def.max, Math.round((def.min + def.max) / 2), def.min + 1])) {
        if (v > def.max) continue
        const msg = encodeNrpn(def, v)!
        const got = decodeNrpn(msg.param, msg.value, (d) => d === def)
        if (got?.def.key !== def.key || got.value !== v) wrong.push(`${def.key}=${v} -> ${got?.def.key}=${got?.value}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('reads what the synth sent from its panel (captured 2026-10-08)', () => {
    const none = () => false
    expect(decodeNrpn(8232, 1528, none)).toMatchObject({ def: { key: 'filter1cutoff' }, value: 191 })
    expect(decodeNrpn(7679, 8, none)).toMatchObject({ def: { key: 'prefxtype' }, value: 1 })
    expect(decodeNrpn(8064, 1537, none)).toMatchObject({ def: { key: 'env1bpmsync' }, value: 1 })
    expect(decodeNrpn(8064, 3072, none)).toMatchObject({ def: { key: 'env1delaysyncon' }, value: 0 })
    expect(decodeNrpn(7299, 477, none)).toMatchObject({ def: { key: 'arpgate' }, value: 93 })
    expect(decodeNrpn(8151, 0, none)).toBeNull() // sent with a patch change; not a param
  })
})

describe('PatchSync, from the synth’s panel', () => {
  const setup = async () => {
    const synth = new FakeHydrasynth()
    const sync = new PatchSync({ session: new HydrasynthSession(synth), channel: 1 })
    await settle(sync.open({ bank: 0, patch: 0 }))
    return { synth, sync }
  }

  it('follows a knob without sending it back, as one undo step that does send', async () => {
    const { synth, sync } = await setup()
    const before = sync.get().patch!.get('filter1cutoff')
    synth.panel(...knob(8232, 1280), ...knob(8232, 1528))
    await settle(sync.settled())
    expect(sync.get().patch!.get('filter1cutoff')).toBe(191)
    expect(synth.nrpns()).toEqual([])
    expect(sync.get().dirty).toBe(true)
    sync.undo()
    await settle(sync.settled())
    expect(sync.get().patch!.get('filter1cutoff')).toBe(before)
    expect(synth.nrpns()).toEqual([[8232, encodeNrpn(param('filter1cutoff'), before)!.value]])
  })

  it('sends the new mode’s values after a mode switch on the synth (it sends only the switch)', async () => {
    const { synth, sync } = await setup()
    synth.panel(...knob(7679, 7 * 8)) // Pre-FX type -> EQ
    await settle(sync.settled())
    expect(sync.get().patch!.get('prefxtype')).toBe(7)
    const sent = synth.nrpns().map(([n]) => n)
    expect(sent).not.toContain(7679)
    expect(sent).toEqual(expect.arrayContaining([8431, 8432, 7600, 7616, 7632]))
  })

  it('keeps a value for an inactive mode until the switch, as the synth sends them', async () => {
    const { synth, sync } = await setup()
    sync.set('env1bpmsync', 0)
    synth.panel(...knob(8064, 3072 + 5), ...knob(8064, 1537)) // synced Delay 5, then sync on
    await settle(sync.settled())
    expect(sync.get().patch!.get('env1delaysyncon')).toBe(5)
  })

  it('stops following once the synth changes patch, and says so', async () => {
    const { synth, sync } = await setup()
    synth.panel([0xb0, 0, 0], [0xb0, 32, 5], [0xc0, 17])
    expect(sync.get().synthSwitched).toEqual({ bank: 5, patch: 17 })
    const cutoff = sync.get().patch!.get('filter1cutoff')
    synth.panel(...knob(8232, 8))
    expect(sync.get().patch!.get('filter1cutoff')).toBe(cutoff)
  })

  it('ignores other MIDI channels', async () => {
    const { synth, sync } = await setup()
    const cutoff = sync.get().patch!.get('filter1cutoff')
    synth.panel(...knob(8232, 8).map(([s, ...rest]) => [s + 1, ...rest]))
    expect(sync.get().patch!.get('filter1cutoff')).toBe(cutoff)
  })
})
