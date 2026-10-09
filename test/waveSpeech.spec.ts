import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { WAVE_FEATURES } from '../src/ui/waveFeatures.generated'
import { harmonicLevels, SILENCE, speakWavelist, spellSounds } from '../src/ui/waveSpeech'

const data = JSON.parse(readFileSync('public/wave-cycles.json', 'utf8'))
const levels: number[][] = data.waves.map((w: { cycle: string }) =>
  harmonicLevels(Float32Array.from(new Int16Array(new Uint8Array(Buffer.from(w.cycle, 'base64')).buffer), (v) => v / 32767)),
)
const index = (n: string) => WAVE_FEATURES.findIndex((w) => w.name === n)

describe('harmonicLevels', () => {
  it('reads a sine as one harmonic and a saw as falling 6 dB per octave', () => {
    const n = 512
    const sine = harmonicLevels(Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * i) / n)))
    expect(sine[0]).toBeCloseTo(0)
    expect(Math.max(...sine.slice(1))).toBeLessThan(-80)
    const saw = levels[index('Saw')]
    expect(saw[1] - saw[0]).toBeCloseTo(-6, 0)
    expect(saw[3] - saw[0]).toBeCloseTo(-12, 0)
  })
})

describe('spellSounds', () => {
  it('spells common patterns and words', () => {
    expect(spellSounds('make')).toEqual(['m', 'ey', 'k'])
    expect(spellSounds('cheese')).toEqual(['ch', 'iy', 's'])
    expect(spellSounds('night')).toEqual(['n', 'ay', 't'])
    expect(spellSounds('my cat')).toEqual(['m', 'ay', '', 'k', 'ae', 't'])
    expect(spellSounds('the')).toEqual(['dh', 'ah'])
    expect(spellSounds('Boom!')).toEqual(['b', 'uw', 'm'])
  })
})

describe('speakWavelist', () => {
  it('gives eight slots, never Silence in slot 1, nothing for no words', () => {
    for (const text of ['hello world', 'yes', 'a', 'thank you very much', 'daisy daisy give me your answer do']) {
      const s = speakWavelist(text, levels)!
      expect(s.waves, text).toHaveLength(8)
      expect(s.sounds, text).toHaveLength(8)
      expect(s.waves[0], text).not.toBe(SILENCE)
      for (const w of s.waves) expect(w === SILENCE || (w >= 0 && w < WAVE_FEATURES.length), text).toBe(true)
    }
    expect(speakWavelist('', levels)).toBeNull()
    expect(speakWavelist('?!', levels)).toBeNull()
  })

  it('tells the vowels apart', () => {
    const vowel = (text: string) => speakWavelist(text, levels)!.waves[0]
    expect(spellSounds('aah ooh')).toEqual(['aa', '', 'uw'])
    const ee = vowel('ee')
    const ah = vowel('ah')
    const oo = vowel('ooh')
    expect(new Set([ee, ah, oo]).size).toBe(3)
  })

  it('holds short words, leaves out sounds from long ones', () => {
    const yes = speakWavelist('yes', levels)!
    expect(yes.sounds[0]).toBe('y')
    expect(yes.sounds.at(-1)).toBe('s')
    expect(yes.dropped).toBe(0)
    const long = speakWavelist('daisy daisy give me your answer do', levels)!
    expect(long.dropped).toBeGreaterThan(0)
    // Stops and word gaps go first: what's left is vowels.
    expect(long.sounds.every((s) => s !== '')).toBe(true)
  })

  it('tunes to the note: a higher note can pick other waves', () => {
    const low = speakWavelist('hello world', levels, 65.41)!.waves
    const high = speakWavelist('hello world', levels, 261.63)!.waves
    expect(low).not.toEqual(high)
  })
})

describe('the pronunciation dictionary', async () => {
  const { parsePronunciations, pronounce } = await import('../src/ui/waveSpeech')
  const dictionary = parsePronunciations(readFileSync('public/pronunciations.txt', 'utf8'))

  it('has the CMU words, front-coded lines decoded', () => {
    expect(dictionary.size).toBeGreaterThan(120000)
    expect(pronounce('voice', dictionary).map((s) => s.sound)).toEqual(['v', 'oy', 's'])
    expect(pronounce('orange', dictionary).map((s) => s.sound)).toEqual(['ao', 'r', 'ah', 'n', 'jh'])
  })

  it('marks stressed vowels (primary and secondary): hel-LO, RO-bot', () => {
    const stressed = (w: string) => pronounce(w, dictionary).filter((s) => s.stressed).map((s) => s.sound)
    expect(stressed('hello')).toEqual(['ow'])
    expect(stressed('robot')).toEqual(['ow', 'aa'])
  })

  it('falls back to the spelling rules for words it lacks', () => {
    expect(pronounce('hydrasynth', dictionary).map((s) => s.sound)).toEqual(pronounce('hydrasynth').map((s) => s.sound))
  })
})
