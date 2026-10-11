import { create } from 'zustand'
import { noteOff, noteOn } from '../midi/channel'
import { findHydrasynth, requestWebMidi, webMidiTransport } from '../midi/transport'
import { initPatchBytes } from '../params/initPatch'
import { Patch } from '../params/patch'
import { decodeMessage } from '../sysex/codec'
import { parseChunk } from '../sysex/protocol'
import { HydrasynthSession } from '../sysex/session'
import { CENTER_DEPTH, destinationOf, freeMacroSlot, freeRoute, newSlotDepth, type Modulation } from '../ui/modDestinations'
import demoDump from '../../test/fixtures/sawexpressive.syx.hex?raw'
import { inSlotOrder, runBackup, type BackupProgress } from '../library/backup'
import { BackupFileError, backupFileName, decodeBackup, encodeBackup, type StoredPatch } from '../library/backupFile'
import { runRestore, type RestoreItem, type RestoreProgress, type RestoreResult } from '../library/restore'
import { History } from '../sync/history'
import { fxPresetValues } from '../params/fxPresets'
import { PatchSync, labelFor, type Slot, type SyncState } from '../sync/patchSync'

export type Connection =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'connected'; port: string }
  | { status: 'failed'; message: string }
  | { status: 'demo' }

export interface BackupState {
  phase: 'choose' | 'running' | 'stopped' | 'done'
  banks: number[]
  progress: BackupProgress | null
  /** Why a run stopped early (cancelled, a patch that didn't come through, the port gone). */
  stopped?: string
  retries: number
  /** Patches read so far for the chosen banks. */
  count: number
}

export interface RestoreState {
  phase: 'choose' | 'running' | 'done'
  fileName: string
  /** The backup's patches, or why the file couldn't be read. */
  patches: StoredPatch[]
  fileError?: string
  progress?: RestoreProgress
  result?: RestoreResult
  /** What the run replaces, in words ("bank C", "C12"). */
  target?: string
}

interface EditorState {
  connection: Connection
  channel: number
  sync: SyncState | null
  /** Patch names per bank (0-7), loaded on demand. */
  bankNames: Record<number, string[]>
  /** The slot last opened (or asked for): where Write starts for a patch that isn't stored. */
  lastSlot: Slot
  /** The slot a write in progress stores to (it takes seconds: the app shows a wait message). */
  writing: Slot | null
  module: string
  /** A param to scroll to and highlight (a mod-matrix or macro row), and what to focus there. */
  reveal: { module: string; rowKey: string; focusKey?: string; nonce: number } | null
  revealModulation(m: Modulation, focusKey?: string): void
  /** Points a free mod-matrix route at `key`'s destination; returns the route, if one was free. */
  addRoute(key: string): number | undefined
  /** Adds `key`'s destination to a free slot of a macro; returns the slot, if one was free. */
  addToMacro(key: string, macro: number): number | undefined
  /** The backup dialog's state; null while it's closed. */
  backup: BackupState | null
  openBackup(): void
  closeBackup(): void
  /** Reads the chosen banks, or after a stop only the patches still missing. */
  startBackup(banks: number[]): Promise<void>
  cancelBackup(): void
  /** Offers the patches read so far as a .syx download. */
  saveBackupFile(): void
  /** The restore dialog's state; null while it's closed. */
  restore: RestoreState | null
  openRestore(file: File): Promise<void>
  /** Writes `items` to their slots (flash included, checked afterwards); `target` names them. */
  startRestore(items: RestoreItem[], target: string): Promise<void>
  cancelRestore(): void
  /** Offers what the restore replaced as a .syx download. */
  saveReplaced(): void
  closeRestore(): void
  /** The param context menu, at a viewport position. */
  menu: { x: number; y: number; key: string } | null
  openMenu(key: string, x: number, y: number): void
  closeMenu(): void
  connect(): Promise<void>
  /** Offline: a bundled patch to look at and edit locally, nothing sent anywhere. */
  startDemo(): void
  setChannel(channel: number): void
  loadBankNames(bank: number): Promise<void>
  open(slot: Slot): Promise<void>
  /** Starts from the synth's Init patch, played from H128. */
  initPatch(): Promise<void>
  /** Replaces the open patch with `patch`, played from H128 (live: no undo; demo: one undo step). */
  loadPatch(patch: Patch, label: string): Promise<void>
  set(key: string, value: number): void
  setName(name: string): void
  setMacroName(macro: number, name: string): void
  undo(): void
  redo(): void
  /** Everything `body` changes becomes one undo step called `label`. */
  grouped(label: string, body: () => void): void
  /** A pointer drag from press to release: one undo step, whatever it changes. */
  beginGesture(): void
  endGesture(): void
  write(slot: Slot): Promise<void>
  selectModule(id: string): void
  note(note: number, on: boolean, velocity?: number): void
}

