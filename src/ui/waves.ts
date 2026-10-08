import type { Patch } from '../params/patch'

/** Wave pictures by Thierry Rochebois Zic (CC BY 4.0, see public/waves/README.txt), one per wave 0..218. */
export const waveImage = (wave: number) => `${import.meta.env.BASE_URL}waves/${wave}.png`

/**
 * The wave a param's value selects, 'silence', or null for Off (and for keys that aren't
 * waves). Wavelist slot 1 holds a wave number like the Single-mode wave; slots 2-8 put Off
 * and Silence ahead of the waves.
 */
export function waveOf(key: string, value: number): number | 'silence' | null {
  if (/^osc\d(type|wavscanwave1)$/.test(key)) return value
  if (/^osc\dwavscanwave[2-8]$/.test(key)) return value >= 2 ? value - 2 : value === 1 ? 'silence' : null
  return null
}

export const isWaveKey = (key: string) => /^osc\d(type|wavscanwave\d)$/.test(key)

export interface WavelistEntry {
  slot: number
  wave: number | 'silence'
}

/** The wavelist as the synth scans it: Off slots drop out (a later wave moves up into their place). */
export function wavelist(patch: Patch, osc: number): WavelistEntry[] {
  const out: WavelistEntry[] = []
  for (let slot = 1; slot <= 8; slot++) {
    const key = `osc${osc}wavscanwave${slot}`
    const wave = waveOf(key, patch.get(key))
    if (wave !== null) out.push({ slot, wave })
  }
  return out
}

/** Index into `wavelist` nearest the WaveScan position (0..1024 = positions 1.0 .. 8.0). */
export function scanPosition(patch: Patch, osc: number, length: number): number {
  return Math.min((patch.get(`osc${osc}wavscan`) / 1024) * 7, Math.max(0, length - 1))
}

/** The wavelist entry shown large: the picked slot while it's in the list, else the one nearest the scan position. */
export function shownEntry(patch: Patch, osc: number, picked: number | undefined): WavelistEntry | undefined {
  const list = wavelist(patch, osc)
  return list.find((w) => w.slot === picked) ?? list[Math.round(scanPosition(patch, osc, list.length))]
}
