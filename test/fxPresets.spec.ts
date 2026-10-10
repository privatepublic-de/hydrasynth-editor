import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatValue } from '../src/params/display'
import { fxPresetValues } from '../src/params/fxPresets'
import { initPatchBytes } from '../src/params/initPatch'
import { Patch, param } from '../src/params/patch'
import { HydrasynthSession } from '../src/sysex/session'
import { PatchSync } from '../src/sync/patchSync'
import { isShown } from '../src/ui/visibility'
import { FakeHydrasynth } from './fakeSynth'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false
  const out = p.finally(() => (done = true))
  while (!done) await vi.advanceTimersByTimeAsync(20)
  return out
}

describe('FX presets', () => {
  it('reads the preset the synth names from knob 2’s byte', () => {
    const p = new Patch(new Uint8Array(2790))
    p.set('postfxtype', 7)
    p.set('postfx7preset', 6)
    expect(formatValue(param('postfx7preset'), p.get('postfx7preset'))).toBe('Warm')
    expect(p.bytes[402]).toBe(6) // the byte Edisyn calls Sidechain
  })

  it('shows Preset on knob 2, Sidechain only on the Compressor', () => {
    const p = new Patch(new Uint8Array(2790))
    p.set('prefxtype', 7)
    expect([p.isActive(param('prefx7preset')), p.isActive(param('prefxsidechain'))]).toEqual([true, false])
    p.set('prefxtype', 8)
    expect(isShown('prefxsidechain', p) && p.isActive(param('prefxsidechain'))).toBe(true)
    expect(() => param('prefx8preset')).toThrow() // the Compressor has no presets
  })

  it('gives each preset its five values', () => {
    expect(fxPresetValues('prefx1preset', 0)).toEqual([
      ['prefx1param1', 259],
      ['prefx1param2', 224],
      ['prefx1param3', 180],
      ['prefx1param4', 64],
      ['prefx1param5', 1],
    ])
    expect(fxPresetValues('prefxtype', 1)).toBeNull()
  })

  it('gives a new FX type its first preset’s values, every time, as the synth does', async () => {
    const synth = new FakeHydrasynth()
    const sync = new PatchSync({ session: new HydrasynthSession(synth), channel: 1 })
    await settle(sync.load(new Patch(initPatchBytes()), { dirty: false }))
    const chorus1 = [259, 224, 180, 64, 1]
    const params = () => [1, 2, 3, 4, 5].map((j) => sync.get().patch!.get(`prefx1param${j}`))
    sync.set('prefxtype', 1)
    await settle(sync.settled())
    expect(params()).toEqual(chorus1)
    expect(synth.nrpns().slice(-5).map(([, v]) => v / 8)).toEqual(chorus1)
    sync.set('prefx1param1', 900)
    sync.set('prefxtype', 2)
    sync.set('prefxtype', 1)
    expect(params()).toEqual(chorus1)
    expect(sync.get().patch!.get('prefxwet')).toBe(512) // Dry/Wet stays
  })

  it('starts the Compressor where the synth does', async () => {
    const synth = new FakeHydrasynth()
    const sync = new PatchSync({ session: new HydrasynthSession(synth), channel: 1 })
    await settle(sync.load(new Patch(initPatchBytes()), { dirty: false }))
    sync.set('postfxtype', 8)
    const p = sync.get().patch!
    expect([1, 2, 3, 4, 5].map((j) => formatValue(param(`postfx8param${j}`), p.get(`postfx8param${j}`)))).toEqual(['20,0:1', '-32,0', '1', '285', '128'])
    expect(p.get('postfxsidechain')).toBe(0)
  })

  it('doesn’t send a preset when the FX type changes, so the synth keeps the values sent', async () => {
    const synth = new FakeHydrasynth()
    const sync = new PatchSync({ session: new HydrasynthSession(synth), channel: 1 })
    await settle(sync.open({ bank: 0, patch: 0 }))
    sync.set('prefxtype', 7)
    sync.set('prefxtype', 1)
    await settle(sync.settled())
    expect(synth.nrpns().map(([p]) => p)).not.toContain(7552)
    // Back on Chorus, the type's preset is what it was before the switch.
    const other = (sync.get().patch!.get('prefx1preset') + 1) % 3
    sync.set('prefx1preset', other)
    await settle(sync.settled())
    expect(synth.nrpns().at(-1)).toEqual([7552, other * 8])
  })
})

describe('FX presets in the user’s banks', () => {
  it.skipIf(!safeExists('local/patches/A.bin'))('names A34’s Post-FX “Warm” and A38’s Pre-FX “Lo-Fi”, as the synth does', () => {
    const bank = readFileSync('local/patches/A.bin')
    const at = (n: number) => new Patch(new Uint8Array(bank.subarray(n * 2790, (n + 1) * 2790)))
    expect(formatValue(param('postfx7preset'), at(33).get('postfx7preset'))).toBe('Warm')
    expect(formatValue(param('prefx7preset'), at(37).get('prefx7preset'))).toBe('Lo-Fi')
  })
})

function safeExists(file: string) {
  try {
    readFileSync(file)
    return true
  } catch {
    return false
  }
}
