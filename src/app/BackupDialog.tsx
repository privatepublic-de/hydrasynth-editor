import { useEffect, useRef, useState } from 'react'
import { BANK_LETTERS, PATCHES_PER_BANK } from '../sysex/protocol'
import { useEditor } from './store'

/** Measured in the browser: ~45 ms a patch, plus the pause after each bank. */
const estimateSeconds = (banks: number) => Math.round(banks * PATCHES_PER_BANK * 0.05 + Math.max(0, banks - 1) * 1.5)

export function BackupDialog() {
  const backup = useEditor((s) => s.backup)
  const connected = useEditor((s) => s.connection.status === 'connected')
  const connect = useEditor((s) => s.connect)
  const start = useEditor((s) => s.startBackup)
  const cancel = useEditor((s) => s.cancelBackup)
  const save = useEditor((s) => s.saveBackupFile)
  const close = useEditor((s) => s.closeBackup)
  const ref = useRef<HTMLDialogElement>(null)
  const [banks, setBanks] = useState<number[]>([0, 1, 2, 3, 4, 5, 6, 7])
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (backup && !ref.current?.open) ref.current?.showModal()
    if (!backup) {
      ref.current?.close()
      setSaved(false)
    }
  }, [backup])

  if (!backup) return <dialog ref={ref} className="write-dialog backup-dialog" />
  const running = backup.phase === 'running'
  const p = backup.progress
  const total = backup.banks.length * PATCHES_PER_BANK

  return (
    <dialog
      ref={ref}
      className="write-dialog backup-dialog"
      // A running backup is stopped with Cancel, not by closing the dialog.
      onCancel={(e) => {
        e.preventDefault()
        if (!running) close()
      }}
    >
      <h2>Back up the synth</h2>

      {backup.phase === 'choose' && (
        <>
          <p>Reads the patches of the chosen banks from the synth and saves them as one .syx file. Nothing on the synth changes.</p>
          <fieldset className="backup-dialog__banks">
            <legend>Banks</legend>
            {[...BANK_LETTERS].map((l, i) => (
              <label key={l}>
                <input
                  type="checkbox"
                  checked={banks.includes(i)}
                  onChange={(e) => setBanks((b) => (e.target.checked ? [...b, i].sort() : b.filter((x) => x !== i)))}
                />
                {l}
              </label>
            ))}
          </fieldset>
          <p className="backup-dialog__note">
            {banks.length * PATCHES_PER_BANK} patches, about {estimateSeconds(banks.length)} seconds. The synth’s panel pauses briefly for each patch.
          </p>
          <div className="write-dialog__actions">
            <button type="button" className="function-button" onClick={close}>
              Cancel
            </button>
            <button type="button" className="function-button function-button--primary" disabled={!banks.length || !connected} onClick={() => void start(banks)}>
              Start backup
            </button>
          </div>
        </>
      )}

      {(running || backup.phase === 'stopped' || backup.phase === 'done') && (
        <>
          <progress className="backup-dialog__progress" max={total} value={backup.count} />
          <p className="backup-dialog__note" aria-live="polite">
            {running && p ? `Reading ${BANK_LETTERS[p.bank]}${p.patch + 1}, ${backup.count} of ${total}` : `${backup.count} of ${total} patches read`}
            {backup.retries ? `, ${backup.retries} retried` : ''}
          </p>
          {backup.phase === 'stopped' && <p className="status--error">{backup.stopped}</p>}
          {backup.phase === 'done' && <p>All patches read. Save the file to keep the backup{saved ? ': saved to your downloads.' : '.'}</p>}
          <div className="write-dialog__actions">
            {running ? (
              <button type="button" className="function-button" onClick={cancel}>
                Cancel
              </button>
            ) : (
              <>
                <button type="button" className="function-button" onClick={close}>
                  Close
                </button>
                {backup.phase === 'stopped' && (
                  <button
                    type="button"
                    className="function-button"
                    onClick={async () => {
                      if (!connected) await connect()
                      void start(backup.banks)
                    }}
                  >
                    {connected ? 'Continue' : 'Reconnect and continue'}
                  </button>
                )}
                <button
                  type="button"
                  className="function-button function-button--primary"
                  disabled={!backup.count}
                  onClick={() => {
                    save()
                    setSaved(true)
                  }}
                >
                  {backup.phase === 'done' ? 'Save backup file' : `Save the ${backup.count} read`}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </dialog>
  )
}
