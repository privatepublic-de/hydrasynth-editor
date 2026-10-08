// The synth's Left display: the wave of an oscillator, the shape of an envelope, an LFO or a
// filter's response -- and here also a place to edit them by dragging. The dials stay the
// keyboard-accessible way to set every value these handles change.
import { useEffect, useRef } from 'react'
import { formatValue } from '../params/display'
import { param, type Patch } from '../params/patch'
import { F_MAX, F_MIN, cutoffHz, filter1Gain, filter2Gain, responseCurve } from '../ui/filterResponse'
import { envelopeShape, lfoAt, lfoLevel, type Point } from '../ui/shapes'
import { scanPosition, shownEntry, waveImage, wavelist } from '../ui/waves'
import { useEditor, useGesture } from './store'

const W = 360
const H = 140
const PAD = 10
const X = (x: number) => PAD + x * (W - 2 * PAD)
const Y = (y: number) => H - PAD - y * (H - 2 * PAD)

const path = (pts: Point[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ')

/** Pointer position in the SVG's viewBox units. */
function svgPoint(svg: SVGSVGElement, e: React.PointerEvent): { x: number; y: number } {
  const r = svg.getBoundingClientRect()
  return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }
}

/**
 * A draggable point. `begin` snapshots what the drag starts from; `move` gets that, the drag
 * offset and the pointer position, all in viewBox units.
 */
function Handle<T>({
  cx,
  cy,
  r = 6,
  title,
  begin,
  move,
}: {
  cx: number
  cy: number
  r?: number
  title: string
  begin: () => T
  move: (start: T, d: { dx: number; dy: number; x: number; y: number }) => void
}) {
  const drag = useRef<{ x: number; y: number; start: T } | null>(null)
  const { beginGesture, endGesture } = useGesture()
  return (
    <circle
      cx={cx}
      cy={cy}
      r={r}
      className="screen__handle"
      onPointerDown={(e) => {
        e.stopPropagation()
        e.currentTarget.setPointerCapture(e.pointerId)
        const p = svgPoint(e.currentTarget.ownerSVGElement!, e)
        beginGesture()
        drag.current = { ...p, start: begin() }
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        const p = svgPoint(e.currentTarget.ownerSVGElement!, e)
        move(drag.current.start, { dx: p.x - drag.current.x, dy: p.y - drag.current.y, ...p })
      }}
      onPointerUp={() => {
        drag.current = null
        endGesture()
      }}
      onPointerCancel={() => {
        drag.current = null
        endGesture()
      }}
    >
      <title>{title}</title>
    </circle>
  )
}

function EnvelopeGraph({ patch, env }: { patch: Patch; env: number }) {
  const set = useEditor((s) => s.set)
  const { points, marks, sustain } = envelopeShape(patch, env)
  const p = `env${env}`
  const timeKey = (name: string) => `${p}${name}sync${patch.get(`${p}bpmsync`) ? 'on' : 'off'}`
  /** A time follows the drag like a dial: the full width is about the whole range. */
  const time = (name: string) => {
    const key = timeKey(name)
    const def = param(key)
    return {
      begin: () => patch.get(key),
      move: (start: number, { dx }: { dx: number }) => set(key, start + (dx * (def.max - def.min)) / (W - 2 * PAD)),
    }
  }
  /** Dragging a segment's middle bends it; `sign` is which way is a fast start. */
  const curve = (name: string, sign: 1 | -1) => ({
    begin: () => patch.get(`${p}${name}curve`),
    move: (start: number, { dy }: { dy: number }) => set(`${p}${name}curve`, start + sign * dy * 1.2),
  })
  const mid = (a: number, b: number, from: number, to: number) => {
    const x = (marks[a] + marks[b]) / 2
    const near = points.reduce((best, q) => (Math.abs(q.x - x) < Math.abs(best.x - x) ? q : best), points[0])
    return { cx: X(x), cy: Y(from === to ? from : near.y) }
  }
  const area = `${path(points)} L${W - PAD},${H - PAD} L${PAD},${H - PAD} Z`
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="screen__graph screen__graph--edit" aria-label={`Envelope ${env}: drag the points to edit`}>
      {marks.slice(1, -1).map((m, i) => (
        <line key={i} x1={X(m)} x2={X(m)} y1={PAD} y2={H - PAD} className="screen__grid" />
      ))}
      <line x1={PAD} x2={W - PAD} y1={H - PAD} y2={H - PAD} className="screen__grid" />
      <path d={area} className="screen__area" />
      <path d={path(points)} className="screen__line" />
      {/* Later handles sit on top where they meet: Attack wins over Delay and Hold at 0. */}
      <Handle cx={X(marks[1])} cy={Y(0)} title="Delay" {...time('delay')} />
      <Handle cx={X(marks[3])} cy={Y(1)} title="Hold" {...time('hold')} />
      <Handle cx={X(marks[2])} cy={Y(1)} title="Attack" {...time('attack')} />
      <Handle
        cx={X(marks[4])}
        cy={Y(sustain)}
        title="Decay (sideways), Sustain (up and down)"
        begin={() => patch.get(timeKey('decay'))}
        move={(start, { dx, y }) => {
          const key = timeKey('decay')
          const def = param(key)
          set(key, start + (dx * (def.max - def.min)) / (W - 2 * PAD))
          set(`${p}sustain`, (1 - (y - PAD) / (H - 2 * PAD)) * 1024)
        }}
      />
      <Handle cx={X(marks[6])} cy={Y(0)} title="Release" {...time('release')} />
      <Handle r={4} {...mid(1, 2, 0, 1)} title="Attack curve (up and down)" {...curve('atk', -1)} />
      <Handle r={4} {...mid(3, 4, 1, sustain)} title="Decay curve (up and down)" {...curve('dec', 1)} />
      <Handle r={4} {...mid(5, 6, sustain, 0)} title="Release curve (up and down)" {...curve('rel', 1)} />
    </svg>
  )
}

