// How the editor groups params: the Desktop's module buttons and, inside each, its own edit
// pages, after the owner's manual. A slot's index is the Control knob it sits on (0 = knob 1;
// knobs 1-4 are the top row, 5-8 the bottom), so a null keeps the knobs after it in place.
// Kept by hand on purpose (docs/FINDINGS.md): the generated param data has no notion of pages.
import { PARAM_BY_KEY } from '../params/patch'

/**
 * One param key; several keys = the readings of one knob in different modes (exactly one is
 * active, see ParamDef.when / Patch.isActive); null = a knob position the model has nothing for.
 */
export type Slot = string | string[] | null

export interface Page {
  title: string
  slots: Slot[]
  /**
   * The page is one row of a table: consecutive pages of a module with the same `table` title
   * are best drawn as one grid (rows = pages, columns = slot positions), not as knob pages.
   */
  table?: string
}

export interface ModuleLayout {
  id: string
  /** Panel button text. */
  label: string
  pages: Page[]
  keyboardOnly?: true
}

const range = (n: number, from = 1) => Array.from({ length: n }, (_, i) => i + from)

/** Envelope and LFO times have one key per BPM Sync state. */
const synced = (prefix: string, name: string): string[] => [`${prefix}${name}syncoff`, `${prefix}${name}syncon`]

function osc(n: number): ModuleLayout {
  const p = `osc${n}`
  const scanning = n !== 3
  const pages: Page[] = [
    {
      title: 'Oscillator',
      // Osc 3 has no Mode and no WaveScan, but keeps the other knobs where Osc 1/2 have them.
      // Wave sits on knob 2 in Single mode, WaveScan on knob 5 (the manual's examples);
      // knob 2 opens the Wavelist in WaveScan mode. Keytrack's position is a guess.
      slots: [
        scanning ? `${p}mode` : null,
        `${p}type`,
        `${p}semi`,
        `${p}cent`,
        scanning ? `${p}wavscan` : null,
        null,
        `${p}bitreduction`,
        `${p}keytrack`,
      ],
    },
  ]
  // Table: the eight WaveScan positions.
  if (scanning) pages.push({ title: 'Wavelist', slots: range(8).map((i) => `${p}wavscanwave${i}`) })
  return { id: p, label: `OSC ${n}`, pages }
}

function mutant(n: number): ModuleLayout {
  const p = `mutant${n}`
  return {
    id: p,
    label: `MUTANT ${n}`,
    pages: [
      {
        title: 'Mutant',
        // Knob 7's button opens Custom Edit (PW-ASM's warp points, the next page).
        slots: [
          `${p}mode`,
          [`${p}sourcefmlin`, `${p}sourceoscsync`],
          `${p}ratio`,
          `${p}depth`,
          `${p}window`,
          `${p}feedback`,
          null,
          `${p}wet`,
        ],
      },
      { title: 'Custom Edit', slots: range(8).map((i) => `${p}warp${i}`) },
    ],
  }
}

const ringNoise: ModuleLayout = {
  id: 'ringnoise',
  label: 'RING-NOISE',
  pages: [
    {
      title: 'Ring-Noise',
      // Ring Vol and Noise Vol are Mixer page 1's mixerringmodvol/mixernoisevol, which the synth
      // also shows here; they live in the Mixer so each key has one home.
      slots: ['ringmodsource1', 'ringmodsource2', 'ringmoddepth', null, 'noisetype', null],
    },
  ],
}

const mixer: ModuleLayout = {
  id: 'mixer',
  label: 'MIXER',
  pages: [
    // Knob 8's button is Solo, which is not stored in the patch.
    { title: 'Levels', slots: ['mixerosc1vol', 'mixerosc2vol', 'mixerosc3vol', null, 'mixerringmodvol', 'mixernoisevol', null, null] },
    {
      title: 'Osc Pan / Filter',
      slots: ['mixerosc1pan', 'mixerosc2pan', 'mixerosc3pan', null, 'mixerosc1filterratio', 'mixerosc2filterratio', 'mixerosc3filterratio'],
    },
    {
      title: 'Ring / Noise Pan / Filter',
      // Filter Routing is also Filter 1 page 2's knob 1; it lives here.
      slots: ['mixerringmodpan', 'mixernoisepan', null, 'mixerfilterrouting', 'mixerringmodfilterratio', 'mixernoisefilterratio'],
    },
  ],
}

const filter1: ModuleLayout = {
  id: 'filter1',
  label: 'FILTER 1',
  pages: [
    {
      title: 'Filter',
      // Control only applies to the Vowel type (the model has no condition for it).
      slots: ['filter1type', 'filter1special', 'filter1cutoff', 'filter1resonance', 'filter1env1amount', 'filter1lfo1amount', 'filter1velenv', 'filter1keytrack'],
    },
    {
      title: 'Drive',
      // Knob 1 is the Filter Routing kept in the Mixer (mixerfilterrouting); knob 2 is blank.
      // Vowel Order only applies to the Vowel type.
      slots: [null, null, 'filter1drive', 'filter1positionofdrive', 'filter1vowelorder'],
    },
  ],
}

