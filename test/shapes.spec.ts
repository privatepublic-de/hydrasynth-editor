import { describe, expect, it } from 'vitest'
import { Patch } from '../src/params/patch'
import { curveAt, displayedSeconds, envelopeShape, lfoAt } from '../src/ui/shapes'
import { fixtureBytes } from './fakeSynth'

describe('shapes for the display', () => {
  it('reads displayed times in seconds, synced ones at 120 BPM', () => {
    expect(displayedSeconds('0ms')).toBe(0)
    expect(displayedSeconds('448ms')).toBeCloseTo(0.448)
    expect(displayedSeconds('2.17s')).toBeCloseTo(2.17)
    expect(displayedSeconds('1/4')).toBeCloseTo(0.5)
    expect(displayedSeconds('1/4 D')).toBeCloseTo(0.75)
    expect(displayedSeconds('1/4 T')).toBeCloseTo(1 / 3)
    expect(displayedSeconds('2')).toBeCloseTo(4)
  })

  it('bends curves between a slow and a fast start, linear at 64', () => {
    expect(curveAt(0.5, 64)).toBeCloseTo(0.5)
    for (const c of [0, 128]) {
      expect(curveAt(0, c)).toBeCloseTo(0)
      expect(curveAt(1, c)).toBeCloseTo(1)
    }
    expect(curveAt(0.25, 128)).toBeGreaterThan(0.5)
    expect(curveAt(0.25, 0)).toBeLessThan(0.1)
  })

  it('draws an envelope from 0 up to 1, through the sustain, back to 0', () => {
    const p = new Patch(fixtureBytes())
    p.set('env1bpmsync', 0)
    p.set('env1attacksyncoff', 500)
    p.set('env1sustain', 512)
    const { points, sustain, marks } = envelopeShape(p, 1)
    expect(sustain).toBeCloseTo(0.5)
    expect(points[0]).toEqual({ x: 0, y: 0 })
    expect(points.at(-1)!.y).toBeCloseTo(0)
    expect(points.at(-1)!.x).toBeCloseTo(marks[6])
    expect(marks[6]).toBeLessThanOrEqual(1 + 1e-9)
    expect(Math.max(...points.map((q) => q.y))).toBeCloseTo(1)
    for (let i = 1; i < points.length; i++) expect(points[i].x).toBeGreaterThanOrEqual(points[i - 1].x - 1e-9)
  })

  it('draws 0 ms stages as near-vertical edges, not stretched ramps (the Init patch)', () => {
    const p = new Patch(fixtureBytes())
    p.set('env1bpmsync', 0)
    for (const k of ['delay', 'attack', 'hold', 'decay', 'release']) p.set(`env1${k}syncoff`, 0)
    p.set('env1sustain', 1024)
    const { marks } = envelopeShape(p, 1)
    expect(marks[2] - marks[1]).toBeLessThan(0.05) // attack
    expect(marks[6] - marks[5]).toBeLessThan(0.05) // release
    expect(marks[6]).toBeLessThan(0.35) // the whole envelope is short
  })

  it('compresses a long envelope to fit, keeping short stages visible', () => {
    const p = new Patch(fixtureBytes())
    p.set('env1bpmsync', 0)
    p.set('env1attacksyncoff', 100)
    p.set('env1decaysyncoff', 1024)
    p.set('env1releasesyncoff', 1024)
    const { marks } = envelopeShape(p, 1)
    expect(marks[6]).toBeCloseTo(1)
    expect(marks[2] - marks[1]).toBeGreaterThan(0.03)
  })

  it('draws LFO waves with their phase, and Step waves from the steps', () => {
    const p = new Patch(fixtureBytes())
    p.set('lfo1wave', 0)
    p.set('lfo1phase', 0)
    expect(lfoAt(p, 1, 0.25)).toBeCloseTo(1)
    p.set('lfo1phase', 90)
    expect(lfoAt(p, 1, 0)).toBeCloseTo(1)
    p.set('lfo1wave', 10)
    p.set('lfo1phase', 0)
    p.set('lfo1steps', 4)
    p.set('lfo1smooth', 0)
    p.set('lfo1step2', 1024)
    expect(lfoAt(p, 1, 0.3)).toBeCloseTo(1)
  })
})
