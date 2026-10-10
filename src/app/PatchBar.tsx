import { useEffect, useRef, useState } from 'react'
import { BANK_LETTERS } from '../sysex/protocol'
import { slotName, type Slot } from '../sync/patchSync'
import { AboutDialog } from './AboutDialog'
import { InitIcon, MenuIcon, OpenIcon, RedoIcon, UndoIcon } from './icons'
import { NOT_STORED, SlotPicker } from './SlotPicker'
import { SpeechPatchDialog } from './SpeechPatchDialog'
import { useEditor } from './store'

export function WriteDialog({ initial, onClose }: { initial: Slot; onClose: () => void }) {
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

/**
 * The synth changed patch from its panel: what's open here no longer sounds, and its knobs now
 * change the other patch. Opens that one (discarding unwritten changes, said so) or keeps editing.
 */
function SynthSwitchedDialog({ slot, onOpen, onKeep }: { slot: Slot; onOpen: () => void; onKeep: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const name = useEditor((s) => s.sync?.patch?.name ?? '')
  const dirty = useEditor((s) => !!s.sync?.dirty)
  const target = useEditor((s) => s.bankNames[slot.bank]?.[slot.patch])
  const loadBankNames = useEditor((s) => s.loadBankNames)
  useEffect(() => {
    ref.current?.showModal()
    if (!target) loadBankNames(slot.bank).catch(() => undefined)
  }, [])
  const there = `${slotName(slot)}${target ? ` “${target}”` : ''}`
  return (
    <dialog ref={ref} className="write-dialog" onCancel={onKeep}>
      <h2>The synth switched to {there}</h2>
      <p>
        Its knobs now change {slotName(slot)}, and “{name}”, open here, no longer sounds.
        {dirty && ` Your changes to “${name}” haven’t been written to the synth.`}
      </p>
      <div className="write-dialog__actions">
        <button type="button" className="function-button" onClick={onKeep}>
          Keep editing
        </button>
        <button type="button" className="function-button function-button--primary" onClick={onOpen} autoFocus>
          {dirty ? `Discard changes, open ${slotName(slot)}` : `Open ${slotName(slot)}`}
        </button>
      </div>
    </dialog>
  )
}

/**
 * Less frequent actions: the speech patch (once a patch is open), backup and restore (with a
 * synth connected), and About.
 */
function MoreMenu({ withSynth }: { withSynth: boolean }) {
  const [open, setOpen] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [words, setWords] = useState('hello world')
  const [about, setAbout] = useState(false)
  const busy = useEditor((s) => !!s.sync?.busy)
  const patch = useEditor((s) => s.sync?.patch)
  const openBackup = useEditor((s) => s.openBackup)
  const openRestore = useEditor((s) => s.openRestore)
  const ref = useRef<HTMLSpanElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
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
        <MenuIcon />
      </button>
      {open && (
        <div className="param-menu more-menu__list" role="menu">
          {patch && (
            <button
              type="button"
              role="menuitem"
              title="Replaces the patch with one that says a few English words on every note"
              disabled={busy}
              onClick={() => {
                setOpen(false)
                setSpeaking(true)
              }}
            >
              Generate Speech Patch…
            </button>
          )}
          {withSynth && (
            <>
              {patch && <hr />}
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
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  fileInput.current?.click()
                }}
              >
                Restore from a backup…
              </button>
            </>
          )}
          {(patch || withSynth) && <hr />}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              setAbout(true)
            }}
          >
            About Hydrasynth Editor…
          </button>
        </div>
      )}
      {about && <AboutDialog onClose={() => setAbout(false)} />}
      {speaking && (
        <SpeechPatchDialog
          text={words}
          onDone={(_, w) => {
            setSpeaking(false)
            setWords(w)
          }}
        />
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".syx"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = '' // the same file can be picked again
          if (file) void openRestore(file)
        }}
      />
    </span>
  )
}

