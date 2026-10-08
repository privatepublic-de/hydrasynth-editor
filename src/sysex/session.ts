import { controlChange, programChange, sleep } from '../midi/channel'
import type { MidiTransport } from '../midi/transport'
import { decodeMessage, encodeMessage, isHydrasynthSysex } from './codec'
import {
  CHUNK_KIND,
  CMD,
  NAMES_BYTES,
  PATCH_CHUNK_COUNT,
  chunkAck,
  chunkMessage,
  footer,
  handshake,
  header,
  namesRequest,
  normalizePatch,
  parseBankNames,
  parseChunk,
  patchChunks,
  patchRequest,
  versionRequest,
  writeRequest,
  type ChunkKind,
} from './protocol'

/** Saving rewrites the synth's whole flash; Edisyn measured "3 seconds or more". */
const WRITE_TIMEOUT_MS = 10_000
/** Edisyn's pause between the patches of a batch write. */
const BATCH_PATCH_PAUSE_MS = 100
/** Edisyn: nothing may reach the synth for at least 3.5 s after a write, notes included. */
export const WRITE_SETTLE_MS = 3500

export interface SessionEvent {
  dir: 'in' | 'out'
  /** ms since the session started */
  t: number
  raw: Uint8Array
  info?: Uint8Array
  checksumOk?: boolean
}

export interface SessionOptions {
  timeoutMs?: number
  onEvent?: (e: SessionEvent) => void
}

interface Waiter {
  accept: (info: Uint8Array) => boolean
  resolve: (info: Uint8Array) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class SysexTimeoutError extends Error {}

/**
 * Request/reply on top of a transport. One operation at a time: the synth's
 * header/footer pair locks its panel, so overlapping dumps make no sense.
 */
export class HydrasynthSession {
  private waiters: Waiter[] = []
  /** Replies that arrived before anything waited for them (a fast synth can answer an ack first). */
  private inbox: Uint8Array[] = []
  private unsubscribe: () => void
  private readonly start = Date.now()
  private readonly timeoutMs: number
  private busy: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly transport: MidiTransport,
    private readonly options: SessionOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 2000
    this.unsubscribe = transport.subscribe((m) => this.receive(m))
  }

  /** Channel messages from the synth (knob NRPNs, program changes); SysEx stays with the session. */
  listen(listener: (message: Uint8Array) => void): () => void {
    return this.transport.subscribe((m) => {
      if (m[0] !== 0xf0) listener(m)
    })
  }

  dispose() {
    this.unsubscribe()
    for (const w of this.waiters) {
      clearTimeout(w.timer)
      w.reject(new Error('session closed'))
    }
    this.waiters = []
  }

  /** Returns the handshake reply's info bytes (`01 00 41 3A ...`). */
  handshake(): Promise<Uint8Array> {
    return this.exclusive(() => this.request(handshake(), CMD.handshakeReply))
  }

  /** Returns the version reply's info bytes (`29 00 <version> ...`). */
  version(): Promise<Uint8Array> {
    return this.exclusive(() => this.request(versionRequest(), CMD.versionReply))
  }

  /** Reads one stored patch (bank 0-7, patch 0-127) as the concatenated chunk data. */
  downloadPatch(bank: number, patch: number): Promise<Uint8Array> {
    return this.exclusive(() =>
      this.locked(async () => {
        this.sendInfo(patchRequest(bank, patch))
        const parts: Uint8Array[] = []
        for (let i = 0; i < PATCH_CHUNK_COUNT; i++) parts.push(await this.receiveChunk(i, CHUNK_KIND.patch))
        return concat(parts)
      }),
    )
  }

  downloadBankNames(bank: number): Promise<{ bank: number; names: string[] }> {
    return this.exclusive(() =>
      this.locked(async () => {
        this.sendInfo(namesRequest(bank))
        const parts: Uint8Array[] = []
        let total = 0
        for (let i = 0; total < NAMES_BYTES; i++) {
          const part = await this.receiveChunk(i, CHUNK_KIND.names)
          parts.push(part)
          total += part.length
        }
        return parseBankNames(concat(parts))
      }),
    )
  }

  /**
   * Puts a patch into working memory at a slot, without the write request that
   * would save every patch to flash. The synth only plays it after a program
   * change away and back (see `reloadSlot`).
   */
  uploadToRam(bank: number, patch: number, data: Uint8Array): Promise<{ savedAck: boolean }> {
    return this.exclusive(() => this.locked(() => this.sendPatch(bank, patch, data)))
  }

  /**
   * Stores a patch in a slot and saves to flash. The synth rewrites all of its
   * memory, so it ignores everything for ~3.5 s afterwards; the session holds
   * its queue that long before the next operation.
   */
  writePatch(bank: number, patch: number, data: Uint8Array): Promise<{ savedAck: boolean }> {
    return this.exclusive(async () => {
      const result = await this.locked(async () => {
        const sent = await this.sendPatch(bank, patch, data)
        await this.request(writeRequest(), CMD.writeRequestReply, WRITE_TIMEOUT_MS)
        return sent
      })
      await sleep(WRITE_SETTLE_MS)
      return result
    })
  }

