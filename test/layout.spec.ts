import { describe, expect, it } from 'vitest'
import { PARAMS } from '../src/params/generated'
import { FX_PRESET_PARAMS } from '../src/params/fxPresets'
import { param } from '../src/params/patch'
import { MIRRORS, MODULES, moduleOf, slotKeys } from '../src/ui/layout'

const keysOf = (m: (typeof MODULES)[number]) => m.pages.flatMap((p) => p.slots.flatMap(slotKeys))
// Each key's home placement; mirrored copies elsewhere are checked on their own below.
const placed = MODULES.flatMap((m) => keysOf(m).filter((k) => (MIRRORS.get(k) ?? m.id) === m.id))

describe('module layout', () => {
  it('places every param exactly once', () => {
    const all = [...PARAMS, ...FX_PRESET_PARAMS]
    const known = new Set(all.map((p) => p.key))
    const seen = new Set<string>()
    const dupes = placed.filter((k) => seen.has(k) || !seen.add(k))
    expect(dupes).toEqual([])
    expect(placed.filter((k) => !known.has(k))).toEqual([])
    expect(all.map((p) => p.key).filter((k) => !seen.has(k))).toEqual([])
  })

  it('mirrors only keys placed in their home module', () => {
    for (const [key, home] of MIRRORS) {
      expect(keysOf(MODULES.find((m) => m.id === home)!), key).toContain(key)
      expect(MODULES.filter((m) => keysOf(m).includes(key)).length, key).toBeGreaterThan(1)
    }
    expect(moduleOf('mixerosc1vol')?.id).toBe('mixer')
  })

  it('fits every page on the eight Control knobs', () => {
    const over = MODULES.flatMap((m) => m.pages.filter((p) => p.slots.length > 8).map((p) => `${m.id}/${p.title}`))
    expect(over).toEqual([])
  })

  it('shares a knob only between mode-dependent readings', () => {
    for (const m of MODULES)
      for (const p of m.pages)
        for (const slot of p.slots) {
          if (!Array.isArray(slot)) continue
          expect(slot.length).toBeGreaterThan(1)
          for (const k of slot) expect(param(k).when, `${m.id}/${p.title}: ${k}`).toBeDefined()
          // Readings of one knob follow the same mode param, or the editor could show two at once.
          expect(new Set(slot.map((k) => param(k).when!.key)).size).toBe(1)
        }
  })

  it('gives every row of a table the same columns', () => {
    for (const m of MODULES) {
      const widths = new Map<string, Set<number>>()
      for (const p of m.pages) if (p.table) widths.set(p.table, (widths.get(p.table) ?? new Set()).add(p.slots.length))
      for (const [table, w] of widths) expect(w.size, `${m.id}/${table}`).toBe(1)
    }
  })

  it('has unique module ids and page titles', () => {
    expect(new Set(MODULES.map((m) => m.id)).size).toBe(MODULES.length)
    for (const m of MODULES) expect(new Set(m.pages.map((p) => p.title)).size, m.id).toBe(m.pages.length)
  })

  it('finds a key\'s module', () => {
    expect(moduleOf('env1attacksyncon')?.id).toBe('env1')
    expect(moduleOf('prefx9param5')?.label).toBe('PRE-FX')
    expect(moduleOf('ribbonmode')?.keyboardOnly).toBe(true)
    expect(moduleOf('nope')).toBeUndefined()
  })
})
