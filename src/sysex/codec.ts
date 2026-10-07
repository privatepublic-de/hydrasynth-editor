// The Hydrasynth's SysEx envelope (reverse engineered by Edisyn, see NOTICE):
//   F0 00 20 2B 00 6F <base64(checksum[4] + info)> F7
// checksum = the CRC-32 of info, little-endian, each byte subtracted from 0xFF.

export const SYSEX_HEADER = [0xf0, 0x00, 0x20, 0x2b, 0x00, 0x6f] as const

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const b of data) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export function checksumBytes(info: Uint8Array): Uint8Array {
  const crc = crc32(info)
  return Uint8Array.of(
    0xff - (crc & 0xff),
    0xff - ((crc >>> 8) & 0xff),
    0xff - ((crc >>> 16) & 0xff),
    0xff - ((crc >>> 24) & 0xff),
  )
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = new Int16Array(128).fill(-1)
for (let i = 0; i < B64.length; i++) B64_INDEX[B64.charCodeAt(i)] = i

// Hand-rolled rather than btoa/atob: works on byte arrays directly and in any runtime.
export function base64Encode(data: Uint8Array): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < data.length; i += 3) {
    const n = (data[i] << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0)
    const remaining = data.length - i
    out.push(B64.charCodeAt((n >>> 18) & 63), B64.charCodeAt((n >>> 12) & 63))
    out.push(remaining > 1 ? B64.charCodeAt((n >>> 6) & 63) : 0x3d)
    out.push(remaining > 2 ? B64.charCodeAt(n & 63) : 0x3d)
  }
  return Uint8Array.from(out)
}

export function base64Decode(chars: Uint8Array): Uint8Array {
  if (chars.length % 4 !== 0) throw new Error(`base64 length ${chars.length} is not a multiple of 4`)
  const out: number[] = []
  for (let i = 0; i < chars.length; i += 4) {
    let n = 0
    let pad = 0
    for (let j = 0; j < 4; j++) {
      const c = chars[i + j]
      if (c === 0x3d) {
        pad++
        n <<= 6
        continue
      }
      const v = c < 128 ? B64_INDEX[c] : -1
      if (v < 0 || pad > 0) throw new Error(`invalid base64 byte 0x${c.toString(16)} at ${i + j}`)
      n = (n << 6) | v
    }
    out.push((n >>> 16) & 0xff)
    if (pad < 2) out.push((n >>> 8) & 0xff)
    if (pad < 1) out.push(n & 0xff)
  }
  return Uint8Array.from(out)
}

export function encodeMessage(info: ArrayLike<number>): Uint8Array {
  const infoBytes = Uint8Array.from(info)
  const payload = new Uint8Array(4 + infoBytes.length)
  payload.set(checksumBytes(infoBytes), 0)
  payload.set(infoBytes, 4)
  const encoded = base64Encode(payload)
  const sysex = new Uint8Array(SYSEX_HEADER.length + encoded.length + 1)
  sysex.set(SYSEX_HEADER, 0)
  sysex.set(encoded, SYSEX_HEADER.length)
  sysex[sysex.length - 1] = 0xf7
  return sysex
}

export function isHydrasynthSysex(data: Uint8Array): boolean {
  return (
    data.length >= SYSEX_HEADER.length + 1 &&
    SYSEX_HEADER.every((b, i) => data[i] === b) &&
    data[data.length - 1] === 0xf7
  )
}

export interface DecodedMessage {
  info: Uint8Array
  checksumOk: boolean
}

export function decodeMessage(sysex: Uint8Array): DecodedMessage {
  if (!isHydrasynthSysex(sysex)) throw new Error('not a Hydrasynth SysEx message')
  const payload = base64Decode(sysex.subarray(SYSEX_HEADER.length, sysex.length - 1))
  if (payload.length < 4) throw new Error(`payload too short (${payload.length} bytes)`)
  const info = payload.slice(4)
  const expected = checksumBytes(info)
  const checksumOk = expected.every((b, i) => payload[i] === b)
  return { info, checksumOk }
}
