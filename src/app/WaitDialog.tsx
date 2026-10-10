import { useEffect, useRef } from 'react'
import { slotName } from '../sync/patchSync'
import { useEditor } from './store'

/** While a write runs: the synth is busy for seconds, and nothing here may change meanwhile. */
export function WaitDialog() {
  const writing = useEditor((s) => s.writing)
  const name = useEditor((s) => s.sync?.patch?.name ?? '')
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (writing && !d.open) d.showModal()
    if (!writing && d.open) d.close()
  }, [writing])
  return (
    // Escape doesn't close it: the write goes on regardless.
    <dialog ref={ref} className="write-dialog wait-dialog" onCancel={(e) => e.preventDefault()} aria-busy="true">
      <span className="spinner" aria-hidden="true" />
      <div>
        <h2>Please wait</h2>
        {writing && (
          <p>
            Writing “{name}” to {slotName(writing)}. The synth stores it in its flash memory, which takes a few seconds.
          </p>
        )}
      </div>
    </dialog>
  )
}
