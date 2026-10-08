// The synth's Left display: the wave of an oscillator, the shape of an envelope or an LFO.
import type { Patch } from '../params/patch'
import { envelopeShape, lfoAt, lfoLevel, type Point } from '../ui/shapes'
import { useEditor } from './store'

const W = 360
const H = 140
const PAD = 10

const path = (pts: Point[]) =>
  pts.map((p, i) => `${i ? 'L' : 'M'}${(PAD + p.x * (W - 2 * PAD)).toFixed(1)},${(H - PAD - p.y * (H - 2 * PAD)).toFixed(1)}`).join(' ')

function EnvelopeGraph({ patch, env }: { patch: Patch; env: number }) {
  const { points, marks } = envelopeShape(patch, env)
  const area = `${path(points)} L${W - PAD},${H - PAD} L${PAD},${H - PAD} Z`
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="screen__graph" role="img" aria-label={`Envelope ${env} shape`}>
      {marks.slice(1, -1).map((m, i) => (
        <line key={i} x1={PAD + m * (W - 2 * PAD)} x2={PAD + m * (W - 2 * PAD)} y1={PAD} y2={H - PAD} className="screen__grid" />
      ))}
      <line x1={PAD} x2={W - PAD} y1={H - PAD} y2={H - PAD} className="screen__grid" />
      <path d={area} className="screen__area" />
      <path d={path(points)} className="screen__line" />
    </svg>
  )
}

function LfoGraph({ patch, lfo }: { patch: Patch; lfo: number }) {
  const level = lfoLevel(patch, lfo)
  const N = 240
  const CYCLES = 2
  const points = Array.from({ length: N + 1 }, (_, i) => {
    const c = (i / N) * CYCLES
    return { x: i / N, y: 0.5 + 0.5 * level * lfoAt(patch, lfo, c) }
  })
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="screen__graph" role="img" aria-label={`LFO ${lfo} wave`}>
      <line x1={PAD} x2={W - PAD} y1={H / 2} y2={H / 2} className="screen__grid" />
      <line x1={W / 2} x2={W / 2} y1={PAD} y2={H - PAD} className="screen__grid" />
      <path d={path(points)} className="screen__line" />
    </svg>
  )
}

/** Wave pictures by Thierry Rochebois Zic (CC BY 4.0, see public/waves/README.txt). */
const waveImage = (wave: number) => `${import.meta.env.BASE_URL}waves/${wave}.png`

function OscWave({ patch, osc }: { patch: Patch; osc: number }) {
  const p = `osc${osc}`
  const scanning = osc !== 3 && patch.get(`${p}mode`) === 1
  if (!scanning) {
    const wave = patch.get(`${p}type`)
    return <img className="screen__wave" src={waveImage(wave)} alt="" />
  }
  // Wavelist: wave 1 is a wave number; waves 2-8 put Off and Silence ahead of the waves.
  const list = [1, 2, 3, 4, 5, 6, 7, 8]
    .map((i) => {
      const v = patch.get(`${p}wavscanwave${i}`)
      return i === 1 ? { i, wave: v } : v >= 2 ? { i, wave: v - 2 } : v === 1 ? { i, wave: null } : null
    })
    .filter((w): w is { i: number; wave: number | null } => w !== null)
  // WaveScan 0..1024 runs over positions 1.0 .. 8.0; an Off slot drops out of the list.
  const position = (patch.get(`${p}wavscan`) / 1024) * 7
  const at = Math.min(position, list.length - 1)
  const near = list[Math.round(at)]
  return (
    <div className="screen__scan">
      {near?.wave != null ? (
        <img className="screen__wave" src={waveImage(near.wave)} alt="" />
      ) : (
        <div className="screen__wave screen__silence screen__silence--large">Silence</div>
      )}
      <div className="screen__strip">
        {list.map((w, n) =>
          w.wave === null ? (
            <span key={w.i} className="screen__silence">Silence</span>
          ) : (
            <img key={w.i} src={waveImage(w.wave)} alt="" className={Math.round(at) === n ? 'is-near' : ''} />
          ),
        )}
      </div>
      <div className="screen__marker" style={{ left: `${((at + 0.5) / list.length) * 100}%` }} aria-hidden="true" />
    </div>
  )
}

/** Shown above a module's pages when the synth's display would draw something for it. */
export function ModuleDisplay({ module }: { module: string }) {
  const patch = useEditor((s) => s.sync?.patch)
  useEditor((s) => s.sync?.revision)
  if (!patch) return null
  let m: RegExpMatchArray | null
  let body: JSX.Element | null = null
  if ((m = module.match(/^env(\d)$/))) body = <EnvelopeGraph patch={patch} env={+m[1]} />
  else if ((m = module.match(/^lfo(\d)$/))) body = <LfoGraph patch={patch} lfo={+m[1]} />
  else if ((m = module.match(/^osc(\d)$/))) body = <OscWave patch={patch} osc={+m[1]} />
  if (!body) return null
  return <div className="screen">{body}</div>
}
