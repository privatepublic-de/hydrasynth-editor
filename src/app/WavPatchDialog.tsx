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
    <dialog ref={ref} className="write-dialog speech-dialog" onCancel={onDone}>
      <h2>Generate patch from “{title}”</h2>
      <p>
        Replaces all of “{name}” with a patch to start from, made from the note recorded in the file.
        {demo ? '' : ' Can’t be undone.'}
        {dirty && ' Your unwritten changes are lost.'}
      </p>
      <label
        className="speech-dialog__field"
        title="What makes the sound: the synth’s own waves matched to the recording’s harmonics, a Sine through Mutant 1’s FM at the ratio and depth that match them, or whichever of the two comes closer."
      >
        Sound from
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
      <label
        className="speech-dialog__field"
        title="Waves picked along the note, swept by WaveScan (ENV 3), and the filter following its brightness (ENV 1); with FM, ENV 3 moves its depth instead, and the filter stays put. A pad's slow swings on LFO 4 and 5 (pitch, the cutoff or WaveScan), and Amp LFO 2 (level)."
      >
        <input type="checkbox" checked={choices.overTime} onChange={(e) => choose({ overTime: e.target.checked })} />
        Follow how the sound changes
      </label>
      <label className="speech-dialog__field" title="Vibrato (LFO 1) and tremolo (LFO 2) as in the recording; without vibrato in it, the Mod Wheel adds some.">
        <input type="checkbox" checked={choices.wobble} onChange={(e) => choose({ wobble: e.target.checked })} />
        Vibrato and tremolo as recorded
      </label>
      <label
        className="speech-dialog__field"
        title="Noise between the harmonics (the noise source), a second voice some cents off (OSC 3), a string machine's ensemble (two Choruses on the FX) and a pitch that wanders (a Random LFO 3), where the recording has more of them than a clean synth. Distortion is on the Dirt macro."
      >
        <input type="checkbox" checked={choices.dirt} onChange={(e) => choose({ dirt: e.target.checked })} />
        Drift, detune, ensemble and noise as recorded
      </label>
      <details className="wav-dialog__what">
        <summary>What it can make</summary>
        <p>A starting point to shape further, not a copy of the recording.</p>
        <ul>
          <li>
            <strong>Good starting points:</strong> one note of a synth, keys, bass, lead, pad, organ, flute or string machine;
            sung vowels; tonal drums (kicks with their pitch drop, toms, snare bodies).
          </li>
          <li>
            <strong>Pads that move:</strong> a held note's slow swings (pitch, filter, pulse width, level) on LFOs at their rate; a
            second oscillator at its own interval, a sub or an octave; voices beating a few cents apart. Hold it two seconds or
            more.
          </li>
          <li>
            <strong>Rough, but usable:</strong> hi-hats, claps, crashes and other noise: the noise source through the filter, any
            key plays it.
          </li>
          <li>
            <strong>A single-note stand-in:</strong> chords, bells, drum loops, long slides.
          </li>
        </ul>
        <p>Best with one note, dry, at least a quarter second long, from about 20 Hz to 2 kHz.</p>
      </details>
      <p className="speech-dialog__said wav-dialog__said">{status}</p>
      {result && (
        <p className="wav-dialog__next">
          Shape it from there with the macros ({result.macros.join(', ')}); velocity and aftertouch open the filter.
        </p>
      )}
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
