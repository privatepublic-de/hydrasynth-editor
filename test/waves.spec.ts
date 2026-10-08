import { describe, expect, it } from 'vitest'
import { Patch } from '../src/params/patch'
import { entryPositions, morphAt, scanPosition, slotShares, waveOf, wavelist } from '../src/ui/waves'
import { fixtureBytes } from './fakeSynth'

describe('wavelist', () => {
  it('maps slot values to waves: slot 1 directly, slots 2-8 after Off and Silence', () => {
    expect(waveOf('osc1type', 3)).toBe(3)
    expect(waveOf('osc1wavscanwave1', 0)).toBe(0)
    expect(waveOf('osc1wavscanwave2', 0)).toBeNull()
    expect(waveOf('osc1wavscanwave2', 1)).toBe('silence')
    expect(waveOf('osc1wavscanwave2', 5)).toBe(3)
    expect(waveOf('filter1type', 3)).toBeNull()
  })

  it('drops Off slots, so later waves move up, and finds the nearest to the scan position', () => {
    const p = new Patch(fixtureBytes())
    p.set('osc1wavscanwave1', 3)
    p.set('osc1wavscanwave2', 0)
    p.set('osc1wavscanwave3', 40)
    p.set('osc1wavscanwave4', 1)
    for (const s of [5, 6, 7, 8]) p.set(`osc1wavscanwave${s}`, 0)
    const list = wavelist(p, 1)
    expect(list).toEqual([
      { slot: 1, wave: 3 },
      { slot: 3, wave: 38 },
      { slot: 4, wave: 'silence' },
    ])
    p.set('osc1wavscan', 1024)
    expect(scanPosition(p, 1, list.length)).toBe(2)
  })

  it('splits the sound between the two waves around the scan position, skipping Off slots', () => {
    const p = new Patch(fixtureBytes())
    p.set('osc1wavscanwave1', 3)
    p.set('osc1wavscanwave2', 0) // Off: wave 3 sounds second
    p.set('osc1wavscanwave3', 40)
    p.set('osc1wavscanwave4', 60)
    for (const s of [5, 6, 7, 8]) p.set(`osc1wavscanwave${s}`, 0)
    p.set('osc1wavscan', 0)
    expect([...slotShares(p, 1)]).toEqual([[1, 1]])
    p.set('osc1wavscan', Math.round((1.25 / 7) * 1024)) // between the 2nd and 3rd sounding waves
    const shares = slotShares(p, 1)
    expect(shares.get(3)).toBeCloseTo(0.75, 1)
    expect(shares.get(4)).toBeCloseTo(0.25, 1)
    expect(shares.has(2)).toBe(false)
    p.set('osc1wavscan', 1024) // past the last wave: it alone
    expect(morphAt(p, 1)).toMatchObject({ from: { slot: 4 }, towards: 0 })
    expect(entryPositions(p, 1).map((e) => e.slot)).toEqual([1, 3, 4])
  })
})