/**
 * Steps a choice-like param by dragging sideways (a step per 12 px), the wheel, or the arrow
 * keys while focused -- for picking waves by looking at them.
 */
function Stepper({ paramKey, showName, children }: { paramKey: string; showName?: boolean; children: React.ReactNode }) {
  const def = param(paramKey)
  const value = useEditor((s) => s.sync?.patch?.get(paramKey) ?? def.min)
  const set = useEditor((s) => s.set)
  const drag = useRef<{ x: number; start: number } | null>(null)
  const el = useRef<HTMLDivElement>(null)
  const { beginGesture, endGesture } = useGesture()
  const go = (v: number) => set(paramKey, Math.max(def.min, Math.min(def.max, v)))
  // React's wheel handler is passive: it can't stop the page scrolling along. A native one can.
  const latest = useRef(go)
  latest.current = go
  const valueRef = useRef(value)
  valueRef.current = value
  useEffect(() => {
    const node = el.current
    if (!node) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      latest.current(valueRef.current + (e.deltaY > 0 || e.deltaX > 0 ? 1 : -1))
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [])
  return (
    <div
      ref={el}
      className="screen__stepper"
      role="slider"
      tabIndex={0}
      aria-label={`${def.labels[0] ?? paramKey}: drag sideways, scroll or use the arrow keys`}
      aria-valuemin={def.min}
      aria-valuemax={def.max}
      aria-valuenow={value}
      aria-valuetext={formatValue(def, value)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        beginGesture()
        drag.current = { x: e.clientX, start: value }
      }}
      onPointerMove={(e) => drag.current && go(drag.current.start + Math.round((e.clientX - drag.current.x) / 12))}
      onPointerUp={() => {
        drag.current = null
        endGesture()
      }}
      onPointerCancel={() => {
        drag.current = null
        endGesture()
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') go(value + 1)
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') go(value - 1)
        else return
        e.preventDefault()
      }}
    >
      {children}
      {showName && <span className="screen__stepper-name">{formatValue(def, value)}</span>}
    </div>
  )
}

function LfoGraph({ patch, lfo }: { patch: Patch; lfo: number }) {
  const level = lfoLevel(patch, lfo)
  const N = 240
  const CYCLES = 2
  const points = Array.from({ length: N + 1 }, (_, i) => ({ x: i / N, y: 0.5 + 0.5 * level * lfoAt(patch, lfo, (i / N) * CYCLES) }))
  return (
    <Stepper paramKey={`lfo${lfo}wave`} showName>
      <svg viewBox={`0 0 ${W} ${H}`} className="screen__graph" aria-hidden="true">
        <line x1={PAD} x2={W - PAD} y1={H / 2} y2={H / 2} className="screen__grid" />
        <line x1={W / 2} x2={W / 2} y1={PAD} y2={H - PAD} className="screen__grid" />
        <path d={path(points)} className="screen__line" />
      </svg>
    </Stepper>
  )
}

/** Click or drag along it to move the WaveScan position over the wavelist. */
function ScanTrack({ osc, length }: { osc: number; length: number }) {
  const key = `osc${osc}wavscan`
  const value = useEditor((s) => s.sync?.patch?.get(key) ?? 0)
  const set = useEditor((s) => s.set)
  const dragging = useRef(false)
  const { beginGesture, endGesture } = useGesture()
  // Entry i sits at the centre of the i-th of `length` cells; position i is WaveScan i/7.
  const fromX = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const i = ((e.clientX - r.left) / r.width) * length - 0.5
    set(key, Math.round((Math.max(0, Math.min(length - 1, i)) / 7) * 1024))
  }
  const at = Math.min((value / 1024) * 7, length - 1)
  return (
    <div
      className="screen__track"
      role="slider"
      tabIndex={0}
      aria-label="WaveScan position"
      aria-valuemin={0}
      aria-valuemax={1024}
      aria-valuenow={value}
      aria-valuetext={formatValue(param(key), value)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        beginGesture()
        dragging.current = true
        fromX(e)
      }}
      onPointerMove={(e) => dragging.current && fromX(e)}
      onPointerUp={() => {
        dragging.current = false
        endGesture()
      }}
      onPointerCancel={() => {
        dragging.current = false
        endGesture()
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 8 : 64
        if (e.key === 'ArrowRight') set(key, value + step)
        else if (e.key === 'ArrowLeft') set(key, value - step)
        else return
        e.preventDefault()
      }}
    >
      <div className="screen__marker" style={{ left: `${((at + 0.5) / length) * 100}%` }} />
    </div>
  )
}

