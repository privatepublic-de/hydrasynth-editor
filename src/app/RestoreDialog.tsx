import { useEffect, useRef, useState } from 'react'
import { Patch } from '../params/patch'
import { slotLabel, type RestorePhase } from '../library/restore'
import { BANK_LETTERS, PATCHES_PER_BANK } from '../sysex/protocol'
import { SlotPicker } from './SlotPicker'
import { useEditor } from './store'

const PHASE_TEXT: Record<RestorePhase, string> = {
  reading: 'Reading what’s there now',
  sending: 'Sending',
  flashing: 'Writing to flash',
  reverting: 'Putting the previous patches back',
  verifying: 'Checking',
}

const nameOf = (bytes: Uint8Array) => new Patch(bytes).name.trim() || '(no name)'
/**
 * Patch format version (byte 4): 2.0.0 is 200 (0xC8), later 2.x above. 1.5.5 patches (0x9B)
 * have another layout -- Edisyn converts them before writing -- so they aren't restored as is.
 */
const MIN_VERSION = 0xc8
const restorable = (bytes: Uint8Array) => bytes[4] >= MIN_VERSION

export function RestoreDialog() {
  const restore = useEditor((s) => s.restore)
  const connected = useEditor((s) => s.connection.status === 'connected')
  const start = useEditor((s) => s.startRestore)
  const cancel = useEditor((s) => s.cancelRestore)
  const saveReplaced = useEditor((s) => s.saveReplaced)
  const close = useEditor((s) => s.closeRestore)
  const bankNames = useEditor((s) => s.bankNames)
  const loadBankNames = useEditor((s) => s.loadBankNames)
  const ref = useRef<HTMLDialogElement>(null)
  const [mode, setMode] = useState<'bank' | 'patch'>('bank')
  const [fromBank, setFromBank] = useState(0)
  const [toBank, setToBank] = useState(0)
  const [fromIndex, setFromIndex] = useState(0)
  const [toSlot, setToSlot] = useState({ bank: 0, patch: 0 })
  const [saved, setSaved] = useState(false)

  const patches = restore?.patches ?? []
  // Some tools store every patch with the same slot header: then the slots in the file mean
  // nothing, so it's patch by patch, labelled by position.
  const slotsKnown = new Set(patches.map((p) => p.bank * 128 + p.patch)).size === patches.length
  /** Banks the file holds completely: those can be restored as a bank. */
  const fullBanks = slotsKnown ? [...Array(8).keys()].filter((b) => patches.filter((p) => p.bank === b).length === PATCHES_PER_BANK) : []
  const oldCount = patches.filter((p) => !restorable(p.bytes)).length
  const label = (i: number) => (slotsKnown ? slotLabel(patches[i].bank, patches[i].patch) : `#${i + 1}`)

  useEffect(() => {
    if (!restore) {
      ref.current?.close()
      setSaved(false)
      return
    }
    if (!ref.current?.open) {
      ref.current?.showModal()
      // Start with the file's first full bank (same bank on the synth) or its first patch's slot.
      const first = fullBanks[0]
      setMode(first === undefined ? 'patch' : 'bank')
      setFromBank(first ?? 0)
      setToBank(first ?? 0)
      setFromIndex(0)
      if (patches[0]) setToSlot({ bank: patches[0].bank, patch: patches[0].patch })
    }
    // Only when the dialog opens or a run ends: the defaults come from the file just opened.
  }, [restore])

  // Read the target bank's names fresh: the confirmation quotes them.
  const namesBank = mode === 'bank' ? toBank : toSlot.bank
  const choosing = restore?.phase === 'choose'
  useEffect(() => {
    if (choosing && connected) loadBankNames(namesBank).catch(() => undefined)
  }, [choosing, namesBank, connected, loadBankNames])

  if (!restore) return <dialog ref={ref} className="write-dialog restore-dialog" />
  const running = restore.phase === 'running'
  const source = patches[fromIndex]
  const current = (bank: number, patch: number) => bankNames[bank]?.[patch]

  const items =
    mode === 'bank'
      ? patches.filter((p) => p.bank === fromBank).map((p) => ({ bank: toBank, patch: p.patch, bytes: p.bytes }))
      : source
        ? [{ bank: toSlot.bank, patch: toSlot.patch, bytes: source.bytes }]
        : []
  const target = mode === 'bank' ? `bank ${BANK_LETTERS[toBank]}` : slotLabel(toSlot.bank, toSlot.patch)
  const p = restore.progress
  const r = restore.result

  return (
    <dialog
      ref={ref}
      className="write-dialog restore-dialog"
      onCancel={(e) => {
        e.preventDefault()
        if (!running) close()
      }}
    >
      <h2>Restore from a backup</h2>
      <p className="backup-dialog__note">
        {restore.fileName}
        {patches.length ? `: ${patches.length} patches` : ''}
      </p>

      {restore.fileError && (
        <>
          <p className="status--error">{restore.fileError}</p>
          <div className="write-dialog__actions">
            <button type="button" className="function-button" onClick={close}>
              Close
            </button>
          </div>
        </>
      )}

      {restore.phase === 'choose' && !restore.fileError && (
        <>
          <fieldset className="restore-dialog__mode">
            <label>
              <input type="radio" name="restore-mode" checked={mode === 'bank'} disabled={!fullBanks.length} onChange={() => setMode('bank')} />
              Whole bank
            </label>
            <label>
              <input type="radio" name="restore-mode" checked={mode === 'patch'} onChange={() => setMode('patch')} />
              Single patch
            </label>
          </fieldset>

          {mode === 'bank' ? (
            <div className="restore-dialog__row">
              <label>
                From the file
                <select value={fromBank} onChange={(e) => setFromBank(Number(e.target.value))}>
                  {fullBanks.map((b) => (
                    <option key={b} value={b}>
                      Bank {BANK_LETTERS[b]}
                    </option>
                  ))}
                </select>
              </label>
              <span aria-hidden="true">→</span>
              <label>
                To the synth
                <select value={toBank} onChange={(e) => setToBank(Number(e.target.value))}>
                  {[...BANK_LETTERS].map((l, i) => (
                    <option key={l} value={i}>
                      Bank {l}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : (
            <div className="restore-dialog__row">
              <label>
                From the file
                <select
                  value={fromIndex}
                  onChange={(e) => {
                    const i = Number(e.target.value)
                    setFromIndex(i)
                    // Back where it came from, unless changed afterwards.
                    if (slotsKnown) setToSlot({ bank: patches[i].bank, patch: patches[i].patch })
                  }}
                >
                  {patches.map((pt, i) => (
                    <option key={i} value={i} disabled={!restorable(pt.bytes)}>
                      {label(i)} {nameOf(pt.bytes)}
                      {restorable(pt.bytes) ? '' : ' (old firmware)'}
                    </option>
                  ))}
                </select>
              </label>
              <span aria-hidden="true">→</span>
              <label>
                To the synth
                <SlotPicker slot={toSlot} onChange={setToSlot} />
              </label>
            </div>
          )}

          {!slotsKnown && (
            <p className="backup-dialog__note">This file doesn’t say which slot each patch came from, so it can only be restored patch by patch.</p>
          )}
          {oldCount > 0 && (
            <p className="backup-dialog__note">
              {oldCount} patch{oldCount === 1 ? ' is' : 'es are'} from firmware 1.5 (another format) and can’t be restored here.
            </p>
          )}
          <p className="write-dialog__target">
            {mode === 'bank'
              ? `Replaces all ${items.length} patches of bank ${BANK_LETTERS[toBank]} on the synth${
                  bankNames[toBank] ? `, starting with “${bankNames[toBank][0]}”, “${bankNames[toBank][1]}”, “${bankNames[toBank][2]}”` : ''
                }.`
              : `Replaces ${target}${current(toSlot.bank, toSlot.patch) ? ` “${current(toSlot.bank, toSlot.patch)}”` : ''} with “${source ? nameOf(source.bytes) : ''}”.`}
          </p>
          <p className="backup-dialog__note">
            Written to the synth’s flash memory. What’s there now is read first, so you can save it afterwards; if anything goes wrong
            before the flash write, nothing is saved and the synth keeps what it had.
          </p>
          <div className="write-dialog__actions">
            <button type="button" className="function-button" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="function-button function-button--danger"
              disabled={!items.length || !connected || items.some((it) => !restorable(it.bytes))}
              onClick={() => void start(items, target)}
            >
              Overwrite {target}
            </button>
          </div>
        </>
      )}

      {running && (
        <>
          <progress className="backup-dialog__progress" max={p?.total ?? 1} value={p?.done ?? 0} />
          <p className="backup-dialog__note" aria-live="polite">
            {p ? `${PHASE_TEXT[p.phase]}${p.phase === 'flashing' ? '…' : `: ${p.done} of ${p.total}`}` : 'Starting…'}
          </p>
          <div className="write-dialog__actions">
            <button type="button" className="function-button" onClick={cancel} disabled={!p || !['reading', 'sending'].includes(p.phase)}>
              Cancel
            </button>
          </div>
        </>
      )}

      {restore.phase === 'done' && r && (
        <>
          {r.outcome === 'restored' ? (
            r.mismatches.length ? (
              <p className="status--error">
                Written to {restore.target}, but {r.mismatches.length} read back different: {r.mismatches.slice(0, 8).join(', ')}
                {r.mismatches.length > 8 ? '…' : ''}.
              </p>
            ) : r.unchecked?.length ? (
              <p className="status--error">
                Written to {restore.target}, but the check stopped before {r.unchecked.length === 1 ? 'one slot' : `${r.unchecked.length} slots`}:{' '}
                {r.unchecked.slice(0, 8).join(', ')}
                {r.unchecked.length > 8 ? '…' : ''}. Open them later to check.
              </p>
            ) : (
              <p>
                {restore.target} restored and checked: {r.previous.length === 1 ? 'it matches' : `all ${r.previous.length} match`}.
              </p>
            )
          ) : (
            <p className={r.outcome === 'unconfirmed' && !r.mismatches.length ? '' : 'status--error'}>{r.reason}</p>
          )}
          {r.filled && Object.keys(r.filled).length > 0 && (
            <details className="restore-dialog__differences">
              <summary>
                {Object.keys(r.filled).join(', ')}: the backup left some settings empty, and the synth filled in its defaults
              </summary>
              {Object.entries(r.filled)
                .slice(0, 8)
                .map(([slot, diffs]) => (
                  <div key={slot}>
                    <strong>{slot}</strong>
                    <ul>
                      {diffs.slice(0, 40).map((d) => (
                        <li key={d}>{d}</li>
                      ))}
                      {diffs.length > 40 && <li>and {diffs.length - 40} more</li>}
                    </ul>
                  </div>
                ))}
            </details>
          )}
          {r.differences && Object.keys(r.differences).length > 0 && (
            <details className="restore-dialog__differences">
              <summary>What reads back different</summary>
              {Object.entries(r.differences)
                .slice(0, 8)
                .map(([slot, diffs]) => (
                  <div key={slot}>
                    <strong>{slot}</strong>
                    <ul>
                      {diffs.slice(0, 40).map((d) => (
                        <li key={d}>{d}</li>
                      ))}
                      {diffs.length > 40 && <li>and {diffs.length - 40} more</li>}
                    </ul>
                  </div>
                ))}
            </details>
          )}
          <div className="write-dialog__actions">
            <button type="button" className="function-button" onClick={close}>
              Close
            </button>
            {r.outcome !== 'not-written' && r.previous.length > 0 && (
              <button
                type="button"
                className="function-button"
                onClick={() => {
                  saveReplaced()
                  setSaved(true)
                }}
              >
                {saved ? 'Saved what was replaced' : 'Save what was replaced'}
              </button>
            )}
          </div>
        </>
      )}
    </dialog>
  )
}
