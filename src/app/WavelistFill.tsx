import { useState } from 'react'
import { loadWaveCycles } from '../ui/waveCycles'
import { WAVE_FEATURES } from '../ui/waveFeatures.generated'
import { FILL_STYLES, fillWavelist, type FillStyle } from '../ui/wavePopulate'
import { harmonicLevels, speakWavelist, SILENCE } from '../ui/waveSpeech'
import { SpeechPatchDialog } from './SpeechPatchDialog'
import { useEditor } from './store'

const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8]
/** Wavelist slots 2-8 store Off and Silence ahead of the waves; slot 1 stores the wave itself. */
const stored = (slot: number, wave: number) => (slot === 1 ? wave : wave === SILENCE ? 1 : wave + 2)

const SPEECH = 'speech'
const SPEECH_DESCRIPTION =
  'Waves that say a few English words, talk-box style, as WaveScan sweeps from 1 to 8 (an envelope on WaveScan over the note does it). Vowels carry it; tuned for one octave.'
/** Notes the speech is tuned for: formants sit at fixed frequencies, harmonics move with the key. */
const PITCHES = [
  { label: 'C2', hz: 65.41 },
  { label: 'C3', hz: 130.81 },
  { label: 'C4', hz: 261.63 },
]

/** Each wave's harmonic levels, measured once from the recorded cycles. */
let levels: Promise<(number[] | null)[]> | null = null
const waveLevels = () => (levels ??= loadWaveCycles().then((cycles) => cycles.map((c) => (c ? harmonicLevels(c.cycle) : null))))

/** Fills an oscillator's eight WaveScan waves in a chosen style; each Fill rolls a new set (one undo step). */
export function WavelistFill({ osc }: { osc: number }) {
  const set = useEditor((s) => s.set)
  const grouped = useEditor((s) => s.grouped)
  const patch = useEditor((s) => s.sync?.patch)
  const [style, setStyle] = useState<FillStyle | typeof SPEECH>('morph')
  const [text, setText] = useState('hello world')
  const [pitch, setPitch] = useState(1)
  const [said, setSaid] = useState('')
  const [asking, setAsking] = useState(false)
  const key = (slot: number) => `osc${osc}wavscanwave${slot}`
  if (!patch) return null

  const write = (label: string, waves: number[]) =>
    // One undo step for the eight waves.
    grouped(label, () => SLOTS.forEach((s, i) => set(key(s), stored(s, waves[i]))))

  const fill = async () => {
    if (style !== SPEECH) return write(`Fill OSC ${osc} wavelist`, fillWavelist(style, Math.random, patch.get(key(1))))
    const measured = await waveLevels()
    if (measured.filter(Boolean).length < WAVE_FEATURES.length) return setSaid("The wave data didn't load")
    const speech = speakWavelist(text, measured, PITCHES[pitch].hz)
    if (!speech) return setSaid('Nothing to say')
    write(`Speak "${text.trim()}" on OSC ${osc}`, speech.waves)
    setSaid(speech.sounds.map((s) => s || '·').join(' ') + (speech.dropped ? ` (${speech.dropped} sounds left out)` : ''))
  }
  const description = style === SPEECH ? SPEECH_DESCRIPTION : FILL_STYLES.find((s) => s.id === style)?.description

  return (
    <span className="wavelist-fill">
      {style === SPEECH && said && <span className="wavelist-fill__said" title="The sound in each slot; · is a Silence gap">{said}</span>}
      <select aria-label="Fill style" value={style} title={description} onChange={(e) => setStyle(e.target.value as FillStyle)}>
        {FILL_STYLES.map((s) => (
          <option key={s.id} value={s.id} title={s.description}>
            {s.label}
          </option>
        ))}
        <option value={SPEECH} title={SPEECH_DESCRIPTION}>
          Speech
        </option>
      </select>
      {style === SPEECH && (
        <>
          <input
            type="text"
            aria-label="Words to say"
            placeholder="Words to say"
            value={text}
            maxLength={60}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void fill()}
          />
          <select aria-label="Tuned for" title="The note the speech is tuned for" value={pitch} onChange={(e) => setPitch(Number(e.target.value))}>
            {PITCHES.map((p, i) => (
              <option key={p.label} value={i}>
                {p.label}
              </option>
            ))}
          </select>
        </>
      )}
      <button type="button" className="function-button function-button--primary" title={`Fill all eight waves: ${description}`} onClick={() => void fill()}>
        Fill
      </button>
      {style === SPEECH && (
        <button
          type="button"
          className="function-button"
          title="Replace the whole patch with one that says the words: Vowel filter, noise and five step LFOs"
          onClick={() => setAsking(true)}
          disabled={!text.trim()}
        >
          Speech patch…
        </button>
      )}
      {asking && (
        <SpeechPatchDialog
          text={text}
          onDone={(result, words) => {
            setAsking(false)
            setText(words)
            if (result) setSaid(result)
          }}
        />
      )}
    </span>
  )
}
