import { useEffect, useRef, useState } from 'react'
import { BANK_LETTERS } from '../sysex/protocol'
import { slotName, type Slot } from '../sync/patchSync'
import { useEditor } from './store'

/** The patch selector's value while the open patch (Init, a file) isn't stored in a slot. */
const NOT_STORED = -1

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
        {slot.patch === NOT_STORED && <option value={NOT_STORED}>Not stored</option>}
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
/** What would replace the patch being edited: a stored slot, or the Init patch. */
type Replacement = { kind: 'slot'; slot: Slot } | { kind: 'init' }

function DiscardDialog({ next, onConfirm, onCancel }: { next: Replacement; onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const name = useEditor((s) => s.sync?.patch?.name ?? '')
  const target = useEditor((s) => (next.kind === 'slot' ? s.bankNames[next.slot.bank]?.[next.slot.patch] : undefined))
  useEffect(() => ref.current?.showModal(), [])
  const what = next.kind === 'init' ? 'Starting from the Init patch' : `Opening ${slotName(next.slot)}${target ? ` “${target}”` : ''}`
  return (
    <dialog ref={ref} className="write-dialog" onCancel={onCancel}>
      <h2>Discard changes to “{name}”?</h2>
      <p>{what} replaces the patch you’re editing. Its changes haven’t been written to the synth.</p>
      <div className="write-dialog__actions">
        <button type="button" className="function-button" onClick={onCancel} autoFocus>
          Cancel
        </button>
        <button type="button" className="function-button function-button--primary" onClick={onConfirm}>
          {next.kind === 'init' ? 'Discard changes and init' : 'Discard changes and open'}
        </button>
      </div>
    </dialog>
  )
}

/** Less frequent actions: backup now, restore later. */
function MoreMenu() {
  const [open, setOpen] = useState(false)
  const openBackup = useEditor((s) => s.openBackup)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', escape)
    }
  }, [open])
  return (
    <span className="more-menu" ref={ref}>
      <button type="button" className="function-button" aria-label="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        ⋯
      </button>
      {open && (
        <div className="param-menu more-menu__list" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              openBackup()
            }}
          >
            Back up the synth…
          </button>
        </div>
      )}
    </span>
  )
}

/** Undo / Redo, named after the step they'd take back or redo. */
function UndoRedo() {
  const undoLabel = useEditor((s) => s.sync?.undoLabel ?? null)
  const redoLabel = useEditor((s) => s.sync?.redoLabel ?? null)
  const undo = useEditor((s) => s.undo)
  const redo = useEditor((s) => s.redo)
  const mac = /Mac|iPhone|iPad/.test(navigator.platform)
  return (
    <span className="undo-redo">
      <button
        type="button"
        className="function-button"
        onClick={undo}
        disabled={!undoLabel}
        title={undoLabel ? `Undo ${undoLabel} (${mac ? '⌘Z' : 'Ctrl+Z'})` : 'Nothing to undo'}
      >
        Undo
      </button>
      <button
        type="button"
        className="function-button"
        onClick={redo}
        disabled={!redoLabel}
        title={redoLabel ? `Redo ${redoLabel} (${mac ? '⇧⌘Z' : 'Ctrl+Y'})` : 'Nothing to redo'}
      >
        Redo
      </button>
    </span>
  )
}

/** One line that takes the room left and is cut off with an ellipsis (full text on hover). */
function Status() {
  const sync = useEditor((s) => s.sync)
  if (!sync) return null
  const [text, kind] = sync.error
    ? [sync.error, 'error']
    : sync.busy
      ? [`${sync.busy}…`, 'busy']
      : sync.pendingFullSend
        ? ['Sending the whole patch in a moment', '']
        : sync.playing.kind === 'slot'
          ? [`Playing ${slotName(sync.playing.slot)}`, '']
          : sync.playing.kind === 'audition'
            ? ['Playing from H128 (scratch slot)', '']
            : ['', '']
  return (
    <span className={`status patch-bar__status${kind ? ` status--${kind}` : ''}`} title={text} role="status">
      {text}
    </span>
  )
}

/** Beside the name, with its room always kept so it doesn't move the bar when it appears. */
function EditedMark() {
  const dirty = useEditor((s) => !!s.sync?.dirty)
  return (
    <span className="edited-mark" title="Edited, not written" aria-hidden={!dirty} style={{ visibility: dirty ? 'visible' : 'hidden' }}>
      Edited<span className="visually-hidden">, not written</span>
    </span>
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
  const [pending, setPending] = useState<Replacement | null>(null)
  const initPatch = useEditor((s) => s.initPatch)
  const replace = (next: Replacement) => (next.kind === 'init' ? void initPatch() : void open(next.slot))
  const ask = (next: Replacement) => (sync?.patch && sync.dirty ? setPending(next) : replace(next))
  const [writing, setWriting] = useState(false)
  // The selectors show the open patch's slot; while asking or loading, the one picked. A
  // cancelled or failed open leaves them back on the open patch.
  const slot =
    pending?.kind === 'slot'
      ? pending.slot
      : sync?.busy
        ? chosen
        : sync?.patch && !sync.origin
          ? { bank: chosen.bank, patch: NOT_STORED }
          : (sync?.origin ?? chosen)
  const pick = (next: Slot) => {
    setChosen(next)
    if (!sync?.patch) return // nothing open yet: the Open button loads it
    ask({ kind: 'slot', slot: next })
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
        <UndoRedo />
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
      <label className="patch-bar__channel" title={`MIDI channel of ${connection.port}`}>
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
      <button
        type="button"
        className="function-button"
        title="Start a new patch from the synth's Init patch, played from H128"
        onClick={() => ask({ kind: 'init' })}
        disabled={!!sync?.busy}
      >
        Init
      </button>
      {patch && (
        <>
          <input
            className="patch-bar__name"
            aria-label="Patch name"
            maxLength={16}
            value={patch.name}
            onChange={(e) => setName(e.target.value)}
          />
          <EditedMark />
          <button type="button" className="function-button" onClick={() => setWriting(true)} disabled={!!sync?.busy}>
            Write…
          </button>
          <UndoRedo />
        </>
      )}
      <Status />
      <MoreMenu />
      {writing && patch && <WriteDialog initial={sync?.origin ?? chosen} onClose={() => setWriting(false)} />}
      {pending && (
        <DiscardDialog
          next={pending}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null)
            replace(pending)
          }}
        />
      )}
    </header>
  )
}
