import { useState } from 'react'
import { useEditor } from './store'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const noteName = (n: number) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`

/** 24 pads like the Desktop's, chromatic from the bottom left; play notes to audition the patch. */
export function Pads() {
  const note = useEditor((s) => s.note)
  const connected = useEditor((s) => s.connection.status === 'connected')
  const [base, setBase] = useState(48)
  const [held, setHeld] = useState<Set<number>>(new Set())
  const rows = [2, 1, 0].map((r) => Array.from({ length: 8 }, (_, i) => base + r * 8 + i))

  const press = (n: number, on: boolean) => {
    if (on === held.has(n)) return
    note(n, on)
    setHeld((h) => {
      const next = new Set(h)
      if (on) next.add(n)
      else next.delete(n)
      return next
    })
  }

  return (
    <section className="pads" aria-label="Pads">
      <div className="pads__octave">
        <button type="button" className="function-button" onClick={() => setBase((b) => Math.max(0, b - 12))} disabled={base <= 0}>
          Oct −
        </button>
        <span>{noteName(base)}</span>
        <button type="button" className="function-button" onClick={() => setBase((b) => Math.min(96, b + 12))} disabled={base >= 96}>
          Oct +
        </button>
      </div>
      <div className="pads__grid">
        {rows.flat().map((n) => (
          <button
            key={n}
            type="button"
            className={`pad ${n % 12 === 0 ? 'pad--root' : NOTE_NAMES[n % 12].includes('#') ? 'pad--sharp' : 'pad--natural'}`}
            aria-pressed={held.has(n)}
            aria-label={noteName(n)}
            disabled={!connected}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              press(n, true)
            }}
            onPointerUp={() => press(n, false)}
            onPointerCancel={() => press(n, false)}
            onKeyDown={(e) => {
              if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                e.preventDefault()
                press(n, true)
              }
            }}
            onKeyUp={(e) => {
              if (e.key === ' ' || e.key === 'Enter') press(n, false)
            }}
          >
            {n % 12 === 0 ? noteName(n) : ''}
          </button>
        ))}
      </div>
    </section>
  )
}
