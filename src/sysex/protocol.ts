// Command bytes of the (decoded) info payloads. Names follow Edisyn's
// SysexEncoding.txt; meanings marked "?" there are guesses, as they are here.

export const CMD = {
  handshake: 0x00,
  handshakeReply: 0x01,
  namesRequest: 0x02,
  namesReply: 0x03,
  patchRequest: 0x04,
  patchSavedAck: 0x07,
  writeRequest: 0x14,
  writeRequestReply: 0x15,
  chunk: 0x16,
  chunkAck: 0x17,
  header: 0x18,
  headerReply: 0x19,
  footer: 0x1a,
  footerReply: 0x1b,
  versionRequest: 0x28,
  versionReply: 0x29,
} as const

/** The tag byte after the chunk index: 0x16 for patch chunks, 0x13 for bank-name chunks. */
export const CHUNK_KIND = { patch: 0x16, names: 0x13 } as const
export type ChunkKind = (typeof CHUNK_KIND)[keyof typeof CHUNK_KIND]

export const PATCH_CHUNK_COUNT = 22
export const PATCH_CHUNK_SIZE = 128
export const PATCH_BYTES = 21 * PATCH_CHUNK_SIZE + 102
/** `03 00 BANK` + 128 names of 18 bytes (16 + `00` + `:`), the last without its `:`. */
export const NAMES_BYTES = 3 + 128 * 18 - 1

export const BANK_COUNT = 8
export const PATCHES_PER_BANK = 128
export const BANK_LETTERS = 'ABCDEFGH'

export const handshake = () => [CMD.handshake, 0x00]
export const versionRequest = () => [CMD.versionRequest, 0x00]
export const header = () => [CMD.header, 0x00]
export const footer = () => [CMD.footer, 0x00]
export const writeRequest = () => [CMD.writeRequest, 0x00]
export const patchRequest = (bank: number, patch: number) => [CMD.patchRequest, 0x00, bank, patch]
export const namesRequest = (bank: number) => [CMD.namesRequest, 0x00, bank]
export const chunkAck = (index: number, kind: ChunkKind) => [CMD.chunkAck, 0x00, index, kind]

export interface Chunk {
  index: number
  kind: number
  data: Uint8Array
}

export function parseChunk(info: Uint8Array): Chunk | null {
  if (info.length < 4 || info[0] !== CMD.chunk || info[1] !== 0x00) return null
  return { index: info[2], kind: info[3], data: info.subarray(4) }
}

export function chunkMessage(index: number, kind: ChunkKind, data: Uint8Array): number[] {
  return [CMD.chunk, 0x00, index, kind, ...data]
}

/** Splits a patch into the 22 chunk payloads the synth sends and expects. */
export function patchChunks(patch: Uint8Array): Uint8Array[] {
  if (patch.length !== PATCH_BYTES) throw new Error(`patch must be ${PATCH_BYTES} bytes, got ${patch.length}`)
  const chunks: Uint8Array[] = []
  for (let i = 0; i < patch.length; i += PATCH_CHUNK_SIZE) chunks.push(patch.subarray(i, i + PATCH_CHUNK_SIZE))
  return chunks
}

/** Bank-name dump: `03 00 BANK` then 128 names of 16 bytes, each followed by `00`, separated by `:`. */
export function parseBankNames(data: Uint8Array): { bank: number; names: string[] } {
  if (data[0] !== CMD.namesReply) throw new Error(`not a names dump (starts with 0x${data[0]?.toString(16)})`)
  const bank = data[2]
  const names: string[] = []
  let pos = 3
  for (let i = 0; i < PATCHES_PER_BANK; i++) {
    names.push(asciiName(data.subarray(pos, pos + 16)))
    pos += 18
  }
  return { bank, names }
}

/**
 * 'ETCD' at 1766-1769 makes the synth read the extended block from 1770 on. Without it
 * (the Init patch has zeros, banks B/C of a factory dump 'XXXX'), LFO steps 9-64 played as 0
 * although their bytes were there (user, 2026-10-09). In a full dump of the synth no unmarked
 * patch but one all-zero slot differs from Init in the extended params or holds steps 9+
 * other than centre, so marking every send changes nothing they play.
 */
export const EXTENDED_MARKER = { offset: 1766, bytes: Uint8Array.from('ETCD', (c) => c.charCodeAt(0)) }

/**
 * Bytes 2390-2399 are five 16-bit -100s in every patch the synth stores; it
 * rewrites them on receive (seen on 2.2.0: an older "Init" in H128 came back
 * changed only there, identical from then on). Edisyn writes them too.
 * Every patch also goes out with the extended-block marker.
 */
export function normalizePatch(patch: Uint8Array): Uint8Array {
  const out = new Uint8Array(patch)
  for (let i = 2390; i < 2400; i += 2) {
    out[i] = 0x9c
    out[i + 1] = 0xff
  }
  out.set(EXTENDED_MARKER.bytes, EXTENDED_MARKER.offset)
  return out
}

export interface PatchMeta {
  bank: number
  patch: number
  version: number
  category: number
  name: string
}

export function patchMeta(patch: Uint8Array): PatchMeta {
  return {
    bank: patch[2],
    patch: patch[3],
    version: patch[4],
    category: patch[8],
    name: asciiName(patch.subarray(9, 9 + 16)),
  }
}

export function firmwareLabel(version: number): string {
  const known: Record<number, string> = { 0x9b: '1.5.5', 0xc8: '2.0.0', 0xdc: '2.2.0' }
  return known[version] ?? `unknown (0x${version.toString(16)} = ${version})`
}

export function slotLabel(bank: number, patch: number): string {
  return `${BANK_LETTERS[bank] ?? `?${bank}`}${patch + 1}`
}

function asciiName(bytes: Uint8Array): string {
  const end = bytes.indexOf(0)
  return String.fromCharCode(...(end < 0 ? bytes : bytes.subarray(0, end))).trimEnd()
}
