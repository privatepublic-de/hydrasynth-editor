import { useState } from 'react'
import { slotName } from '../sync/patchSync'
import { WriteIcon } from './icons'
import { WriteDialog } from './PatchBar'
import { useEditor } from './store'

/** What the panel edits: where it's stored, its name (editable), and whether it has changes. */
export function PatchHeading() {
  const patch = useEditor((s) => s.sync?.patch)
  const origin = useEditor((s) => s.sync?.origin ?? null)
  const dirty = useEditor((s) => !!s.sync?.dirty)
  const demo = useEditor((s) => s.connection.status === 'demo')
  const setName = useEditor((s) => s.setName)
  const busy = useEditor((s) => !!s.sync?.busy)
  const lastSlot = useEditor((s) => s.lastSlot)
  const [writing, setWriting] = useState(false)
  useEditor((s) => s.sync?.revision)
  if (!patch) return null
  const [tag, where] = demo
    ? ['Demo', 'A built-in patch: nothing is sent to a synth']
    : origin
      ? [slotName(origin), `Stored in ${slotName(origin)}; the synth plays it from there`]
      : ['New', 'Not stored in a slot: the synth plays it from H128 (scratch slot)']
  return (
    <div className="patch-heading">
      <span className="patch-heading__slot" title={where}>
        {tag}
      </span>
      <input className="patch-heading__name" aria-label="Patch name" maxLength={16} value={patch.name} onChange={(e) => setName(e.target.value)} />
      {/* Its room always kept, so the heading doesn't shift when it appears. */}
      <span className="edited-mark" title="Edited, not written" aria-hidden={!dirty} style={{ visibility: dirty ? 'visible' : 'hidden' }}>
        Edited<span className="visually-hidden">, not written</span>
      </span>
      {!demo && (
        <button type="button" className="function-button with-icon patch-heading__write" onClick={() => setWriting(true)} disabled={busy}>
          <WriteIcon />
          Write…
        </button>
      )}
      {writing && <WriteDialog initial={origin ?? lastSlot} onClose={() => setWriting(false)} />}
    </div>
  )
}