  /**
   * Sends several patches to their slots in working memory, then, with `flash`, one write
   * request that saves the synth's memory to flash -- only if every patch arrived and
   * `keepGoing()` still holds. Edisyn's batch: one header/footer, ~100 ms between patches,
   * one write. A failure or a stop skips the write, so flash keeps what it had.
   */
  writePatches(
    items: { bank: number; patch: number; bytes: Uint8Array }[],
    { onSent, keepGoing = () => true, flash }: { onSent?: (count: number) => void; keepGoing?: () => boolean; flash: boolean },
  ): Promise<{ sent: number; writeRequested: boolean; flashed: boolean; error?: Error }> {
    return this.exclusive(async () => {
      let sent = 0
      // Sent but unconfirmed is not "not written": the synth may have saved and the reply got lost.
      let writeRequested = false
      let flashed = false
      let error: Error | undefined
      try {
        await this.locked(async () => {
          for (const it of items) {
            if (!keepGoing()) return
            await this.sendPatch(it.bank, it.patch, it.bytes)
            sent++
            onSent?.(sent)
            await sleep(BATCH_PATCH_PAUSE_MS)
          }
          if (!flash || !keepGoing()) return
          writeRequested = true
          await this.request(writeRequest(), CMD.writeRequestReply, WRITE_TIMEOUT_MS)
          flashed = true
        })
      } catch (err) {
        error = err as Error
      }
      if (writeRequested) await sleep(WRITE_SETTLE_MS)
      return { sent, writeRequested, flashed, error }
    })
  }

  /** Resolves once every queued operation has finished. */
  idle(): Promise<void> {
    return this.busy.then(() => undefined)
  }

  private async sendPatch(bank: number, patch: number, data: Uint8Array): Promise<{ savedAck: boolean }> {
    const body = normalizePatch(data)
    body[0] = 0x06
    body[2] = bank
    body[3] = patch
    for (const [i, chunk] of patchChunks(body).entries()) {
      const ack = this.expect((m) => m[0] === CMD.chunkAck && m[2] === i && m[3] === CHUNK_KIND.patch)
      this.sendInfo(chunkMessage(i, CHUNK_KIND.patch, chunk))
      await ack
    }
    // Arrives before the last chunk's ack, so by now it is in the inbox if it came at all.
    const savedAck = this.inbox.some((m) => m[0] === CMD.patchSavedAck && m[2] === bank && m[3] === patch)
    return { savedAck }
  }

  /**
   * The synth ignores a program change to the patch it is on, so to hear a
   * re-uploaded slot: bank select, a program change away, then back.
   * Timings are Edisyn's (150 ms between, ~200 ms before playing).
   */
  reloadSlot(channel: number, bank: number, patch: number): Promise<void> {
    return this.exclusive(async () => {
      this.sendRaw(controlChange(channel, 0, 0))
      this.sendRaw(controlChange(channel, 32, bank))
      this.sendRaw(programChange(channel, patch === 0 ? 1 : 0))
      await sleep(150)
      this.sendRaw(programChange(channel, patch))
      await sleep(200)
    })
  }

  /** Plain channel messages (bank select, program change), outside the SysEx flow. */
  sendRaw(message: ArrayLike<number>) {
    const raw = Uint8Array.from(message)
    this.options.onEvent?.({ dir: 'out', t: Date.now() - this.start, raw })
    this.transport.send(raw)
  }

  private async receiveChunk(index: number, kind: ChunkKind): Promise<Uint8Array> {
    const info = await this.expect((m) => {
      const c = parseChunk(m)
      return c !== null && c.index === index && c.kind === kind
    })
    const data = new Uint8Array(parseChunk(info)!.data)
    this.sendInfo(chunkAck(index, kind))
    return data
  }

  /** Header/footer bracket. The footer is sent even after a failure: without it the panel stays locked ~20 s. */
  private async locked<T>(body: () => Promise<T>): Promise<T> {
    await this.request(header(), CMD.headerReply)
    try {
      return await body()
    } finally {
      await this.request(footer(), CMD.footerReply).catch(() => undefined)
    }
  }

  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const start = () => {
      this.inbox = []
      return op()
    }
    const run = this.busy.then(start, start)
    this.busy = run.catch(() => undefined)
    return run
  }

  private request(info: number[], replyCmd: number, timeoutMs?: number): Promise<Uint8Array> {
    const reply = this.expect((m) => m[0] === replyCmd, timeoutMs)
    this.sendInfo(info)
    return reply
  }

  private sendInfo(info: number[]) {
    const raw = encodeMessage(info)
    this.options.onEvent?.({ dir: 'out', t: Date.now() - this.start, raw, info: Uint8Array.from(info) })
    this.transport.send(raw)
  }

  private expect(accept: (info: Uint8Array) => boolean, timeoutMs = this.timeoutMs): Promise<Uint8Array> {
    const early = this.inbox.findIndex(accept)
    if (early >= 0) return Promise.resolve(this.inbox.splice(early, 1)[0])
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        accept,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter)
          reject(new SysexTimeoutError(`no reply within ${timeoutMs} ms`))
        }, timeoutMs),
      }
      this.waiters.push(waiter)
    })
  }

  private receive(raw: Uint8Array) {
    if (!isHydrasynthSysex(raw)) {
      this.options.onEvent?.({ dir: 'in', t: Date.now() - this.start, raw })
      return
    }
    let info: Uint8Array
    let checksumOk: boolean
    try {
      ;({ info, checksumOk } = decodeMessage(raw))
    } catch {
      this.options.onEvent?.({ dir: 'in', t: Date.now() - this.start, raw, checksumOk: false })
      return
    }
    this.options.onEvent?.({ dir: 'in', t: Date.now() - this.start, raw, info, checksumOk })
    if (!checksumOk) return
    const waiter = this.waiters.find((w) => w.accept(info))
    if (!waiter) {
      this.inbox.push(info)
      if (this.inbox.length > 64) this.inbox.shift()
      return
    }
    clearTimeout(waiter.timer)
    this.waiters = this.waiters.filter((w) => w !== waiter)
    waiter.resolve(info)
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let pos = 0
  for (const p of parts) {
    out.set(p, pos)
    pos += p.length
  }
  return out
}
