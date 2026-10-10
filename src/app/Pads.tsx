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
  /** Latch: a pad's release sends no note off; the note sounds until its pad is tapped again or latch is switched off. */
  const [latch, setLatch] = useState(false)
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

  // In latch mode a press toggles the note, and a release does nothing.
  const down = (n: number) => press(n, latch ? !held.has(n) : true)
  const up = (n: number) => {
    if (!latch) press(n, false)
  }
  const toggleLatch = () => {
    if (latch) {
      for (const n of held) note(n, false)
      setHeld(new Set())
    }
    setLatch(!latch)
  }

  return (
    <section className="pads" aria-label="Pads">
      <div className="pads__octave">
        {/* Up on top, down below, like the pad rows. */}
        <button type="button" className="function-button" onClick={() => setBase((b) => Math.min(96, b + 12))} disabled={base >= 96}>
          Oct +
        </button>
        <span>{noteName(base)}</span>
        <button type="button" className="function-button" onClick={() => setBase((b) => Math.max(0, b - 12))} disabled={base <= 0}>
          Oct −
        </button>
      </div>
      <button type="button" className="function-button pads__latch" aria-pressed={latch} onClick={toggleLatch} title="Notes keep sounding until their pad is tapped again or Latch is switched off">
        Latch
      </button>
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
              down(n)
            }}
            onPointerUp={() => up(n)}
            onPointerCancel={() => up(n)}
            onKeyDown={(e) => {
              if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                e.preventDefault()
                down(n)
              }
            }}
            onKeyUp={(e) => {
              if (e.key === ' ' || e.key === 'Enter') up(n)
            }}
          >
            {n % 12 === 0 ? noteName(n) : ''}
          </button>
        ))}
      </div>
    </section>
  )
}

/** The connected port and its channel, beside the pads that play on it. */
export function MidiPort() {
  const connection = useEditor((s) => s.connection)
  const channel = useEditor((s) => s.channel)
  const setChannel = useEditor((s) => s.setChannel)
  if (connection.status !== 'connected') return null
  return (
    <div className="midi-port">
      <span className="midi-port__name" title="MIDI port">
        {connection.port}
      </span>
      <label className="midi-port__channel" title={`MIDI channel of ${connection.port}`}>
        Channel
        <select value={channel} onChange={(e) => setChannel(Number(e.target.value))}>
          {Array.from({ length: 16 }, (_, i) => (
            <option key={i + 1} value={i + 1}>
              {i + 1}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
