// The sound of a Sine on OSC 1 through Mutant 1 in FM-Linear mode (Sine source, wet 100 %), and
// the ratio and depth whose harmonics come closest to a recorded note's. A model of the synth's
// FM, measured with tools/calibrateMutant.ts; see FM_CALIBRATION.
import { valueTable } from './timeTables'

/** What the synth showed when measured (tools/calibrateMutant.ts, 2026-10-11), so the numbers can be checked again. */
export const FM_CALIBRATION = {
  /** OSC 1 runs through Mutants 1 and 2, OSC 2 through 3 and 4; OSC 3 through none (routing). */
  routing: { osc1: [1, 2], osc2: [3, 4] },
  /**
   * Phase modulation: the carrier at the note, the modulator at Ratio times it, starting at -cos
   * (3/4 of a turn: at ratios 1 and 2 the folded sidebands only fit so, within 1.3 dB to depth 64;
   * at 3 any phase fits), its index in radians per raw of Depth (fm, at Depth shown 0-128 = raw/8:
   * 0.7 at 8, 2.9 at 32, 6.1 at 64, 9.2 at 96, ~12 at 128, the same at ratios 1, 2 and 3).
   */
  modulatorPhase: 1.5 * Math.PI,
  indexPerRaw: 0.0118,
  /**
   * Feedback isn't a modulator fed back on itself: already at 9 % it raises the upper harmonics to
   * ~-30 dB, more like noise (feedback). Left at 0.
   */
  feedback: 0,
}

/** Samples per modelled cycle: harmonics to 255, past what any ratio and depth here reach. */
const N = 512
/** Harmonics modelled, as many as the waves' (src/ui/waveSpeech.ts HARMONICS). */
const COUNT = 128

const COS = Float64Array.from({ length: N }, (_, i) => Math.cos((2 * Math.PI * i) / N))
const SIN = Float64Array.from({ length: N }, (_, i) => Math.sin((2 * Math.PI * i) / N))

const cache = new Map<string, number[]>()
/** Harmonic levels (dB, loudest 0, floor -100) of the FM'd Sine at `ratio` (whole) and Depth `depthRaw`. */
export function fmLevels(ratio: number, depthRaw: number): number[] {
  const key = `${ratio}/${depthRaw}`
  let levels = cache.get(key)
  if (!levels) {
    const index = depthRaw * FM_CALIBRATION.indexPerRaw
    const x = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      const ph = (2 * Math.PI * i) / N
      x[i] = Math.sin(ph + index * Math.sin(ratio * ph + FM_CALIBRATION.modulatorPhase))
    }
    const amps: number[] = []
    for (let k = 1; k <= COUNT; k++) {
      let re = 0
      let im = 0
      for (let i = 0; i < N; i++) {
        const j = (k * i) % N
        re += x[i] * COS[j]
        im -= x[i] * SIN[j]
      }
      amps.push(Math.hypot(re, im))
    }
    const peak = Math.max(...amps) || 1
    levels = amps.map((a) => 20 * Math.log10(a / peak + 1e-5))
    cache.set(key, levels)
  }
  return levels
}

/**
 * The Ratios the fit tries, with their raw values: the whole ones from 1 to 12 (others put the
 * sidebands between the note's harmonics, or below it).
 */
export const FM_RATIOS: { ratio: number; raw: number }[] = valueTable('mutant1ratio')
  .filter(([, shown]) => Number.isInteger(shown) && shown >= 1 && shown <= 12)
  .map(([raw, ratio]) => ({ ratio, raw }))

/** Depths the fit tries (raw): every 16. */
export const FM_DEPTHS = Array.from({ length: 65 }, (_, i) => i * 16)
