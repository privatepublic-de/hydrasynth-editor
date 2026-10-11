import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyse } from '../src/audio/analyse'
import { parseWav } from '../src/audio/wav'
import { formatValue } from '../src/params/display'
import { param, type Patch } from '../src/params/patch'
import { labelNumber, rawFor } from '../src/ui/timeTables'
import { decodeCycle } from '../src/ui/waveCycles'
import { WAVE_FEATURES } from '../src/ui/waveFeatures.generated'
import { harmonicLevels } from '../src/ui/waveSpeech'
import { FM_CALIBRATION } from '../src/ui/fmModel'
import { buildWavPatch, CALIBRATION, distance, fitFm, fitWave, wavStatus } from '../src/ui/wavPatch'
import { RATE, sawAmps, tone } from './signals'

const data = JSON.parse(readFileSync('public/wave-cycles.json', 'utf8'))
const cycles: (Float32Array | null)[] = data.waves.map((w: { cycle: string } | null) => w && decodeCycle(w.cycle))
const levels = cycles.map((c) => (c ? harmonicLevels(c) : null))
const index = (n: string) => WAVE_FEATURES.findIndex((w) => w.name === n)
const show = (p: Patch, key: string) => formatValue(param(key), p.get(key))

/** `cycle` played at `f0` for `seconds`, shaped by `level(t)`. */
function play(cycle: Float32Array, f0: number, seconds: number, level: (t: number) => number = () => 1) {
  const n = cycle.length
  return Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => {
    const pos = ((i * f0 * n) / RATE) % n
    const k = Math.floor(pos)
    const f = pos - k
    return 0.5 * level(i / RATE) * (cycle[k] * (1 - f) + cycle[(k + 1) % n] * f)
  })
}

describe('timeTables', () => {
  it('reads labels and finds the nearest raw value', () => {
    expect(labelNumber('448ms')).toBe(448)
    expect(labelNumber('1.28s')).toBe(1280)
    expect(labelNumber('5,5')).toBe(5.5)
    expect(formatValue(param('env2attacksyncoff'), rawFor('env2attacksyncoff', 448))).toBe('448ms')
    expect(formatValue(param('env2decaysyncoff'), rawFor('env2decaysyncoff', 896))).toBe('896ms')
    expect(formatValue(param('lfo1ratesyncoff'), rawFor('lfo1ratesyncoff', 1))).toBe('1.00')
    expect(rawFor('env2attacksyncoff', 0)).toBe(0)
  })
})

describe('fitWave', () => {
  it('finds the wave a note was played with, at notes far from C2', () => {
    for (const name of ['Saw', 'Square', 'Pulse 3', 'Horizon 2', 'Vokz 1'])
      for (const f0 of [110, 220, 392]) {
        const w = index(name)
        const a = analyse({ samples: play(cycles[w]!, f0, 0.6), sampleRate: RATE })
        expect(fitWave(a.spectrum.levels, levels).wave, `${name} at ${f0} Hz`).toBe(w)
      }
  })

  it('hears a low-passed saw as a saw with the cutoff where it was', () => {
    const f0 = 110
    // A saw through a two-pole low-pass at 8x the pitch: harmonics past it fall 12 dB an octave.
    const amps = sawAmps(f0).map((a, k) => a / Math.hypot(1 - ((k + 1) / 8) ** 2, (k + 1) / 8 / 0.54))
    const a = analyse({ samples: tone(f0, amps, 0.6), sampleRate: RATE })
    const fit = fitWave(a.spectrum.levels, levels)
    expect(WAVE_FEATURES[fit.wave].name).toMatch(/Saw/)
    expect(Math.log2(fit.cutoff / 8)).toBeCloseTo(0, 0)
  })

  it('takes out an overall level difference', () => {
    const saw = levels[index('Saw')]!
    expect(distance(saw.map((v) => v - 6), saw)).toBeCloseTo(0)
  })
})

