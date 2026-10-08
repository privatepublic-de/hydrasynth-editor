import { useState } from 'react'
import { FILL_STYLES, fillWavelist, type FillStyle } from '../ui/wavePopulate'
import { useEditor } from './store'

const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8]
/** Wavelist slots 2-8 store Off and Silence ahead of the waves; slot 1 stores the wave itself. */
const stored = (slot: number, wave: number) => (slot === 1 ? wave : wave + 2)

/** Fills an oscillator's eight WaveScan waves in a chosen style; each Fill rolls a new set (one undo step). */
export function WavelistFill({ osc }: { osc: number }) {
  const set = useEditor((s) => s.set)
  const grouped = useEditor((s) => s.grouped)
  const patch = useEditor((s) => s.sync?.patch)
  const [style, setStyle] = useState<FillStyle>('morph')
  const key = (slot: number) => `osc${osc}wavscanwave${slot}`
  if (!patch) return null

  const fill = () => {
    const waves = fillWavelist(style, Math.random, patch.get(key(1)))
    // One undo step for the eight waves.
    grouped(`Fill OSC ${osc} wavelist`, () => SLOTS.forEach((s, i) => set(key(s), stored(s, waves[i]))))
  }
  const description = FILL_STYLES.find((s) => s.id === style)?.description

  return (
    <span className="wavelist-fill">
      <select aria-label="Fill style" value={style} title={description} onChange={(e) => setStyle(e.target.value as FillStyle)}>
        {FILL_STYLES.map((s) => (
          <option key={s.id} value={s.id} title={s.description}>
            {s.label}
          </option>
        ))}
      </select>
      <button type="button" className="function-button function-button--primary" title={`Fill all eight waves: ${description}`} onClick={fill}>
        Fill
      </button>
    </span>
  )
}