const filter2: ModuleLayout = {
  id: 'filter2',
  label: 'FILTER 2',
  pages: [
    {
      title: 'Filter',
      slots: ['filter2type', 'filter2morph', 'filter2cutoff', 'filter2resonance', 'filter2env1amount', 'filter2lfo1amount', 'filter2velenv', 'filter2keytrack'],
    },
  ],
}

const amp: ModuleLayout = {
  id: 'amp',
  label: 'AMP',
  pages: [{ title: 'Amp', slots: [null, null, null, null, null, 'amplfo2amount', 'ampvelenv', 'amplevel'] }],
}

/** Pre- and Post-FX share their nine types; each type's five params share knobs 3-7. */
function fx(where: 'pre' | 'post'): ModuleLayout {
  const p = `${where}fx`
  return {
    id: p,
    label: `${where.toUpperCase()}-FX`,
    pages: [
      {
        title: 'FX',
        // Knob 2 is the type's Preset (which also sets the other knobs) except on the Compressor,
        // where it is Sidechain; both are kept in the same byte (see params/fxPresets.ts).
        slots: [
          `${p}type`,
          [`${p}sidechain`, ...range(9).map((t) => `${p}${t}preset`).filter((k) => PARAM_BY_KEY.has(k))],
          ...range(5).map((m) => range(9).map((t) => `${p}${t}param${m}`)),
          `${p}wet`,
        ],
      },
    ],
  }
}

const delay: ModuleLayout = {
  id: 'delay',
  label: 'DELAY',
  pages: [
    {
      title: 'Delay',
      slots: ['delaytype', ['delaytimesyncoff', 'delaytimesyncon'], 'delayfeedback', 'delaywettone', null, 'delaybpmsync', 'delayfeedtone', 'delaywet'],
    },
  ],
}

const reverb: ModuleLayout = {
  id: 'reverb',
  label: 'REVERB',
  pages: [
    { title: 'Reverb', slots: ['reverbtype', 'reverbpredelay', 'reverbtime', 'reverbtone', null, 'reverbhidamp', 'reverblodamp', 'reverbwet'] },
  ],
}

function env(n: number): ModuleLayout {
  const p = `env${n}`
  return {
    id: p,
    label: `ENV ${n}`,
    pages: [
      {
        title: 'Envelope',
        slots: [synced(p, 'attack'), synced(p, 'decay'), `${p}sustain`, synced(p, 'release'), synced(p, 'delay'), synced(p, 'hold'), `${p}quantize`, `${p}bpmsync`],
      },
      // The synth hides Legato in Poly mode and Reset while Legato is on (no condition in the model).
      { title: 'Curves', slots: [`${p}atkcurve`, `${p}deccurve`, null, `${p}relcurve`, `${p}legato`, `${p}reset`, `${p}freerun`, `${p}loop`] },
      {
        title: 'Triggers',
        // Env 2's first trigger is fixed to Note On, so the patch has no field for it.
        // Knob 5's button is Tap Trigger, an action.
        slots: range(4).map((i) => (n === 2 && i === 1 ? null : `${p}trigsrc${i}`)),
      },
    ],
  }
}

function lfo(n: number): ModuleLayout {
  const p = `lfo${n}`
  return {
    id: p,
    label: `LFO ${n}`,
    pages: [
      {
        title: 'LFO',
        slots: [`${p}wave`, synced(p, 'rate'), `${p}bpmsync`, `${p}trigsync`, synced(p, 'delay'), synced(p, 'fadein'), `${p}phase`, `${p}level`],
      },
      // Knob 7 is SemiLock (a Step Edit display option the model has no field for); knob 8's
      // button opens Step Edit.
      { title: 'Step', slots: [`${p}steps`, `${p}smooth`, `${p}quantize`, `${p}oneshot`] },
      // Table: 64 step values, eight per page as on the synth; `steps` says how many play.
      ...range(8).map((g) => ({
        title: `Steps ${g * 8 - 7}-${g * 8}`,
        slots: range(8, g * 8 - 7).map((s) => `${p}step${s}`),
        table: 'Step Edit',
      })),
    ],
  }
}

const scaleEdit = (prefix: string): Page => ({
  title: 'Scale Edit',
  // Note 1 is the Key Lock note, not a field of its own.
  slots: [null, ...range(7, 2).map((i) => `${prefix}scalenote${i}`)],
})

