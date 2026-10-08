// Turns the recordings from tools/recordWaves.ts into one clean cycle per wave, written to
// public/wave-cycles.json for the editor to draw: per wave the cycle (CYCLE points, -1..1 as
// base64 int16), its level as recorded (peak, full scale = 1; for mixing waves in their real
// proportions) and the picture's line and bar colours. Per wave: the steady middle of the held note,
// its exact period (autocorrelation, refined to a fraction of a sample), every cycle in it
// resampled onto CYCLE points and averaged (which cancels noise), then the DC blocking of the
// synth's output and the interface's input undone (it bends ramps and sags flat parts: two
// first-order high-passes at ~6 Hz, fitted on the Saw, whose ramps are straight; this takes its
// bend from 5.6 % to 0.15 %). The cycle's start and sign are
// then lined up with Thierry Rochebois Zic's picture of the wave (public/waves), so it reads the
// same way round.
// Usage: npx vite-node tools/extractCycles.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { CYCLE, PHASE_TIMING, RATE, averageCycle, cycleAt, onsetOf, period, readWav, steadyPart, unHighpass } from './waveAudio'

const WAVES = 219
const IN = 'local/wave-recordings'
/** The picture's drawn cycle, one value per column (up = positive), for lining up. */
function pictureTrace(wave: number): number[] {
  const img = PNG.sync.read(readFileSync(`public/waves/${wave}.png`))
  const ys: number[] = []
  for (let x = 8; x <= 212; x++) {
    let sum = 0
    let n = 0
    for (let y = 24; y < 96; y++) {
      const i = (y * img.width + x) * 4
      const c = Math.max(img.data[i], img.data[i + 1], img.data[i + 2]) - Math.min(img.data[i], img.data[i + 1], img.data[i + 2])
      if (c > 40) {
        sum += c * y
        n += c
      }
    }
    ys.push(n ? -sum / n : NaN)
  }
  // Fill gaps (behind the name) from the neighbours.
  for (let i = 0; i < ys.length; i++) if (Number.isNaN(ys[i])) ys[i] = ys[i - 1] ?? ys.find((v) => !Number.isNaN(v)) ?? 0
  const mean = ys.reduce((a, b) => a + b, 0) / ys.length
  return ys.map((v) => v - mean)
}

/** Rotate and maybe flip `cycle` to best match the picture. */
function lineUp(cycle: number[], picture: number[]): { cycle: number[]; shift: number; sign: number; match: number } {
  const n = picture.length
  const at = (shift: number, i: number) => cycle[Math.floor(((i / n) * CYCLE + shift) % CYCLE)]
  let best = { shift: 0, sign: 1, score: -Infinity }
  for (let shift = 0; shift < CYCLE; shift += 2) {
    let s = 0
    for (let i = 0; i < n; i++) s += at(shift, i) * picture[i]
    for (const sign of [1, -1]) if (sign * s > best.score) best = { shift, sign, score: sign * s }
  }
  const rotated = cycle.map((_, k) => best.sign * cycle[(k + best.shift) % CYCLE])
  const norm = (v: number[]) => Math.sqrt(v.reduce((a, b) => a + b * b, 0))
  const sampled = picture.map((_, i) => rotated[Math.floor((i / n) * CYCLE)])
  const match = sampled.reduce((a, v, i) => a + v * picture[i], 0) / (norm(sampled) * norm(picture) || 1)
  return { cycle: rotated, shift: best.shift, sign: best.sign, match }
}

/** The picture's colours: its line's, and each harmonic bar's (black where a bar is off). */
function pictureColours(wave: number): { line: string; bars: string[] } {
  const img = PNG.sync.read(readFileSync(`public/waves/${wave}.png`))
  const rgb = (x: number, y: number) => {
    const i = (y * img.width + x) * 4
    return [img.data[i], img.data[i + 1], img.data[i + 2]]
  }
  const hex = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
  let line = [0, 0, 0]
  let best = -1
  for (let y = 24; y < 96; y++) {
    for (let x = 8; x <= 212; x++) {
      const c = rgb(x, y)
      const chroma = Math.max(...c) - Math.min(...c)
      if (chroma > best) {
        best = chroma
        line = c
      }
    }
  }
  // Bar k spans x = 16 + 8k .. +3 at y 8..21; its right half, clear of the "x" mark some carry.
  const bars = Array.from({ length: 24 }, (_, k) => hex(rgb(16 + 8 * k + 3, 14)))
  return { line: hex(line), bars }
}

