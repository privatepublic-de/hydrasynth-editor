// Reading a WAV file into mono samples, in the browser and the tools alike (no AudioContext, no
// node:fs): PCM 8/16/24/32-bit, float 32/64, plain or WAVE_FORMAT_EXTENSIBLE (as DAWs export),
// any channel count, mixed to mono at the file's own sample rate.

export interface Audio {
  /** Mono, -1..1. */
  samples: Float32Array
  sampleRate: number
}

const PCM = 1
const FLOAT = 3
const EXTENSIBLE = 0xfffe

/** The WAV in `buf` as mono samples; throws an Error whose message can be shown as it is. */
export function parseWav(buf: ArrayBuffer | Uint8Array): Audio {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))
  if (bytes.length < 12 || text(0) !== 'RIFF' || text(8) !== 'WAVE') throw new Error('This isn’t a WAV file')
  let format = 0
  let channels = 0
  let sampleRate = 0
  let bits = 0
  for (let pos = 12; pos + 8 <= bytes.length; ) {
    const id = text(pos)
    const size = view.getUint32(pos + 4, true)
    const body = pos + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
      // Extensible: the real format is the first two bytes of the sub-format GUID.
      if (format === EXTENSIBLE && size >= 26) format = view.getUint16(body + 24, true)
    } else if (id === 'data') {
      if (!channels) throw new Error('This WAV file has no format chunk before its data')
      if (format !== PCM && format !== FLOAT) throw new Error(`Compressed WAV files (format ${format}) aren’t supported: save it as PCM`)
      if (format === FLOAT ? bits !== 32 && bits !== 64 : ![8, 16, 24, 32].includes(bits)) throw new Error(`${bits}-bit WAV files aren’t supported`)
      const width = bits / 8
      // A data chunk cut short (a file still being written) reads as far as it goes.
      const frames = Math.floor(Math.min(size, bytes.length - body) / (width * channels))
      const read = sampleReader(view, format === FLOAT, bits)
      const samples = new Float32Array(frames)
      for (let f = 0; f < frames; f++) {
        let sum = 0
        for (let c = 0; c < channels; c++) sum += read(body + (f * channels + c) * width)
        samples[f] = sum / channels
      }
      return { samples, sampleRate }
    }
    pos = body + size + (size & 1)
  }
  throw new Error('This WAV file has no sound in it')
}

function sampleReader(view: DataView, float: boolean, bits: number): (at: number) => number {
  if (float) return bits === 32 ? (at) => view.getFloat32(at, true) : (at) => view.getFloat64(at, true)
  switch (bits) {
    case 8:
      return (at) => (view.getUint8(at) - 128) / 128 // 8-bit WAV is unsigned
    case 16:
      return (at) => view.getInt16(at, true) / 32768
    case 24:
      return (at) => ((view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)) / 8388608)
    default:
      return (at) => view.getInt32(at, true) / 2147483648
  }
}
