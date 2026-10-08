import { describe, expect, it } from 'vitest'
import { Patch } from '../src/params/patch'
import { scanPosition, shownEntry, waveOf, wavelist } from '../src/ui/waves'
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

  it('shows the picked slot while it is in the list, else the one at the scan position', () => {
    const p = new Patch(fixtureBytes())
    p.set('osc1wavscanwave1', 3)
    p.set('osc1wavscanwave2', 40)
    p.set('osc1wavscanwave3', 0)
    for (const s of [4, 5, 6, 7, 8]) p.set(`osc1wavscanwave${s}`, 0)
    p.set('osc1wavscan', 0)
    expect(shownEntry(p, 1, undefined)?.slot).toBe(1)
    expect(shownEntry(p, 1, 2)?.slot).toBe(2)
    expect(shownEntry(p, 1, 3)?.slot).toBe(1)
  })
})
