import { describe, expect, it } from 'vitest'
import { choicesOf } from '../src/params/display'
import { Patch, param } from '../src/params/patch'
import { cutoffHz, filter1Gain, filter2Gain } from '../src/ui/filterResponse'
import { fixtureBytes } from './fakeSynth'

const db = (g: number) => 20 * Math.log10(g)

describe('filter response pictures', () => {
  const at = (type: number, reso = 0) => {
    const p = new Patch(fixtureBytes())
    p.set('filter1type', type)
    p.set('filter1cutoff', 512)
    p.set('filter1resonance', reso)
    return { p, fc: cutoffHz(512) }
  }

  it('passes the lows and falls 12 / 24 dB per octave above the cutoff for 2 and 4 poles', () => {
    for (const [type, slope] of [[0, 12], [1, 24]]) {
      const { p, fc } = at(type)
      expect(db(filter1Gain(p, fc / 16))).toBeCloseTo(0, 0)
      const drop = db(filter1Gain(p, fc * 8)) - db(filter1Gain(p, fc * 16))
      expect(drop).toBeCloseTo(slope, 0)
    }
  })

  it('peaks at the cutoff with resonance, and the high-pass types cut the lows', () => {
    const { p, fc } = at(0, 1024)
    expect(db(filter1Gain(p, fc))).toBeGreaterThan(18)
    const hp = at(6)
    expect(db(filter1Gain(hp.p, hp.fc / 16))).toBeLessThan(-40)
  })

  it('draws three formant peaks for Vowel, in the synth’s vowel orders', () => {
    expect(choicesOf(param('filter1vowelorder')).map(([, l]) => l)).toEqual(['AEIOU', 'AIUEO', 'AUIOE', 'AOUIE', 'IOUAE', 'UEAOI', 'IOEAU', 'UIEAO'])
    const { p } = at(10, 512)
    p.set('filter1vowelorder', 0)
    p.set('filter1special', 0)
    expect(filter1Gain(p, 730)).toBeGreaterThan(filter1Gain(p, 450) * 2)
  })

  it('morphs Filter 2 from low-pass through band-pass (or notch) to high-pass', () => {
    const p = new Patch(fixtureBytes())
    p.set('filter2cutoff', 512)
    p.set('filter2resonance', 300)
    p.set('filter2type', 0)
    const fc = cutoffHz(512)
    p.set('filter2morph', 0)
    expect(db(filter2Gain(p, fc / 16))).toBeCloseTo(0, 0)
    p.set('filter2morph', 1024)
    expect(db(filter2Gain(p, fc / 16))).toBeLessThan(-40)
    p.set('filter2type', 1)
    p.set('filter2morph', 512)
    expect(db(filter2Gain(p, fc))).toBeLessThan(-30)
  })
})
