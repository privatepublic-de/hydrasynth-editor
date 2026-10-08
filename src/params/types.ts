/** How a parameter sits in the 2790-byte patch. */
export interface ByteField {
  offset: number
  /** 2 = little-endian 16 bit. 1 = one byte, whose next byte holds its sign (or 0) unless `packed`. */
  size: 1 | 2
  /** A single bit of a shared byte. */
  bit?: number
  signed: boolean
  /** A 1-byte field whose next byte belongs to something else (category | name, panel button states). */
  packed?: true
}

/** A param is only the active reading of its bytes while `key` is (or isn't) one of `values`. */
export interface Condition {
  key: string
  values: number[]
  negate?: boolean
}

export type NrpnSpec =
  /** value14 = base + v*mul, plus negAdd for v < 0 (the synth's two's complement in 7 or 14 bits). */
  | { param: number; base: number; mul: number; negAdd: number }
  /** value14 = NRPN_TABLES[table][v - min] */
  | { param: number; table: number }

export type Widget = 'dial' | 'choice' | 'check'

export interface ParamDef {
  key: string
  /** Edisyn's widget caption(s), e.g. ["Attack"] or ["Hi-Speed", "(Param 2)"] */
  labels: string[]
  min: number
  max: number
  widget: Widget
  field?: ByteField
  /** Stored outside the plain field layout (see patch.ts). */
  special?: 'vibratoAmount'
  when?: Condition
  /** Display: a value shown as `v - displayOffset` ... */
  displayOffset?: number
  /** ... or DISPLAY_TABLES[display][v - min] ... */
  display?: number
  /** ... or CHOICE_TABLES[choices] as [value, label] pairs ... */
  choices?: number
  /** ... or these [value, label] pairs (params defined here, not from Edisyn's tables). */
  options?: [number, string][]
  nrpn?: NrpnSpec
}
