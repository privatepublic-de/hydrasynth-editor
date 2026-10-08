import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('recorded wave cycles', () => {
  it('has one cycle of 512 points for every wave, normalised, with the picture colours', () => {
    const data = JSON.parse(readFileSync('public/wave-cycles.json', 'utf8'))
    expect(data.points).toBe(512)
    expect(data.waves).toHaveLength(219)
    for (const [w, wave] of data.waves.entries()) {
      const ints = new Int16Array(new Uint8Array(Buffer.from(wave.cycle, 'base64')).buffer)
      expect(ints.length, `wave ${w}`).toBe(512)
      expect(Math.max(...ints.map(Math.abs)), `wave ${w} peak`).toBeGreaterThan(32000)
      expect(wave.bars).toHaveLength(24)
      expect(wave.line).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})

describe('mixCycles', async () => {
  const { mixCycles } = await import('../src/ui/waveCycles')
  const wave = (level: number, values: number[]) => ({ cycle: Float32Array.from(values), level, line: '#000000', bars: [] })

  it('is each wave as drawn at the ends, and the level-weighted mix between', () => {
    const loud = wave(0.4, [1, -1])
    const quiet = wave(0.1, [-1, 1])
    expect([...mixCycles(loud, quiet, 0)]).toEqual([1, -1])
    expect([...mixCycles(loud, quiet, 1)]).toEqual([-1, 1])
    // Halfway the loud wave dominates: (0.2 - 0.05) / (0.2 + 0.05).
    expect(mixCycles(loud, quiet, 0.5)[0]).toBeCloseTo(0.6)
  })

  it('fades towards Silence', () => {
    expect(mixCycles(wave(0.3, [1, -1]), null, 0.75)[0]).toBeCloseTo(0.25)
  })
})
