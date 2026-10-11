// Writes patches from a backup into slots on the synth, flash included -- carefully:
//  1. read what the target slots hold now (kept, so it can be saved and to undo a failed run);
//  2. send every patch to working memory, then one write request saves to flash, only if all
//     of them arrived and nobody cancelled;
//  3. if they weren't flashed, put the previous patches back into working memory, so the
//     synth is as it was (a later write anywhere would otherwise save the half-restored set);
//  4. after a flash, read every target back and compare.
import { PARAMS } from '../params/generated'
import { BANK_LETTERS, normalizePatch } from '../sysex/protocol'
import type { HydrasynthSession } from '../sysex/session'
import type { StoredPatch } from './backupFile'

export interface RestoreItem {
  /** Where it goes on the synth. */
  bank: number
  patch: number
  bytes: Uint8Array
}

export type RestorePhase = 'reading' | 'sending' | 'flashing' | 'reverting' | 'verifying'

export interface RestoreProgress {
  phase: RestorePhase
  done: number
  total: number
}

export interface RestoreResult {
  /**
   * restored: flashed and checked; not-written: flash untouched (cancelled or failed before the
   * write); unconfirmed: the write was asked for but never confirmed -- the slots were read
   * back, `mismatches` says which don't hold the restored patch.
   */
  outcome: 'restored' | 'not-written' | 'unconfirmed'
  /** What the target slots held before (saved to a file on request). */
  previous: StoredPatch[]
  /** Slots that read back different from what was written. */
  mismatches: string[]
  /** Slots not read back because the run was stopped (the port went away) while checking. */
  unchecked?: string[]
  /** Per mismatching slot: what reads back different, e.g. "Arp Swing 0 → 50". */
  differences?: Record<string, string[]>
  /**
   * Slots that read back with settings filled in that the patch had empty (zero): the synth
   * puts its defaults there -- seen with half-initialised old slots. Counted as restored.
   */
  filled?: Record<string, string[]>
  /** A cancel, or what failed. */
  reason?: string
  /** After a run that wasn't flashed: whether working memory got the previous patches back. */
  reverted?: boolean
}

export const slotLabel = (bank: number, patch: number) => `${BANK_LETTERS[bank]}${patch + 1}`

/** Bytes 0-7 are the dump's header (command, slot, version); the patch is the rest. */
const samePatch = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => i < 8 || v === b[i])
/** `back` differs from `sent` only where `sent` had zeros: the synth filled in defaults. */
const onlyFilled = (sent: Uint8Array, back: Uint8Array) => sent.length === back.length && sent.every((v, i) => i < 8 || v === back[i] || v === 0)

/** The settings that differ between what was sent and what reads back. */
export function patchDifferences(sent: Uint8Array, back: Uint8Array): string[] {
  const out: string[] = []
  const covered = new Set<number>()
  for (const p of PARAMS) {
    const f = p.field
    if (!f) continue
    for (let i = 0; i < f.size; i++) covered.add(f.offset + i)
    let differs = false
    for (let i = 0; i < f.size; i++) differs ||= sent[f.offset + i] !== back[f.offset + i]
    if (!differs) continue
    const value = (b: Uint8Array) => (f.size === 2 ? b[f.offset] | (b[f.offset + 1] << 8) : b[f.offset])
    out.push(`${p.labels.join(' ')} (${p.key}) ${value(sent)} → ${value(back)}`)
  }
  const other = [...Array(sent.length).keys()].filter((i) => i >= 8 && !covered.has(i) && sent[i] !== back[i])
  if (other.length) out.push(`${other.length} other ${other.length === 1 ? 'byte' : 'bytes'} at ${other.slice(0, 6).join(', ')}${other.length > 6 ? '…' : ''}`)
  return out
}