/** Undo / Redo as icons; the tooltip names the step they'd take back or redo. */
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
        aria-label="Undo"
        title={undoLabel ? `Undo ${undoLabel} (${mac ? '⌘Z' : 'Ctrl+Z'})` : 'Nothing to undo'}
      >
        <UndoIcon />
      </button>
      <button
        type="button"
        className="function-button"
        onClick={redo}
        disabled={!redoLabel}
        aria-label="Redo"
        title={redoLabel ? `Redo ${redoLabel} (${mac ? '⇧⌘Z' : 'Ctrl+Y'})` : 'Nothing to redo'}
      >
        <RedoIcon />
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
    : sync.synthSwitched
      ? [`Synth is on ${slotName(sync.synthSwitched)}: its knobs no longer change this patch`, 'busy']
      : sync.busy
      ? [`${sync.busy}…`, 'busy']
      : sync.pendingFullSend
        ? ['Sending the whole patch in a moment', '']
        : ['', '']
  return (
    <span className={`status patch-bar__status${kind ? ` status--${kind}` : ''}`} title={text} role="status">
      {text}
    </span>
  )
}

export function PatchBar() {
  const connection = useEditor((s) => s.connection)
  const connect = useEditor((s) => s.connect)
  const open = useEditor((s) => s.open)
  const sync = useEditor((s) => s.sync)
  useEditor((s) => s.sync?.revision)
  const [chosen, setChosen] = useState<Slot>({ bank: 0, patch: 0 })
  const [pending, setPending] = useState<Replacement | null>(null)
  /** The synth patch change last answered with "Keep editing" (each change is a new object). */
  const [dismissedSwitch, setDismissedSwitch] = useState<Slot | null>(null)
  const initPatch = useEditor((s) => s.initPatch)
  const replace = (next: Replacement) => (next.kind === 'init' ? void initPatch() : void open(next.slot))
  const ask = (next: Replacement) => (sync?.patch && sync.dirty ? setPending(next) : replace(next))
  // The picker marks the open patch's slot; while asking or loading, the one picked. A
  // cancelled or failed open leaves it back on the open patch.
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
    // Browsing faster than patches load: the last pick waits for the load in progress.
    if (sync?.busy) queued.current = next
    else ask({ kind: 'slot', slot: next })
  }
  const queued = useRef<Slot | null>(null)
  useEffect(() => {
    if (sync?.busy || !queued.current) return
    const next = queued.current
    queued.current = null
    ask({ kind: 'slot', slot: next })
  }, [sync?.busy])
  const patch = sync?.patch

  if (connection.status === 'demo') {
    return (
      <header className="patch-bar">
        <span className="brand">Hydrasynth Editor</span>
        <span className="status patch-bar__status">Demo: a built-in patch, nothing is sent to a synth</span>
        <UndoRedo />
        <MoreMenu withSynth={false} />
      </header>
    )
  }

  if (connection.status !== 'connected') {
    return (
      <header className="patch-bar patch-bar--offline">
        <span className="brand">Hydrasynth Editor</span>
        <button type="button" className="function-button function-button--primary" onClick={() => void connect()} disabled={connection.status === 'connecting'}>
          {connection.status === 'connecting' ? 'Connecting…' : 'Connect to the Hydrasynth'}
        </button>
        {connection.status === 'failed' && <span className="status status--error">{connection.message}</span>}
        <MoreMenu withSynth={false} />
      </header>
    )
  }

  return (
    <header className="patch-bar">
      <span className="brand">Hydrasynth Editor</span>
      <SlotPicker slot={slot} onChange={pick} buttonLabel="Open" icon={<OpenIcon />} stayOpen />
      <button
        type="button"
        className="function-button with-icon"
        title="Start a new patch from the synth's Init patch, played from H128"
        onClick={() => ask({ kind: 'init' })}
        disabled={!!sync?.busy}
      >
        <InitIcon />
        Init
      </button>
      <Status />
      {sync?.synthSwitched && !sync.busy && (
        <button type="button" className="function-button function-button--primary" onClick={() => ask({ kind: 'slot', slot: sync.synthSwitched! })}>
          Open {slotName(sync.synthSwitched)}
        </button>
      )}
      {patch && <UndoRedo />}
      <MoreMenu withSynth />
      {sync?.synthSwitched && !sync.busy && sync.synthSwitched !== dismissedSwitch && !pending && (
        <SynthSwitchedDialog
          key={`${sync.synthSwitched.bank}:${sync.synthSwitched.patch}`}
          slot={sync.synthSwitched}
          onKeep={() => setDismissedSwitch(sync.synthSwitched)}
          onOpen={() => replace({ kind: 'slot', slot: sync.synthSwitched! })}
        />
      )}
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
