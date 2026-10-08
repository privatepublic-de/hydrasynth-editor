import { useRef, useState } from 'react'
import { formatValue } from '../params/display'
import { param } from '../params/patch'
import { useEditor, useGesture } from './store'

const W = 640
const H = 150
const FULL = 1024

/**
 * An LFO's Step sequence as bars around the centre line, like the synth's Step Edit page:
 * drag across them to draw, or pick a step with Left/Right and change it with Up/Down.
 */
export function StepEditor({ lfo }: { lfo: number }) {
  const patch = useEditor((s) => s.sync?.patch)
  useEditor((s) => s.sync?.revision)
  const set = useEditor((s) => s.set)
  const [selected, setSelected] = useState(0)
  const drawing = useRef(false)
  const { beginGesture, endGesture } = useGesture()
  if (!patch) return null
  const p = `lfo${lfo}`
  const count = Math.max(2, Math.min(64, patch.get(`${p}steps`)))
  const key = (i: number) => `${p}step${i + 1}`
  const value = (i: number) => patch.get(key(i))
  const barW = W / count
  const at = Math.min(selected, count - 1)

  const fromPointer = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const i = Math.max(0, Math.min(count - 1, Math.floor(((e.clientX - r.left) / r.width) * count)))
    const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))
    set(key(i), Math.round((1 - y) * FULL))
    setSelected(i)
  }

  return (
    <div className="step-editor">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="step-editor__bars"
        role="group"
        tabIndex={0}
        aria-label={`LFO ${lfo} steps; Left and Right pick a step, Up and Down change it`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          beginGesture()
          drawing.current = true
          fromPointer(e)
        }}
        onPointerMove={(e) => drawing.current && fromPointer(e)}
        onPointerUp={() => {
          drawing.current = false
          endGesture()
        }}
        onPointerCancel={() => {
          drawing.current = false
          endGesture()
        }}
        onKeyDown={(e) => {
          // One displayed unit is 8 raw steps (-64..64 over 0..1024); Shift for an eighth.
          const unit = e.shiftKey ? 1 : 8
          if (e.key === 'ArrowLeft') setSelected(Math.max(0, at - 1))
          else if (e.key === 'ArrowRight') setSelected(Math.min(count - 1, at + 1))
          else if (e.key === 'ArrowUp') set(key(at), Math.min(FULL, value(at) + unit))
          else if (e.key === 'ArrowDown') set(key(at), Math.max(0, value(at) - unit))
          else return
          e.preventDefault()
        }}
      >
        <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="screen__grid" />
        {Array.from({ length: count }, (_, i) => {
          const y = H - (value(i) / FULL) * H
          return (
            <rect
              key={i}
              x={i * barW + 1}
              width={Math.max(1, barW - 2)}
              y={Math.min(y, H / 2)}
              height={Math.max(1, Math.abs(y - H / 2))}
              className={i === at ? 'step-editor__bar is-selected' : 'step-editor__bar'}
            />
          )
        })}
      </svg>
      <p className="step-editor__readout" aria-live="polite">
        Step {at + 1} of {count}: {formatValue(param(key(at)), value(at))}
      </p>
    </div>
  )
}
