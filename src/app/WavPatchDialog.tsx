import { useEffect, useMemo, useRef, useState } from 'react'
import { analyse, type SoundAnalysis } from '../audio/analyse'
import { parseWav } from '../audio/wav'
import { WAVE_FEATURES } from '../ui/waveFeatures.generated'
import { waveLevels, wavePeaks } from '../ui/waveSpeech'
import { buildWavPatch, ENVELOPES, SOURCES, wavStatus } from '../ui/wavPatch'
import { isIndex, useSessionChoices } from './sessionChoices'
import { useEditor } from './store'

/** The dialog's choices, kept for the browser session: the stored ones where still valid. */
const readChoices = (v: Record<string, unknown>) => ({
  source: isIndex(v.source, SOURCES.length) ? v.source : 0,
  envelope: isIndex(v.envelope, ENVELOPES.length) ? v.envelope : 0,
  overTime: v.overTime !== false,
  wobble: v.wobble !== false,
  dirt: v.dirt !== false,
})

type Loaded = { analysis: SoundAnalysis; levels: (number[] | null)[]; peaks: (number | null)[] } | { error: string } | null

/**
 * Asks before the whole patch is replaced by one that plays the note recorded in `file`
 * (src/ui/wavPatch.ts), then loads it. Live, the replacement has no undo, so this says so.
 */
export function WavPatchDialog({ file, onDone }: { file: File; onDone: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const name = useEditor((s) => s.sync?.patch?.name ?? '')
  const dirty = useEditor((s) => !!s.sync?.dirty)
  const demo = useEditor((s) => s.connection.status === 'demo')
  const loadPatch = useEditor((s) => s.loadPatch)
  const [choices, choose] = useSessionChoices('hydrasynth-editor.wav', readChoices)
  const [loaded, setLoaded] = useState<Loaded>(null)
  useEffect(() => {
    ref.current?.showModal()
    let live = true
    void (async () => {
      try {
        const [bytes, levels, peaks] = await Promise.all([file.arrayBuffer(), waveLevels(), wavePeaks()])
        if (levels.filter(Boolean).length < WAVE_FEATURES.length) throw new Error('The wave data didn’t load')
        const analysis = analyse(parseWav(bytes))
        if (live) setLoaded({ analysis, levels, peaks })
      } catch (e) {
        if (live) setLoaded({ error: e instanceof Error ? e.message : String(e) })
      }
    })()
    return () => {
      live = false
    }
  }, [file])

  const title = file.name.replace(/\.wav$/i, '')
  const result = useMemo(
    () =>
      loaded && 'analysis' in loaded
        ? buildWavPatch(loaded.analysis, {
            levels: loaded.levels,
            peaks: loaded.peaks,
            source: SOURCES[choices.source].value,
            envelope: ENVELOPES[choices.envelope].value,
            overTime: choices.overTime,
            wobble: choices.wobble,
            dirt: choices.dirt,
            name: title,
          })
        : null,
    [loaded, choices.source, choices.envelope, choices.overTime, choices.wobble, choices.dirt, title],
  )
  const status = result ? wavStatus(result) : loaded && 'error' in loaded ? loaded.error : 'Listening…'

  const replace = () => {
    ref.current?.close()
    if (result) void loadPatch(result.patch, `Patch from “${file.name}”`)
    onDone()
  }

  return (
    <dialog ref={ref} className="write-dialog speech-dialog wav-dialog" onCancel={onDone}>
      <h2>Patch from “{title}”</h2>
      <p className="wav-dialog__intro">
        Replaces “{name}” with a starting point made from the recorded note.
        {demo ? '' : ' No undo.'}
        {dirty && ' Unwritten changes are lost.'}
      </p>
      <div className="wav-dialog__selects">
        <label
          className="speech-dialog__field"
          title="The synth’s own waves matched to the recording’s harmonics, a Sine through Mutant 1’s FM at the ratio and depth that match them, or whichever of the two comes closer."
        >
          Sound
          <select value={choices.source} onChange={(e) => choose({ source: Number(e.target.value) })}>
            {SOURCES.map((s, i) => (
              <option key={s.value} value={i}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="speech-dialog__field" title="The Amp envelope: as the recording rises and fades, or a typical shape.">
          Envelope
          <select value={choices.envelope} onChange={(e) => choose({ envelope: Number(e.target.value) })}>
            {ENVELOPES.map((env, i) => (
              <option key={env.value} value={i}>
                {env.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label
        className="speech-dialog__field"
        title="Waves picked along the note, swept by WaveScan (ENV 3), and the filter following its brightness (ENV 1); with FM, ENV 3 moves its depth instead. A pad’s slow swings on LFO 4 and 5 (pitch, the cutoff, WaveScan or the pulse width), and Amp LFO 2 (level)."
      >
        <input type="checkbox" checked={choices.overTime} onChange={(e) => choose({ overTime: e.target.checked })} />
        Changes over time and slow swings
      </label>
      <label className="speech-dialog__field" title="Vibrato (LFO 1) and tremolo (LFO 2) as in the recording; without vibrato in it, the Mod Wheel adds some.">
        <input type="checkbox" checked={choices.wobble} onChange={(e) => choose({ wobble: e.target.checked })} />
        Vibrato and tremolo
      </label>
      <label
        className="speech-dialog__field"
        title="Noise between the harmonics (the noise source), a second voice some cents off (OSC 3), a string machine’s ensemble (two Choruses on the FX) and a pitch that wanders (a Random LFO 3), where the recording has more of them than a clean synth. Distortion is on the Dirt macro."
      >
        <input type="checkbox" checked={choices.dirt} onChange={(e) => choose({ dirt: e.target.checked })} />
        Drift, detune, ensemble and noise
      </label>
      <div className="wav-dialog__result" aria-live="polite">
        <p className="speech-dialog__said wav-dialog__said">{status}</p>
        {result && <p className="wav-dialog__next">Macros: {result.macros.join(', ')}. Velocity and aftertouch open the filter.</p>}
      </div>
      <details className="wav-dialog__what">
        <summary>What it can make</summary>
        <ul>
          <li>
            <strong>Good:</strong> one note of a synth, keys, bass, lead, organ, flute or string machine; sung vowels; tonal drums.
          </li>
          <li>
            <strong>Pads that move</strong> (held 2 s or more): slow swings on LFOs; a second oscillator, sub or octave; voices a few
            cents apart.
          </li>
          <li>
            <strong>Rough:</strong> hi-hats, claps, crashes and other noise, as filtered noise.
          </li>
          <li>
            <strong>A stand-in:</strong> chords, bells, drum loops, long slides.
          </li>
        </ul>
        <p>Best with one dry note of a quarter second or more, 20 Hz to 2 kHz.</p>
      </details>
      <div className="write-dialog__actions">
        <button type="button" className="function-button" onClick={() => (ref.current?.close(), onDone())}>
          Cancel
        </button>
        <button type="button" className="function-button function-button--primary" onClick={replace} disabled={!result}>
          {dirty ? 'Discard changes and generate' : 'Generate'}
        </button>
      </div>
    </dialog>
  )
}
