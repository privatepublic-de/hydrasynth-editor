import { useEffect, useRef, useState } from 'react'
import { WAVE_FEATURES } from '../ui/waveFeatures.generated'
import { buildSpeechPatch } from '../ui/speechPatch'
import { loadPronunciations, PITCHES, waveLevels, type Pronunciations } from '../ui/waveSpeech'
import { useEditor } from './store'

/** What the voice is made of (OSC 1): the plain Saw, one wave for the phrase, or a wave per sound. */
const SOURCES = [
  { label: 'Saw, with melody', waves: false, fixed: false, says: 'A Saw', lfo5: 'melody' },
  { label: 'One wave, with melody', waves: true, fixed: true, says: 'One wave fitting all its sounds', lfo5: 'melody' },
  { label: 'A wave per sound', waves: true, fixed: false, says: 'Waves matched to each sound', lfo5: 'wave (ENV 3 moves the pitch)' },
]

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
  const [source, setSource] = useState(1)
  const [pitch, setPitch] = useState(1)
  const [sing, setSing] = useState(false)
  const [dictionary, setDictionary] = useState<Pronunciations | null>(null)
  useEffect(() => {
    ref.current?.showModal()
    void loadPronunciations().then(setDictionary)
  }, [])
  const speech = buildSpeechPatch(input, { speed: SPEEDS[speed].speed, dictionary, sing })
  const words = input.trim()

  const replace = async () => {
    ref.current?.close()
    if (!speech) return onDone('Nothing to say', input)
    let patch = speech.patch
    if (SOURCES[source].waves) {
      const levels = await waveLevels()
      if (levels.filter(Boolean).length < WAVE_FEATURES.length) return onDone("The wave data didn't load", input)
      const waves = { levels, f0: PITCHES[pitch].hz, fixed: SOURCES[source].fixed }
      patch = buildSpeechPatch(input, { speed: SPEEDS[speed].speed, dictionary, waves, sing })!.patch
    }
    void loadPatch(patch, `Speech patch “${words}”`)
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
        <input type="text" value={input} maxLength={60} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && speech && void replace()} />
      </label>
      <p>
        A new patch that says {words ? `“${words}”` : 'the words'} on every note replaces the whole patch you’re editing: oscillators, mixer, both filters,
        envelopes, all five LFOs and the mod matrix.
        {demo ? '' : ' This can’t be undone.'}
        {dirty && ` Your changes to “${name}” haven’t been written to the synth.`}
      </p>
      <p>
        {SOURCES[source].says} through the Vowel filter and noise through Filter 2, run by one-shot Step LFOs: vowel, voicing,{' '}
        {sing && SOURCES[source].lfo5 === 'melody' ? 'hiss and hiss colour' : `hiss, hiss colour and ${sing ? 'wave' : SOURCES[source].lfo5}`}
        {sing ? '; the keys play the tune' : ''}. {speech ? `It says ${speech.sounds.map((s) => s || '·').join(' ')} in ${(speech.ms / 1000).toFixed(1)} s; hold the note at least that long.` : 'There are no words to say.'}
        {speech?.dropped ? ` Too long: the last ${speech.dropped} sounds are left out.` : ''}
      </p>
      <label
        className="speech-dialog__field"
        title="Waves whose harmonics already show the sounds' formants: clearer vowels around the chosen note, less so far from it. A wave per sound changes with each sound but has no melody on its syllables."
      >
        Voice
        <select value={source} onChange={(e) => setSource(Number(e.target.value))}>
          {SOURCES.map((s, i) => (
            <option key={s.label} value={i}>
              {s.label}
            </option>
          ))}
        </select>
        tuned for
        <select value={pitch} onChange={(e) => setPitch(Number(e.target.value))} disabled={!SOURCES[source].waves}>
          {PITCHES.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
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
      <label
        className="speech-dialog__field"
        title="Mono: the keys give the pitch, no melody. Play legato and the phrase goes on at the new note (a short glide between them); let go and the next note starts it again. A phrase ending on a vowel holds it. Hold past twice the phrase and it starts over. The Mod Wheel (or Macro 5, Freeze) stops the phrase on its current sound while it's up."
      >
        <input type="checkbox" checked={sing} onChange={(e) => setSing(e.target.checked)} />
        Sing: Mono, play legato over the phrase
      </label>
      <div className="write-dialog__actions">
        <button type="button" className="function-button" onClick={() => (ref.current?.close(), onDone('', input))}>
          Cancel
        </button>
        <button type="button" className="function-button function-button--primary" onClick={() => void replace()} disabled={!speech}>
          {dirty ? 'Discard changes and replace' : 'Replace with speech patch'}
        </button>
      </div>
    </dialog>
  )
}