/** A cycle (-1..1) as base64 little-endian int16, the compact form the editor reads. */
function encode(cycle: number[]): string {
  const ints = new Int16Array(cycle.map((v) => Math.round(v * 32767)))
  return Buffer.from(ints.buffer).toString('base64')
}

/**
 * A wave's cycle in the synth's own phase, from its recording against the Sine
 * (tools/recordPhases.ts): turned so the Sine part starts at its upward zero crossing.
 */
function synthPhaseCycle(w: number): { cycle: number[]; p: number } | null {
  const file = `${IN}/phase-${w}.wav`
  if (!existsSync(file)) return null
  const x = readWav(file)
  const onset = onsetOf(x)
  const s = (seconds: number) => onset + Math.round(seconds * RATE)
  const p = period(x.subarray(s(0.15), s(PHASE_TIMING.sineS - 0.05)))
  const sine = cycleAt(x, p, s(0.2), s(PHASE_TIMING.sineS - 0.05))
  const wave = cycleAt(x, p, s(PHASE_TIMING.sineS + 0.25), s(PHASE_TIMING.sineS + PHASE_TIMING.waveS - 0.1))
  let shift = 0
  let best = -Infinity
  for (let k = 0; k < CYCLE; k++) {
    let score = 0
    for (let i = 0; i < CYCLE; i++) score += sine[(i + k) % CYCLE] * Math.sin((2 * Math.PI * i) / CYCLE)
    if (score > best) {
      best = score
      shift = k
    }
  }
  return { cycle: wave.map((_, i) => wave[(i + shift) % CYCLE]), p }
}

const pictures = Array.from({ length: WAVES }, (_, w) => pictureTrace(w))
const found = Array.from({ length: WAVES }, (_, w) => {
  const phased = synthPhaseCycle(w)
  if (phased) return { ...phased, phased: true }
  const file = `${IN}/${w}.wav`
  if (!existsSync(file)) return null
  // No reference recording: lined up with its picture on its own (phase and sign unknown).
  const steady = steadyPart(readWav(file))
  const p = period(steady)
  return { cycle: lineUp(unHighpass(averageCycle(steady, p), RATE / p), pictures[w]).cycle, p, phased: false }
})

// One turn and sign for all the synth-phase cycles together: the one that best matches the
// pictures overall, so the waves read the familiar way round and still mix as the synth does.
let turn = { shift: 0, sign: 1, score: -Infinity }
for (let shift = 0; shift < CYCLE; shift += 2) {
  let score = 0
  for (let w = 0; w < WAVES; w++) {
    const f = found[w]
    if (!f?.phased) continue
    const pic = pictures[w]
    let s = 0
    let norm = 0
    for (let i = 0; i < pic.length; i++) {
      const v = f.cycle[(Math.floor((i / pic.length) * CYCLE) + shift) % CYCLE]
      s += v * pic[i]
      norm += v * v
    }
    score += s / Math.sqrt(norm * pic.reduce((a, b) => a + b * b, 0) || 1)
  }
  for (const sign of [1, -1]) if (sign * score > turn.score) turn = { shift, sign, score: sign * score }
}

const cycles: ({ cycle: string; level: number; line: string; bars: string[] } | null)[] = []
const report: string[] = []
for (let w = 0; w < WAVES; w++) {
  const f = found[w]
  if (!f) {
    cycles.push(null)
    continue
  }
  const cycle = f.phased ? f.cycle.map((_, i) => turn.sign * f.cycle[(i + turn.shift) % CYCLE]) : f.cycle
  const match = lineUp(cycle, pictures[w])
  const peak = Math.max(...cycle.map(Math.abs)) || 1
  cycles.push({ cycle: encode(cycle.map((v) => v / peak)), level: Math.round(peak * 1e5) / 1e5, ...pictureColours(w) })
  const asDrawn = match.shift === 0 && match.sign === 1 ? '' : ` (the picture is drawn ${match.shift}/${CYCLE} along${match.sign < 0 ? ', flipped' : ''})`
  report.push(
    `${w}: ${f.phased ? 'synth phase' : 'picture phase'}, ${(RATE / f.p).toFixed(3)} Hz, peak ${(20 * Math.log10(peak)).toFixed(1)} dB, matches picture ${match.match.toFixed(2)}${asDrawn}`,
  )
}
writeFileSync('public/wave-cycles.json', JSON.stringify({ points: CYCLE, waves: cycles }))
console.log(`common turn ${turn.shift}/${CYCLE}${turn.sign < 0 ? ', flipped' : ''}`)
console.log(report.join('\n'))
