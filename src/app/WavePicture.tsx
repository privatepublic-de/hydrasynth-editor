import type { CSSProperties } from 'react'
import { mixCycles, useWaveCycles, type WaveCycle } from '../ui/waveCycles'
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
 * A wave as recorded from the synth: its harmonic bars and one cycle, in the colours of its
 * picture, sharp at any size. Until the recordings have loaded (or for a wave without one),
 * the picture itself, without its name.
 */
export function WavePicture({ wave, ...props }: Props & { wave: number }) {
  const w = useWaveCycles()?.[wave]
  if (!w) return <img className={props.className} style={props.style} src={waveImage(wave)} alt="" draggable={false} />
  return <WaveSvg cycle={w.cycle} line={w.line} bars={w.bars} {...props} />
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
  const line = blend(a?.line ?? b!.line, b?.line ?? a!.line, a && b ? t : 0)
  const bars = Array.from({ length: 24 }, (_, k) => blend(a?.bars[k] ?? OFF, b?.bars[k] ?? OFF, t))
  return <WaveSvg cycle={cycle} line={line} bars={bars} {...props} />
}
