import { useEffect, useRef, useState } from 'react'
import { buildSpeechPatch } from '../ui/speechPatch'
import { useEditor } from './store'

const SPEEDS = [
  { label: 'Slow', speed: 1.4 },
  { label: 'Normal', speed: 1 },
  { label: 'Fast', speed: 0.75 },
]

/**
 * Asks before the whole patch is replaced by one that speaks `text` (src/ui/speechPatch.ts),
 * then loads it. Live, the replacement has no undo, so this says so every time.
 */
export function SpeechPatchDialog({ text, onDone }: { text: string; onDone: (said: string, words: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const name = useEditor((s) => s.sync?.patch?.name ?? '')
  const dirty = useEditor((s) => !!s.sync?.dirty)
  const demo = useEditor((s) => s.connection.status === 'demo')
  const loadPatch = useEditor((s) => s.loadPatch)
  const [speed, setSpeed] = useState(1)
  const [input, setInput] = useState(text)
  useEffect(() => ref.current?.showModal(), [])
  const speech = buildSpeechPatch(input, { speed: SPEEDS[speed].speed })
  const words = input.trim()

  const replace = () => {
    ref.current?.close()
    if (!speech) return onDone('Nothing to say', input)
    void loadPatch(speech.patch, `Speech patch “${words}”`)
    onDone(
      `${speech.sounds.map((s) => s || '·').join(' ')}: hold a note ${(speech.ms / 1000).toFixed(1)} s` +
        (speech.dropped ? ` (${speech.dropped} sounds left out)` : ''),
      input,
    )
  }

  return (
    <dialog ref={ref} className="write-dialog" onCancel={() => onDone('', input)}>
      <h2>Replace “{name}” with a speech patch?</h2>
      <label className="speech-dialog__field">
        Words
        <input type="text" value={input} maxLength={60} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && speech && replace()} />
      </label>
      <p>
        A new patch that says {words ? `“${words}”` : 'the words'} on every note replaces the whole patch you’re editing: oscillators, mixer, both filters,
        envelopes, all five LFOs and the mod matrix.
        {demo ? '' : ' This can’t be undone.'}
        {dirty && ` Your changes to “${name}” haven’t been written to the synth.`}
      </p>
      <p>
        A Saw through the Vowel filter and noise through Filter 2, run by five one-shot Step LFOs: vowel, voicing, hiss, hiss colour
        and pitch. {speech ? `It says ${speech.sounds.map((s) => s || '·').join(' ')} in ${(speech.ms / 1000).toFixed(1)} s; hold the note at least that long.` : 'There are no words to say.'}
        {speech?.dropped ? ` Too long: the last ${speech.dropped} sounds are left out.` : ''}
      </p>
      <label className="speech-dialog__field">
        Speed
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
          {SPEEDS.map((s, i) => (
            <option key={s.label} value={i}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <div className="write-dialog__actions">
        <button type="button" className="function-button" onClick={() => (ref.current?.close(), onDone('', input))}>
          Cancel
        </button>
        <button type="button" className="function-button function-button--primary" onClick={replace} disabled={!speech}>
          {dirty ? 'Discard changes and replace' : 'Replace with speech patch'}
        </button>
      </div>
    </dialog>
  )
}