let session: HydrasynthSession | null = null
/** Patches read by the current backup run (kept across a stop, so Continue reads only the rest). */
let backupHave = new Map<string, StoredPatch>()
let backupAbort: AbortController | null = null
let restoreAbort: AbortController | null = null
/** The patch's revision when the synth's port disappeared; null while connected (or never). */
let offlineRevision: number | null = null

/** Hands `bytes` to the browser as a file download. */
export function download(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
let patchSync: PatchSync | null = null

const CHANNEL_KEY = 'hydrasynth-editor.channel'
function storedChannel(): number {
  try {
    const v = Number(localStorage.getItem(CHANNEL_KEY))
    return v >= 1 && v <= 16 ? v : 1
  } catch {
    return 1
  }
}

export const useEditor = create<EditorState>((set, get) => ({
  connection: { status: 'disconnected' },
  channel: storedChannel(),
  sync: null,
  bankNames: {},
  lastSlot: { bank: 0, patch: 0 },
  writing: null,
  module: 'osc1',
  reveal: null,
  menu: null,
  backup: null,
  restore: null,

  async openRestore(file) {
    const fileName = file.name
    try {
      const patches = decodeBackup(new Uint8Array(await file.arrayBuffer()))
      if (!patches.length) throw new BackupFileError('it holds no patches')
      set({ restore: { phase: 'choose', fileName, patches } })
    } catch (err) {
      const why = err instanceof BackupFileError ? err.message : 'it couldn\u2019t be read'
      set({ restore: { phase: 'choose', fileName, patches: [], fileError: `This isn\u2019t a Hydrasynth backup: ${why}.` } })
    }
  },

  async startRestore(items, target) {
    if (!session || get().restore?.phase === 'running') return
    const update = (r: Partial<RestoreState>) => set((s) => ({ restore: s.restore && { ...s.restore, ...r } }))
    update({ phase: 'running', target, progress: undefined, result: undefined })
    await patchSync?.settled().catch(() => undefined)
    restoreAbort = new AbortController()
    const result = await runRestore({ session, items, signal: restoreAbort.signal, onProgress: (progress) => update({ progress }) }).catch(
      (err: Error): RestoreResult => ({ outcome: 'not-written', previous: [], mismatches: [], reason: err.message }),
    )
    restoreAbort = null
    // The patch list shows the new names once they're read again.
    const banks = new Set(items.map((i) => i.bank))
    set((s) => ({ bankNames: Object.fromEntries(Object.entries(s.bankNames).filter(([b]) => !banks.has(Number(b)))) }))
    update({ phase: 'done', result })
  },

  cancelRestore() {
    restoreAbort?.abort()
  },

  saveReplaced() {
    const previous = get().restore?.result?.previous
    if (previous?.length) download(encodeBackup(previous), backupFileName().replace('backup', 'before-restore'))
  },

  closeRestore() {
    if (get().restore?.phase === 'running') return
    set({ restore: null })
  },

  openBackup() {
    backupHave = new Map()
    set({ backup: { phase: 'choose', banks: [0, 1, 2, 3, 4, 5, 6, 7], progress: null, retries: 0, count: 0 } })
  },

  closeBackup() {
    backupAbort?.abort()
    backupHave = new Map()
    set({ backup: null })
  },

  async startBackup(banks) {
    if (!session || get().backup?.phase === 'running') return
    const update = (b: Partial<BackupState>) => set((s) => ({ backup: s.backup && { ...s.backup, ...b } }))
    update({ phase: 'running', banks, stopped: undefined })
    // Edits still on their way go out first; the backup then has the synth to itself.
    await patchSync?.settled().catch(() => undefined)
    backupAbort = new AbortController()
    const retriesBefore = get().backup?.retries ?? 0
    const result = await runBackup({
      session,
      banks,
      have: backupHave,
      signal: backupAbort.signal,
      onProgress: (progress) => update({ progress, count: progress.done }),
    }).catch((err: Error) => ({ stopped: err.message, retries: 0 }))
    backupAbort = null
    const count = inSlotOrder(backupHave, banks).length
    const stopped = get().connection.status === 'connected' ? result.stopped : 'The synth\u2019s USB MIDI port disappeared.'
    update({ phase: stopped ? 'stopped' : 'done', stopped, count, retries: retriesBefore + result.retries })
  },

  cancelBackup() {
    backupAbort?.abort()
  },

  saveBackupFile() {
    const b = get().backup
    if (b) download(encodeBackup(inSlotOrder(backupHave, b.banks)), backupFileName())
  },

  revealModulation(m, focusKey) {
    const rowKey = m.kind === 'matrix' ? `modmatrix${m.route}modtarget` : `macro${m.macro}target${m.slot}`
    set((s) => ({
      module: m.kind === 'matrix' ? 'modmatrix' : 'macros',
      reveal: { module: m.kind === 'matrix' ? 'modmatrix' : 'macros', rowKey, focusKey, nonce: (s.reveal?.nonce ?? 0) + 1 },
    }))
  },

  addRoute(key) {
    const patch = get().sync?.patch
    const dest = destinationOf(key)
    if (!patch || dest === undefined) return undefined
    const route = freeRoute(patch)
    if (route === undefined) return undefined
    get().set(`modmatrix${route}modtarget`, dest)
    // Its source is still Off: focus that, the one thing left to choose.
    get().revealModulation({ kind: 'matrix', route }, `modmatrix${route}modsource`)
    return route
  },

  addToMacro(key, macro) {
    const patch = get().sync?.patch
    const dest = destinationOf(key)
    if (!patch || dest === undefined) return undefined
    const slot = freeMacroSlot(patch, macro)
    if (slot === undefined) return undefined
    get().set(`macro${macro}target${slot}`, dest)
    get().revealModulation({ kind: 'macro', macro, slot }, `macro${macro}depth${slot}`)
    return slot
  },

  openMenu(key, x, y) {
    set({ menu: { key, x, y } })
  },

  closeMenu() {
    set({ menu: null })
  },


  startDemo() {
    const bytes = demoDump
      .trim()
      .split('\n')
      .flatMap((line) => [...parseChunk(decodeMessage(Uint8Array.from(line.trim().split(/\s+/).map((h) => parseInt(h, 16)))).info)!.data])
    const patch = new Patch(Uint8Array.from(bytes))
    set({
      connection: { status: 'demo' },
      sync: {
        patch,
        origin: { bank: 0, patch: 0 },
        dirty: false,
        playing: { kind: 'unknown' },
        synthSwitched: null,
        pendingFullSend: false,
        busy: null,
        error: null,
        revision: 0,
        undoLabel: null,
        redoLabel: null,
      },
    })
  },

  async connect() {
    set({ connection: { status: 'connecting' } })
    try {
      const access = await requestWebMidi()
      const ports = findHydrasynth(access)
      if (!ports) {
        set({ connection: { status: 'failed', message: 'No Hydrasynth found. Check the USB cable and that the synth is on.' } })
        return
      }
      // A reconnect keeps the patch being edited (after a lost port: as it was edited offline).
      const previous = patchSync?.get() ?? get().sync
      const editedOffline = offlineRevision !== null && previous !== null && previous.revision !== offlineRevision
      offlineRevision = null
      patchSync?.dispose()
      session?.dispose()
      session = new HydrasynthSession(webMidiTransport(ports), { timeoutMs: 3000 })
      // The synth's USB port can vanish (a long run of dumps did that once): say so, stop what
      // runs, and keep editing offline until the next connect.
      access.onstatechange = (e) => {
        const port = (e as MIDIConnectionEvent).port
        if (!port || port.state !== 'disconnected' || (port.id !== ports.input.id && port.id !== ports.output.id)) return
        if (get().connection.status !== 'connected') return
        access.onstatechange = null
        backupAbort?.abort()
        restoreAbort?.abort()
        patchSync?.dispose()
        session?.dispose()
        patchSync = null
        session = null
        // Offline edits keep their own undo history, as in the demo; nothing is in flight any more.
        demoHistory.reset()
        const sync = get().sync
        offlineRevision = sync?.revision ?? null
        set({
          connection: { status: 'failed', message: 'The synth\u2019s USB MIDI port disappeared. Check the cable, then connect again.' },
          sync: sync && { ...sync, busy: null, pendingFullSend: false, undoLabel: null, redoLabel: null },
        })
      }
      patchSync = new PatchSync({ session, channel: get().channel })
      patchSync.subscribe((s) => set({ sync: s }))
      if (previous) patchSync.adopt(previous)
      // Edits made while the port was gone never reached the synth: send it the whole patch.
      if (editedOffline) void patchSync.audition().catch(() => undefined) // the error is in sync.error
      set({ connection: { status: 'connected', port: ports.output.name ?? 'Hydrasynth' }, sync: patchSync.get() })
    } catch (err) {
      set({ connection: { status: 'failed', message: `The browser didn\u2019t allow MIDI access (${(err as Error).message}). Allow it for this page, then connect again.` } })
    }
  },

  setChannel(channel) {
    patchSync?.setChannel(channel)
    try {
      localStorage.setItem(CHANNEL_KEY, String(channel))
    } catch {
      // per-browser convenience only
    }
    set({ channel })
  },

  async loadBankNames(bank) {
    if (!session) return
    const { names } = await session.downloadBankNames(bank)
    set((s) => ({ bankNames: { ...s.bankNames, [bank]: names } }))
  },

  async open(slot) {
    set({ lastSlot: slot })
    await patchSync?.open(slot).catch(() => undefined) // the error is in sync.error
  },

  async initPatch() {
    await patchSync?.load(new Patch(initPatchBytes()), { dirty: false }).catch(() => undefined) // the error is in sync.error
  },

  async loadPatch(patch, label) {
    if (patchSync) await patchSync.load(patch, { dirty: true }).catch(() => undefined) // the error is in sync.error
    else demoEdit(set, get, (p) => p.bytes.set(patch.bytes), 'patch', label)
  },

  set(key, value) {
    const put = (k: string, v: number) => (patchSync ? patchSync.set(k, v) : demoEdit(set, get, (p) => p.set(k, v), k, labelFor(k)))
    const patch = get().sync?.patch
    // An FX preset sets the type's five params too, in the same undo step.
    const preset = fxPresetValues(key, value)
    if (preset) {
      return get().grouped(labelFor(key), () => {
        put(key, value)
        for (const [k, v] of preset) put(k, v)
      })
    }
    const depth = patch && newSlotDepth(patch, key, value)
    if (!depth) return put(key, value)
    // A new route or macro slot starts with no depth, the same undo step.
    get().grouped(labelFor(key), () => {
      put(key, value)
      put(depth, CENTER_DEPTH)
    })
  },

  setName(name) {
    if (patchSync) patchSync.setName(name)
    else demoEdit(set, get, (p) => (p.name = name), 'name', 'Patch name')
  },

  setMacroName(macro, name) {
    if (patchSync) patchSync.setMacroName(macro, name)
    else demoEdit(set, get, (p) => p.setMacroName(macro, name), `macro${macro}name`, `Macro ${macro} name`)
  },

  undo() {
    if (patchSync) patchSync.undo()
    else demoRestore(set, get, 'undo')
  },

  redo() {
    if (patchSync) patchSync.redo()
    else demoRestore(set, get, 'redo')
  },

  beginGesture() {
    if (patchSync) patchSync.beginGesture()
    else demoHistory.beginGesture()
  },

  endGesture() {
    if (patchSync) patchSync.endGesture()
    else demoHistory.endGesture()
  },

  grouped(label, body) {
    if (patchSync) patchSync.grouped(label, body)
    else demoHistory.grouped(label, body)
  },

  async write(slot) {
    if (!patchSync) return // offline: the Write button waits for a connection
    set({ writing: slot })
    await patchSync?.write(slot).catch(() => undefined)
    set({ writing: null })
    const names = get().bankNames[slot.bank]
    const patch = patchSync?.get().patch
    if (names && patch) {
      const next = [...names]
      next[slot.patch] = patch.name
      set((s) => ({ bankNames: { ...s.bankNames, [slot.bank]: next } }))
    }
  },

  selectModule(id) {
    set({ module: id })
  },

  note(n, on, velocity = 100) {
    if (!session) return
    session.sendRaw(on ? noteOn(get().channel, n, velocity) : noteOff(get().channel, n))
  },
}))

/** The demo edits a local patch without a synth, so it keeps its own undo history. */
const demoHistory = new History()
const demoSnapshot = (p: Patch) => ({ bytes: new Uint8Array(p.bytes), inactive: [] })

function demoEdit(set: (p: Partial<EditorState>) => void, get: () => EditorState, edit: (p: Patch) => void, key: string, label: string) {
  const sync = get().sync
  if (!sync?.patch) return
  const patch = sync.patch
  const before = new Uint8Array(patch.bytes)
  edit(patch)
  if (patch.bytes.every((b, i) => b === before[i])) return
  const after = new Uint8Array(patch.bytes)
  patch.bytes.set(before)
  demoHistory.record(() => demoSnapshot(patch), key, label)
  patch.bytes.set(after)
  set({ sync: { ...sync, dirty: true, revision: sync.revision + 1, undoLabel: demoHistory.undoLabel, redoLabel: demoHistory.redoLabel } })
}

function demoRestore(set: (p: Partial<EditorState>) => void, get: () => EditorState, which: 'undo' | 'redo') {
  const sync = get().sync
  if (!sync?.patch) return
  const snap = which === 'undo' ? demoHistory.undo(demoSnapshot(sync.patch)) : demoHistory.redo(demoSnapshot(sync.patch))
  if (!snap) return
  sync.patch.bytes.set(snap.bytes)
  set({ sync: { ...sync, revision: sync.revision + 1, undoLabel: demoHistory.undoLabel, redoLabel: demoHistory.redoLabel } })
}

/** begin/end of a pointer drag, so the whole drag is one undo step. */
export function useGesture() {
  const beginGesture = useEditor((s) => s.beginGesture)
  const endGesture = useEditor((s) => s.endGesture)
  return { beginGesture, endGesture }
}
