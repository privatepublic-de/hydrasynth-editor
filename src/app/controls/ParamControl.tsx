import { useRef } from 'react'
import { choicesOf, formatValue } from '../../params/display'
import { param } from '../../params/patch'
import type { ParamDef } from '../../params/types'
import { useEditor } from '../store'

/** The value of `key` in the open patch, re-read on every sync revision (bytes change in place). */
export function useParamValue(key: string): number | null {
  return useEditor((s) => (s.sync?.patch ? s.sync.patch.get(key) : null))
}

/** `label` overrides the param's own caption; '' leaves it visually out (a table cell, labelled by its column). */
export function ParamControl({ paramKey, label }: { paramKey: string; label?: string }) {
  const def = param(paramKey)
  const value = useParamValue(paramKey)
  const set = useEditor((s) => s.set)
  const caption = label || def.labels[0] || paramKey
  const hidden = label === ''
  if (value === null) return null
  const props = { def, label: caption, hideLabel: hidden, value, onChange: (v: number) => set(def.key, v) }
  if (def.widget === 'check') return <Toggle {...props} />
  if (def.widget === 'choice') return <Choice {...props} />
  return <Dial {...props} />
}

interface ControlProps {
  def: ParamDef
  label: string
  hideLabel?: boolean
  value: number
  onChange: (v: number) => void
}

const Caption = ({ label, hide }: { label: string; hide?: boolean }) => (
  <span className={hide ? 'visually-hidden' : 'control__label'}>{label}</span>
)

const SWEEP = 270
const START = -135

function arcPath(from: number, to: number, r: number) {
  const pt = (deg: number) => {
    const a = ((deg - 90) * Math.PI) / 180
    return `${(24 + r * Math.cos(a)).toFixed(2)} ${(24 + r * Math.sin(a)).toFixed(2)}`
  }
  const large = to - from > 180 ? 1 : 0
  return `M ${pt(from)} A ${r} ${r} 0 ${large} 1 ${pt(to)}`
}

/** An endless-encoder style dial: drag vertically (Shift = fine), wheel, or arrow keys. */
export function Dial({ def, label, hideLabel, value, onChange }: ControlProps) {
  const drag = useRef<{ y: number; start: number } | null>(null)
  const range = def.max - def.min
  const inRange = value >= def.min && value <= def.max
  const t = inRange ? (value - def.min) / (range || 1) : 0
  const bipolar = def.min < 0
  const zeroAt = bipolar ? START + SWEEP * ((0 - def.min) / range) : START
  const at = START + SWEEP * t
  const step = (fine: boolean) => (fine || range <= 128 ? 1 : Math.max(1, Math.round(range / 128)))
  const nudge = (delta: number) => onChange(Math.max(def.min, Math.min(def.max, value + delta)))

  return (
    <div className="control dial">
      <Caption label={label} hide={hideLabel} />
      <svg
        viewBox="0 0 48 48"
        className="dial__knob"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={def.min}
        aria-valuemax={def.max}
        aria-valuenow={value}
        aria-valuetext={formatValue(def, value)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { y: e.clientY, start: value }
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          // A full sweep is ~200 px of travel, ten times finer with Shift.
          const px = drag.current.y - e.clientY
          const perPx = (range / 200) * (e.shiftKey ? 0.1 : 1)
          const next = Math.round(drag.current.start + px * perPx)
          onChange(Math.max(def.min, Math.min(def.max, next)))
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onWheel={(e) => nudge((e.deltaY < 0 ? 1 : -1) * step(e.shiftKey))}
        onKeyDown={(e) => {
          const s = step(e.shiftKey)
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') nudge(s)
          else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') nudge(-s)
          else if (e.key === 'PageUp') nudge(s * 10)
          else if (e.key === 'PageDown') nudge(-s * 10)
          else if (e.key === 'Home') onChange(def.min)
          else if (e.key === 'End') onChange(def.max)
          else return
          e.preventDefault()
        }}
      >
        <path d={arcPath(START, START + SWEEP, 19)} className="dial__track" />
        {inRange && <path d={arcPath(Math.min(zeroAt, at), Math.max(zeroAt, at) + 0.01, 19)} className="dial__fill" />}
        <circle cx="24" cy="24" r="13" className="dial__cap" />
        <line
          x1="24"
          y1="24"
          x2={24 + 11 * Math.cos(((at - 90) * Math.PI) / 180)}
          y2={24 + 11 * Math.sin(((at - 90) * Math.PI) / 180)}
          className="dial__pointer"
        />
      </svg>
      <span className="control__value">{formatValue(def, value)}</span>
    </div>
  )
}

export function Choice({ def, label, hideLabel, value, onChange }: ControlProps) {
  const choices = choicesOf(def)
  const known = choices.some(([v]) => v === value)
  return (
    <label className="control choice">
      <Caption label={label} hide={hideLabel} />
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {!known && <option value={value}>{formatValue(def, value)}</option>}
        {choices.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  )
}

export function Toggle({ label, hideLabel, value, onChange }: ControlProps) {
  return (
    <div className="control toggle">
      <Caption label={label} hide={hideLabel} />
      <button
        type="button"
        className="toggle__button"
        aria-pressed={value !== 0}
        aria-label={hideLabel ? label : undefined}
        onClick={() => onChange(value ? 0 : 1)}
      >
        {value ? 'On' : 'Off'}
      </button>
    </div>
  )
}