export async function runRestore({
  session,
  items,
  signal,
  onProgress,
}: {
  session: HydrasynthSession
  items: RestoreItem[]
  signal?: AbortSignal
  onProgress: (p: RestoreProgress) => void
}): Promise<RestoreResult> {
  const total = items.length
  const previous: StoredPatch[] = []
  const notWritten = (reason: string, reverted?: boolean): RestoreResult => ({ outcome: 'not-written', previous, mismatches: [], reason, reverted })

  for (const it of items) {
    onProgress({ phase: 'reading', done: previous.length, total })
    if (signal?.aborted) return notWritten('Cancelled before anything was sent.')
    try {
      previous.push({ bank: it.bank, patch: it.patch, bytes: await session.downloadPatch(it.bank, it.patch) })
    } catch (err) {
      return notWritten(`Couldn’t read ${slotLabel(it.bank, it.patch)} first: ${(err as Error).message}. Nothing was sent.`)
    }
  }

  onProgress({ phase: 'sending', done: 0, total })
  const result = await session.writePatches(items, {
    onSent: (n) => onProgress({ phase: n === total ? 'flashing' : 'sending', done: n, total }),
    keepGoing: () => !signal?.aborted,
    flash: true,
  })

  if (!result.flashed && !result.writeRequested) {
    const why = result.error ? `Sending failed: ${result.error.message}.` : 'Cancelled.'
    if (result.sent === 0) return notWritten(`${why} Nothing was written.`)
    onProgress({ phase: 'reverting', done: 0, total: result.sent })
    const back = await session.writePatches(previous.slice(0, result.sent), {
      onSent: (n) => onProgress({ phase: 'reverting', done: n, total: result.sent }),
      flash: false,
    })
    const reverted = back.sent === result.sent && !back.error
    return notWritten(
      reverted
        ? `${why} Nothing was written to flash memory, and the synth’s working memory has the previous patches back.`
        : `${why} Nothing was written to flash memory, but putting the previous patches back into working memory failed: switch the synth off and on to discard the ${result.sent} sent.`,
      reverted,
    )
  }

  const mismatches: string[] = []
  const differences: Record<string, string[]> = {}
  const filled: Record<string, string[]> = {}
  const unchecked: string[] = []
  for (const [i, it] of items.entries()) {
    onProgress({ phase: 'verifying', done: i, total })
    // Stopped (the port went away): the rest is unchecked, not wrong.
    if (signal?.aborted) {
      unchecked.push(...items.slice(i).map((x) => slotLabel(x.bank, x.patch)))
      break
    }
    try {
      const back = await session.downloadPatch(it.bank, it.patch)
      const sent = normalizePatch(it.bytes)
      if (samePatch(back, sent)) continue
      if (onlyFilled(sent, back)) filled[slotLabel(it.bank, it.patch)] = patchDifferences(sent, back)
      else {
        mismatches.push(slotLabel(it.bank, it.patch))
        differences[slotLabel(it.bank, it.patch)] = patchDifferences(sent, back)
      }
    } catch {
      mismatches.push(`${slotLabel(it.bank, it.patch)} (couldn’t read it back)`)
    }
  }
  onProgress({ phase: 'verifying', done: total, total })
  if (!result.flashed) {
    // Nothing is put back here: flash may already hold the new patches.
    return {
      outcome: 'unconfirmed',
      previous,
      mismatches,
      differences,
      filled,
      reason: mismatches.length
        ? `The synth didn’t confirm writing to flash memory (${result.error?.message ?? 'no reply'}), and ${mismatches.length === 1 ? 'one slot doesn’t' : `${mismatches.length} slots don’t`} hold the restored patch: ${mismatches.slice(0, 8).join(', ')}.`
        : unchecked.length
          ? `The synth didn’t confirm writing to flash memory (${result.error?.message ?? 'no reply'}), and the check stopped before ${unchecked.length === 1 ? 'one slot' : `${unchecked.length} slots`}: ${unchecked.slice(0, 8).join(', ')}${unchecked.length > 8 ? '…' : ''}.`
          : `The synth didn’t confirm writing to flash memory (${result.error?.message ?? 'no reply'}), but every slot reads back as restored.`,
      unchecked,
    }
  }
  return { outcome: 'restored', previous, mismatches, differences, filled, unchecked }
}
