import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeMessage } from '../src/sysex/codec'
import { PATCH_BYTES, parseChunk } from '../src/sysex/protocol'
import { MOD_DESTINATION_CATEGORIES, PARAMS } from '../src/params/generated'
import { encodeNrpn } from '../src/params/nrpn'
import { Patch, param } from '../src/params/patch'
import type { ParamDef } from '../src/params/types'
import { loadFixtureMessages } from './fixtures'

const fixturePatch = () =>
  new Patch(Uint8Array.from(loadFixtureMessages().flatMap((m) => [...parseChunk(decodeMessage(m).info)!.data])))

function ownBytes(def: ParamDef): number[] {
  if (def.special === 'vibratoAmount') return [46, 2462]
  const f = def.field!
  if (f.bit !== undefined || f.packed) return [f.offset]
  return [f.offset, f.offset + 1]
}

function derivedBytes(key: string): number[] {
  let m: RegExpMatchArray | null
  if ((m = key.match(/^modmatrix(\d+)modtarget$/))) return [1030 + (+m[1] - 1) * 2]
  if ((m = key.match(/^macro(\d)target(\d)$/))) return [1478 + (+m[1] - 1) * 16 + (+m[2] - 1) * 2]
  if (key === 'arptempo') return [808, 809]
  return []
}

describe('parameter schema', () => {
  it('covers the patch with ~1,100 params, all in range of the 2790 bytes', () => {
    expect(PARAMS.length).toBeGreaterThan(1000)
    for (const p of PARAMS) for (const b of ownBytes(p)) expect(b).toBeLessThan(PATCH_BYTES)
  })

  it('never lets two params share a byte unless a condition or a bit tells them apart', () => {
    const owners = new Map<number, ParamDef[]>()
    for (const p of PARAMS) for (const b of ownBytes(p)) owners.set(b, [...(owners.get(b) ?? []), p])
    for (const [b, ps] of owners) {
      if (ps.length < 2) continue
      const ok = ps.every((p) => p.when) || ps.every((p) => p.field?.bit !== undefined)
      expect(ok, `byte ${b}: ${ps.map((p) => p.key).join(', ')}`).toBe(true)
    }
  })

  it('writes only its own bytes (and its derived category byte), for min, max, 0 and -1', () => {
    const base = fixturePatch()
    for (const def of PARAMS) {
      const allowed = new Set([...ownBytes(def), ...derivedBytes(def.key)])
      for (const v of new Set([def.min, def.max, Math.max(def.min, Math.min(def.max, 0)), Math.max(def.min, -1)])) {
        const p = base.clone()
        p.set(def.key, v)
        expect(p.get(def.key), `${def.key}=${v}`).toBe(v)
        for (let i = 0; i < PATCH_BYTES; i++)
          if (p.bytes[i] !== base.bytes[i]) expect(allowed.has(i), `${def.key}=${v} touched byte ${i}`).toBe(true)
      }
    }
  })

  it('clears a stale high byte when writing a 1-byte value', () => {
    const p = fixturePatch()
    const f = param('mutant3sourcefmlin').field!
    p.bytes[f.offset] = 0x9c
    p.bytes[f.offset + 1] = 0xff
    p.set('mutant3sourcefmlin', 3)
    expect([p.bytes[f.offset], p.bytes[f.offset + 1]]).toEqual([3, 0])
  })

  it('writes the arp tempo to both of its copies', () => {
    const p = fixturePatch()
    p.set('arptempo', 1234)
    expect([p.bytes[28] | (p.bytes[29] << 8), p.bytes[808] | (p.bytes[809] << 8)]).toEqual([1234, 1234])
  })

  it('keeps a mod-matrix target and its category byte together', () => {
    const p = fixturePatch()
    const target = MOD_DESTINATION_CATEGORIES.findIndex((c, i) => i > 0 && c !== MOD_DESTINATION_CATEGORIES[0])
    p.set('modmatrix5modtarget', target)
    expect(p.bytes[1030 + 4 * 2]).toBe(MOD_DESTINATION_CATEGORIES[target])
  })

  it('reads and writes NUL-terminated names without touching neighbours', () => {
    const p = fixturePatch()
    expect(p.name).toBe('Sawpressive GD')
    p.name = 'Shelf Pad'
    expect(p.name).toBe('Shelf Pad')
    p.name = 'Exactly16CharsXY+'
    expect(p.name).toBe('Exactly16CharsXY')
    expect(p.bytes[25]).toBe(0)
    expect(p.get('category')).toBe(fixturePatch().get('category'))
    expect(p.get('color')).toBe(fixturePatch().get('color'))
    p.setMacroName(8, 'Wobble')
    expect(p.macroName(8)).toBe('Wobble')
    p.setMacroName(7, 'Tremolo-Darken-Extra')
    expect(p.macroName(7)).toBe('Tremolo-Darken-E')
    expect(p.macroName(8)).toBe('Wobble')
  })

  it('resolves a shared byte by its mode', () => {
    const p = fixturePatch()
    p.set('env1bpmsync', 0)
    expect(p.isActive(param('env1attacksyncoff'))).toBe(true)
    expect(p.isActive(param('env1attacksyncon'))).toBe(false)
    p.set('mutant1mode', 2)
    expect(p.isActive(param('mutant1sourceoscsync'))).toBe(true)
    expect(p.isActive(param('mutant1sourcefmlin'))).toBe(false)
  })
})

