// Ways to fill an oscillator's eight-wave WaveScan list: random, or random within a character,
// using what the wave pictures show (src/ui/waveFeatures.generated.ts).
import { WAVE_FEATURES, type WaveFeatures } from './waveFeatures.generated'

export type FillStyle = 'random' | 'family' | 'morph' | 'brighten' | 'hollow' | 'ladder' | 'contrast' | 'gritty' | 'variations'

export const FILL_STYLES: { id: FillStyle; label: string; description: string }[] = [
  { id: 'random', label: 'Random', description: 'Any eight waves.' },
  { id: 'family', label: 'One family', description: 'A wave family in its own order, a natural morph.' },
  { id: 'morph', label: 'Smooth morph', description: 'Each wave close to the one before: the scan glides.' },
  { id: 'brighten', label: 'Dark to bright', description: 'Waves climbing in brightness, like opening a filter.' },
  { id: 'hollow', label: 'Hollow', description: 'Weak even harmonics: square- and clarinet-like, dark to bright.' },
  { id: 'ladder', label: 'Harmonic ladder', description: 'Single harmonics rising up the series, like organ drawbars.' },
  { id: 'contrast', label: 'Contrast', description: 'Every step a very different wave, for rhythmic or glitchy scans.' },
  { id: 'gritty', label: 'Gritty', description: 'The noisiest, most jagged waves, smooth to rough.' },
  { id: 'variations', label: 'Variations of wave 1', description: 'Keeps wave 1, adds its closest relatives.' },
]

export type Rng = () => number

/** Small seedable generator, so a fill can be repeated in tests. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WAVES = WAVE_FEATURES.length
const LIST = 8
const all = () => Array.from({ length: WAVES }, (_, i) => i)
const pick = <T,>(xs: T[], rng: Rng): T => xs[Math.floor(rng() * xs.length)]
function shuffle<T>(xs: T[], rng: Rng): T[] {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export const family = (w: number) => WAVE_FEATURES[w].name.replace(/\s*\d+$/, '')

/** Spectral centroid in harmonic numbers: 1 for a sine, higher for brighter waves. */
export function brightness(w: number): number {
  const h = WAVE_FEATURES[w].harmonics
  const sum = h.reduce((a, b) => a + b, 0)
  return sum ? h.reduce((a, v, i) => a + v * (i + 1), 0) / sum : 1
}

/** Share of the harmonics above the fundamental that is even: 0 for a square, ~0.5 for a saw. */
export function evenShare(w: number): number {
  const h = WAVE_FEATURES[w].harmonics.slice(1)
  const total = h.reduce((a, b) => a + b, 0)
  return total ? h.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0) / total : 0
}

/**
 * Odd harmonics over a real fundamental: a single-partial wave (Harmon 4) has no even/odd
 * balance to speak of, however its bars read.
 */
export function isHollow(w: number): boolean {
  const h = WAVE_FEATURES[w].harmonics
  // Under 0.3 (a saw is ~0.5) leaves 16 waves: enough to vary, all clearly odd-weighted.
  return h[0] > 0.5 && h.filter((v) => v > 0.15).length >= 3 && evenShare(w) < 0.3
}

/** Distance in harmonic content (the 24 bar levels) plus roughness. */
export function distance(a: number, b: number): number {
  const fa: WaveFeatures = WAVE_FEATURES[a]
  const fb: WaveFeatures = WAVE_FEATURES[b]
  let d = 0
  for (let i = 0; i < 24; i++) d += (fa.harmonics[i] - fb.harmonics[i]) ** 2
  return Math.sqrt(d) + Math.abs(fa.jagged - fb.jagged) * 0.3
}

/** `count` waves starting at `start`, each the nearest unused one to the previous. */
function chain(start: number, count: number, pool: number[], rng: Rng, far = false): number[] {
  const out = [start]
  const left = new Set(pool.filter((w) => w !== start))
  while (out.length < count && left.size) {
    const prev = out[out.length - 1]
    // Choose among the few best, not always the single best, so fills differ every time.
    const ranked = [...left].sort((x, y) => (far ? -1 : 1) * (distance(prev, x) - distance(prev, y)))
    const next = pick(ranked.slice(0, 3), rng)
    out.push(next)
    left.delete(next)
  }
  return out
}

/** `count` of `pool`, spread evenly over it once sorted by `key` (with a little jitter). */
function spread(pool: number[], count: number, key: (w: number) => number, rng: Rng): number[] {
  const sorted = [...pool].sort((a, b) => key(a) - key(b))
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const at = (i + 0.5 + (rng() - 0.5) * 0.8) / count
    const w = sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(at * sorted.length)))]
    if (!out.includes(w)) out.push(w)
  }
  // Rare duplicates from the jitter: top up from the rest, then keep the sort.
  for (const w of shuffle(sorted, rng)) if (out.length < count && !out.includes(w)) out.push(w)
  return out.sort((a, b) => key(a) - key(b))
}

/** Eight wave numbers (0..218) for the WaveScan list. `first` is the current wave 1. */
export function fillWavelist(style: FillStyle, rng: Rng, first = 0): number[] {
  switch (style) {
    case 'random':
      return shuffle(all(), rng).slice(0, LIST)
    case 'family': {
      const families = new Map<string, number[]>()
      for (const w of all()) families.set(family(w), [...(families.get(family(w)) ?? []), w])
      const members = pick([...families.values()].filter((m) => m.length >= 4), rng)
      if (members.length >= LIST) {
        const from = Math.floor(rng() * (members.length - LIST + 1))
        return members.slice(from, from + LIST)
      }
      // A short family continues into its nearest relatives.
      const rest = chain(members[members.length - 1], LIST - members.length + 1, all().filter((w) => !members.includes(w)), rng)
      return [...members, ...rest.slice(1)]
    }
    case 'morph':
      return chain(pick(all(), rng), LIST, all(), rng)
    case 'brighten': {
      // A bright-climbing set from one region of the wave space keeps a common character.
      const start = pick(all().filter((w) => brightness(w) < 6), rng)
      const pool = [...all()].sort((a, b) => distance(start, a) - distance(start, b)).slice(0, 48)
      return spread(pool, LIST, brightness, rng)
    }
    case 'hollow':
      return spread(all().filter(isHollow), LIST, brightness, rng)
    case 'ladder': {
      const harmon = all().filter((w) => family(w) === 'Harmon')
      return spread(harmon, LIST, (w) => Number(WAVE_FEATURES[w].name.replace(/\D/g, '')), rng)
    }
    case 'contrast':
      return chain(pick(all(), rng), LIST, all(), rng, true)
    case 'gritty': {
      const rough = [...all()].sort((a, b) => WAVE_FEATURES[b].jagged - WAVE_FEATURES[a].jagged).slice(0, 40)
      return spread(rough, LIST, (w) => WAVE_FEATURES[w].jagged, rng)
    }
    case 'variations':
      return chain(first, LIST, all(), rng)
  }
}
