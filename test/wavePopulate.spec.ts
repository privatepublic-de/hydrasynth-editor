import { describe, expect, it } from 'vitest'
import { WAVE_FEATURES } from '../src/ui/waveFeatures.generated'
import { FILL_STYLES, brightness, evenShare, family, fillWavelist, isHollow, seededRng } from '../src/ui/wavePopulate'

const name = (w: number) => WAVE_FEATURES[w].name
const index = (n: string) => WAVE_FEATURES.findIndex((w) => w.name === n)

describe('wave features', () => {
  it('reads the harmonic bars of the classic waves', () => {
    expect(brightness(index('Sine'))).toBeCloseTo(1)
    expect(evenShare(index('Square'))).toBeLessThan(0.05)
    expect(evenShare(index('Saw'))).toBeGreaterThan(0.4)
    expect(brightness(index('Harmon 10'))).toBeGreaterThan(brightness(index('Harmon 2')))
  })
})

describe('filling a wavelist', () => {
  for (const { id } of FILL_STYLES) {
    it(`${id}: eight different waves, over many seeds`, () => {
      for (let seed = 1; seed <= 40; seed++) {
        const list = fillWavelist(id, seededRng(seed), 3)
        expect(list).toHaveLength(8)
        expect(new Set(list).size).toBe(8)
        for (const w of list) expect(w >= 0 && w < WAVE_FEATURES.length).toBe(true)
      }
    })
  }

  it('gives each style its character', () => {
    const rng = seededRng(7)
    const fam = fillWavelist('family', rng)
    expect(new Set(fam.slice(0, 4).map(family)).size).toBe(1)
    const bright = fillWavelist('brighten', rng).map(brightness)
    expect(bright).toEqual([...bright].sort((a, b) => a - b))
    expect(fillWavelist('hollow', rng).every((w) => evenShare(w) < 0.3 && !name(w).startsWith('Harmon'))).toBe(true)
    expect(isHollow(index('Square'))).toBe(true)
    expect(isHollow(index('Harmon 4'))).toBe(false)
    const ladder = fillWavelist('ladder', rng).map(name)
    expect(ladder.every((n) => n.startsWith('Harmon'))).toBe(true)
    expect(fillWavelist('variations', rng, index('Saw'))[0]).toBe(index('Saw'))
  })
})
