import { describe, expect, it } from 'vitest'
import { formatValue } from '../src/params/display'
import { param } from '../src/params/patch'
import { buildSpeechPatch, CALIBRATION } from '../src/ui/speechPatch'

const show = (p: ReturnType<typeof buildSpeechPatch>, key: string) => formatValue(param(key), p!.patch.get(key))
const step = (p: ReturnType<typeof buildSpeechPatch>, lfo: number, n: number) => (p!.patch.get(`lfo${lfo}step${n}`) - 512) / 8

describe('buildSpeechPatch', () => {
  it('sets up the voice, the noise and five one-shot step LFOs routed to their targets', () => {
    const s = buildSpeechPatch('hello world')!
    expect(show(s, 'filter1type')).toBe('Vowel')
    expect(show(s, 'filter1vowelorder')).toBe('AEIOU')
    expect(show(s, 'mixerfilterrouting')).toBe('Parallel')
    expect(show(s, 'mixernoisefilterratio')).toBe('0:100')
    expect(show(s, 'filter1keytrack')).toBe('0%')
    const targets = [1, 2, 3, 4, 5].map((m) => show(s, `modmatrix${m}modtarget`))
    expect(targets).toEqual(['Filt 1 Cutoff', 'Osc 1 Vol', 'Noise Vol', 'Filt 2 Cutoff', 'Osc 1 Pitch'])
    for (let l = 1; l <= 5; l++) {
      expect(show(s, `lfo${l}wave`)).toBe('Step')
      expect(show(s, `lfo${l}oneshot`)).toBe('On')
      expect(show(s, `modmatrix${l}modsource`)).toBe(`LFO ${l}`)
    }
    expect(s.patch.name).toBe('hello world')
  })

  it('marks the patch so steps 9-64 play', () => {
    const { offset, text } = CALIBRATION.extendedMarker
    const bytes = buildSpeechPatch('hi')!.patch.bytes
    expect(String.fromCharCode(...bytes.subarray(offset, offset + text.length))).toBe(text)
  })

  it('fits the phrase into the steps and ends silent', () => {
    const s = buildSpeechPatch('hello world')!
    const steps = s.patch.get('lfo1steps')
    expect(steps).toBeLessThanOrEqual(64)
    for (let l = 1; l <= 5; l++) expect(s.patch.get(`lfo${l}steps`)).toBe(steps)
    // The last step: no voice, no noise.
    expect(step(s, 2, steps)).toBe(0)
    expect(step(s, 3, steps)).toBe(0)
    // The phrase lasts its steps at the LFO rate (Hz per step).
    const hz = parseFloat(show(s, 'lfo1ratesyncoff').replace(',', '.'))
    expect(s.ms).toBeCloseTo(((steps - 1) * 1000) / hz, -1)
  })

  it('opens on the vowel filter where the vowel sits: "ee" on I, "oo" on U', () => {
    const iy = buildSpeechPatch('ee')!
    const uw = buildSpeechPatch('ooh')!
    // Filt 1 Cutoff = 512 + step * 8 (base 512, depth +64).
    expect(512 + step(iy, 1, 1) * 8).toBe(CALIBRATION.vowelAt.I)
    expect(512 + step(uw, 1, 1) * 8).toBe(CALIBRATION.vowelAt.U)
    // A hiss is noise without voice.
    const s = buildSpeechPatch('see')!
    expect(step(s, 3, 1)).toBeGreaterThan(40)
    expect(step(s, 2, 1)).toBe(0)
  })

  it('slower speech takes longer; nothing to say gives null; too much is cut', () => {
    expect(buildSpeechPatch('hello', { speed: 1.4 })!.ms).toBeGreaterThan(buildSpeechPatch('hello')!.ms)
    expect(buildSpeechPatch('')).toBeNull()
    const long = buildSpeechPatch('the quick brown fox jumps over the lazy dog and keeps on running far away')!
    expect(long.dropped).toBeGreaterThan(0)
    expect(long.patch.get('lfo1steps')).toBe(64)
  })
})
