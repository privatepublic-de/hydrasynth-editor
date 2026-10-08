// The synth's Left display: the wave of an oscillator, the shape of an envelope or an LFO.
import type { Patch } from '../params/patch'
import { envelopeShape, lfoAt, lfoLevel, type Point } from '../ui/shapes'
import { scanPosition, shownEntry, waveImage, wavelist } from '../ui/waves'
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

function OscWave({ patch, osc }: { patch: Patch; osc: number }) {
  const p = `osc${osc}`
  const picked = useEditor((s) => s.waveView[p])
  const setWaveView = useEditor((s) => s.setWaveView)
  const scanning = osc !== 3 && patch.get(`${p}mode`) === 1
  if (!scanning) return <img className="screen__wave" src={waveImage(patch.get(`${p}type`))} alt="" />
  const list = wavelist(patch, osc)
  const at = scanPosition(patch, osc, list.length)
  const shown = shownEntry(patch, osc, picked)
  const toggle = (slot: number) => setWaveView(p, picked === slot ? undefined : slot)
  return (
    <div className="screen__scan">
      {shown && shown.wave !== 'silence' ? (
        <img className="screen__wave" src={waveImage(shown.wave)} alt="" />
      ) : (
        <div className="screen__wave screen__silence screen__silence--large">Silence</div>
      )}
      <p className="screen__caption">
        {shown ? `Wave ${shown.slot}` : ''}
        {picked !== undefined && shown?.slot === picked ? (
          <button type="button" className="screen__follow" onClick={() => setWaveView(p, undefined)}>
            Follow WaveScan
          </button>
        ) : (
          <span> at the WaveScan position</span>
        )}
      </p>
      <div className="screen__strip">
        {list.map((w) => (
          <button
            key={w.slot}
            type="button"
            className={`screen__thumb${shown?.slot === w.slot ? ' is-shown' : ''}`}
            aria-label={`Show wave ${w.slot}`}
            aria-pressed={shown?.slot === w.slot}
            onClick={() => toggle(w.slot)}
          >
            {w.wave === 'silence' ? <span className="screen__silence">Silence</span> : <img src={waveImage(w.wave)} alt="" />}
          </button>
        ))}
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
