import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyse } from '../src/audio/analyse'
import { parseWav } from '../src/audio/wav'
import { formatValue } from '../src/params/display'
import { param, type Patch } from '../src/params/patch'
import { labelNumber, rawFor } from '../src/ui/timeTables'
import { decodeCycle } from '../src/ui/waveCycles'
import { WAVE_FEATURES } from '../src/ui/waveFeatures.generated'
import { harmonicAmps, harmonicLevels } from '../src/ui/waveSpeech'
import { FM_CALIBRATION } from '../src/ui/fmModel'
import { destinationOf } from '../src/ui/modDestinations'
import { buildWavPatch, CALIBRATION, distance, filterDb, fitFm, fitWave, wavStatus } from '../src/ui/wavPatch'
import { ensemble, noise, RATE, sawAmps, tone } from './signals'

const data = JSON.parse(readFileSync('public/wave-cycles.json', 'utf8'))
const cycles: (Float32Array | null)[] = data.waves.map((w: { cycle: string } | null) => w && decodeCycle(w.cycle))
const levels = cycles.map((c) => (c ? harmonicLevels(c) : null))
const peaks: (number | null)[] = data.waves.map((w: { level: number } | null, i: number) => w && w.level * Math.max(...harmonicAmps(cycles[i]!)))
const index = (n: string) => WAVE_FEATURES.findIndex((w) => w.name === n)
/** `key` as the patch plays it: plus what any macro on it adds at its knob (depth d: d * 8 raw over the knob). */
function played(p: Patch, key: string): number {
  let v = p.get(key)
  for (let m = 1; m <= 8; m++)
    for (let slot = 1; slot <= 8; slot++)
      if (p.get(`macro${m}target${slot}`) === destinationOf(key))
        v += ((p.get(`macro${m}depth${slot}`) - 512) / 4) * 8 * (p.get(`macro${m}panelvalue`) / 1024)
  return Math.round(v)
}
const show = (p: Patch, key: string) => formatValue(param(key), played(p, key))

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
    expect(wavStatus(w)).toBe('Play A3: Saw, vibrato on the Mod Wheel')
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
    expect(played(pad, 'env2sustain')).toBeGreaterThan(512)
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
    expect(wavStatus(w)).toMatch(new RegExp(`: ${WAVE_FEATURES[w.waves[0]].name} → .*${WAVE_FEATURES[w.waves.at(-1)!].name} by WaveScan`))
    expect(buildWavPatch(a, { levels, overTime: false }).waves).toHaveLength(1)

    const n = 20
    const dark = new Float32Array(RATE)
    for (let k = 1; k <= n; k++) {
      const part = tone(220 * k, [0.5 / k], 1, { level: (t) => Math.exp(-t * k * 0.6) })
      for (let i = 0; i < dark.length; i++) dark[i] += part[i]
    }
    const d = buildWavPatch(analyse({ samples: dark, sampleRate: RATE }), { levels })
    expect(d.filterEnvelope).toBe(true)
    expect(played(d.patch, 'filter1env1amount')).toBeGreaterThan(512)
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

  it('puts what to shape next on macros, each knob where the patch is', () => {
    const w = buildWavPatch(saw, { levels })
    expect(w.macros).toEqual(['Bright', 'Resonance', 'Attack', 'Release', 'Dirt', 'Unison'])
    // Unison: OSC 2 and 3 copies of the wave either side of the note, faded in from none.
    expect(show(w.patch, 'macro6target1')).toBe('Osc 2 Vol')
    expect(show(w.patch, 'macro6target2')).toBe('Osc 3 Vol')
    expect(w.patch.get('macro6panelvalue')).toBe(0)
    expect(w.patch.get('macro6depth1')).toBe(w.patch.get('macro6depth2'))
    expect([w.patch.get('mixerosc2vol'), w.patch.get('mixerosc3vol')]).toEqual([0, 0])
    expect([w.patch.get('osc2type'), w.patch.get('osc3type')]).toEqual([w.patch.get('osc1type'), w.patch.get('osc1type')])
    expect([w.patch.get('osc2cent'), w.patch.get('osc3cent'), w.patch.get('osc3semi')]).toEqual([10, -10, 0])
    expect(show(w.patch, 'macro5target1')).toBe('Filt 1 Drive')
    // Some Post drive to start with, a quarter up the knob: from none to four times as much.
    expect(w.patch.get('macro5panelvalue')).toBe(256)
    expect(w.patch.get('filter1drive')).toBe(0)
    expect(w.patch.get('macro5depth1')).toBe(512 + 512)
    expect(show(w.patch, 'filter1positionofdrive')).toBe('Post')
    expect(w.patch.macroName(1)).toBe('Bright')
    expect(show(w.patch, 'macro1target1')).toBe('Filt 1 Cutoff')
    expect(show(w.patch, 'macro3target1')).toBe('Env 2 Attack')
    // Unchanged by the macros, as played: a still note gets no resonance, an attack as recorded.
    expect(show(w.patch, 'filter1resonance')).toBe('0.0')
    expect(labelNumber(show(w.patch, 'env2attacksyncoff'))).toBeLessThan(20)
    expect(w.patch.get('macro2panelvalue')).toBe(0)
    // With movement over time, a fifth: none at the bottom, as generated in the middle.
    const fm = buildWavPatch(analyse({ samples: fmTone(220, 2, (t) => 128 + 512 * Math.max(0, 1 - t / 0.6), 1.2), sampleRate: RATE }), { levels, source: 'fm' })
    expect(fm.macros).toEqual(['Bright', 'Timbre', 'Attack', 'Release', 'Dirt', 'Movement'])
    expect(show(fm.patch, 'macro2target1')).toMatch(/Mut.*1.*Depth/)
    expect(fm.patch.get('modmatrix1depth')).toBe(512)
    expect(fm.patch.get('macro6panelvalue')).toBe(512)
  })

  it('plays: velocity on the Amp and the filter, aftertouch on the cutoff', () => {
    const w = buildWavPatch(saw, { levels })
    expect(show(w.patch, 'ampvelenv')).toBe('48.0')
    expect(show(w.patch, 'modmatrix3modsource')).toBe('Note-On Vel')
    expect(show(w.patch, 'modmatrix3modtarget')).toBe('Filt 1 Cutoff')
    expect(show(w.patch, 'modmatrix4modsource')).toBe('Chan Aftertouch')
    expect(show(w.patch, 'modmatrix5modsource')).toMatch(/^Poly A/)
  })

  it('plays a Sine on OSC 2 under a wave whose fundamental falls short', () => {
    // The Mini's Basic Triangle (Samples From Mars): an octave-up triangle over a sub 9 dB under it,
    // and only SquRoo 11 (its fundamental 25 dB under its octave) to play it with.
    const amps = [-9, 0, -31, -47, -39, -22, -45, -57, -49, -31, -53, -62, -55, -37].map((db) => 0.5 * 10 ** (db / 20))
    const a = analyse({ samples: tone(110, amps, 0.8), sampleRate: RATE })
    const only = levels.map((l, i) => (i === index('SquRoo 11') ? l : null))
    const w = buildWavPatch(a, { levels: only, peaks, overTime: false })
    expect(w.sub).toBe(true)
    expect(show(w.patch, 'osc2type')).toBe('Sine')
    expect(w.patch.get('mixerosc2vol')).toBeGreaterThan(256)
    expect(wavStatus(w)).toContain('SquRoo 11 over a Sine')
    // With its fundamental there, none; nor without the waves' loudness.
    expect(buildWavPatch(saw, { levels, peaks }).sub).toBe(false)
    expect(buildWavPatch(a, { levels: only, overTime: false }).sub).toBe(false)
  })

  it('plays the dirt it finds: noise, a second voice some cents off, a pitch that wanders', () => {
    const mix = (...parts: Float32Array[]) => parts[0].map((_, i) => parts.reduce((sum, q) => sum + q[i], 0))
    const f0 = 220
    const clean = buildWavPatch(analyse({ samples: tone(f0, sawAmps(f0), 2), sampleRate: RATE }), { levels })
    expect(clean.dirt).toEqual({ noise: null, drift: null, detune: null, ensemble: false })
    expect(clean.patch.get('mixernoisevol')).toBe(0)

    const noisy = buildWavPatch(analyse({ samples: mix(tone(f0, sawAmps(f0), 2), noise(2).map((v) => v * 0.25)), sampleRate: RATE }), { levels })
    expect(noisy.dirt.noise).toBe('White')
    expect(played(noisy.patch, 'mixernoisevol')).toBeGreaterThan(0)
    // Through Filter 1, with the note; a Noise macro, the generated level in its middle.
    expect(show(noisy.patch, 'mixernoisefilterratio')).toBe('100:0')
    expect(noisy.macros).toContain('Noise')
    const knob = noisy.macros.indexOf('Noise') + 1
    expect(show(noisy.patch, `macro${knob}target1`)).toBe('Noise Vol')
    expect(noisy.patch.get(`macro${knob}panelvalue`)).toBe(512)
    expect(clean.macros).not.toContain('Noise')
    expect(wavStatus(noisy)).toContain('white noise')
    const noisyAnalysis = analyse({ samples: mix(tone(f0, sawAmps(f0), 2), noise(2).map((v) => v * 0.25)), sampleRate: RATE })
    expect(buildWavPatch(noisyAnalysis, { levels, dirt: false }).dirt.noise).toBeNull()

    const twin = buildWavPatch(analyse({ samples: mix(tone(130.81, sawAmps(130.81), 2.5), tone(130.81 * 2 ** (6 / 1200), sawAmps(130.81), 2.5)), sampleRate: RATE }), { levels })
    expect(twin.dirt.detune).toBeGreaterThanOrEqual(4)
    expect(show(twin.patch, 'osc3type')).toBe(show(twin.patch, 'osc1type'))
    // At the note's octave (Init has OSC 3 an octave down), the two the detune apart.
    expect(twin.patch.get('osc3semi')).toBe(0)
    expect(twin.patch.get('osc3cent') - twin.patch.get('osc1cent')).toBe(twin.dirt.detune)
    expect(twin.patch.get('mixerosc3vol')).toBeGreaterThan(512)

    const strings = buildWavPatch(analyse({ samples: ensemble(130.81, sawAmps(130.81), 3, 1), sampleRate: RATE }), { levels })
    expect(strings.dirt.ensemble).toBe(true)
    expect(show(strings.patch, 'prefxtype')).toBe('Chorus')
    expect(show(strings.patch, 'postfxtype')).toBe('Chorus')
    expect(labelNumber(show(strings.patch, 'prefx1param1'))).toBeCloseTo(0.6, 1)
    expect(strings.dirt.drift).toBeNull()
    expect(wavStatus(strings)).toContain('ensemble')

    let seed = 1
    const walk = Array.from({ length: 60 }, () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 12)
    const at = (t: number) => {
      const i = Math.min(walk.length - 2, Math.floor(t * 20))
      return walk[i] + (walk[i + 1] - walk[i]) * (t * 20 - i)
    }
    const drifting = buildWavPatch(analyse({ samples: tone(f0, sawAmps(f0), 2.5, { cents: at }), sampleRate: RATE }), { levels })
    expect(drifting.dirt.drift).toBeGreaterThan(0)
    expect(show(drifting.patch, 'modmatrix6modsource')).toBe('LFO 3')
    expect(show(drifting.patch, 'modmatrix6modtarget')).toBe('All Osc Pitch')
    expect(show(drifting.patch, 'lfo3wave')).toBe('Random')
  }, 20000) // several analyses of 2 s notes: ~2.5 s here, over 5 s on CI runners

  it('plays noise as noise: its colour through the low-pass that shapes it, its filter moving', () => {
    /** `x` through a two-pole low-pass at `hz` (Q 0.54, LP Ladder 12's shape), the cutoff moving if a function. */
    const lowPass = (x: Float32Array, hz: number | ((t: number) => number)) => {
      let [y1, y2, x1, x2] = [0, 0, 0, 0]
      return x.map((v, i) => {
        const w = (2 * Math.PI * (typeof hz === 'number' ? hz : hz(i / RATE))) / RATE
        const alpha = Math.sin(w) / (2 * 0.54)
        const c = Math.cos(w)
        const [b0, b1, a0, a1, a2] = [(1 - c) / 2, 1 - c, 1 + alpha, -2 * c, 1 - alpha]
        const y = (b0 * v + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2) / a0
        ;[x2, x1, y2, y1] = [x1, v, y1, y]
        return y
      })
    }
    const burst = (x: Float32Array, decayS: number) => x.map((v, i) => v * Math.min(1, i / 50) * Math.exp(-i / RATE / decayS))
    const hiss = buildWavPatch(analyse({ samples: burst(lowPass(noise(1), 2000), 0.3), sampleRate: RATE }), { levels })
    expect(hiss.noise).not.toBeNull()
    expect(hiss.noise!.colour).toBe('White')
    expect(Math.abs(Math.log2(hiss.noise!.cutoffHz / 2000))).toBeLessThan(0.75)
    expect(hiss.patch.get('mixerosc1vol')).toBe(0)
    expect(hiss.patch.get('mixernoisevol')).toBe(1024)
    expect(show(hiss.patch, 'mixernoisefilterratio')).toBe('100:0') // through Filter 1
    expect(hiss.vibrato).toBeNull()
    expect(wavStatus(hiss)).toMatch(/^Play any key \(the filter as at C4\): white noise through a low-pass at [12]\.\d kHz/)
    expect(hiss.warnings).not.toContain('no clear single note')
    // A burst that darkens as it fades: ENV 1 on the filter.
    const closing = buildWavPatch(analyse({ samples: burst(lowPass(noise(1.5), (t) => 300 + 8000 * Math.exp(-t / 0.15)), 0.8), sampleRate: RATE }), { levels })
    expect(closing.noise).not.toBeNull()
    expect(closing.filterEnvelope).toBe(true)
    expect(played(closing.patch, 'filter1env1amount')).toBeGreaterThan(512)
    // A note keeps its oscillator.
    expect(buildWavPatch(saw, { levels }).noise).toBeNull()
  })

  it('plays a pitch that drops into the note on ENV 4', () => {
    let phase = 0
    const kick = Float32Array.from({ length: Math.round(0.6 * RATE) }, (_, i) => {
      const t = i / RATE
      const v = 0.8 * Math.exp(-t / 0.2) * Math.sin(phase)
      phase += (2 * Math.PI * (50 + 50 * Math.exp(-t / 0.03))) / RATE
      return v
    })
    const w = buildWavPatch(analyse({ samples: kick, sampleRate: RATE }), { levels })
    expect(w.glide).toBeGreaterThanOrEqual(7)
    expect(show(w.patch, 'modmatrix7modsource')).toBe('Env 4')
    expect(show(w.patch, 'modmatrix7modtarget')).toBe('All Osc Pitch')
    expect(parseFloat(show(w.patch, 'modmatrix7depth'))).toBeCloseTo(w.glide! * 10, -1)
    expect(show(w.patch, 'env4sustain')).toBe('0.0')
    expect(labelNumber(show(w.patch, 'env4decaysyncoff'))).toBeLessThan(400)
    expect(wavStatus(w)).toContain(`pitch dropping ${w.glide} semitones into it`)
    expect(buildWavPatch(saw, { levels }).glide).toBeNull()
  })

  it('hears a resonant filter, and not in a plain saw, a sine or a bell', () => {
    // A saw through LP Ladder 12 as measured (src/ui/ladderResponse.generated.ts) at 8x the pitch.
    const through = (resonance: number) => sawAmps(110, 8000).map((amp, k) => amp * 10 ** (filterDb((k + 1) / 8, resonance) / 20))
    for (const resonance of [704, 832]) {
      const w = buildWavPatch(analyse({ samples: tone(110, through(resonance), 1), sampleRate: RATE }), { levels })
      expect(w.resonance, `resonance ${resonance}`).toBeGreaterThanOrEqual(512)
      // As played, through the Resonance macro at its knob: the resonance found, exactly.
      expect(played(w.patch, 'filter1resonance')).toBe(w.resonance)
      expect(show(w.patch, 'filter1resonance')).not.toBe('0.0')
      expect(wavStatus(w)).toContain('resonant filter')
    }
    expect(buildWavPatch(analyse({ samples: tone(110, through(0), 1), sampleRate: RATE }), { levels }).resonance).toBe(0)
    expect(buildWavPatch(analyse({ samples: tone(220, [0.5, 0.01], 1), sampleRate: RATE }), { levels }).resonance).toBe(0)
    // A bell: a few partials at harmonic places, far apart, each with a peak of its own.
    const bell = tone(110, Array.from({ length: 24 }, (_, k) => ([0, 2, 6, 11, 17].includes(k) ? 0.3 / (1 + k / 4) : 0)), 1, { level: (t) => Math.exp(-t / 0.5) })
    expect(buildWavPatch(analyse({ samples: bell, sampleRate: RATE }), { levels }).resonance).toBe(0)
  })

  it('names what may be off in the status', () => {
    const w = buildWavPatch(saw, { levels })
    expect(wavStatus({ ...w, warnings: ['noisy', 'clipped'] })).toMatch(/\(noisy, clipped: a rough start\)$/)
  })

  it('keeps a note with vibrato or a beat as bright as it is', () => {
    // Read at their exact frequencies, the upper harmonics of a wobbling or detuned note read dark,
    // and the fit closed the filter; read as band power, the saw plays through an open one.
    const wobbly = analyse({ samples: tone(130.81, sawAmps(130.81), 2, { cents: (t) => 25 * Math.sin(2 * Math.PI * 5.5 * t) }), sampleRate: RATE })
    const w = buildWavPatch(wobbly, { levels })
    expect(show(w.patch, 'osc1type')).toBe('Saw')
    // As open as a still saw's (velocity takes some off, to add at 100).
    expect(played(w.patch, 'filter1cutoff')).toBe(played(buildWavPatch(analyse({ samples: tone(130.81, sawAmps(130.81), 2), sampleRate: RATE }), { levels }).patch, 'filter1cutoff'))
  })

  it('plays a second oscillator on OSC 2 at its interval, with its own wave', () => {
    // A ninth up: none of their harmonics meet (a fifth up, the square's even ones lie on the saw's,
    // and a saw's odd ones fit it as well).
    const square = play(cycles[index('Square')]!, 293.66, 3)
    const a = analyse({ samples: play(cycles[index('Saw')]!, 130.81, 3).map((v, i) => 0.6 * (v + 0.5 * square[i])), sampleRate: RATE })
    const w = buildWavPatch(a, { levels, peaks })
    expect(show(w.patch, 'osc2type')).toBe('Square')
    expect(w.patch.get('osc2semi')).toBe(14)
    expect(Math.abs(w.patch.get('osc2cent'))).toBeLessThanOrEqual(1)
    expect(w.patch.get('mixerosc2vol')).toBeGreaterThan(512)
    expect(w.sub).toBe(false)
    expect(wavStatus(w)).toMatch(/^Play C3: Saw, OSC 2 Square at \+14 semitones/)
  })

  it('plays a pad’s slow swings on LFO 4: its pitch, WaveScan or the cutoff; its level on Amp LFO 2', () => {
    const lfo = (rateHz: number, depth: number) => (t: number) => depth * Math.sin(2 * Math.PI * rateHz * t)
    // Harmonics to 5 kHz: six-second notes of every one take long to make.
    const saw = sawAmps(130.81, 5000)
    const pitch = buildWavPatch(analyse({ samples: tone(130.81, saw, 6, { cents: lfo(0.5, 20) }), sampleRate: RATE }), { levels })
    expect(show(pitch.patch, 'modmatrix9modsource')).toBe('LFO 4')
    expect(show(pitch.patch, 'modmatrix9modtarget')).toBe('All Osc Pitch')
    // LFO 4 at half level, the route twice as deep: the Movement macro in its middle plays it as read.
    expect(played(pitch.patch, 'lfo4level')).toBe(512)
    expect((pitch.patch.get('modmatrix9depth') - 512) / 4).toBeCloseTo((2 * 20) / CALIBRATION.slow.pitchCentsPerDepth, 0)
    expect(labelNumber(show(pitch.patch, 'lfo4ratesyncoff'))).toBeCloseTo(0.5, 1)
    expect(pitch.macros).toContain('Movement')
    expect(pitch.filterEnvelope).toBe(false)
    expect(wavStatus(pitch)).toMatch(/pitch swinging (1[6-9]|2[0-4]) cents 0\.5 Hz/)

    // A square fading into a narrow pulse and back: WaveScan between them, LFO 4 Unipolar from the first.
    const fade = (sign: 1 | -1) => (t: number) => 0.5 + sign * lfo(0.7, 0.5)(t)
    const [sq, pulse] = [play(cycles[index('Square')]!, 130.81, 6, fade(-1)), play(cycles[index('Pulse 3')]!, 130.81, 6, fade(1))]
    const scan = buildWavPatch(analyse({ samples: sq.map((v, i) => v + pulse[i]), sampleRate: RATE }), { levels })
    expect(show(scan.patch, 'osc1mode')).toBe('WaveScan')
    expect(scan.waves.map((w) => WAVE_FEATURES[w].name)).toEqual(['Square', 'Pulse 3'])
    expect(show(scan.patch, 'modmatrix8modsource')).toBe('LFO 4 Unipolar')
    expect(show(scan.patch, 'modmatrix8modtarget')).toBe('Osc 1 WaveScan')
    expect(wavStatus(scan)).toMatch(/^Play C3: Square ↔ Pulse 3, WaveScan swinging 0\.7 Hz/)

    // A pulse whose width swings from 40 % to 10 % and back: a Saw through Mutant PhazDiff, LFO 4 on its Depth.
    const width = (t: number) => 0.25 + lfo(0.7, 0.15)(t)
    let turn = 0
    let parts: [number, number][] = []
    const pwm = Float32Array.from({ length: 6 * RATE }, (_, i) => {
      // All its harmonics (to 15 kHz): the fit reads to 10 kHz.
      if (i % 256 === 0) parts = sawAmps(130.81).map((_, k) => [(0.6 * Math.sin(Math.PI * (k + 1) * width(i / RATE))) / (k + 1), Math.PI * (k + 1) * width(i / RATE)])
      turn += (2 * Math.PI * 130.81) / RATE
      return parts.reduce((v, [amp, shift], k) => v + amp * Math.cos((k + 1) * turn - shift), 0)
    })
    const pw = buildWavPatch(analyse({ samples: pwm, sampleRate: RATE }), { levels })
    expect(show(pw.patch, 'osc1type')).toBe('Saw')
    expect(show(pw.patch, 'mutant1mode')).toBe('PhazDiff')
    expect(show(pw.patch, 'modmatrix8modtarget')).toBe('Mut 1 Depth')
    expect(played(pw.patch, 'mutant1depth') / 1024).toBeCloseTo(0.25, 1)
    expect(wavStatus(pw)).toMatch(/pulse width swinging (3\d|4\d)–(\d|1\d) % 0\.7 Hz/)

    // A saw whose cutoff swings an octave and a half either side of 4x its pitch.
    const cutoff = (t: number) => 4 * 2 ** lfo(0.4, 1.5)(t)
    let phase = 0
    let gains: number[] = []
    const swept = Float32Array.from({ length: 6 * RATE }, (_, i) => {
      // The filter's gains anew every 256 samples (6 ms): smooth enough at 0.4 Hz.
      if (i % 256 === 0) gains = saw.map((amp, k) => amp * 10 ** (filterDb((k + 1) / cutoff(i / RATE)) / 20))
      phase += (2 * Math.PI * 130.81) / RATE
      return gains.reduce((v, g, k) => v + g * Math.sin((k + 1) * phase), 0)
    })
    const filter = buildWavPatch(analyse({ samples: swept, sampleRate: RATE }), { levels })
    expect(show(filter.patch, 'modmatrix8modsource')).toBe('LFO 4')
    expect(show(filter.patch, 'modmatrix8modtarget')).toBe('Filt 1 Cutoff')
    // Three octaves between the ends, as far as the ends are read (where the swing is near them); the
    // route twice as deep as that, LFO 4 at half level.
    const octavesApart = (((filter.patch.get('modmatrix8depth') - 512) / 4) * CALIBRATION.slow.cutoffOctavesPerDepth) / 2
    expect(octavesApart).toBeGreaterThan(2)
    expect(octavesApart).toBeLessThan(3.5)
    expect(wavStatus(filter)).toMatch(/filter swinging 0\.4 Hz/)

    const level = buildWavPatch(analyse({ samples: tone(130.81, saw, 6, { level: (t) => 0.5 * 10 ** (lfo(0.6, 2)(t) / 20) }), sampleRate: RATE }), { levels })
    expect(labelNumber(show(level.patch, 'lfo2ratesyncoff'))).toBeCloseTo(0.6, 1)
    expect(level.patch.get('amplfo2amount')).toBeGreaterThan(512 + 128)
    expect(wavStatus(level)).toMatch(/level swinging 0\.6 Hz/)

    // None of it with "Follow how the sound changes" off.
    expect(buildWavPatch(analyse({ samples: tone(130.81, saw, 6, { cents: lfo(0.5, 20) }), sampleRate: RATE }), { levels, overTime: false }).swings).toEqual([])
  }, 20000)
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
    expect(wavStatus(w)).toMatch(/^Play A3: Mutant FM 3:1, vibrato/)
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
    expect(wavStatus(w)).toContain('Mutant FM 2:1, its depth moving')
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
  }, 20000) // 44 recordings
})
