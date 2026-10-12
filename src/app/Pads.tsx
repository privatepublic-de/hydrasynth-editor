import { useEffect, useRef, useState } from 'react'
import { NOTE_NAMES, noteName } from '../audio/pitch'
import { useEditor } from './store'

/**
 * The computer keyboard plays the pads by key position, not by letter, so any layout works: on an
 * English one Z…, (comma) is the bottom pad row, A…K the middle and Q…I the top.
 */
const KEY_ROWS = [
  ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma'],
  ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK'],
  ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI'],
]
const KEY_PADS = new Map(KEY_ROWS.flatMap((row, r) => row.map((code, i) => [code, r * 8 + i] as const)))

/** Whether a key typed at this element is text for it: in a text field, a select or the patch picker's search, the letters are not notes. */
function typing(t: EventTarget | null) {
  if (!(t instanceof HTMLElement)) return false
  if (t.closest('[role="dialog"]') || t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true
  return t.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button'].includes((t as HTMLInputElement).type)
}

/** 24 pads like the Desktop's, chromatic from the bottom left; play notes to audition the patch. */
export function Pads() {
  const note = useEditor((s) => s.note)
  const connected = useEditor((s) => s.connection.status === 'connected')
  const [base, setBase] = useState(48)
  const [held, setHeld] = useState<Set<number>>(new Set())
  /** Latch: a pad's release sends no note off; the note sounds until its pad is tapped again or latch is switched off. */
  const [latch, setLatch] = useState(false)
  const rows = [2, 1, 0].map((r) => Array.from({ length: 8 }, (_, i) => base + r * 8 + i))

  // The held notes as of now, for key events that come quicker than renders.
  const heldNow = useRef(held)

  const press = (n: number, on: boolean) => {
    if (on === heldNow.current.has(n)) return
    note(n, on)
    const next = new Set(heldNow.current)
    if (on) next.add(n)
    else next.delete(n)
    heldNow.current = next
    setHeld(next)
  }

  // In latch mode a press toggles the note, and a release does nothing.
  const down = (n: number) => press(n, latch ? !heldNow.current.has(n) : true)
  const up = (n: number) => {
    if (!latch) press(n, false)
  }
  const toggleLatch = () => {
    if (latch) {
      for (const n of heldNow.current) note(n, false)
      heldNow.current = new Set()
      setHeld(heldNow.current)
    }
    setLatch(!latch)
  }

  // The keys' handlers see this render's base, latch and connection.
  const keys = useRef({ down, up, base, connected })
  keys.current = { down, up, base, connected }
  useEffect(() => {
    // The note each key started, so its release ends that note even after an octave change.
    const playing = new Map<string, number>()
    const onDown = (e: KeyboardEvent) => {
      const pad = KEY_PADS.get(e.code)
      if (pad === undefined || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return
      if (!keys.current.connected || document.querySelector('dialog[open]')) return
      e.preventDefault()
      if (e.repeat || playing.has(e.code)) return
      const n = keys.current.base + pad
      playing.set(e.code, n)
      keys.current.down(n)
    }
    const onUp = (e: KeyboardEvent) => {
      const n = playing.get(e.code)
      if (n === undefined) return
      playing.delete(e.code)
      keys.current.up(n)
    }
    // A key let go in another window sends no keyup here: end its note on leaving.
    const onBlur = () => {
      for (const n of playing.values()) keys.current.up(n)
      playing.clear()
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

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