// Checks against what Edisyn itself does, over every patch dumped from the synth.
// Needs local/patches (tools/dumpBanks.ts) and local/extract (tools/edisyn-extract/run.sh).
const EXTRACT = 'local/extract'
const haveExtract = existsSync(`${EXTRACT}/values.jsonl`) && existsSync('local/patches/A.bin')

describe.skipIf(!haveExtract)('against Edisyn, on the dumped patches', () => {
  it('decodes every active param of every patch to Edisyn’s value', () => {
    const lines = readFileSync(`${EXTRACT}/values.jsonl`, 'utf8').trim().split('\n')
    const banks = new Map<string, Uint8Array>()
    let checked = 0
    const mismatches: string[] = []
    const outOfRange = new Set<string>()
    for (const line of lines) {
      const { file, index, values } = JSON.parse(line) as { file: string; index: number; values: Record<string, number | string> }
      if (!banks.has(file)) banks.set(file, readFileSync(`local/patches/${file}`))
      const patch = new Patch(banks.get(file)!.subarray(index * PATCH_BYTES, (index + 1) * PATCH_BYTES))
      for (const def of PARAMS) {
        if (!patch.isActive(def) || !(def.key in values)) continue
        const ours = patch.get(def.key)
        // Raw values outside Edisyn's range, which it clamps or rewrites on load; we keep the byte.
        if (ours < def.min || ours > def.max) {
          outOfRange.add(def.key.replace(/\d+/g, '#'))
          continue
        }
        let theirs = values[def.key] as number
        // Edisyn reads these 2-byte values with its 1-byte setter (256 reads as 0).
        if (/^voicemodulation\d$/.test(def.key)) theirs = theirs & 0xff
        const cmp = /^voicemodulation\d$/.test(def.key) ? ours & 0xff : ours
        if (cmp !== theirs) mismatches.push(`${file}#${index} ${def.key}: ours ${ours}, Edisyn ${theirs}`)
        checked++
      }
      // Edisyn turns NUL, non-ASCII and filename-unsafe characters into spaces; the synth itself allows ';' etc.
      const edisynName = String.fromCharCode(...patch.bytes.subarray(9, 25)).replace(/[^ -~]|["*\\|/<>?;~]/g, ' ')
      expect(edisynName.trim()).toBe((values.name as string).trim())
    }
    expect(mismatches.slice(0, 20)).toEqual([])
    expect(checked).toBeGreaterThan(1_000_000)
    // Seen in the user's dump: unset LFO steps (0), filter 1 type 16 and FX sidechains 5/6 (unknown
    // to Edisyn), ribbon key lock 0, and a few stray bytes. A new key here is worth a look.
    expect([...outOfRange].sort()).toEqual(
      [
        'arpgate', 'arpoctave', 'arpphrase', 'arpswing', 'filter#type', 'lfo#steps', 'mutant#feedback',
        'mutant#ratio', 'mutant#sourcefmlin', 'postfx#param#', 'postfxsidechain', 'prefxsidechain',
        'ribbonscalekeylock', 'voicedensity',
      ].sort(),
    )
  })

  it('writes every in-range param of every dumped patch back to identical bytes', () => {
    let checked = 0
    for (const bank of 'ABCDEFGH') {
      const raw = readFileSync(`local/patches/${bank}.bin`)
      for (let n = 0; n < 128; n++) {
        const original = new Patch(raw.subarray(n * PATCH_BYTES, (n + 1) * PATCH_BYTES))
        const p = original.clone()
        for (const def of PARAMS) {
          const v = p.get(def.key)
          if (v < def.min || v > def.max) continue
          p.set(def.key, v)
          checked++
        }
        p.name = original.name
        for (let m = 1; m <= 8; m++) p.setMacroName(m, original.macroName(m))
        const diff = p.bytes.findIndex((b, i) => b !== original.bytes[i])
        expect(diff, `${bank}${n + 1}: byte ${diff}`).toBe(-1)
      }
    }
    expect(checked).toBeGreaterThan(1_000_000)
  })

  it('emits the same NRPN as Edisyn for every value of every param', () => {
    const mismatches: string[] = []
    let checked = 0
    for (const line of readFileSync(`${EXTRACT}/nrpn.jsonl`, 'utf8').trim().split('\n')) {
      const { key, emits } = JSON.parse(line) as { key: string; emits: (number | null | number[])[][] }
      const def = PARAMS.find((p) => p.key === key)
      // Edisyn sends these, but its own notes say the synth ignores them on receive.
      if (!def || key === 'arptempo' || key === 'filter1vowelorder') continue
      for (const [v, ...msgs] of emits as [number, ...(number[] | null)[]][]) {
        const ours = encodeNrpn(def, v)
        const theirs =
          msgs.length === 4
            ? (() => {
                const cc = new Map((msgs as number[][]).map(([c, x]) => [c, x]))
                return { param: (cc.get(99)! << 7) | cc.get(98)!, value: (cc.get(6)! << 7) | cc.get(38)! }
              })()
            : null
        // Edisyn never sends FX params live (see tools/generateParams.ts); ours are confirmed on the device.
        if (theirs === null && /^(pre|post)fx\dparam\d$/.test(key)) continue
        if (JSON.stringify(ours) !== JSON.stringify(theirs)) mismatches.push(`${key}=${v}: ours ${JSON.stringify(ours)}, Edisyn ${JSON.stringify(theirs)}`)
        checked++
      }
    }
    expect(mismatches.slice(0, 20)).toEqual([])
    expect(checked).toBeGreaterThan(100_000)
  })
})

describe('display', async () => {
  const { formatValue } = await import('../src/params/display')
  it('shows values the way Edisyn does', () => {
    expect(formatValue(param('osc1semi'), -12)).toBe('-12')
    expect(formatValue(param('lfo1wave'), 0)).toBe('Sine')
    expect(formatValue(param('modmatrix1modtarget'), 0)).toBe('Off')
    expect(formatValue(param('voicesnap'), 1)).toBe('On')
    expect(formatValue(param('env1atkcurve'), 0)).not.toMatch(/[<>&]/)
  })
  it('labels values confirmed on the device, and marks the rest it does not know', () => {
    expect(formatValue(param('filter1type'), 16)).toBe('Vowel')
    expect(formatValue(param('filter1type'), 10)).toBe('Vowel')
    expect(formatValue(param('prefxsidechain'), 5)).toBe('? (5)')
  })
})
