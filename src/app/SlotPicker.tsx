import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BANK_LETTERS } from '../sysex/protocol'
import { slotName, type Slot } from '../sync/patchSync'
import { useEditor } from './store'

/** A slot value meaning: the open patch (Init, a file) isn't stored in a slot. */
export const NOT_STORED = -1
const PATCHES = 128

/**
 * Bank and patch in one: a button with the current slot, opening a panel with the banks down
 * the left and the chosen bank's patches beside them, plus a search over every bank's names.
 * The panel is a popover, so it shows above modal dialogs too.
 */
export function SlotPicker({
  slot,
  onChange,
  buttonLabel,
  icon,
  disabled,
  stayOpen,
}: {
  slot: Slot
  onChange: (s: Slot) => void
  /** Shown on the button instead of the slot and its name: the picker as an action (Open). */
  buttonLabel?: string
  /** Before the button label. */
  icon?: React.ReactNode
  disabled?: boolean
  /** Picking a patch leaves the panel open, for browsing (Open); otherwise it closes. */
  stayOpen?: boolean
}) {
  const bankNames = useEditor((s) => s.bankNames)
  const loadBankNames = useEditor((s) => s.loadBankNames)
  const connected = useEditor((s) => s.connection.status === 'connected')
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [bank, setBank] = useState(slot.bank)
  const [query, setQuery] = useState('')
  const names = bankNames[slot.bank]
  const shown = bankNames[bank]

  // Names of the bank on the button, and of the bank shown in the panel.
  useEffect(() => {
    if (connected && !names) loadBankNames(slot.bank).catch(() => undefined)
  }, [connected, slot.bank, names, loadBankNames])
  useEffect(() => {
    if (open && connected && !shown) loadBankNames(bank).catch(() => undefined)
  }, [open, connected, bank, shown, loadBankNames])
  // A search reads every bank's names (one short request each, once).
  useEffect(() => {
    if (!open || !query || !connected) return
    let stop = false
    void (async () => {
      for (let b = 0; b < BANK_LETTERS.length && !stop; b++) {
        if (!useEditor.getState().bankNames[b]) await loadBankNames(b).catch(() => undefined)
      }
    })()
    return () => {
      stop = true
    }
  }, [open, query, connected, loadBankNames])

  const show = () => {
    setBank(slot.bank)
    setQuery('')
    setOpen(true)
  }
  const close = (refocus = true) => {
    setOpen(false)
    if (refocus) button.current?.focus()
  }
  const choose = (s: Slot) => {
    if (!stayOpen) close()
    if (s.bank !== slot.bank || s.patch !== slot.patch) onChange(s)
  }

  useLayoutEffect(() => {
    const p = panel.current
    if (!p) return
    if (!open) {
      if (p.matches(':popover-open')) p.hidePopover()
      return
    }
    p.showPopover()
    // Under the button, kept inside the window.
    const r = button.current!.getBoundingClientRect()
    const w = p.offsetWidth
    const h = p.offsetHeight
    p.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`
    p.style.top = `${r.bottom + h + 12 < innerHeight ? r.bottom + 4 : Math.max(8, r.top - h - 4)}px`
    // Start on the current patch, or the bank's first.
    const current = p.querySelector<HTMLElement>('.slot-picker__patch[aria-selected="true"]') ?? p.querySelector<HTMLElement>('.slot-picker__patch')
    current?.focus({ preventScroll: true })
    current?.scrollIntoView({ block: 'nearest' })
  }, [open])

  // Clicks outside close it (popover="manual" so a parent dialog's Escape and clicks stay ours).
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      const t = e.target as Node
      // A dialog a pick brings up (discard changes?) is answered without closing the panel.
      if (stayOpen && (t as Element).closest?.('dialog[open]')) return
      if (!panel.current?.contains(t) && !button.current?.contains(t)) close(false)
    }
    addEventListener('pointerdown', away, true)
    return () => removeEventListener('pointerdown', away, true)
  }, [open])

  const results = query
    ? Object.entries(bankNames)
        .flatMap(([b, list]) => list.map((name, patch) => ({ bank: Number(b), patch, name })))
        .filter((r) => r.name.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => a.bank - b.bank || a.patch - b.patch)
    : null
  const loadedBanks = Object.keys(bankNames).length

  // Arrow keys move through the patches: up/down one, left/right a column; Page Up/Down a bank.
  const onPatchKey = (e: React.KeyboardEvent, index: number, count: number, columns: number) => {
    const rows = Math.ceil(count / columns)
    const moves: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -rows, ArrowRight: rows }
    if (e.key in moves) {
      const next = Math.max(0, Math.min(count - 1, index + moves[e.key]))
      panel.current?.querySelectorAll<HTMLElement>('.slot-picker__patch')[next]?.focus()
    } else if ((e.key === 'PageUp' || e.key === 'PageDown') && !results) {
      setBank((b) => (b + (e.key === 'PageUp' ? 7 : 1)) % 8)
    } else return
    e.preventDefault()
  }

  const label = slot.patch === NOT_STORED ? 'Not stored' : `${slotName(slot)} ${names?.[slot.patch] ?? ''}`

  return (
    <span className="slot-picker">
      <button
        ref={button}
        type="button"
        className={`slot-picker__button${buttonLabel ? ' slot-picker__button--action' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={buttonLabel ? `${buttonLabel} a patch` : `Patch: ${label}`}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
      >
        {icon}
        {buttonLabel ?? (
          <>
            <span className="slot-picker__slot">{slot.patch === NOT_STORED ? '—' : slotName(slot)}</span>
            <span className="slot-picker__name">{slot.patch === NOT_STORED ? 'Not stored' : (names?.[slot.patch] ?? '')}</span>
          </>
        )}
        <span aria-hidden="true">▾</span>
      </button>
      <div
        ref={panel}
        // React 18's types don't know `popover` yet; the attribute passes through.
        {...{ popover: 'manual' }}
        className="slot-picker__panel"
        role="dialog"
        aria-label="Choose a patch"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close()
          } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.target !== search.current && e.key !== ' ') {
            // Typing anywhere in the panel searches.
            e.preventDefault()
            setQuery((q) => q + e.key)
            search.current?.focus()
          }
        }}
      >
        <input
          ref={search}
          className="slot-picker__search"
          type="search"
          placeholder="Search all banks"
          aria-label="Search patch names in all banks"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              panel.current?.querySelector<HTMLElement>('.slot-picker__patch')?.focus()
            }
          }}
        />
        {open && (
          <div className="slot-picker__body">
            {!results && (
              <div className="slot-picker__banks" role="tablist" aria-label="Bank">
                {[...BANK_LETTERS].map((l, i) => (
                  <button
                    key={l}
                    type="button"
                    role="tab"
                    aria-selected={i === bank}
                    className="slot-picker__bank"
                    onClick={() => setBank(i)}
                    onPointerEnter={(e) => e.pointerType === 'mouse' && setBank(i)}
                  >
                    {l}
                  </button>
                ))}
              </div>
            )}
            {results ? (
              <div className="slot-picker__results" role="listbox" aria-label="Matching patches">
                {results.length === 0 && (
                  <p className="slot-picker__note">{loadedBanks < 8 ? 'Reading the banks’ names…' : 'No patch has that in its name.'}</p>
                )}
                {results.map((r, i) => (
                  <button
                    key={`${r.bank}:${r.patch}`}
                    type="button"
                    role="option"
                    aria-selected={r.bank === slot.bank && r.patch === slot.patch}
                    className="slot-picker__patch"
                    onClick={() => choose({ bank: r.bank, patch: r.patch })}
                    onKeyDown={(e) => onPatchKey(e, i, results.length, 1)}
                  >
                    <span className="slot-picker__number">{slotName(r)}</span> {r.name}
                  </button>
                ))}
              </div>
            ) : (
              <div className="slot-picker__patches" role="listbox" aria-label={`Bank ${BANK_LETTERS[bank]}`}>
                {Array.from({ length: PATCHES }, (_, patch) => (
                  <button
                    key={patch}
                    type="button"
                    role="option"
                    aria-selected={bank === slot.bank && patch === slot.patch}
                    className="slot-picker__patch"
                    onClick={() => choose({ bank, patch })}
                    onKeyDown={(e) => onPatchKey(e, patch, PATCHES, 4)}
                  >
                    <span className="slot-picker__number">{patch + 1}</span> {shown?.[patch] ?? ''}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </span>
  )
}
