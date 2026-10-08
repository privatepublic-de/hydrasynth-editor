import { describe, expect, it } from 'vitest'
import { choicesOf } from '../src/params/display'
import { PARAMS } from '../src/params/generated'
import { Patch, param } from '../src/params/patch'
import { DESTINATION_KEYS, destinationOf, freeMacroSlot, freeRoute, modulations } from '../src/ui/modDestinations'
import { fixtureBytes } from './fakeSynth'

const names = choicesOf(param('modmatrix1modtarget')).map(([, l]) => l)

describe('mod destinations', () => {
  it('has one entry per destination, and every key it names exists', () => {
    expect(DESTINATION_KEYS).toHaveLength(names.length)
    const known = new Set(PARAMS.map((p) => p.key))
    for (const keys of DESTINATION_KEYS) for (const k of keys ?? []) expect(known.has(k), k).toBe(true)
  })

  it('lines up with the synth’s destination names', () => {
    const check = (key: string, name: string) => expect(names[destinationOf(key)!], key).toBe(name)
    check('arpchance', 'Arp Chance')
    check('osc2cent', 'Osc 2 Pitch')
    check('mutant3warp8', 'Mut 3 Warp 8')
    check('mixernoisefilterratio', 'Noise F1/2')
    check('filter1special', 'Filt 1 Control')
    check('filter2keytrack', 'Filt 2 Keytrack')
    check('prefx7param2', 'Pre-FX Param2')
    check('delaytimesyncon', 'Delay Time')
    check('postfxwet', 'Post-FX Dry/Wet')
    check('env5releasesyncoff', 'Env 5 Release')
    check('lfo5level', 'LFO 5 Level')
    check('modmatrix32depth', 'Matrix 32 Depth')
    check('macro8panelvalue', 'Macro 8')
    check('voiceglidetime', 'Glide Time')
    expect(names[DESTINATION_KEYS.indexOf(null, 200)]).toBe('CV Mod Out 1')
  })

  it('finds what modulates a param, and free routes and macro slots', () => {
    const p = new Patch(fixtureBytes())
    for (let r = 1; r <= 32; r++) {
      p.set(`modmatrix${r}modtarget`, 0)
      p.set(`modmatrix${r}modsource`, 0)
    }
    for (let m = 1; m <= 8; m++) for (let s = 1; s <= 8; s++) p.set(`macro${m}target${s}`, 0)
    expect(freeRoute(p)).toBe(1)
    p.set('modmatrix1modtarget', destinationOf('filter1cutoff')!)
    expect(modulations(p).get('filter1cutoff')).toBeUndefined() // no source yet
    p.set('modmatrix1modsource', 3)
    p.set('macro2target1', destinationOf('filter1cutoff')!)
    expect(modulations(p).get('filter1cutoff')).toEqual([
      { kind: 'matrix', route: 1 },
      { kind: 'macro', macro: 2, slot: 1 },
    ])
    expect(freeRoute(p)).toBe(2)
    expect(freeMacroSlot(p, 2)).toBe(2)
  })
})
