import { useEffect, useRef, useState } from 'react'
import { BANK_LETTERS } from '../sysex/protocol'
import { slotName, type Slot } from '../sync/patchSync'
import { useEditor } from './store'

function SlotPicker({ slot, onChange }: { slot: Slot; onChange: (s: Slot) => void }) {
  const names = useEditor((s) => s.bankNames[slot.bank])
  const loadBankNames = useEditor((s) => s.loadBankNames)
  useEffect(() => {
    if (!names) loadBankNames(slot.bank).catch(() => undefined)
  }, [slot.bank, names, loadBankNames])
  return (
    <span className="slot-picker">
      <select aria-label="Bank" value={slot.bank} onChange={(e) => onChange({ bank: Number(e.target.value), patch: slot.patch })}>
        {[...BANK_LETTERS].map((l, i) => (
          <option key={l} value={i}>
            Bank {l}
          </option>
        ))}
      </select>
      <select aria-label="Patch" value={slot.patch} onChange={(e) => onChange({ bank: slot.bank, patch: Number(e.target.value) })}>
        {Array.from({ length: 128 }, (_, i) => (
          <option key={i} value={i}>
            {i + 1} {names?.[i] ?? ''}
          </option>
        ))}
      </select>
    </span>
  )
}

function WriteDialog({ initial, onClose }: { initial: Slot; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [slot, setSlot] = useState(initial)
  const write = useEditor((s) => s.write)
  const names = useEditor((s) => s.bankNames[slot.bank])
  const name = useEditor((s) => s.sync?.patch?.name ?? '')
  useEffect(() => ref.current?.showModal(), [])
  const target = names?.[slot.patch]
  return (
    <dialog ref={ref} className="write-dialog" onClose={onClose}>
      <h2>Write “{name}”</h2>
      <p>Saves the patch on the synth and to its flash memory. The synth is busy for about 4 seconds.</p>
      <SlotPicker slot={slot} onChange={setSlot} />
      <p className="write-dialog__target">
        {target !== undefined ? `Replaces ${slotName(slot)} “${target}”.` : `Replaces whatever is stored in ${slotName(slot)}.`}
      </p>
      <div className="write-dialog__actions">
        <button type="button" className="function-button" onClick={() => ref.current?.close()}>
          Cancel
        </button>
        <button
          type="button"
          className="function-button function-button--primary"
          onClick={() => {
            ref.current?.close()
            void write(slot)
          }}
        >
          Write to {slotName(slot)}
        </button>
      </div>
    </dialog>
  )
}

/** Asks before a newly picked patch replaces one with unsaved changes. */
function DiscardDialog({ slot, onConfirm, onCancel }: { slot: Slot; onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const name = useEditor((s) => s.sync?.patch?.name ?? '')
  const target = useEditor((s) => s.bankNames[slot.bank]?.[slot.patch])
  useEffect(() => ref.current?.showModal(), [])
  return (
    <dialog ref={ref} className="write-dialog" onCancel={onCancel}>
      <h2>Discard changes to “{name}”?</h2>
      <p>
        Opening {slotName(slot)}
        {target ? ` “${target}”` : ''} replaces the patch you’re editing. Its changes haven’t been written to the synth.
      </p>
      <div className="write-dialog__actions">
        <button type="button" className="function-button" onClick={onCancel} autoFocus>
          Cancel
        </button>
        <button type="button" className="function-button function-button--primary" onClick={onConfirm}>
          Discard changes and open
        </button>
      </div>
    </dialog>
  )
}

function Status() {
  const sync = useEditor((s) => s.sync)
  if (!sync) return null
  if (sync.error) return <span className="status status--error">{sync.error}</span>
  if (sync.busy) return <span className="status status--busy">{sync.busy}…</span>
  if (sync.pendingFullSend) return <span className="status">Sending the whole patch in a moment</span>
  const playing =
    sync.playing.kind === 'slot'
      ? `Playing ${slotName(sync.playing.slot)}`
      : sync.playing.kind === 'audition'
        ? 'Playing from H128 (scratch slot)'
        : ''
  return (
    <>
      <span className="status">{playing}</span>
      {sync.dirty && <span className="status status--dirty">Edited, not written</span>}
    </>
  )
}

export function PatchBar() {
  const connection = useEditor((s) => s.connection)
  const connect = useEditor((s) => s.connect)
  const channel = useEditor((s) => s.channel)
  const setChannel = useEditor((s) => s.setChannel)
  const open = useEditor((s) => s.open)
  const sync = useEditor((s) => s.sync)
  const setName = useEditor((s) => s.setName)
  useEditor((s) => s.sync?.revision)
  const [chosen, setChosen] = useState<Slot>({ bank: 0, patch: 0 })
  const [pending, setPending] = useState<Slot | null>(null)
  const [writing, setWriting] = useState(false)
  // The selectors show the open patch's slot; while asking or loading, the one picked. A
  // cancelled or failed open leaves them back on the open patch.
  const slot = pending ?? (sync?.busy ? chosen : (sync?.origin ?? chosen))
  const pick = (next: Slot) => {
    setChosen(next)
    if (!sync?.patch) return // nothing open yet: the Open button loads it
    if (sync.dirty) setPending(next)
    else void open(next)
  }
  const patch = sync?.patch

  if (connection.status === 'demo') {
    return (
      <header className="patch-bar">
        <span className="brand">Hydrasynth editor</span>
        <span className="status">Demo: a built-in patch, nothing is sent to a synth</span>
        {patch && (
          <input className="patch-bar__name" aria-label="Patch name" maxLength={16} value={patch.name} onChange={(e) => setName(e.target.value)} />
        )}
      </header>
    )
  }

  if (connection.status !== 'connected') {
    return (
      <header className="patch-bar patch-bar--offline">
        <span className="brand">Hydrasynth editor</span>
        <button type="button" className="function-button function-button--primary" onClick={() => void connect()} disabled={connection.status === 'connecting'}>
          {connection.status === 'connecting' ? 'Connecting…' : 'Connect to the Hydrasynth'}
        </button>
        {connection.status === 'failed' && <span className="status status--error">{connection.message}</span>}
      </header>
    )
  }

  return (
    <header className="patch-bar">
      <span className="brand">Hydrasynth editor</span>
      <span className="patch-bar__port" title="MIDI port">
        {connection.port}
      </span>
      <label className="patch-bar__channel">
        Channel
        <select value={channel} onChange={(e) => setChannel(Number(e.target.value))}>
          {Array.from({ length: 16 }, (_, i) => (
            <option key={i + 1} value={i + 1}>
              {i + 1}
            </option>
          ))}
        </select>
      </label>
      <SlotPicker slot={slot} onChange={pick} />
      {!patch && (
        <button type="button" className="function-button function-button--primary" onClick={() => void open(slot)} disabled={!!sync?.busy}>
          Open {slotName(slot)}
        </button>
      )}
      {patch && (
        <>
          <input
            className="patch-bar__name"
            aria-label="Patch name"
            maxLength={16}
            value={patch.name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="button" className="function-button" onClick={() => setWriting(true)} disabled={!!sync?.busy}>
            Write…
          </button>
        </>
      )}
      <Status />
      {writing && patch && <WriteDialog initial={sync?.origin ?? slot} onClose={() => setWriting(false)} />}
      {pending && (
        <DiscardDialog
          slot={pending}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null)
            void open(pending)
          }}
        />
      )}
    </header>
  )
}
