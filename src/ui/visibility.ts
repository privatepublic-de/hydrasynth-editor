// Controls the synth's own pages hide in some modes (owner's manual 2.0), on top of the
// mode-dependent alternatives in the param model (ParamDef.when). Hidden controls keep their
// knob position empty; their values stay in the patch.
import type { Patch } from '../params/patch'

/** Filter 1 types with the Vowel controls: 10, and 16, which the synth also shows as Vowel. */
const VOWEL_TYPES = [10, 16]
const COMPRESSOR = 8
const LFO_STEP_WAVE = 10

/** Mutant modes (mutantNmode) and which of them use each control (manual 2.0, pp. 35-39). */
const FM_LIN = 0, WAVSTACK = 1, OSC_SYNC = 2, PW_ASM = 5
const USES_RATIO = [2, 3, 4, 5, 6]
/** FM-Lin's Ratio only tunes its own Sine or Triangle source. */
const FM_OWN_SOURCES = [0, 1]

const RULES: [RegExp, (p: Patch, m: RegExpMatchArray) => boolean][] = [
  // Single mode plays one wave; WaveScan mode scans the Wavelist.
  [/^(osc[12])type$/, (p, m) => p.get(`${m[1]}mode`) === 0],
  [/^(osc[12])wavscan(wave\d)?$/, (p, m) => p.get(`${m[1]}mode`) === 1],
  [/^filter1(special|vowelorder)$/, (p) => VOWEL_TYPES.includes(p.get('filter1type'))],
  [/^(pre|post)fxsidechain$/, (p, m) => p.get(`${m[1]}fxtype`) === COMPRESSOR],
  // The synth only takes LFO steps while the wave is Step (Edisyn's notes); unset they read 0.
  [/^(lfo\d)step(s|\d+)$/, (p, m) => p.get(`${m[1]}wave`) === LFO_STEP_WAVE],
  [/^(mutant\d)source(fmlin|oscsync)$/, (p, m) => [FM_LIN, OSC_SYNC].includes(p.get(`${m[1]}mode`))],
  [
    /^(mutant\d)ratio$/,
    (p, m) => {
      const mode = p.get(`${m[1]}mode`)
      return USES_RATIO.includes(mode) || (mode === FM_LIN && FM_OWN_SOURCES.includes(p.get(`${m[1]}sourcefmlin`)))
    },
  ],
  [/^(mutant\d)window$/, (p, m) => p.get(`${m[1]}mode`) === OSC_SYNC],
  [/^(mutant\d)feedback$/, (p, m) => p.get(`${m[1]}mode`) !== WAVSTACK],
  [/^(mutant\d)warp\d$/, (p, m) => p.get(`${m[1]}mode`) === PW_ASM],
  [/^voiceglide(time|curve|legato)$/, (p) => p.get('voiceglide') !== 0],
  [/^env\dlegato$/, (p) => p.get('voicepolyphony') !== 0],
  [/^(env\d)reset$/, (p, m) => p.get(`${m[1]}legato`) === 0],
]

export function isShown(key: string, patch: Patch): boolean {
  for (const [re, shown] of RULES) {
    const m = key.match(re)
    if (m) return shown(patch, m)
  }
  return true
}

/** For tests: a rule whose pattern matches no key would silently do nothing. */
export const RULE_PATTERNS: RegExp[] = RULES.map(([re]) => re)
