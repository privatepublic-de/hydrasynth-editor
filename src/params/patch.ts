// A patch is its 2790 bytes as the synth sends them; every parameter is a view onto
// them. Editing in place keeps all the bytes nobody has decoded yet exactly as they were.
import { PATCH_BYTES } from '../sysex/protocol'
import { FX_PRESET_PARAMS, withKnob2Condition } from './fxPresets'
import { MOD_DESTINATION_CATEGORIES, PARAMS } from './generated'
import type { ByteField, Condition, ParamDef } from './types'

export const PARAM_BY_KEY: ReadonlyMap<string, ParamDef> = new Map([...PARAMS.map(withKnob2Condition), ...FX_PRESET_PARAMS].map((p) => [p.key, p]))

const NAME = { offset: 9, length: 16 }
/** 16 characters + NUL each. Edisyn assumes 8, but factory patches use more ("Tremolo-Darken"). */
const MACRO_NAME = { offset: 1630, stride: 17, length: 16 }
/** Firmware 2.x keeps the vibrato amount's tenths in a separate byte. */
const VIBRATO = { whole: 46, tenths: 2462 }
/**
 * A second copy of the arp tempo (the param reads byte 28). They differ in ~1/5 of real
 * patches; Edisyn writes both, and a whole-patch send with only byte 28 changed left the
 * synth's tempo as it was (user, 2026-10-08).
 */
const ARP_TEMPO_COPY = 808
/** The synth stores a category byte beside every mod-matrix and macro target. */
const MOD_TARGET = /^modmatrix(\d+)modtarget$/
const MACRO_TARGET = /^macro(\d)target(\d)$/

export function param(key: string): ParamDef {
  const def = PARAM_BY_KEY.get(key)
  if (!def) throw new Error(`unknown parameter ${key}`)
  return def
}

function readField(bytes: Uint8Array, f: ByteField): number {
  if (f.bit !== undefined) return (bytes[f.offset] >> f.bit) & 1
  if (f.size === 1) return f.signed ? (bytes[f.offset] << 24) >> 24 : bytes[f.offset]
  const v = bytes[f.offset] | (bytes[f.offset + 1] << 8)
  return f.signed ? (v << 16) >> 16 : v
}

function writeField(bytes: Uint8Array, f: ByteField, v: number) {
  if (f.bit !== undefined) {
    bytes[f.offset] = (bytes[f.offset] & ~(1 << f.bit)) | ((v & 1) << f.bit)
    return
  }
  bytes[f.offset] = v & 0xff
  // A 1-byte value still owns its high byte (sign or 0; a stray -100 left 0xFF there),
  // unless the next byte is a neighbour's.
  if (!f.packed) bytes[f.offset + 1] = (v >> 8) & 0xff
}

export class Patch {
  readonly bytes: Uint8Array

  constructor(bytes: Uint8Array) {
    if (bytes.length !== PATCH_BYTES) throw new Error(`a patch is ${PATCH_BYTES} bytes, got ${bytes.length}`)
    this.bytes = new Uint8Array(bytes)
  }

  clone(): Patch {
    return new Patch(this.bytes)
  }

  get(key: string): number {
    const def = param(key)
    if (def.special === 'vibratoAmount') return this.bytes[VIBRATO.whole] * 10 + this.bytes[VIBRATO.tenths]
    return readField(this.bytes, def.field!)
  }

  /** Writes a value (clamped to the param's range), plus the bytes derived from it. */
  set(key: string, value: number) {
    const def = param(key)
    const v = Math.max(def.min, Math.min(def.max, Math.round(value)))
    // Unchanged values leave the bytes alone (e.g. an arp tempo copy that differs stays as stored).
    if (this.get(key) === v) return
    if (def.special === 'vibratoAmount') {
      this.bytes[VIBRATO.whole] = Math.floor(v / 10)
      this.bytes[VIBRATO.tenths] = v % 10
      return
    }
    writeField(this.bytes, def.field!, v)
    let m: RegExpMatchArray | null
    if (key === 'arptempo') {
      this.bytes[ARP_TEMPO_COPY] = v & 0xff
      this.bytes[ARP_TEMPO_COPY + 1] = v >> 8
    } else if ((m = key.match(MOD_TARGET))) this.bytes[1030 + (+m[1] - 1) * 2] = MOD_DESTINATION_CATEGORIES[v]
    else if ((m = key.match(MACRO_TARGET))) this.bytes[1478 + (+m[1] - 1) * 16 + (+m[2] - 1) * 2] = MOD_DESTINATION_CATEGORIES[v]
  }

  /** Whether `def` is the meaning its bytes have right now (e.g. a sync-on time while BPM sync is on). */
  isActive(def: ParamDef): boolean {
    return def.when ? conditionHolds(this, def.when) : true
  }

  get name(): string {
    return readString(this.bytes, NAME.offset, NAME.length)
  }
  set name(name: string) {
    writeString(this.bytes, NAME.offset, NAME.length, name)
  }

  macroName(macro: number): string {
    return readString(this.bytes, MACRO_NAME.offset + (macro - 1) * MACRO_NAME.stride, MACRO_NAME.length)
  }
  setMacroName(macro: number, name: string) {
    writeString(this.bytes, MACRO_NAME.offset + (macro - 1) * MACRO_NAME.stride, MACRO_NAME.length, name)
  }

  get version(): number {
    return this.bytes[4]
  }
}

function conditionHolds(patch: Patch, c: Condition): boolean {
  const hit = c.values.includes(patch.get(c.key))
  return c.negate ? !hit : hit
}

function readString(bytes: Uint8Array, offset: number, length: number): string {
  const raw = bytes.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return String.fromCharCode(...(end < 0 ? raw : raw.subarray(0, end)))
}

/**
 * Printable ASCII, then a NUL (one past a full field: the patch name's byte 25 and each macro
 * name's 17th byte). What follows the NUL is leftover from
 * earlier names (the synth reads up to it), so it's left alone.
 */
function writeString(bytes: Uint8Array, offset: number, length: number, s: string) {
  const n = Math.min(s.length, length)
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i)
    bytes[offset + i] = c >= 32 && c < 127 ? c : 32
  }
  bytes[offset + n] = 0
}