describe('buildWavPatch', () => {
  const saw = analyse({ samples: tone(220, sawAmps(220), 1), sampleRate: RATE })

  it('plays the wave through an LP Ladder 12 that keeps its place among the harmonics', () => {
    const w = buildWavPatch(saw, { levels, name: 'a very long sample name.wav' })
    expect(w.patch.name).toBe('a very long samp')
    expect(show(w.patch, 'osc1mode')).toBe('Single')
    expect(show(w.patch, 'osc1type')).toBe('Saw')
    expect(show(w.patch, 'filter1type')).toBe('LP Ladder 12')
    expect(show(w.patch, 'filter1keytrack')).toBe('100%')
    expect(w.note).toBe('A3')
    expect(wavStatus(w)).toBe(`Play A3: Saw, vibrato on the Mod Wheel; fit ${w.fit.toFixed(1)} dB`)
  })

  it('sets the Amp envelope as recorded, or from a preset', () => {
    const pluck = analyse({ samples: tone(220, sawAmps(220), 1.5, { level: (t) => Math.min(1, t / 0.005) * Math.exp(-t / 0.15) }), sampleRate: RATE })
    const p = buildWavPatch(pluck, { levels, overTime: false }).patch
    expect(show(p, 'env2sustain')).toBe('0.0')
    expect(labelNumber(show(p, 'env2attacksyncoff'))).toBeLessThan(20)
    const decayMs = labelNumber(show(p, 'env2decaysyncoff')) * CALIBRATION.ampDecayFactor
    expect(decayMs).toBeGreaterThan(500)
    expect(decayMs).toBeLessThan(1000)
    const pad = buildWavPatch(pluck, { levels, envelope: 'pad' }).patch
    expect(show(pad, 'env2attacksyncoff')).toMatch(/ms|s/)
    expect(labelNumber(show(pad, 'env2attacksyncoff'))).toBeGreaterThan(600)
    expect(pad.get('env2sustain')).toBeGreaterThan(512)
  })

  it('follows a note that darkens with a filter envelope, and its changing waves with WaveScan', () => {
    // A square that turns into a saw over a second, and darkens as it goes.
    const square = cycles[index('Square')]!
    const sawCycle = cycles[index('Saw')]!
    const x = play(square, 165, 1.5)
    const y = play(sawCycle, 165, 1.5)
    const mixed = x.map((v, i) => {
      const t = Math.min(1, i / RATE)
      return v * (1 - t) + y[i] * t
    })
    const a = analyse({ samples: mixed, sampleRate: RATE })
    const w = buildWavPatch(a, { levels })
    expect(w.waves.length).toBeGreaterThan(1)
    expect(show(w.patch, 'osc1mode')).toBe('WaveScan')
    expect(show(w.patch, 'osc1wavscanwave1')).toBe(WAVE_FEATURES[w.waves[0]].name)
    expect(show(w.patch, 'modmatrix1modsource')).toBe('Env 3')
    expect(show(w.patch, 'modmatrix1modtarget')).toBe('Osc 1 WaveScan')
    // Depth 128 reaches position 8: n waves need (n - 1)/7 of it.
    expect(parseFloat(show(w.patch, 'modmatrix1depth'))).toBeCloseTo((128 * (w.waves.length - 1)) / 7, 0)
    expect(wavStatus(w)).toContain(`${w.waves.length} waves by WaveScan`)
    expect(buildWavPatch(a, { levels, overTime: false }).waves).toHaveLength(1)

    const n = 20
    const dark = new Float32Array(RATE)
    for (let k = 1; k <= n; k++) {
      const part = tone(220 * k, [0.5 / k], 1, { level: (t) => Math.exp(-t * k * 0.6) })
      for (let i = 0; i < dark.length; i++) dark[i] += part[i]
    }
    const d = buildWavPatch(analyse({ samples: dark, sampleRate: RATE }), { levels })
    expect(d.filterEnvelope).toBe(true)
    expect(d.patch.get('filter1env1amount')).toBeGreaterThan(512)
    expect(wavStatus(d)).toContain('filter envelope')
  })

  it('puts vibrato on LFO 1 and tremolo on the Amp’s LFO 2', () => {
    const a = analyse({
      samples: tone(220, sawAmps(220), 2, { cents: (t) => 30 * Math.sin(2 * Math.PI * 5.5 * t), level: (t) => 0.5 * 10 ** ((2 * Math.sin(2 * Math.PI * 4 * t)) / 20) }),
      sampleRate: RATE,
    })
    const w = buildWavPatch(a, { levels })
    expect(show(w.patch, 'modmatrix2modsource')).toBe('LFO 1')
    expect(show(w.patch, 'modmatrix2modtarget')).toBe('Osc 1 Pitch')
    expect(labelNumber(show(w.patch, 'lfo1ratesyncoff'))).toBeCloseTo(5.5, 0)
    expect(labelNumber(show(w.patch, 'lfo2ratesyncoff'))).toBeCloseTo(4, 0)
    expect(w.patch.get('amplfo2amount')).toBeGreaterThan(512)
    expect(wavStatus(w)).toMatch(/vibrato 5\.\d Hz, tremolo 4\.\d Hz/)
    const still = buildWavPatch(a, { levels, wobble: false })
    expect(still.vibrato).toBeNull()
    expect(still.patch.get('amplfo2amount')).toBe(512)
  })

  it('plays one wave when nothing was followed over time (a note too short for its frames)', () => {
    const w = buildWavPatch({ ...saw, frames: [] }, { levels })
    expect(w.waves).toHaveLength(1)
    expect(w.filterEnvelope).toBe(false)
  })

  it('names what may be off in the status', () => {
    const w = buildWavPatch(saw, { levels })
    expect(wavStatus({ ...w, warnings: ['noisy', 'clipped'] })).toMatch(/\(noisy, clipped: best effort\)$/)
  })
})

