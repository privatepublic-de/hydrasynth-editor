import { useEffect, useMemo, useRef, useState } from 'react'
import { analyse, type SoundAnalysis } from '../audio/analyse'
import { parseWav } from '../audio/wav'
import { WAVE_FEATURES } from '../ui/waveFeatures.generated'
import { waveLevels } from '../ui/waveSpeech'
import { buildWavPatch, ENVELOPES, SOURCES, wavStatus } from '../ui/wavPatch'
import { isIndex, useSessionChoices } from './sessionChoices'
import { useEditor } from './store'

/** The dialog's choices, kept for the browser session: the stored ones where still valid. */
const readChoices = (v: Record<string, unknown>) => ({
  source: isIndex(v.source, SOURCES.length) ? v.source : 0,
  envelope: isIndex(v.envelope, ENVELOPES.length) ? v.envelope : 0,
  overTime: v.overTime !== false,
  wobble: v.wobble !== false,
})

type Loaded = { analysis: SoundAnalysis; levels: (number[] | null)[] } | { error: string } | null

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
        const [bytes, levels] = await Promise.all([file.arrayBuffer(), waveLevels()])
        if (levels.filter(Boolean).length < WAVE_FEATURES.length) throw new Error('The wave data didn’t load')
        const analysis = analyse(parseWav(bytes))
        if (live) setLoaded({ analysis, levels })
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
            source: SOURCES[choices.source].value,
            envelope: ENVELOPES[choices.envelope].value,
            overTime: choices.overTime,
            wobble: choices.wobble,
            name: title,
          })
        : null,
    [loaded, choices.source, choices.envelope, choices.overTime, choices.wobble, title],
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
        Replaces all of “{name}” with a patch that plays the note recorded in the file.
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
        title="Waves picked along the note, swept by WaveScan (ENV 3), and the filter following its brightness (ENV 1); with FM, ENV 3 moves its depth instead, and the filter stays put."
      >
        <input type="checkbox" checked={choices.overTime} onChange={(e) => choose({ overTime: e.target.checked })} />
        Follow how the sound changes
      </label>
      <label className="speech-dialog__field" title="Vibrato (LFO 1) and tremolo (LFO 2) as in the recording; without vibrato in it, the Mod Wheel adds some.">
        <input type="checkbox" checked={choices.wobble} onChange={(e) => choose({ wobble: e.target.checked })} />
        Vibrato and tremolo as recorded
      </label>
      <p className="speech-dialog__said wav-dialog__said">{status}</p>
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