function OscWave({ patch, osc }: { patch: Patch; osc: number }) {
  const p = `osc${osc}`
  const picked = useEditor((s) => s.waveView[p])
  const setWaveView = useEditor((s) => s.setWaveView)
  const scanning = osc !== 3 && patch.get(`${p}mode`) === 1
  if (!scanning) {
    return (
      <Stepper paramKey={`${p}type`}>
        <img className="screen__wave" src={waveImage(patch.get(`${p}type`))} alt="" draggable={false} />
      </Stepper>
    )
  }
  const list = wavelist(patch, osc)
  const shown = shownEntry(patch, osc, picked)
  const toggle = (slot: number) => setWaveView(p, picked === slot ? undefined : slot)
  const big =
    shown && shown.wave !== 'silence' ? (
      <img className="screen__wave" src={waveImage(shown.wave)} alt="" draggable={false} />
    ) : (
      <div className="screen__wave screen__silence screen__silence--large">Silence</div>
    )
  return (
    <div className="screen__scan">
      {shown ? <Stepper paramKey={`${p}wavscanwave${shown.slot}`}>{big}</Stepper> : big}
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
            {w.wave === 'silence' ? <span className="screen__silence">Silence</span> : <img src={waveImage(w.wave)} alt="" draggable={false} />}
          </button>
        ))}
      </div>
      <ScanTrack osc={osc} length={list.length} />
    </div>
  )
}

const DB_TOP = 24
const DB_BOTTOM = -48
const dbY = (db: number) => PAD + ((DB_TOP - Math.max(DB_BOTTOM, Math.min(DB_TOP, db))) / (DB_TOP - DB_BOTTOM)) * (H - 2 * PAD)
const freqX = (hz: number) => PAD + (Math.log(hz / F_MIN) / Math.log(F_MAX / F_MIN)) * (W - 2 * PAD)
/** Cutoff 0..1024 is linear in x (the graph's log axis), so a pointer's x is a cutoff value. */
const xToValue = (x: number) => ((x - PAD) / (W - 2 * PAD)) * 1024

function FilterGraph({ patch, filter }: { patch: Patch; filter: 1 | 2 }) {
  const set = useEditor((s) => s.set)
  const f = `filter${filter}`
  const gain = filter === 1 ? (hz: number) => filter1Gain(patch, hz) : (hz: number) => filter2Gain(patch, hz)
  const curve = responseCurve(gain)
  const d = curve.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${dbY(p.db).toFixed(1)}`).join(' ')
  const vowel = filter === 1 && [10, 16].includes(patch.get('filter1type'))
  // On Vowel the sideways drag moves the formants (Formant / Control) instead of a cutoff.
  const xKey = vowel ? 'filter1special' : `${f}cutoff`
  const handleX = vowel ? X(patch.get('filter1special') / 1024) : freqX(cutoffHz(patch.get(`${f}cutoff`)))
  const handleHz = F_MIN * (F_MAX / F_MIN) ** ((handleX - PAD) / (W - 2 * PAD))
  const handleY = dbY(20 * Math.log10(Math.max(1e-6, gain(handleHz))))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="screen__graph screen__graph--edit" aria-label={`Filter ${filter}: drag the point to edit`}>
      {[100, 1000, 10000].map((hz) => (
        <line key={hz} x1={freqX(hz)} x2={freqX(hz)} y1={PAD} y2={H - PAD} className="screen__grid" />
      ))}
      <line x1={PAD} x2={W - PAD} y1={dbY(0)} y2={dbY(0)} className="screen__grid" />
      <line x1={handleX} x2={handleX} y1={PAD} y2={H - PAD} className="screen__cutoff" />
      <path d={`${d} L${W - PAD},${H - PAD} L${PAD},${H - PAD} Z`} className="screen__area" />
      <path d={d} className="screen__line" />
      <Handle
        cx={handleX}
        cy={handleY}
        title={`${vowel ? 'Formant' : 'Cutoff'} (sideways), Resonance (up and down)`}
        begin={() => patch.get(`${f}resonance`)}
        move={(start, { dy, x }) => {
          set(xKey, xToValue(x))
          set(`${f}resonance`, start - dy * 8)
        }}
      />
    </svg>
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
  else if (module === 'filter1' || module === 'filter2') body = <FilterGraph patch={patch} filter={module === 'filter1' ? 1 : 2} />
  if (!body) return null
  return <div className="screen">{body}</div>
}
