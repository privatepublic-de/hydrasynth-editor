import { NRPN_TABLES } from './generated'
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
