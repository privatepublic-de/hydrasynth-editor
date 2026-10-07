import { describe, expect, it } from 'vitest'
import { base64Decode, base64Encode, decodeMessage, encodeMessage } from '../src/sysex/codec'
import { PATCH_BYTES, chunkMessage, CHUNK_KIND, parseChunk, patchChunks, patchMeta } from '../src/sysex/protocol'
import { loadFixtureMessages } from './fixtures'

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')

describe('codec', () => {
  it('encodes the documented "request A128" example byte for byte', () => {
    // SysexEncoding.txt: INFO 04 00 00 7F -> F0 00 20 2B 00 6F "GdtjkQQAAH8=" F7
    expect(hex(encodeMessage([0x04, 0x00, 0x00, 0x7f]))).toBe(
      'F0 00 20 2B 00 6F 47 64 74 6A 6B 51 51 41 41 48 38 3D F7',
    )
  })

  it('round-trips base64 for every padding length', () => {
    for (let n = 0; n < 8; n++) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 13) & 0xff)
      expect(base64Decode(base64Encode(data))).toEqual(data)
    }
  })

  it('flags a corrupted checksum', () => {
    const msg = encodeMessage([0x18, 0x00])
    msg[6] = msg[6] === 0x41 ? 0x42 : 0x41
    expect(decodeMessage(msg).checksumOk).toBe(false)
  })
})

describe('a real patch dump (Edisyn fixture)', () => {
  const messages = loadFixtureMessages()
  const decoded = messages.map(decodeMessage)

  it('has 22 checksum-valid chunks in order', () => {
    expect(decoded).toHaveLength(22)
    decoded.forEach((d, i) => {
      expect(d.checksumOk).toBe(true)
      expect(parseChunk(d.info)).toMatchObject({ index: i, kind: CHUNK_KIND.patch })
    })
  })

  it('assembles into a patch named "Sawpressive GD"', () => {
    const patch = Uint8Array.from(decoded.flatMap((d) => [...parseChunk(d.info)!.data]))
    expect(patch.length).toBe(PATCH_BYTES)
    expect(patchMeta(patch)).toMatchObject({ bank: 0, patch: 0, version: 0x9b, name: 'Sawpressive GD' })
  })

  it('re-encodes to the identical SysEx', () => {
    const patch = Uint8Array.from(decoded.flatMap((d) => [...parseChunk(d.info)!.data]))
    patchChunks(patch).forEach((chunk, i) => {
      expect(hex(encodeMessage(chunkMessage(i, CHUNK_KIND.patch, chunk)))).toBe(hex(messages[i]))
    })
  })
})
