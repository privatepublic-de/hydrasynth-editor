import { useEditor } from './store'

// The Desktop's Module Select section (owner's manual 2.0, p. 14): buttons on a grid of
// 9 columns x 5 rows, some on half rows, joined by the panel's signal-flow lines.
const BUTTONS: { id: string; label: string; col: number; row: number }[] = [
  { id: 'osc1', label: 'OSC 1', col: 0, row: 1 },
  { id: 'mutant1', label: 'MUTANT 1', col: 1, row: 1 },
  { id: 'mutant2', label: 'MUTANT 2', col: 2, row: 1 },
  { id: 'osc2', label: 'OSC 2', col: 0, row: 2 },
  { id: 'mutant3', label: 'MUTANT 3', col: 1, row: 2 },
  { id: 'mutant4', label: 'MUTANT 4', col: 2, row: 2 },
  { id: 'osc3', label: 'OSC 3', col: 0, row: 3 },
  { id: 'ringnoise', label: 'RING-NOISE', col: 2, row: 3 },
  { id: 'mixer', label: 'MIXER', col: 3, row: 2 },
  { id: 'filter1', label: 'FILTER 1', col: 4, row: 1.5 },
  { id: 'filter2', label: 'FILTER 2', col: 4, row: 2.5 },
  { id: 'amp', label: 'AMP', col: 5, row: 2 },
  { id: 'prefx', label: 'PRE-FX', col: 6, row: 2 },
  { id: 'delay', label: 'DELAY', col: 7, row: 1.5 },
  { id: 'reverb', label: 'REVERB', col: 7, row: 2.5 },
  { id: 'postfx', label: 'POST-FX', col: 8, row: 2 },
  ...[1, 2, 3, 4, 5].map((n) => ({ id: `env${n}`, label: `ENV ${n}`, col: n + 3, row: 0 })),
  ...[1, 2, 3, 4, 5].map((n) => ({ id: `lfo${n}`, label: `LFO ${n}`, col: n + 3, row: 4 })),
]

const COL = 100
const ROW = 34
const W = 9 * COL
const H = 5 * ROW
const x = (col: number) => col * COL + COL / 2
const y = (row: number) => row * ROW + ROW / 2

/** Polylines in grid units, as printed on the panel. */
const WIRES: [number, number][][] = [
  [[0, 1], [2, 1], [2.5, 1], [2.5, 2]],
  [[0, 2], [3, 2]],
  [[2, 3], [2.5, 3], [2.5, 2]],
  [[0, 3], [0.5, 3], [0.5, 3.55], [2.5, 3.55], [2.5, 3]],
  [[3, 2], [3.5, 2]],
  [[3.5, 1.5], [3.5, 2.5]],
  [[3.5, 1.5], [4, 1.5]],
  [[3.5, 2.5], [4, 2.5]],
  [[4, 1.5], [4, 2.5]],
  [[4, 1.5], [4.5, 1.5], [4.5, 2.5], [4, 2.5]],
  [[4.5, 2], [6, 2]],
  [[6, 2], [6.5, 2], [6.5, 1.5], [7, 1.5]],
  [[7, 1.5], [7, 2.5]],
  [[7, 2.5], [7.5, 2.5], [7.5, 2], [8, 2]],
]
const BUSES: [number, number][][] = [
  [[3.55, 0], [8.45, 0]],
  [[3.55, 4], [8.45, 4]],
]
/** Pre-wired modulation: Env 1 / LFO 1 to the filters, Env 2 / LFO 2 to the amp. */
const DOTTED: [number, number][][] = [
  [[4, 0], [4, 1.5]],
  [[4, 2.5], [4, 4]],
  [[5, 0], [5, 4]],
]

const points = (line: [number, number][]) => line.map(([c, r]) => `${x(c)},${y(r)}`).join(' ')

export function ModuleSelect() {
  const selected = useEditor((s) => s.module)
  const select = useEditor((s) => s.selectModule)
  return (
    <nav className="module-select" aria-label="Module select">
      {/* The map keeps a width its labels fit; narrower windows scroll it sideways. */}
      <div className="module-select__map">
        <svg viewBox={`0 0 ${W} ${H}`} className="module-select__wires" aria-hidden="true">
          {BUSES.map((l, i) => (
            <polyline key={`b${i}`} points={points(l)} className="wire wire--bus" />
          ))}
          {WIRES.map((l, i) => (
            <polyline key={`w${i}`} points={points(l)} className="wire" />
          ))}
          {DOTTED.map((l, i) => (
            <polyline key={`d${i}`} points={points(l)} className="wire wire--dotted" />
          ))}
        </svg>
        {BUTTONS.map((b) => (
          <button
            key={b.id}
            type="button"
            className="access-button module-select__button"
            aria-pressed={selected === b.id}
            style={{ left: `${(x(b.col) / W) * 100}%`, top: `${(y(b.row) / H) * 100}%` }}
            onClick={() => select(b.id)}
          >
            {b.label}
          </button>
        ))}
      </div>
    </nav>
  )
}
