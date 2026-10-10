// The Pre-/Post-FX presets as params. Knob 2 of the FX page is Preset for every type with presets
// and Sidechain for the Compressor, and the patch keeps both in the same byte (354 / 402): A38's
// Pre-FX EQ stores 5 there and the synth names its preset "Lo-Fi", A34's Post-FX EQ 6, "Warm"
// (user, 2026-10-08; every FX slot with presets in all eight banks holds a valid number there).
// Picking a preset also sets the type's five params (see applyFxPreset).
import { FX_PRESETS } from './fxPresets.generated'
import type { ParamDef } from './types'

const COMPRESSOR = 8
const SIDES = { pre: { offset: 354, nrpn: 7552 }, post: { offset: 402, nrpn: 7680 } } as const

/** `prefx7preset` etc.: one per side and FX type that has presets. */
export const FX_PRESET_PARAMS: ParamDef[] = (['pre', 'post'] as const).flatMap((side) =>
  FX_PRESETS.flatMap((list, type) =>
    list.length
      ? [
          {
            key: `${side}fx${type}preset`,
            labels: ['Preset'],
            min: 0,
            max: list.length - 1,
            widget: 'choice' as const,
            field: { offset: SIDES[side].offset, size: 1, signed: false },
            when: { key: `${side}fxtype`, values: [type] },
            options: list.map((p, i): [number, string] => [i, p.name]),
            nrpn: { param: SIDES[side].nrpn, base: 0, mul: 8, negAdd: 0 },
          },
        ]
      : [],
  ),
)

/** Sidechain is knob 2's reading on the Compressor (type 8) only: say so, as for the presets. */
export function withKnob2Condition(def: ParamDef): ParamDef {
  const m = /^(pre|post)fxsidechain$/.exec(def.key)
  return m ? { ...def, when: { key: `${m[1]}fxtype`, values: [COMPRESSOR] } } : def
}

/** The Compressor's starting values (it has no presets), read off the synth's screen after a
 * switch from Init: Ratio 20.0:1, Threshold -32.0 dB, Attack 1 ms, Release 285 ms, Output 128,
 * Sidechain off (user, 2026-10-11). */
const COMPRESSOR_START = [1020, 512, 1, 285, 128]

/**
 * What the synth sets when the Pre-/Post-FX type changes (`prefxtype` = 1 etc.), by key: the
 * type's first preset, on every switch -- Chorus edited, Flanger, back to Chorus came back as
 * Chorus 1 (captured 2026-10-11) -- or the Compressor's starting values. Dry/Wet stays.
 * Null if `key` isn't an FX type, and for Bypass.
 */
export function fxTypeValues(key: string, type: number): Map<string, number> | null {
  const m = /^(pre|post)fxtype$/.exec(key)
  if (!m) return null
  if (type === COMPRESSOR)
    return new Map([[`${m[1]}fxsidechain`, 0], ...COMPRESSOR_START.map((v, j): [string, number] => [`${m[1]}fx${type}param${j + 1}`, v])])
  const values = fxPresetValues(`${m[1]}fx${type}preset`, 0)
  return values ? new Map([[`${m[1]}fx${type}preset`, 0], ...values]) : null
}

/** The five param values a preset sets, by key, for `prefx7preset` = 6 etc.; null if `key` isn't a preset. */
export function fxPresetValues(key: string, value: number): [string, number][] | null {
  const m = /^(pre|post)fx(\d)preset$/.exec(key)
  const preset = m && FX_PRESETS[Number(m[2])]?.[value]
  if (!m || !preset) return null
  return preset.params.map((v, j) => [`${m[1]}fx${m[2]}param${j + 1}`, v])
}
