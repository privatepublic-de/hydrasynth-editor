import { describe, expect, it } from 'vitest'
import { PARAMS } from '../src/params/generated'
import { Patch } from '../src/params/patch'
import { RULE_PATTERNS, isShown } from '../src/ui/visibility'
import { fixtureBytes } from './fakeSynth'

describe('control visibility', () => {
  const patch = () => new Patch(fixtureBytes())

  it('shows the wave in Single mode and the WaveScan controls in WaveScan mode', () => {
    const p = patch()
    p.set('osc1mode', 0)
    expect([isShown('osc1type', p), isShown('osc1wavscan', p), isShown('osc1wavscanwave3', p)]).toEqual([true, false, false])
    p.set('osc1mode', 1)
    expect([isShown('osc1type', p), isShown('osc1wavscan', p), isShown('osc1wavscanwave3', p)]).toEqual([false, true, true])
  })

  it('shows LFO steps only for the Step wave, and the vowel controls for both Vowel codes', () => {
    const p = patch()
    p.set('lfo2wave', 0)
    expect(isShown('lfo2step17', p)).toBe(false)
    p.set('lfo2wave', 10)
    expect([isShown('lfo2step17', p), isShown('lfo2steps', p), isShown('lfo2smooth', p)]).toEqual([true, true, true])
    p.set('filter1type', 10)
    expect(isShown('filter1vowelorder', p)).toBe(true)
    p.bytes[param1TypeOffset()] = 16
    expect(isShown('filter1vowelorder', p)).toBe(true)
    p.set('filter1type', 1)
    expect(isShown('filter1vowelorder', p)).toBe(false)
  })

  it('has no rule that matches no param', () => {
    for (const re of RULE_PATTERNS) expect(PARAMS.some((d) => re.test(d.key)), String(re)).toBe(true)
  })

  it('hides a matching key and shows everything else', () => {
    const hidden = PARAMS.filter((d) => !isShown(d.key, patch())).map((d) => d.key)
    expect(hidden.length).toBeGreaterThan(0)
    expect(hidden.every((k) => /^(osc|filter1|prefx|postfx|voiceglide|env|lfo)/.test(k))).toBe(true)
  })
})

function param1TypeOffset() {
  return PARAMS.find((d) => d.key === 'filter1type')!.field!.offset
}
