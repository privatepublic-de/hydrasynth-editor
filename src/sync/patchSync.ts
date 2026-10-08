// Keeps the synth playing the patch the editor holds. The synth has no "current patch"
// that can be sent or read back, so:
//  - opening a slot loads it (program change) and downloads it; the synth's edit buffer
//    then equals the model, and live edits go out as NRPN;
//  - what NRPN can't carry (names, scales, arp tempo, ...) goes out as a whole patch to
//    the scratch slot H128 (working memory, no flash write), which is then reloaded;
//  - write saves to a slot and flash.
import { encodeNrpn } from '../params/nrpn'
import { PARAM_BY_KEY, Patch, param } from '../params/patch'
import type { ParamDef } from '../params/types'
import type { HydrasynthSession } from '../sysex/session'
import { NrpnQueue } from './nrpnQueue'

export interface Slot {
  bank: number
  patch: number
}

/** Edisyn's scratch slot too. Whatever is stored there gets overwritten. */
export const AUDITION_SLOT: Slot = { bank: 7, patch: 127 }

/** The synth is playing: a stored slot (as loaded), or our patch sent to the audition slot. */
export type Playing = { kind: 'slot'; slot: Slot } | { kind: 'audition' } | { kind: 'unknown' }

export interface SyncState {
  patch: Patch | null
  /** Where the patch came from / was last written to. */
  origin: Slot | null
  /** Changed since it was opened or written. */
  dirty: boolean
  playing: Playing
  /** Whole-patch send scheduled or running. */
  pendingFullSend: boolean
  busy: string | null
  error: string | null
  /** Bumped on every change, the patch's bytes included (they change in place). */
  revision: number
}

export interface PatchSyncOptions {
  session: HydrasynthSession
  channel: number
  /** Idle time after the last edit that needs a whole-patch send (Edisyn: 1 s). */
  fullSendDelayMs?: number
}

/** Keys whose value changes what other params' bytes mean (BPM sync, mutant mode, FX type). */
const DEPENDENTS = new Map<string, ParamDef[]>()
for (const def of PARAM_BY_KEY.values()) {
  if (!def.when) continue
  DEPENDENTS.set(def.when.key, [...(DEPENDENTS.get(def.when.key) ?? []), def])
}
/** Sent before other queued values; Edisyn's order for bulk NRPN: modes, types, waves, syncs. */
const isLeadKey = (key: string) => DEPENDENTS.has(key) || /(mode|type|wave|bpmsync)$/.test(key)

export class PatchSync {
  private state: SyncState = {
    patch: null,
    origin: null,
    dirty: false,
    playing: { kind: 'unknown' },
    pendingFullSend: false,
    busy: null,
    error: null,
    revision: 0,
  }
  private listeners = new Set<(s: SyncState) => void>()
  private fullSendTimer: ReturnType<typeof setTimeout> | null = null
  /** Values of the modes not currently selected (the patch bytes hold only the active one). */
  private inactiveValues = new Map<string, number>()
  private readonly queue: NrpnQueue
  private channel: number

  constructor(private readonly options: PatchSyncOptions) {
    this.channel = options.channel
    this.queue = new NrpnQueue({
      send: (bytes) => options.session.sendRaw(bytes),
      channel: () => this.channel,
      idle: () => options.session.idle(),
    })
  }

  get(): SyncState {
    return this.state
  }