const voice: ModuleLayout = {
  id: 'voice',
  label: 'VOICE',
  pages: [
    {
      title: 'Voice',
      slots: ['voicepolyphony', 'voicedensity', 'voicedetune', 'voiceanalogfeel', 'voicerandomphase', 'voicestereomode', 'voicestereowidth', 'voicewarmmode'],
    },
    {
      title: 'Pitch / Glide',
      slots: [
        'voicepitchbend',
        'voicevibratoamount',
        'voicevibratobpmsync',
        ['voicevibratoratesyncoff', 'voicevibratoratesyncon'],
        'voiceglide',
        'voiceglidetime',
        'voiceglidecurve',
        'voiceglidelegato',
      ],
    },
    {
      title: 'Scale',
      // Knob 3 (the microtuning scale) has no field in the model; knob 4's button opens Scale
      // Edit, knob 7's VoiceMod Edit.
      slots: ['scalekeylock', 'scaletype', null, null, 'voicesustain', null, null, 'voicesnap'],
    },
    scaleEdit(''),
    { title: 'VoiceMod Edit', slots: range(8).map((i) => `voicemodulation${i}`) },
  ],
}

const ribbon: ModuleLayout = {
  id: 'ribbon',
  label: 'RIBBON',
  keyboardOnly: true,
  // The manual names these params but not their knobs. Lock Global is a system setting.
  pages: [
    { title: 'Ribbon', slots: ['ribbonmode', 'ribbonhold', 'ribbonkeyspan', 'ribbonoctave', 'ribbonquantize', 'ribbonglide', 'ribbonmodcontrol'] },
    { title: 'Theremin Scale', slots: ['ribbonscalekeylock', 'ribbonscaletype'] },
    scaleEdit('ribbon'),
  ],
}

const arp: ModuleLayout = {
  id: 'arp',
  label: 'ARPEGGIATOR',
  pages: [
    { title: 'Arp', slots: ['arptempo', 'arpdivision', 'arpswing', 'arpgate', 'arpoctmode', 'arpoctave', 'arpmode', 'arplength'] },
    { title: 'Arp 2', slots: ['arptaptrig', 'arpphrase', 'arpratchet', 'arpchance', 'arpclklock', null, null, 'arpstepoffset'] },
    // Not on the Arp Edit pages: the arp section's own ON and LATCH buttons.
    { title: 'More', slots: ['arpenable', 'arplatch'] },
  ],
}

const macros: ModuleLayout = {
  id: 'macros',
  label: 'MACRO ASSIGN',
  pages: [
    // The Home page's knobs and buttons: macro N is knob/button N.
    { title: 'Knobs', slots: range(8).map((m) => `macro${m}panelvalue`) },
    { title: 'Buttons', slots: range(8).map((m) => `macro${m}panelbuttonstate`) },
    // Table per macro: one row per destination. The synth pages through them three at a time,
    // stacking destination, button value and knob depth. Names are on Patch.macroName.
    ...range(8).flatMap((m) =>
      range(8).map((d) => ({
        title: `Macro ${m} Dest ${d}`,
        slots: [`macro${m}target${d}`, `macro${m}buttonvalue${d}`, `macro${m}depth${d}`],
        table: `Macro ${m}`,
      })),
    ),
  ],
}

const modMatrix: ModuleLayout = {
  id: 'modmatrix',
  label: 'MOD MATRIX',
  // Table: one row per route. The synth shows four routes a page, source/destination on the
  // upper knob and depth on the lower.
  pages: range(32).map((r) => ({
    title: `Route ${r}`,
    slots: [`modmatrix${r}modsource`, `modmatrix${r}modtarget`, `modmatrix${r}depth`],
    table: 'Mod matrix',
  })),
}

const patch: ModuleLayout = {
  id: 'patch',
  label: 'PATCH',
  pages: [{ title: 'Patch', slots: ['category', 'color'] }],
}

/** Module Select's signal flow first (oscillators to effects, then envelopes and LFOs), then the rest. */
export const MODULES: ModuleLayout[] = [
  osc(1),
  osc(2),
  osc(3),
  ...range(4).map(mutant),
  ringNoise,
  mixer,
  filter1,
  filter2,
  amp,
  fx('pre'),
  delay,
  reverb,
  fx('post'),
  ...range(5).map(env),
  ...range(5).map(lfo),
  voice,
  macros,
  modMatrix,
  arp,
  ribbon,
  patch,
]

export function slotKeys(slot: Slot): string[] {
  return slot === null ? [] : typeof slot === 'string' ? [slot] : slot
}

const MODULE_BY_KEY: ReadonlyMap<string, ModuleLayout> = new Map(
  MODULES.flatMap((m) => m.pages.flatMap((p) => p.slots.flatMap(slotKeys)).map((k) => [k, m] as const)),
)

export function moduleOf(key: string): ModuleLayout | undefined {
  return MODULE_BY_KEY.get(key)
}
