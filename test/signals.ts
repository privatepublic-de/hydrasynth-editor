// Test signals for the audio analysis: notes with known pitch, harmonics, envelope and wobble,
// and WAV files of them.

export const RATE = 44100

/** A note of `amps` (harmonic 1, 2, ...) at `f0`, `seconds` long, shaped by `level(t)` and `cents(t)`. */
export function tone(
  f0: number,
  amps: number[],
  seconds: number,
  { level = () => 1, cents = () => 0, rate = RATE }: { level?: (t: number) => number; cents?: (t: number) => number; rate?: number } = {},
): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate))
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / rate
    let v = 0
    amps.forEach((a, k) => (v += a * Math.sin((k + 1) * phase)))
    out[i] = v * level(t)
    phase += (2 * Math.PI * f0 * 2 ** (cents(t) / 1200)) / rate
  }
  return out
}

/** A band-limited saw's harmonics, 1/k, up to `top` Hz. */
export const sawAmps = (f0: number, top = 15000) => Array.from({ length: Math.floor(top / f0) }, (_, k) => 0.5 / (k + 1))

/** White noise from a fixed seed. */
export function noise(seconds: number, rate = RATE): Float32Array {
  let s = 12345
  return Float32Array.from({ length: Math.round(seconds * rate) }, () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return (s / 0x7fffffff - 0.5) * 0.5
  })
}

/** `channels` copies of `x` as a WAV file: PCM 8/16/24/32, or float 32 (`float`), optionally extensible. */
export function wavBytes(x: Float32Array, { rate = RATE, bits = 16, float = false, channels = 1, extensible = false } = {}): Uint8Array {
  const width = bits / 8
  const fmtSize = extensible ? 40 : 16
  const dataSize = x.length * width * channels
  const buf = new ArrayBuffer(12 + 8 + fmtSize + 8 + dataSize)
  const v = new DataView(buf)
  const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)))
  text(0, 'RIFF')
  v.setUint32(4, buf.byteLength - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  v.setUint32(16, fmtSize, true)
  const format = float ? 3 : 1
  v.setUint16(20, extensible ? 0xfffe : format, true)
  v.setUint16(22, channels, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * width * channels, true)
  v.setUint16(32, width * channels, true)
  v.setUint16(34, bits, true)
  if (extensible) {
    v.setUint16(36, 22, true)
    v.setUint16(38, bits, true)
    v.setUint32(40, 0, true)
    v.setUint16(44, format, true) // sub-format GUID, first two bytes
  }
  const data = 20 + fmtSize
  text(data, 'data')
  v.setUint32(data + 4, dataSize, true)
  let at = data + 8
  for (let i = 0; i < x.length; i++)
    for (let c = 0; c < channels; c++, at += width) {
      const s = Math.max(-1, Math.min(1, x[i]))
      if (float) v.setFloat32(at, s, true)
      else if (bits === 8) v.setUint8(at, Math.round(s * 127) + 128)
      else if (bits === 16) v.setInt16(at, Math.round(s * 32767), true)
      else if (bits === 24) {
        const n = Math.round(s * 8388607)
        v.setUint8(at, n & 0xff)
        v.setUint8(at + 1, (n >> 8) & 0xff)
        v.setInt8(at + 2, n >> 16)
      } else v.setInt32(at, Math.round(s * 2147483647), true)
    }
  return new Uint8Array(buf)
}
