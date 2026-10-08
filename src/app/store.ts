import { create } from 'zustand'
import { noteOff, noteOn } from '../midi/channel'
import { findHydrasynth, requestWebMidi, webMidiTransport } from '../midi/transport'
import { initPatchBytes } from '../params/initPatch'
import { Patch } from '../params/patch'
import { decodeMessage } from '../sysex/codec'
import { parseChunk } from '../sysex/protocol'
import { HydrasynthSession } from '../sysex/session'
import { destinationOf, freeMacroSlot, freeRoute, type Modulation } from '../ui/modDestinations'
import demoDump from '../../test/fixtures/sawexpressive.syx.hex?raw'
import { History } from '../sync/history'
import { PatchSync, labelFor, type Slot, type SyncState } from '../sync/patchSync'

export type Connection =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'connected'; port: string }
  | { status: 'failed'; message: string }
  | { status: 'demo' }

interface EditorState {
  connection: Connection
  channel: number
  sync: SyncState | null
  /** Patch names per bank (0-7), loaded on demand. */
  bankNames: Record<number, string[]>
  module: string
  /** Wavelist slot shown large per oscillator ('osc1'), or absent to follow the WaveScan position. */
  waveView: Record<string, number | undefined>
  setWaveView(osc: string, slot: number | undefined): void
  /** A param to scroll to and highlight (a mod-matrix or macro row), and what to focus there. */
  reveal: { module: string; rowKey: string; focusKey?: string; nonce: number } | null
  revealModulation(m: Modulation, focusKey?: string): void
  /** Points a free mod-matrix route at `key`'s destination; returns the route, if one was free. */
  addRoute(key: string): number | undefined
  /** Adds `key`'s destination to a free slot of a macro; returns the slot, if one was free. */
  addToMacro(key: string, macro: number): number | undefined
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
  module: 'osc1',
  waveView: {},
  reveal: null,
  menu: null,

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

  setWaveView(osc, slot) {
    set((s) => ({ waveView: { ...s.waveView, [osc]: slot } }))
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
      patchSync?.dispose()
      session?.dispose()
      session = new HydrasynthSession(webMidiTransport(ports), { timeoutMs: 3000 })
      patchSync = new PatchSync({ session, channel: get().channel })
      patchSync.subscribe((s) => set({ sync: s }))
      set({ connection: { status: 'connected', port: ports.output.name ?? 'Hydrasynth' }, sync: patchSync.get() })
    } catch (err) {
      set({ connection: { status: 'failed', message: `MIDI access was refused or failed: ${(err as Error).message}` } })
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
    await patchSync?.open(slot).catch(() => undefined) // the error is in sync.error
  },

  async initPatch() {
    await patchSync?.load(new Patch(initPatchBytes()), { dirty: false }).catch(() => undefined) // the error is in sync.error
  },

  set(key, value) {
    if (patchSync) patchSync.set(key, value)
    else demoEdit(set, get, (p) => p.set(key, value), key, labelFor(key))
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
    await patchSync?.write(slot).catch(() => undefined)
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
