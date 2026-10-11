import { sleep } from '../midi/channel'
import { nrpnBytes, type NrpnMessage } from '../params/nrpn'

export interface NrpnQueueOptions {
  send: (bytes: Uint8Array) => void
  channel: () => number
  /** Resolves when the synth is free (no SysEx transfer running). */
  idle: () => Promise<void>
  /** Pause after each message; the synth drops NRPN that arrives too fast (Edisyn: >= 2 ms, more after mod matrix / macros). */
  gapMs?: (key: string) => number
}

interface Pending {
  msg: NrpnMessage
  first: boolean
  seq: number
}

const defaultGap = (key: string) => (/^(modmatrix|macro)/.test(key) ? 4 : 2)

/**
 * Live parameter changes, one NRPN at a time. A param changed again before it went out
 * is sent once with its latest value (a dragged dial), and `first` params (modes the
 * other values depend on) go ahead of the rest.
 */
export class NrpnQueue {
  private pending = new Map<string, Pending>()
  private seq = 0
  private running: Promise<void> | null = null
  private readonly gap: (key: string) => number

  constructor(private readonly options: NrpnQueueOptions) {
    this.gap = options.gapMs ?? defaultGap
  }

  push(key: string, msg: NrpnMessage, first = false) {
    const old = this.pending.get(key)
    this.pending.set(key, { msg, first: first || !!old?.first, seq: old?.seq ?? this.seq++ })
    this.running ??= this.run().finally(() => (this.running = null))
  }

  /** Drops what hasn't gone out (a whole-patch send supersedes it). */
  clear() {
    this.pending.clear()
  }

  /** Resolves when everything pushed so far has been sent. */
  drained(): Promise<void> {
    return this.running ?? Promise.resolve()
  }

  get size() {
    return this.pending.size
  }

  private async run() {
    while (this.pending.size) {
      await this.options.idle()
      const next = this.next()
      if (!next) break
      const [key, { msg }] = next
      this.pending.delete(key)
      try {
        this.options.send(Uint8Array.from(nrpnBytes(this.options.channel(), msg)))
      } catch {
        // The port is gone: the rest can't go out either, and settled() mustn't wait for it.
        this.pending.clear()
        return
      }
      await sleep(this.gap(key))
    }
  }

  private next(): [string, Pending] | undefined {
    let best: [string, Pending] | undefined
    for (const entry of this.pending) {
      const [, p] = entry
      if (!best || (p.first && !best[1].first) || (p.first === best[1].first && p.seq < best[1].seq)) best = entry
    }
    return best
  }
}
