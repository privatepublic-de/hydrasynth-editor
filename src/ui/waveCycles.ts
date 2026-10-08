// One recorded cycle per wave (tools/recordWaves.ts + tools/extractCycles.ts, from the synth's
// output), with the line and bar colours of Thierry Rochebois Zic's picture of it (CC BY 4.0).
// Loaded once, on first use, from public/wave-cycles.json.
import { useEffect, useState } from 'react'

export interface WaveCycle {
  /** The cycle, -1..1, starting where the picture's does. */
  cycle: Float32Array
  /** Its level as recorded (peak, full scale 1): for mixing waves in their real proportions. */
  level: number
  line: string
  /** The 24 harmonic bars' colours: brighter is louder, black is off. */
  bars: string[]
}

let loaded: (WaveCycle | null)[] | null = null
let loading: Promise<(WaveCycle | null)[]> | null = null

function decode(base64: string): Float32Array {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const ints = new Int16Array(bytes.buffer)
  return Float32Array.from(ints, (v) => v / 32767)
}

export function loadWaveCycles(): Promise<(WaveCycle | null)[]> {
  loading ??= fetch(`${import.meta.env.BASE_URL}wave-cycles.json`)
    .then((r) => (r.ok ? r.json() : { waves: [] }))
    .then((data: { waves: ({ cycle: string; level: number; line: string; bars: string[] } | null)[] }) => {
      loaded = data.waves.map((w) => (w ? { cycle: decode(w.cycle), level: w.level, line: w.line, bars: w.bars } : null))
      return loaded
    })
    .catch(() => (loaded = []))
  return loading
}

/** All recorded cycles, or null while loading. */
export function useWaveCycles(): (WaveCycle | null)[] | null {
  const [, rerender] = useState(0)
  useEffect(() => {
    if (!loaded) void loadWaveCycles().then(() => rerender((n) => n + 1))
  }, [])
  return loaded
}

/** The recorded cycle of `wave`, or null while loading or if it wasn't recorded. */
export function useWaveCycle(wave: number): WaveCycle | null {
  return useWaveCycles()?.[wave] ?? null
}

/**
 * What the oscillator plays between two waves, `towards` (0..1) of the way from `a` to `b`:
 * their cycles crossfaded point by point in their recorded proportions (null: Silence), scaled
 * so either end is that wave as drawn on its own.
 */
export function mixCycles(a: WaveCycle | null, b: WaveCycle | null, towards: number): Float32Array {
  const n = (a ?? b)?.cycle.length ?? 0
  const la = (a?.level ?? 0) * (1 - towards)
  const lb = (b?.level ?? 0) * towards
  const out = new Float32Array(n)
  for (let k = 0; k < n; k++) out[k] = la * (a?.cycle[k] ?? 0) + lb * (b?.cycle[k] ?? 0)
  // Full height at the ends; in between, the mix's own size relative to that.
  const scale = (a?.level ?? b!.level) * (1 - towards) + (b?.level ?? a!.level) * towards
  for (let k = 0; k < n; k++) out[k] /= scale || 1
  return out
}
