import { describe, expect, it } from 'vitest'
import { centerValue } from '../src/params/display'
import { PARAMS } from '../src/params/generated'

const def = (key: string) => PARAMS.find((p) => p.key === key)!

describe('centerValue', () => {
  it('finds the zero of bipolar dials, whatever their storage', () => {
    expect(centerValue(def('modmatrix1depth'))).toBe(512)
    expect(centerValue(def('mixerosc1pan'))).toBe(512)
    expect(centerValue(def('env1deccurve'))).toBe(64)
    expect(centerValue(def('osc1semi'))).toBe(0)
    expect(centerValue(def('arpstepoffset'))).toBe(32)
  })

  it('has none for dials that start at zero or end there', () => {
    expect(centerValue(def('amplevel'))).toBeUndefined()
    expect(centerValue(def('postfx8param2'))).toBeUndefined()
  })
})
