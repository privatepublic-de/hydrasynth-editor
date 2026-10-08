import { describe, expect, it } from 'vitest'
import { PARAMS } from '../src/params/generated'
import { Patch, param } from '../src/params/patch'
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

  it('shows each Mutant mode only the controls the synth shows', () => {
    const p = patch()
    const shown = (mode: number) => {
      p.set('mutant1mode', mode)
      const keys = ['sourcefmlin', 'sourceoscsync', 'ratio', 'depth', 'window', 'feedback', 'warp3', 'wet']
      return keys.filter((k) => p.isActive(param(`mutant1${k}`)) && isShown(`mutant1${k}`, p))
    }
    p.set('mutant1sourcefmlin', 0)
    expect(shown(0)).toEqual(['sourcefmlin', 'ratio', 'depth', 'feedback', 'wet'])
    p.set('mutant1sourcefmlin', 2)
    expect(shown(0)).toEqual(['sourcefmlin', 'depth', 'feedback', 'wet'])
    expect(shown(1)).toEqual(['depth', 'wet'])
    expect(shown(2)).toEqual(['sourceoscsync', 'ratio', 'depth', 'window', 'feedback', 'wet'])
    expect(shown(3)).toEqual(['ratio', 'depth', 'feedback', 'wet'])
    expect(shown(5)).toEqual(['ratio', 'depth', 'feedback', 'warp3', 'wet'])
    expect(shown(7)).toEqual(['depth', 'feedback', 'wet'])
  })

  it('gives the FX knobs no meaning under Bypass, so only Dry/Wet remains', () => {
    const p = patch()
    p.set('prefxtype', 0)
    const fxParams = PARAMS.filter((d) => /^prefx\dparam\d$/.test(d.key))
    expect(fxParams.filter((d) => p.isActive(d))).toEqual([])
    p.set('prefxtype', 7)
    expect(fxParams.filter((d) => p.isActive(d)).map((d) => d.key)).toEqual(['prefx7param1', 'prefx7param2', 'prefx7param3', 'prefx7param4', 'prefx7param5'])
  })

  it('has no rule that matches no param', () => {
    for (const re of RULE_PATTERNS) expect(PARAMS.some((d) => re.test(d.key)), String(re)).toBe(true)
  })

  it('hides a matching key and shows everything else', () => {
    const hidden = PARAMS.filter((d) => !isShown(d.key, patch())).map((d) => d.key)
    expect(hidden.length).toBeGreaterThan(0)
    expect(hidden.every((k) => /^(osc|mutant|filter1|prefx|postfx|voiceglide|env|lfo)/.test(k))).toBe(true)
  })
})

function param1TypeOffset() {
  return PARAMS.find((d) => d.key === 'filter1type')!.field!.offset
}
