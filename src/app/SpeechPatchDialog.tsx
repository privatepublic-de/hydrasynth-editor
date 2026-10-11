import { useEffect, useRef, useState } from 'react'
import { WAVE_FEATURES } from '../ui/waveFeatures.generated'
import { buildSpeechPatch } from '../ui/speechPatch'
import { loadPronunciations, PITCHES, waveLevels, type Pronunciations } from '../ui/waveSpeech'
import { isIndex, useSessionChoices } from './sessionChoices'
import { useEditor } from './store'

/**
 * What the voice is made of (OSC 1): the plain Saw, one wave for the phrase, or a wave per sound;
 * that last also without the Vowel filter (`plain`), the waves alone making the vowels.
 */
const SOURCES = [
  { label: 'Saw, with melody', waves: false, fixed: false, plain: false, says: 'A Saw', lfo5: 'melody' },
  { label: 'One wave, with melody', waves: true, fixed: true, plain: false, says: 'One wave fitting all its sounds', lfo5: 'melody' },
  { label: 'A wave per sound', waves: true, fixed: false, plain: false, says: 'Waves matched to each sound', lfo5: 'wave (ENV 3 moves the pitch)' },
  { label: 'A wave per sound, no Vowel filter', waves: true, fixed: false, plain: true, says: 'Waves matched to each sound', lfo5: 'wave (ENV 3 moves the pitch)' },
]

const SPEEDS = [
  { label: 'Slow', speed: 1.4 },
  { label: 'Normal', speed: 1 },
  { label: 'Fast', speed: 0.75 },
]

/** The dialog's choices, kept for the browser session: the stored ones where still valid. */
const readChoices = (v: Record<string, unknown>) => ({
  speed: isIndex(v.speed, SPEEDS.length) ? v.speed : 1,
  source: isIndex(v.source, SOURCES.length) ? v.source : 1,
  pitch: isIndex(v.pitch, PITCHES.length) ? v.pitch : 1,
  sing: v.sing === true,
})

/**
 * Asks before the whole patch is replaced by one that speaks `text` (src/ui/speechPatch.ts),
 * then loads it. Live, the replacement has no undo, so this says so every time.
 */
/**
 * What speech says, after how to play it: "Hold a note 1.3 s (2 sounds left out): h ah l ow".
 * The same for the speech patch (in its dialog and after it) and the wavelist's Speech fill.
 */
export function speechStatus(howToPlay: string, speech: { dropped: number; sounds: string[] }): string {
  const left = speech.dropped ? ` (${speech.dropped} sounds left out)` : ''
  return `${howToPlay}${left}: ${speech.sounds.map((s) => s || '·').join(' ')}`
}

const holdFor = (ms: number) => `Hold a note ${(ms / 1000).toFixed(1)} s`

export function SpeechPatchDialog({ text, onDone }: { text: string; onDone: (said: string, words: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const name = useEditor((s) => s.sync?.patch?.name ?? '')
  const dirty = useEditor((s) => !!s.sync?.dirty)
  const demo = useEditor((s) => s.connection.status === 'demo')
  const loadPatch = useEditor((s) => s.loadPatch)
  const [{ speed, source, pitch, sing }, choose] = useSessionChoices('hydrasynth-editor.speech', readChoices)
  const [input, setInput] = useState(text)
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
      if (levels.filter(Boolean).length < WAVE_FEATURES.length) return onDone('The wave data didn\u2019t load', input)
      const waves = { levels, f0: PITCHES[pitch].hz, fixed: SOURCES[source].fixed, plain: SOURCES[source].plain }
      patch = buildSpeechPatch(input, { speed: SPEEDS[speed].speed, dictionary, waves, sing })!.patch
    }
    void loadPatch(patch, `Speech patch “${words}”`)
    onDone(speechStatus(holdFor(speech.ms), speech), input)
  }

  const routing =
    `${SOURCES[source].says} through ${SOURCES[source].plain ? 'a low-pass (no Vowel filter, no Voice macro)' : 'the Vowel filter'} and noise through Filter 2, ` +
    `run by one-shot Step LFOs: vowel, voicing, ` +
    (sing && SOURCES[source].lfo5 === 'melody' ? 'hiss and hiss colour' : `hiss, hiss colour and ${sing ? 'wave' : SOURCES[source].lfo5}`) +
    (sing ? '; the keys play the tune.' : '.')

  return (
    <dialog ref={ref} className="write-dialog speech-dialog" onCancel={() => onDone('', input)}>
      <h2>Generate speech patch</h2>
      <p>
        Replaces all of “{name}” with a patch that says the words on every note.
        {demo ? '' : ' Can’t be undone.'}
        {dirty && ' Your unwritten changes are lost.'}
      </p>
      <label className="speech-dialog__field">
        Words
        <input type="text" value={input} maxLength={60} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && speech && void replace()} />
      </label>
      <label
        className="speech-dialog__field"
        title="Waves whose harmonics already show the sounds’ formants: clearer vowels around the chosen note, less so far from it. A wave per sound changes with each sound but has no melody on its syllables. Without the Vowel filter, only the waves make the vowels: they hold near the chosen note and lose them an octave away."
      >
        Voice
        <select value={source} onChange={(e) => choose({ source: Number(e.target.value) })}>
          {SOURCES.map((s, i) => (
            <option key={s.label} value={i}>
              {s.label}
            </option>
          ))}
        </select>
        <span className="speech-dialog__nowrap">tuned for</span>
        <select
          aria-label="Tuned for"
          value={pitch}
          onChange={(e) => choose({ pitch: Number(e.target.value) })}
          disabled={!SOURCES[source].waves}
        >
          {PITCHES.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="speech-dialog__field">
        Speed
        <select value={speed} onChange={(e) => choose({ speed: Number(e.target.value) })}>
          {SPEEDS.map((s, i) => (
            <option key={s.label} value={i}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label
        className="speech-dialog__field"
        title="Mono: the keys give the pitch, no melody. Play legato and the phrase goes on at the new note (a short glide between them); let go and the next note starts it again. A phrase ending on a vowel holds it. With a wave per sound, steps are coarser and holding past twice the phrase starts it over. The Mod Wheel (or Macro 5, Freeze) stops the phrase on its current sound while it’s up."
      >
        <input type="checkbox" checked={sing} onChange={(e) => choose({ sing: e.target.checked })} />
        Sing: Mono, play legato over the phrase
      </label>
      <p className="speech-dialog__said" title={routing}>
        {speech
          ? speechStatus(holdFor(speech.ms), speech)
          : 'Nothing to say'}
      </p>
      <div className="write-dialog__actions">
        <button type="button" className="function-button" onClick={() => (ref.current?.close(), onDone('', input))}>
          Cancel
        </button>
        <button type="button" className="function-button function-button--primary" onClick={() => void replace()} disabled={!speech}>
          {dirty ? 'Discard changes and generate' : 'Generate'}
        </button>
      </div>
    </dialog>
  )
}
