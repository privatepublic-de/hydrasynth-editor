import { create } from 'zustand'
import { noteOff, noteOn } from '../midi/channel'
import { findHydrasynth, requestWebMidi, webMidiTransport } from '../midi/transport'
import { Patch } from '../params/patch'
import { decodeMessage } from '../sysex/codec'
import { parseChunk } from '../sysex/protocol'
import { HydrasynthSession } from '../sysex/session'
import demoDump from '../../test/fixtures/sawexpressive.syx.hex?raw'
import { PatchSync, type Slot, type SyncState } from '../sync/patchSync'

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
  connect(): Promise<void>
  /** Offline: a bundled patch to look at and edit locally, nothing sent anywhere. */
  startDemo(): void
  setChannel(channel: number): void
  loadBankNames(bank: number): Promise<void>
  open(slot: Slot): Promise<void>
  set(key: string, value: number): void
  setName(name: string): void
  setMacroName(macro: number, name: string): void
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

  startDemo() {
    const bytes = demoDump
      .trim()
      .split('\n')
      .flatMap((line) => [...parseChunk(decodeMessage(Uint8Array.from(line.trim().split(/\s+/).map((h) => parseInt(h, 16)))).info)!.data])
    const patch = new Patch(Uint8Array.from(bytes))
    set({
      connection: { status: 'demo' },
      sync: { patch, origin: { bank: 0, patch: 0 }, dirty: false, playing: { kind: 'unknown' }, pendingFullSend: false, busy: null, error: null, revision: 0 },
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

  set(key, value) {
    if (patchSync) patchSync.set(key, value)
    else demoEdit(set, get, (p) => p.set(key, value))
  },

  setName(name) {
    if (patchSync) patchSync.setName(name)
    else demoEdit(set, get, (p) => (p.name = name))
  },

  setMacroName(macro, name) {
    if (patchSync) patchSync.setMacroName(macro, name)
    else demoEdit(set, get, (p) => p.setMacroName(macro, name))
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

function demoEdit(set: (p: Partial<EditorState>) => void, get: () => EditorState, edit: (p: Patch) => void) {
  const sync = get().sync
  if (!sync?.patch) return
  edit(sync.patch)
  set({ sync: { ...sync, dirty: true, revision: sync.revision + 1 } })
}
