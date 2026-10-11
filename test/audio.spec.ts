import { describe, expect, it } from 'vitest'
import { analyse, wobble } from '../src/audio/analyse'
import { detectPeriod, noteName, noteOf } from '../src/audio/pitch'
import { harmonicsAt } from '../src/audio/spectrum'
import { parseWav } from '../src/audio/wav'
import { noise, RATE, sawAmps, tone, wavBytes } from './signals'

const cents = (a: number, b: number) => 1200 * Math.log2(a / b)

describe('parseWav', () => {
  const x = tone(440, [0.5], 0.05)
  for (const opts of [{ bits: 8 }, { bits: 16 }, { bits: 24 }, { bits: 32 }, { bits: 32, float: true }, { bits: 24, channels: 2 }, { bits: 16, extensible: true }, { bits: 32, float: true, extensible: true }]) {
    it(`reads ${JSON.stringify(opts)}`, () => {
      const audio = parseWav(wavBytes(x, opts))
      expect(audio.sampleRate).toBe(RATE)
      expect(audio.samples.length).toBe(x.length)
      const tolerance = opts.bits === 8 ? 0.01 : 1e-4
      for (let i = 0; i < x.length; i += 37) expect(Math.abs(audio.samples[i] - x[i])).toBeLessThan(tolerance)
    })
  }

  it('says why it can’t read a file', () => {
    expect(() => parseWav(new TextEncoder().encode('hello, this is text'))).toThrow('isn’t a WAV')
    const adpcm = wavBytes(x)
    new DataView(adpcm.buffer).setUint16(20, 2, true)
    expect(() => parseWav(adpcm)).toThrow('Compressed')
  })
})

describe('pitch', () => {
  it('finds notes from 41 Hz to 1.7 kHz within 2 cents, at 44.1 and 48 kHz', () => {
    for (const rate of [44100, 48000])
      for (const f0 of [41.2, 65.41, 110, 220, 233.08, 440, 1046.5, 1760]) {
        const x = tone(f0, sawAmps(f0, 8000), 0.4, { rate })
        const { period, clarity } = detectPeriod(x, rate)
        expect(Math.abs(cents(rate / period, f0))).toBeLessThan(2)
        expect(clarity).toBeGreaterThan(0.95)
      }
  })

  it('keeps the note when its fundamental is weak', () => {
    const x = tone(110, [0.05, 1, 0.6, 0.4, 0.3], 0.4)
    const { period } = detectPeriod(x, RATE)
    expect(Math.abs(cents(RATE / period, 110))).toBeLessThan(5)
  })

  it('finds no clear note in noise', () => {
    expect(detectPeriod(noise(0.4), RATE).clarity).toBeLessThan(0.8)
  })

  it('names notes as the synth does', () => {
    expect(noteOf(65.41)).toEqual({ midi: 36, cents: 0 })
    expect(noteName(36)).toBe('C2')
    expect(noteName(69)).toBe('A4')
    expect(noteOf(446).cents).toBe(23)
  })
})

describe('harmonicsAt', () => {
  it('reads a saw’s harmonics, falling 6 dB per octave, at any pitch', () => {
    for (const f0 of [82.4, 220, 523.25]) {
      const x = tone(f0, sawAmps(f0), 0.3)
      const h = harmonicsAt(x, RATE, f0, 0, x.length, 8)
      expect(h.levels[0]).toBeCloseTo(0, 1)
      expect(h.levels[1]).toBeCloseTo(-6.02, 0)
      expect(h.levels[3]).toBeCloseTo(-12.04, 0)
      expect(h.share).toBeGreaterThan(0.9)
    }
  })
})

