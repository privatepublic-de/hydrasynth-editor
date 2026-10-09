import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { formatValue } from '../src/params/display'
import { param } from '../src/params/patch'
import { buildSpeechPatch, CALIBRATION, VOWEL_POS } from '../src/ui/speechPatch'
import { harmonicLevels } from '../src/ui/waveSpeech'

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
    // The phrase lasts its steps at the LFO rate (Hz per step), with the Speed macro in its middle
    // adding 96 raw (knob 64/128 * depth 24/128 * 1024).
    const hz = parseFloat(formatValue(param('lfo1ratesyncoff'), s.patch.get('lfo1ratesyncoff') + 96).replace(',', '.'))
    expect(s.ms).toBeCloseTo(((steps - 1) * 1000) / hz, -1)
  })

  it('opens on the vowel filter where the vowel sits: "ee" near I, "oo" near U', () => {
    const iy = buildSpeechPatch('ee')!
    const uw = buildSpeechPatch('ooh')!
    // Filt 1 Cutoff = 512 + step * 8 (base 512, depth +64).
    expect(512 + step(iy, 1, 1) * 8).toBe(VOWEL_POS.iy)
    expect(512 + step(uw, 1, 1) * 8).toBe(VOWEL_POS.uw)
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

  it('has Speed (LFO rates), Fundamental (OSC 3 with the voicing) and Voice (Formant Control) macros', () => {
    const s = buildSpeechPatch('hello world')!
    expect(s.patch.macroName(1)).toBe('Speed')
    expect(show(s, 'macro1panelvalue')).toBe('64,0')
    expect([1, 2, 3, 4, 5].map((i) => show(s, `macro1target${i}`))).toEqual(['LFO 1 Rate', 'LFO 2 Rate', 'LFO 3 Rate', 'LFO 4 Rate', 'LFO 5 Rate'])
    expect(new Set([1, 2, 3, 4, 5].map((i) => s.patch.get(`macro1depth${i}`))).size).toBe(1)
    expect(s.patch.macroName(2)).toBe('Fundamental')
    expect(show(s, 'macro2target1')).toBe('Matrix 8 Depth')
    expect(show(s, 'modmatrix8modsource')).toBe('LFO 2')
    expect(show(s, 'modmatrix8modtarget')).toBe('Osc 3 Vol')
    expect(show(s, 'osc3type')).toBe('Saw')
    expect(s.patch.macroName(3)).toBe('Voice')
    expect(show(s, 'macro3target1')).toBe('Filt 1 Control')
    // Formant Control 64 (raw 512) with the Voice knob in its middle: base + 64/128 * 32/128 * 1024.
    expect(s.patch.get('filter1special') + 128).toBe(512)
    expect(show(s, 'mixerosc3vol')).toBe('0,0')
  })

  describe('with waves', () => {
    const levels = JSON.parse(readFileSync('public/wave-cycles.json', 'utf8')).waves.map((w: { cycle: string }) =>
      harmonicLevels(Float32Array.from(new Int16Array(new Uint8Array(Buffer.from(w.cycle, 'base64')).buffer), (v) => v / 32767)),
    )
    const s = buildSpeechPatch('hello world', { waves: { levels, f0: 130.81 } })!

    it('scans a wave per voiced sound on LFO 5, and lets ENV 3 lower the pitch', () => {
      expect(show(s, 'osc1mode')).toBe('WaveScan')
      expect(show(s, 'modmatrix5modtarget')).toBe('Osc 1 WaveScan')
      expect(show(s, 'modmatrix6modsource')).toBe('Env 3')
      expect(show(s, 'modmatrix6modtarget')).toBe('Osc 1 Pitch')
      expect(show(s, 'osc1wavscanwave1')).not.toBe('Saw')
      // Every LFO 5 step lands on a slot: i/7 of the range, i a sounding slot.
      const slots = [1, 2, 3, 4, 5, 6, 7, 8].filter((n) => n === 1 || s.patch.get(`osc1wavscanwave${n}`) >= 2).length
      for (let n = 1; n <= s.patch.get('lfo5steps'); n++) {
        const slot = (step(s, 5, n) * 7) / 64
        expect(Math.abs(slot - Math.round(slot))).toBeLessThan(0.05)
        expect(Math.round(slot)).toBeLessThan(slots)
      }
    })

    it('leaves the Saw patch as it was without them', () => {
      const plain = buildSpeechPatch('hello world')!
      expect(show(plain, 'osc1mode')).toBe('Single')
      expect(show(plain, 'modmatrix5modtarget')).toBe('Osc 1 Pitch')
    })
  })
})
