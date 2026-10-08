import type { Patch } from '../params/patch'

/**
 * Wave pictures by Thierry Rochebois Zic (CC BY 4.0, see public/waves/README.txt), one per wave
 * 0..218, without the wave's name (tools/stripWaveNames.ts): the editor shows it beside them.
 */
export const waveImage = (wave: number) => `${import.meta.env.BASE_URL}waves-plain/${wave}.png`

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

/**
 * What the WaveScan position plays: the wavelist entry it is on or past, the next one, and how
 * far towards the next (0..1). The picture crossfades by `towards`; each entry's share of the
 * sound is shown on its slot.
 */
export function morphAt(patch: Patch, osc: number): { from: WavelistEntry; to?: WavelistEntry; towards: number } | null {
  const list = wavelist(patch, osc)
  if (!list.length) return null
  const at = scanPosition(patch, osc, list.length)
  const i = Math.floor(at)
  return { from: list[i], to: list[i + 1], towards: list[i + 1] ? at - i : 0 }
}

/** Each sounding slot's share (0..1) at the current WaveScan position, by slot number. */
export function slotShares(patch: Patch, osc: number): Map<number, number> {
  const m = morphAt(patch, osc)
  const out = new Map<number, number>()
  if (!m) return out
  out.set(m.from.slot, 1 - m.towards)
  if (m.to && m.towards > 0) out.set(m.to.slot, m.towards)
  return out
}

/** WaveScan values (0..1024) where each sounding wave sits: entry i is at position i (1.0 = 0). */
export function entryPositions(patch: Patch, osc: number): { slot: number; value: number }[] {
  return wavelist(patch, osc).map((w, i) => ({ slot: w.slot, value: Math.round((i / 7) * 1024) }))
}