/** A Sine at `f0` phase-modulated as Mutant FM does (fmModel), at `ratio` and Depth `depth(t)` (raw). */
function fmTone(f0: number, ratio: number, depth: (t: number) => number, seconds: number) {
  return Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => {
    const t = i / RATE
    const ph = 2 * Math.PI * f0 * t
    return 0.5 * Math.sin(ph + depth(t) * FM_CALIBRATION.indexPerRaw * Math.sin(ratio * ph + FM_CALIBRATION.modulatorPhase))
  })
}

describe('Mutant FM', () => {
  it('finds the ratio and depth a note was played with', () => {
    for (const [ratio, depth] of [[1, 256], [2, 384], [3, 192], [5, 128]]) {
      const a = analyse({ samples: fmTone(220, ratio, () => depth, 0.6), sampleRate: RATE })
      const fit = fitFm(a.spectrum.levels)
      expect(fit.ratio, `ratio ${ratio}, depth ${depth}`).toBe(ratio)
      expect(Math.abs(fit.depth - depth), `ratio ${ratio}, depth ${depth}`).toBeLessThanOrEqual(16)
    }
  })

  it('plays it on a Sine through Mutant 1, and Auto takes it only where it fits better', () => {
    const a = analyse({ samples: fmTone(220, 3, () => 384, 1), sampleRate: RATE })
    const w = buildWavPatch(a, { levels, source: 'fm' })
    expect(show(w.patch, 'osc1type')).toBe('Sine')
    expect(show(w.patch, 'mutant1mode')).toBe('FM-Linear')
    expect(show(w.patch, 'mutant1sourcefmlin')).toBe('Sine')
    expect(show(w.patch, 'mutant1ratio')).toBe('3.000')
    expect(show(w.patch, 'mutant1wet')).toBe('100%')
    expect(w.fm).toEqual({ ratio: 3, depth: 384, envelope: false })
    expect(wavStatus(w)).toMatch(/^Play A3: Mutant FM 3:1, depth 48,/)
    expect(buildWavPatch(a, { levels, source: 'auto' }).fm).not.toBeNull()
    const saw = analyse({ samples: play(cycles[index('Saw')]!, 220, 0.6), sampleRate: RATE })
    const auto = buildWavPatch(saw, { levels, source: 'auto' })
    expect(auto.fm).toBeNull()
    expect(show(auto.patch, 'osc1type')).toBe('Saw')
    expect(show(auto.patch, 'mutant1wet')).toBe('0%')
  })

  it('follows a depth that falls with ENV 3 on Mut 1 Depth', () => {
    const a = analyse({ samples: fmTone(220, 2, (t) => 128 + 512 * Math.max(0, 1 - t / 0.6), 1.2), sampleRate: RATE })
    const w = buildWavPatch(a, { levels, source: 'fm' })
    expect(w.fm!.envelope).toBe(true)
    expect(Math.abs(w.fm!.depth - 128)).toBeLessThanOrEqual(32)
    expect(show(w.patch, 'modmatrix1modsource')).toBe('Env 3')
    expect(show(w.patch, 'modmatrix1modtarget')).toMatch(/Mut.*1.*Depth/)
    // A route at depth d moves the Depth d * 8 raw: about 512 here.
    expect(parseFloat(show(w.patch, 'modmatrix1depth'))).toBeGreaterThan(48)
    expect(labelNumber(show(w.patch, 'env3decaysyncoff'))).toBeGreaterThan(400)
    expect(wavStatus(w)).toContain('depth envelope')
  })
})

// The synth's own waves, recorded at C2 (tools/recordWaves.ts), when local/ has them.
describe.skipIf(!existsSync('local/wave-recordings/0.wav'))('fitWave on the synth’s recordings', () => {
  it('finds the waves themselves, where they read as C2', () => {
    // Others read higher: a Harmon wave is a sine at a higher harmonic (and plays as a Sine there),
    // and a few lack the odd harmonics, so they repeat an octave up.
    let found = 0
    let tried = 0
    for (let w = 0; w < WAVE_FEATURES.length; w += 5) {
      const a = analyse(parseWav(readFileSync(`local/wave-recordings/${w}.wav`)))
      if (a.midi !== 36) continue
      tried++
      if (fitWave(a.spectrum.levels, levels).wave === w) found++
    }
    expect(tried).toBeGreaterThan(30)
    expect(found / tried).toBeGreaterThan(0.95)
  })
})
