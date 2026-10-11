// Backup files: patches as the synth sends them in a dump -- per patch its 22 chunk messages
// (F0 00 20 2B 00 6F <base64> F7), one after another. Other tools that read Hydrasynth patch
// dumps can read the file too; restore reads it back with decodeBackup.
import { decodeMessage, encodeMessage, isHydrasynthSysex } from '../sysex/codec'
import { BANK_LETTERS, CHUNK_KIND, PATCHES_PER_BANK, PATCH_BYTES, PATCH_CHUNK_COUNT, chunkMessage, parseChunk, patchChunks } from '../sysex/protocol'

export interface StoredPatch {
  bank: number
  patch: number
  /** 2790 bytes, header included (bytes 2-3 name the slot it came from). */
  bytes: Uint8Array
}

export function encodeBackup(patches: StoredPatch[]): Uint8Array {
  const messages = patches.flatMap((p) => patchChunks(p.bytes).map((chunk, i) => encodeMessage(chunkMessage(i, CHUNK_KIND.patch, chunk))))
  const out = new Uint8Array(messages.reduce((n, m) => n + m.length, 0))
  let at = 0
  for (const m of messages) {
    out.set(m, at)
    at += m.length
  }
  return out
}

export class BackupFileError extends Error {}

/** The patches in a backup file, in file order; throws on anything that isn't one. */
export function decodeBackup(file: Uint8Array): StoredPatch[] {
  const messages: Uint8Array[] = []
  let start = -1
  for (let i = 0; i < file.length; i++) {
    if (file[i] === 0xf0) start = i
    else if (file[i] === 0xf7 && start >= 0) {
      messages.push(file.subarray(start, i + 1))
      start = -1
    }
  }
  const patches: StoredPatch[] = []
  let parts: Uint8Array[] = []
  for (const [n, m] of messages.entries()) {
    if (!isHydrasynthSysex(m)) throw new BackupFileError(`part ${n + 1} of the file isn\u2019t Hydrasynth data`)
    const { info, checksumOk } = decodeMessage(m)
    if (!checksumOk) throw new BackupFileError(`part ${n + 1} of the file is damaged (bad checksum)`)
    const chunk = parseChunk(info)
    if (!chunk || chunk.kind !== CHUNK_KIND.patch || chunk.index !== parts.length)
      throw new BackupFileError(`part ${n + 1} of the file is out of order (expected piece ${parts.length + 1} of ${PATCH_CHUNK_COUNT} of a patch)`)
    parts.push(new Uint8Array(chunk.data))
    if (parts.length === PATCH_CHUNK_COUNT) {
      const bytes = new Uint8Array(parts.reduce((t, p) => t + p.length, 0))
      let at = 0
      for (const p of parts) {
        bytes.set(p, at)
        at += p.length
      }
      if (bytes.length !== PATCH_BYTES) throw new BackupFileError(`patch ${patches.length + 1} has the wrong size (${bytes.length} bytes, not ${PATCH_BYTES})`)
      // Bytes 2-3 name the slot; restore offers it as the target, so it must be a real one.
      const [bank, patch] = [bytes[2], bytes[3]]
      if (bank >= BANK_LETTERS.length || patch >= PATCHES_PER_BANK)
        throw new BackupFileError(`patch ${patches.length + 1} names a slot the synth doesn\u2019t have (bank ${bank + 1}, patch ${patch + 1})`)
      patches.push({ bank, patch, bytes })
      parts = []
    }
  }
  if (parts.length) throw new BackupFileError(`the file ends inside a patch (${parts.length} of its ${PATCH_CHUNK_COUNT} pieces)`)
  return patches
}

export function backupFileName(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `hydrasynth-backup-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.syx`
}
