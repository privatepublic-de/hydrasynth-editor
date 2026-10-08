import { NRPN_TABLES } from './generated'
import { PARAM_BY_KEY } from './patch'
import type { ParamDef } from './types'

export interface NrpnMessage {
  param: number
  value: number
}

/** The NRPN the synth expects for `value`, or null for params it can only get in a whole-patch send. */
export function encodeNrpn(def: ParamDef, value: number): NrpnMessage | null {
  const spec = def.nrpn
  if (!spec) return null
  if ('table' in spec) return { param: spec.param, value: NRPN_TABLES[spec.table][value - def.min] }
  return { param: spec.param, value: spec.base + value * spec.mul + (value < 0 ? spec.negAdd : 0) }
}

/** CC 99/98/6/38, the order the synth (and Edisyn) use. */
export function nrpnBytes(channel: number, { param, value }: NrpnMessage): number[] {
  const status = 0xb0 | (channel - 1)
  return [status, 99, param >> 7, status, 98, param & 127, status, 6, value >> 7, status, 38, value & 127]
}

let byParam: Map<number, ParamDef[]> | null = null

/**
 * The param an incoming NRPN sets, and its value. One NRPN number can carry several params:
 * by value range (Env 1's loop, legato, delay... each at its own base) or by mode (the nine FX
 * types' params, synced and free times), and then `isActive` picks the current mode's reading;
 * if none is active, the first that fits (a mode about to be switched to sends its value first).
 */
export function decodeNrpn(param: number, value: number, isActive: (def: ParamDef) => boolean): { def: ParamDef; value: number } | null {
  byParam ??= [...PARAM_BY_KEY.values()].reduce((m, d) => {
    if (d.nrpn) m.set(d.nrpn.param, [...(m.get(d.nrpn.param) ?? []), d])
    return m
  }, new Map<number, ParamDef[]>())
  const fits: { def: ParamDef; value: number }[] = []
  for (const def of byParam.get(param) ?? []) {
    const spec = def.nrpn!
    let v: number
    if ('table' in spec) {
      const i = NRPN_TABLES[spec.table].indexOf(value)
      if (i < 0) continue
      v = i + def.min
    } else {
      // negAdd marks negatives as the synth's two's complement in 7 or 14 bits.
      const raw = spec.negAdd && value >= spec.negAdd / 2 + spec.base ? value - spec.negAdd : value
      v = (raw - spec.base) / spec.mul
      if (!Number.isInteger(v)) v = Math.round(v)
    }
    if (v >= def.min && v <= def.max) fits.push({ def, value: v })
  }
  return fits.find((f) => isActive(f.def)) ?? fits[0] ?? null
}
