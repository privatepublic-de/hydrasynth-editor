import { describe, expect, it } from 'vitest'
import { initPatchBytes } from '../src/params/initPatch'
import { Patch } from '../src/params/patch'
import { newSlotDepth } from '../src/ui/modDestinations'

describe('newSlotDepth', () => {
  it('centres the depth of an empty route or macro slot when it gets a source or destination', () => {
    const p = new Patch(initPatchBytes())
    expect(newSlotDepth(p, 'modmatrix3modsource', 5)).toBe('modmatrix3depth')
    expect(newSlotDepth(p, 'modmatrix3modtarget', 5)).toBe('modmatrix3depth')
    expect(newSlotDepth(p, 'macro2target4', 7)).toBe('macro2depth4')
  })

  it('leaves slots in use, set depths and Off alone', () => {
    const p = new Patch(initPatchBytes())
    expect(newSlotDepth(p, 'modmatrix3modsource', 0)).toBeUndefined()
    p.set('modmatrix3modsource', 5)
    expect(newSlotDepth(p, 'modmatrix3modtarget', 9)).toBeUndefined() // the route is in use
    p.set('macro1depth1', 300)
    expect(newSlotDepth(p, 'macro1target1', 9)).toBeUndefined()
    expect(newSlotDepth(p, 'osc1mode', 1)).toBeUndefined()
  })
})
