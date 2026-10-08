import { useEffect, useRef } from 'react'
import { formatValue } from '../../params/display'
import { param } from '../../params/patch'
import { useEditor, useGesture } from '../store'

/**
 * Steps a choice-like param by dragging sideways (a step per 12 px), the wheel, or the arrow
 * keys while focused -- for picking waves by looking at them.
 */
export function Stepper({
  paramKey,
  showName,
  className,
  children,
}: {
  paramKey: string
  showName?: boolean
  className?: string
  children: React.ReactNode
}) {
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
      className={`screen__stepper${className ? ` ${className}` : ''}`}
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
