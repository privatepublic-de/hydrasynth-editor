// An oscillator's WaveScan list: the eight slots where the synth has them (Off gaps included,
// since the synth skips them and they change what a position plays), each wave's share of the
// sound at the current position, and the position itself.
import { useRef } from 'react'
import { formatValue } from '../params/display'
import { param } from '../params/patch'
import { entryPositions, slotShares, waveOf } from '../ui/waves'
import { ParamControl } from './controls/ParamControl'
import { Stepper } from './controls/Stepper'
import { useEditor, useGesture } from './store'
import { WavePicture } from './WavePicture'
import { WavelistFill } from './WavelistFill'

const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8]
const WAVES = 219
/** Slots 2-8 store Off (0) and Silence (1) ahead of the waves; slot 1 stores the wave itself. */
const stored = (slot: number, wave: number) => (slot === 1 ? wave : wave + 2)

function WaveCell({ osc, slot, share }: { osc: number; slot: number; share: number }) {
  const key = `osc${osc}wavscanwave${slot}`
  const value = useEditor((s) => s.sync?.patch?.get(key) ?? 0)
  const set = useEditor((s) => s.set)
  const patch = useEditor((s) => s.sync?.patch)
  const wave = waveOf(key, value)

  if (wave === null) {
    // A new wave: one step on from the nearest wave before it, so it never repeats that one.
    const add = () => {
      let prev = 0
      for (let s = slot - 1; s >= 1 && patch; s--) {
        const w = waveOf(`osc${osc}wavscanwave${s}`, patch.get(`osc${osc}wavscanwave${s}`))
        if (typeof w === 'number') {
          prev = w
          break
        }
      }
      set(key, stored(slot, (prev + 1) % WAVES))
    }
    return (
      <div className="wave-cell wave-cell--off">
        <button type="button" className="wave-cell__add" onClick={add} title={`Wave ${slot} is Off; the synth skips it. Click to add a wave.`}>
          <span className="wave-cell__slot">{slot}</span>+
        </button>
      </div>
    )
  }

  return (
    <div className={`wave-cell${share > 0 ? ' is-sounding' : ''}`}>
      <div className="wave-cell__picture">
        <Stepper paramKey={key} className="wave-cell__stepper">
          {wave === 'silence' ? (
            <div className="wave-cell__silence">Silence</div>
          ) : (
            <WavePicture wave={wave} />
          )}
        </Stepper>
        <span className="wave-cell__slot">{slot}</span>
        {slot !== 1 && (
          <button type="button" className="wave-cell__remove" aria-label={`Set wave ${slot} to Off`} title="Set to Off" onClick={() => set(key, 0)}>
            ×
          </button>
        )}
        {/* How much of this wave the current WaveScan position plays. */}
        <span className="wave-cell__share" style={{ width: `${share * 100}%` }} aria-hidden="true" />
      </div>
      <ParamControl paramKey={key} label="" />
    </div>
  )
}

/** The WaveScan position over its whole range, with a tick where each sounding wave sits. */
function ScanSlider({ osc }: { osc: number }) {
  const key = `osc${osc}wavscan`
  const value = useEditor((s) => s.sync?.patch?.get(key) ?? 0)
  const patch = useEditor((s) => s.sync?.patch)
  useEditor((s) => s.sync?.revision)
  const set = useEditor((s) => s.set)
  const { beginGesture, endGesture } = useGesture()
  const dragging = useRef(false)
  if (!patch) return null
  const ticks = entryPositions(patch, osc)
  const fromX = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    set(key, Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 1024))
  }
  const last = ticks.at(-1)?.value ?? 0
  return (
    <div className="scan-slider">
      <span className="scan-slider__label">WaveScan</span>
      <div
        className="scan-slider__track"
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
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') set(key, value + step)
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') set(key, value - step)
          else return
          e.preventDefault()
        }}
      >
        {/* Past the last sounding wave the scan just holds it. */}
        <span className="scan-slider__beyond" style={{ left: `${(last / 1024) * 100}%` }} aria-hidden="true" />
        {ticks.map((t) => (
          <span key={t.slot} className="scan-slider__tick" style={{ left: `${(t.value / 1024) * 100}%` }} aria-hidden="true">
            {t.slot}
          </span>
        ))}
        <span className="scan-slider__thumb" style={{ left: `${(value / 1024) * 100}%` }} aria-hidden="true" />
      </div>
      <span className="scan-slider__value">{formatValue(param(key), value)}</span>
    </div>
  )
}

export function WavelistView({ osc }: { osc: number }) {
  const patch = useEditor((s) => s.sync?.patch)
  useEditor((s) => s.sync?.revision)
  if (!patch) return null
  const shares = slotShares(patch, osc)
  return (
    <section className="page wavelist">
      <h3 className="page__title">
        Wavelist
        <WavelistFill osc={osc} />
      </h3>
      <div className="wavelist__cells">
        {SLOTS.map((slot) => (
          <WaveCell key={slot} osc={osc} slot={slot} share={shares.get(slot) ?? 0} />
        ))}
      </div>
      <ScanSlider osc={osc} />
    </section>
  )
}