  subscribe(listener: (s: SyncState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setChannel(channel: number) {
    this.channel = channel
  }

  /** Loads a stored slot on the synth and downloads it for editing. */
  async open(slot: Slot) {
    await this.task(`Loading ${slotName(slot)}`, async () => {
      this.cancelFullSend()
      this.queue.clear()
      const bytes = await this.options.session.downloadPatch(slot.bank, slot.patch)
      await this.options.session.reloadSlot(this.channel, slot.bank, slot.patch)
      this.inactiveValues.clear()
      this.update({ patch: new Patch(bytes), origin: slot, dirty: false, playing: { kind: 'slot', slot } })
    })
  }

  /**
   * Edits a patch that isn't stored on the synth (a file, the Init patch): plays it through
   * the audition slot. `dirty` says whether it counts as unwritten work from the start.
   */
  async load(patch: Patch, { dirty = true }: { dirty?: boolean } = {}) {
    this.cancelFullSend()
    this.queue.clear()
    this.inactiveValues.clear()
    this.update({ patch: patch.clone(), origin: null, dirty })
    await this.audition()
  }

  /** Sets a param, sends it live if NRPN can carry it, else schedules a whole-patch send. */
  set(key: string, value: number) {
    const patch = this.requirePatch()
    const def = param(key)
    const before = patch.get(key)
    const dependents = DEPENDENTS.get(key) ?? []
    const wasActive = new Set(dependents.filter((d) => patch.isActive(d)))
    patch.set(key, value)
    if (patch.get(key) === before) return
    const changed = [def]
    // A mode switch (BPM sync, mutant mode, FX type) gives its dependents' shared bytes
    // another meaning. The synth keeps each mode's values apart while editing: switching
    // Env 1 sync on showed attack 0, switching back restored 1.15 s (user, 2026-10-08, A4).
    // So the outgoing mode's values are kept here, the incoming mode gets what it had
    // before (0 if it never had a value since the patch was loaded), and both are sent.
    // (Changing the mode didn't touch their bytes, so they still hold the outgoing values.)
    for (const dep of wasActive) this.inactiveValues.set(dep.key, patch.get(dep.key))
    for (const dep of dependents) {
      if (!patch.isActive(dep) || wasActive.has(dep)) continue
      const v = this.inactiveValues.get(dep.key) ?? 0
      patch.set(dep.key, Math.max(dep.min, Math.min(dep.max, v)))
      changed.push(dep)
    }
    let needsFullSend = false
    for (const d of changed) {
      const msg = this.liveNrpn(d) ? encodeNrpn(d, patch.get(d.key)) : null
      if (msg) this.queue.push(d.key, msg, isLeadKey(d.key))
      else needsFullSend = true
    }
    if (needsFullSend) this.scheduleFullSend()
    this.update({ dirty: true })
  }

  setName(name: string) {
    this.requirePatch().name = name
    this.scheduleFullSend()
    this.update({ dirty: true })
  }

  setMacroName(macro: number, name: string) {
    this.requirePatch().setMacroName(macro, name)
    this.scheduleFullSend()
    this.update({ dirty: true })
  }

  /** Sends the whole patch to the audition slot now and plays it from there. */
  async audition() {
    this.cancelFullSend()
    await this.task('Sending patch', async () => {
      // Everything still queued is in the bytes about to go out.
      this.queue.clear()
      await this.queue.drained()
      const patch = this.requirePatch()
      await this.options.session.uploadToRam(AUDITION_SLOT.bank, AUDITION_SLOT.patch, patch.bytes)
      await this.options.session.reloadSlot(this.channel, AUDITION_SLOT.bank, AUDITION_SLOT.patch)
      this.update({ playing: { kind: 'audition' }, pendingFullSend: false })
    })
  }

  /** Stores the patch in a slot and saves to flash (~4 s, the synth is deaf meanwhile). */
  async write(slot: Slot) {
    this.cancelFullSend()
    await this.task(`Writing ${slotName(slot)}`, async () => {
      this.queue.clear()
      await this.queue.drained()
      await this.options.session.writePatch(slot.bank, slot.patch, this.requirePatch().bytes)
      await this.options.session.reloadSlot(this.channel, slot.bank, slot.patch)
      this.update({ origin: slot, dirty: false, playing: { kind: 'slot', slot }, pendingFullSend: false })
    })
  }

  /** Resolves when nothing is queued, scheduled or running. */
  async settled() {
    while (this.fullSendTimer || this.queue.size || this.state.busy) {
      if (this.fullSendTimer) await this.audition()
      await this.queue.drained()
      await this.options.session.idle()
    }
  }

  dispose() {
    this.cancelFullSend()
    this.queue.clear()
    this.listeners.clear()
  }

  private liveNrpn(def: ParamDef): boolean {
    return !!def.nrpn
  }

  private scheduleFullSend() {
    if (this.fullSendTimer) clearTimeout(this.fullSendTimer)
    this.fullSendTimer = setTimeout(() => {
      this.fullSendTimer = null
      this.audition().catch(() => undefined) // the error is in the state
    }, this.options.fullSendDelayMs ?? 1000)
    if (!this.state.pendingFullSend) this.update({ pendingFullSend: true })
  }

  private cancelFullSend() {
    if (this.fullSendTimer) clearTimeout(this.fullSendTimer)
    this.fullSendTimer = null
  }

  private requirePatch(): Patch {
    if (!this.state.patch) throw new Error('no patch open')
    return this.state.patch
  }

  private async task(label: string, body: () => Promise<void>) {
    this.update({ busy: label, error: null })
    try {
      await body()
      this.update({ busy: null })
    } catch (err) {
      this.update({ busy: null, error: `${label}: ${(err as Error).message}` })
      throw err
    }
  }

  private update(changes: Partial<SyncState>) {
    this.state = { ...this.state, ...changes, revision: this.state.revision + 1 }
    for (const l of this.listeners) l(this.state)
  }
}

export function slotName({ bank, patch }: Slot): string {
  return `${'ABCDEFGH'[bank]}${patch + 1}`
}
