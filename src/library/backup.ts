// Reads stored patches from the synth for a backup: read-only, one patch at a time, with a
// pause after each bank and retries, since a long run of dumps once made the synth's USB MIDI
// port vanish (after ~645 patches back to back). A stopped run keeps what it has, and a new
// run with `have` reads only the rest.
import { sleep } from '../midi/channel'
import { BANK_LETTERS, PATCHES_PER_BANK } from '../sysex/protocol'
import type { HydrasynthSession } from '../sysex/session'
import type { StoredPatch } from './backupFile'

export const slotKey = (bank: number, patch: number) => `${bank}:${patch}`

export interface BackupProgress {
  done: number
  total: number
  bank: number
  patch: number
  retries: number
}

export interface BackupOptions {
  session: HydrasynthSession
  banks: number[]
  /** Patches already read (a resumed run skips them); new ones are added to it. */
  have: Map<string, StoredPatch>
  onProgress: (p: BackupProgress) => void
  signal?: AbortSignal
  attempts?: number
  bankPauseMs?: number
  retryPauseMs?: number
}

export interface BackupResult {
  /** Why the run stopped early; absent when every requested patch was read. */
  stopped?: string
  retries: number
}

export async function runBackup(o: BackupOptions): Promise<BackupResult> {
  const attempts = o.attempts ?? 3
  const total = o.banks.length * PATCHES_PER_BANK
  let retries = 0
  const done = () => o.banks.reduce((n, b) => n + [...Array(PATCHES_PER_BANK).keys()].filter((p) => o.have.has(slotKey(b, p))).length, 0)

  for (const [bi, bank] of o.banks.entries()) {
    let readInThisBank = false
    for (let patch = 0; patch < PATCHES_PER_BANK; patch++) {
      if (o.have.has(slotKey(bank, patch))) continue
      o.onProgress({ done: done(), total, bank, patch, retries })
      if (o.signal?.aborted) return { stopped: 'Cancelled.', retries }
      for (let attempt = 1; ; attempt++) {
        try {
          const bytes = await o.session.downloadPatch(bank, patch)
          o.have.set(slotKey(bank, patch), { bank, patch, bytes })
          readInThisBank = true
          break
        } catch (err) {
          if (attempt >= attempts) {
            return { stopped: `${BANK_LETTERS[bank]}${patch + 1} didn’t come through after ${attempts} tries (${(err as Error).message}).`, retries }
          }
          retries++
          await sleep(o.retryPauseMs ?? 1000)
        }
      }
    }
    if (readInThisBank && bi < o.banks.length - 1) await sleep(o.bankPauseMs ?? 1500)
  }
  o.onProgress({ done: done(), total, bank: o.banks.at(-1) ?? 0, patch: PATCHES_PER_BANK - 1, retries })
  return { retries }
}

/** The patches of `banks` in slot order, for the file. */
export function inSlotOrder(have: Map<string, StoredPatch>, banks: number[]): StoredPatch[] {
  return banks.flatMap((b) => [...Array(PATCHES_PER_BANK).keys()].map((p) => have.get(slotKey(b, p))).filter((p): p is StoredPatch => !!p))
}
