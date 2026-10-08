import type { CSSProperties } from 'react'
import { mixCycles, useWaveCycles, type WaveCycle } from '../ui/waveCycles'
import { WAVE_FEATURES } from '../ui/waveFeatures.generated'
import { family } from '../ui/wavePopulate'
import { waveImage } from '../ui/waves'

// Drawn in the pictures' proportions (220 x 104), at twice their size.
const W = 440
const H = 208
// The pictures' bars: 24 from x = 16, 8 apart, 4 wide, y 8..21 (doubled here).
const BAR_X0 = 32
const BAR_STEP = 16
const BAR_W = 8
const BAR_TOP = 16
const BAR_H = 28
const MID = 122
const AMP = 70
const OFF = '#000000'

interface Props {
  className?: string
  style?: CSSProperties
}

function WaveSvg({ cycle, line, bars, className, style }: Props & { cycle: Float32Array; line: string; bars: string[] }) {
  const n = cycle.length
  // The cycle drawn edge to edge, its end joined back to its start.
  const points = Array.from({ length: n + 1 }, (_, k) => `${((k / n) * W).toFixed(1)},${(MID - cycle[k % n] * AMP).toFixed(1)}`).join(' ')
  return (
    <svg className={`wave-picture${className ? ` ${className}` : ''}`} style={style} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      {bars.map((fill, k) => (fill === OFF ? null : <rect key={k} x={BAR_X0 + BAR_STEP * k} y={BAR_TOP} width={BAR_W} height={BAR_H} fill={fill} />))}
      <polyline points={points} fill="none" stroke={line} className="wave-picture__line" />
    </svg>
  )
}

/**
 * Each wave family (Pulse, Horizon, Spect A, ... 38 of them) in a colour that says how bright it
 * sounds: mellow families (few upper harmonics) warm, harmonic-rich ones cool, as in "a warm
 * pad". The hues are the interface's accents: a warm arc from the pads' red through the labels'
 * orange to the root pads' yellow, a cool arc around the pads' cyan. Families are ranked by their
 * waves' mean spectral centroid (from the harmonic bars) and spread evenly over the hues; the
 * lightness alternates down the list, so neighbours stay apart. The five basic shapes are plain
 * white. A harmonic bar keeps its level as brightness.
 */
const hsl = (h: number, s: number, l: number) => {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    return Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}
/** Warm to cool: red, red-orange, orange, amber, yellow | teal, cyan, sky, light blue. */
const HUES = [2, 16, 28, 40, 50, 174, 187, 200, 212]
const shade = (hue: number, pale: boolean) => (hue < 90 ? hsl(hue, pale ? 80 : 82, pale ? 76 : 58) : hsl(hue, pale ? 60 : 62, pale ? 74 : 52))
const WHITE = '#f2efe6'
const BASIC = ['Sine', 'Triangle', 'TriSaw', 'Saw', 'Square']
export const FAMILIES = [...new Set(WAVE_FEATURES.map((_, w) => family(w)))].filter((f) => !BASIC.includes(f))

/** Level-weighted mean harmonic number of a wave's bars: higher is brighter. */
const centroid = (h: number[]) => {
  const sum = h.reduce((a, b) => a + b, 0)
  return sum ? h.reduce((a, v, k) => a + v * (k + 1), 0) / sum : 1
}
/** Families from the most mellow to the brightest, by their waves' mean centroid. */
export const BY_BRIGHTNESS = [...FAMILIES].sort((a, b) => brightness(a) - brightness(b))
function brightness(f: string) {
  const waves = WAVE_FEATURES.map((w, i) => [w, i] as const).filter(([, i]) => family(i) === f)
  return waves.reduce((a, [w]) => a + centroid(w.harmonics), 0) / waves.length
}

export const familyColour = (wave: number): string => {
  if (!WAVE_FEATURES[wave]) return WHITE
  const f = family(wave)
  const rank = BY_BRIGHTNESS.indexOf(f)
  if (rank < 0) return WHITE
  const hue = HUES[Math.round((rank / (BY_BRIGHTNESS.length - 1)) * (HUES.length - 1))]
  return shade(hue, FAMILIES.indexOf(f) % 2 === 1)
}

function inPalette(wave: number, w: WaveCycle): { line: string; bars: string[] } {
  const colour = familyColour(wave)
  const bars = w.bars.map((b) => {
    const level = Math.max(...rgb(b)) / 255
    return level < 0.08 ? OFF : scale(colour, level)
  })
  return { line: colour, bars }
}

const scale = (hex: string, level: number) =>
  `#${rgb(hex)
    .map((v) => Math.round(v * level).toString(16).padStart(2, '0'))
    .join('')}`

/**
 * A wave as recorded from the synth: its harmonic bars and one cycle, in its family's colour
 * (see familyColour), sharp at any size. Until the recordings have loaded (or for a wave without one),
 * the picture itself, without its name.
 */
export function WavePicture({ wave, ...props }: Props & { wave: number }) {
  const w = useWaveCycles()?.[wave]
  if (!w) return <img className={props.className} style={props.style} src={waveImage(wave)} alt="" draggable={false} />
  return <WaveSvg cycle={w.cycle} {...inPalette(wave, w)} {...props} />
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const blend = (a: string, b: string, t: number) =>
  `#${rgb(a)
    .map((v, i) => Math.round(v + (rgb(b)[i] - v) * t).toString(16).padStart(2, '0'))
    .join('')}`

/**
 * WaveScan between two waves as an oscilloscope would show it: the cycles mixed point by point
 * at the scan position (see mixCycles), the bars and colour blended alongside. 'silence' is
 * nothing. Null while the recordings load.
 */
export function WaveMorphPicture({
  from,
  to,
  towards,
  ...props
}: Props & { from: number | 'silence'; to?: number | 'silence'; towards: number }) {
  const all = useWaveCycles()
  if (!all) return null
  const pick = (w: number | 'silence' | undefined): WaveCycle | null => (typeof w === 'number' ? (all[w] ?? null) : null)
  const a = pick(from)
  const b = to === undefined ? a : pick(to)
  const t = to === undefined ? 0 : towards
  if (!a && !b) return null
  const cycle = mixCycles(a, b, t)
  const pa = a && inPalette(from as number, a)
  const pb = b && inPalette((to ?? from) as number, b)
  const line = blend(pa?.line ?? pb!.line, pb?.line ?? pa!.line, a && b ? t : 0)
  const bars = Array.from({ length: 24 }, (_, k) => blend(pa?.bars[k] ?? OFF, pb?.bars[k] ?? OFF, t))
  return <WaveSvg cycle={cycle} line={line} bars={bars} {...props} />
}