describe('analyse', () => {
  const pluck = tone(220, sawAmps(220), 1.5, { level: (t) => Math.min(1, t / 0.005) * Math.exp(-t / 0.15) })
  const pad = tone(110, sawAmps(110), 3, { level: (t) => (t < 0.8 ? t / 0.8 : 1) * (t > 2.5 ? Math.max(0, 1 - (t - 2.5) / 0.3) : 1) })

  it('finds the note and its pitch', () => {
    const a = analyse({ samples: tone(233.08, sawAmps(233.08), 1), sampleRate: RATE })
    expect(a.midi).toBe(58)
    expect(Math.abs(a.cents)).toBeLessThanOrEqual(1)
    expect(a.warnings).toEqual([])
  })

  it('reads a pluck as a fast attack and a decay to nothing', () => {
    const { adsr } = analyse({ samples: pluck, sampleRate: RATE })
    expect(adsr.attackS).toBeLessThan(0.02)
    expect(adsr.sustain).toBe(0)
    // -40 dB of e^(-t/0.15): 0.15 * ln(100) = 0.69 s.
    expect(adsr.decayS).toBeGreaterThan(0.6)
    expect(adsr.decayS).toBeLessThan(0.8)
  })

  it('reads a pad as a slow attack, a sustain and a release', () => {
    const a = analyse({ samples: pad, sampleRate: RATE })
    expect(a.adsr.attackS).toBeGreaterThan(0.6)
    expect(a.adsr.attackS).toBeLessThan(1)
    expect(a.adsr.sustain).toBeGreaterThan(0.9)
    expect(a.adsr.releaseS).toBeGreaterThan(0.2)
    expect(a.adsr.releaseS).toBeLessThan(0.35)
    expect(a.held).toBe(false)
  })

  it('knows a note cut off by the file’s end is held', () => {
    const a = analyse({ samples: tone(220, sawAmps(220), 1), sampleRate: RATE })
    expect(a.held).toBe(true)
    expect(a.adsr.sustain).toBeGreaterThan(0.9)
  })

  it('follows the brightness of a note that darkens', () => {
    // Each harmonic fades the faster the higher it is.
    const n = 30
    const x = new Float32Array(Math.round(1 * RATE))
    for (let k = 1; k <= n; k++) {
      const part = tone(110 * k, [0.5 / k], 1, { level: (t) => Math.exp(-t * k * 0.5) })
      for (let i = 0; i < x.length; i++) x[i] += part[i]
    }
    const { frames } = analyse({ samples: x, sampleRate: RATE })
    expect(frames.length).toBeGreaterThan(15)
    expect(frames.at(-1)!.harmonics.centroid).toBeLessThan(frames[1].harmonics.centroid * 0.6)
  })

  it('finds vibrato and tremolo, and none in a steady note', () => {
    const vib = analyse({ samples: tone(220, sawAmps(220), 2, { cents: (t) => 30 * Math.sin(2 * Math.PI * 5.5 * t) }), sampleRate: RATE })
    expect(vib.vibrato!.rateHz).toBeCloseTo(5.5, 0)
    expect(vib.vibrato!.depth).toBeGreaterThan(20)
    expect(vib.vibrato!.depth).toBeLessThan(40)
    expect(vib.tremolo).toBeNull()
    const trem = analyse({ samples: tone(220, sawAmps(220), 2, { level: (t) => 10 ** ((3 * Math.sin(2 * Math.PI * 6 * t)) / 20) * 0.5 }), sampleRate: RATE })
    expect(trem.tremolo!.rateHz).toBeCloseTo(6, 0)
    expect(trem.tremolo!.depth).toBeGreaterThan(2)
    expect(trem.tremolo!.depth).toBeLessThan(4)
    expect(trem.vibrato).toBeNull()
    const steady = analyse({ samples: tone(220, sawAmps(220), 2), sampleRate: RATE })
    expect(steady.vibrato).toBeNull()
    expect(steady.tremolo).toBeNull()
  })

  it('warns about noise, chords and clipping, and refuses silence', () => {
    expect(analyse({ samples: noise(1), sampleRate: RATE }).warnings).toContain('no clear single note')
    const chord = tone(220, [0.3], 1)
    const third = tone(277.18, [0.3], 1)
    const fifth = tone(329.63, [0.3], 1)
    for (let i = 0; i < chord.length; i++) chord[i] += third[i] + fifth[i]
    const c = analyse({ samples: chord, sampleRate: RATE })
    expect(c.warnings.some((w) => w === 'no clear single note' || w === 'inharmonic or noisy')).toBe(true)
    expect(analyse({ samples: tone(220, [1.5], 1).map((v) => Math.max(-1, Math.min(1, v))), sampleRate: RATE }).warnings).toContain('clipped')
    expect(() => analyse({ samples: new Float32Array(RATE), sampleRate: RATE })).toThrow('silent')
  })

  it('is not fooled by wobble on noise', () => {
    expect(wobble(Array.from(noise(1).subarray(0, 100)), 0.02, 0.01)?.depth ?? 0).toBeLessThan(0.5)
  })
})
