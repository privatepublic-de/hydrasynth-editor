// Summarises a scoreWavPatch.ts --json run: systematic errors across many samples rather than single
// bad scores. Per category (guessed from the name: bass, lead, pad, keys, brass/strings, FX, other)
// the median signed error of each feature, how often the synth reads more/less of it, and the worst.
// Usage: npx vite-node tools/summariseScores.ts <run.jsonl>
import { readFileSync } from 'node:fs'

interface Record {
  name: string
  error?: string
  status: string
  warnings: string[]
  harmonics: number
  octaveBands: number
  spec: { timbre: number; tilt: number; evolution: number; envelope: number; bands: (number | null)[] }
  brightness: number | null
  adsr: { wav: Adsr; synth: Adsr }
  f0: { wav: number; synth: number }
  dirt: { wav: Dirt; synth: Dirt }
  vibrato: { wav: unknown; synth: unknown }
  tremolo: { wav: unknown; synth: unknown }
  movement: { wav: unknown; synth: unknown }
  second: { wav: unknown; synth: unknown }
  voices: { wav: unknown; synth: unknown }
  glide: { wav: unknown; synth: unknown }
  held: boolean
  ab: string
}
interface Adsr {
  attackS: number
  decayS: number
  sustain: number
  releaseS: number
}
interface Dirt {
  drift: number
  detune: unknown
  chorus: unknown
  noise: { db: number } | null
}

const lines = readFileSync(process.argv[2], 'utf8').trim().split('\n')
const all: Record[] = lines.map((l) => JSON.parse(l))
const failed = all.filter((r) => r.error)
const rs = all.filter((r) => !r.error)
// Bands under the note (below 0.7 x f0) hold only the recording's hum and floor: left out, timbre and
// tilt recomputed from the rest.
const THIRD_HZ = Array.from({ length: 26 }, (_, i) => 50 * 2 ** (i / 3))
for (const r of rs) {
  if (r.warnings.length) continue
  const bands = r.spec.bands.map((v, b) => (THIRD_HZ[b] < 0.7 * r.f0.wav ? null : v))
  const used = bands.map((v, b) => [b / 3, v] as [number, number | null]).filter((p): p is [number, number] => p[1] !== null)
  if (used.length < 3) continue
  const mean = used.reduce((a, [, v]) => a + v, 0) / used.length
  const xm = used.reduce((a, [x]) => a + x, 0) / used.length
  r.spec.bands = bands.map((v) => (v === null ? null : v - mean))
  r.spec.timbre = Math.sqrt(used.reduce((a, [, v]) => a + (v - mean) ** 2, 0) / used.length)
  r.spec.tilt = used.reduce((a, [x, v]) => a + (x - xm) * (v - mean), 0) / used.reduce((a, [x]) => a + (x - xm) ** 2, 0)
}

const CATEGORIES: [string, RegExp][] = [
  ['bass', /bass|sub|303|acid/i],
  ['pad', /pad|string|choir|vox|voice|drone|ensemble|vp330|ooo|ah\b|dream|atmos|warm/i],
  ['keys', /piano|pianet|clav|organ|epiano|harps|vibra|marimba|bell|keys|mallet|celest/i],
  ['brass/wind', /brass|horn|trumpet|flute|reed|sax|oboe|clarinet|breath/i],
  ['lead', /lead|saw|square|pulse|sync|whistle|solo/i],
  ['fx', /fx|zap|noise|laser|siren|alarm|bird|space|weird|glitch|chaos|bomb/i],
]
const category = (name: string) => CATEGORIES.find(([, re]) => re.test(name))?.[0] ?? 'other'

const median = (xs: number[]) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN
}
const pct = (k: number, n: number) => `${Math.round((100 * k) / Math.max(1, n))} %`
const f = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-')
const ratio = (a: number, b: number) => Math.log2(Math.max(b, 0.005) / Math.max(a, 0.005))

function report(title: string, group: Record[]) {
  if (!group.length) return
  console.log(`\n== ${title} (${group.length})`)
  const col = (label: string, xs: number[], unit = '') => console.log(`  ${label.padEnd(32)} median ${f(median(xs))}${unit}   synth more ${pct(xs.filter((v) => v > 0).length, xs.length)}`)
  console.log(`  harmonic RMS ${f(median(group.map((r) => r.harmonics)))} dB, octave bands ${f(median(group.map((r) => r.octaveBands)))} dB`)
  console.log(`  band spectrogram: timbre ${f(median(group.map((r) => r.spec.timbre)))} dB, evolution ${f(median(group.map((r) => r.spec.evolution)))} dB, level shape ${f(median(group.map((r) => r.spec.envelope)))} dB`)
  col('tilt (synth - wav, dB/oct)', group.map((r) => r.spec.tilt))
  col('brightness (log2 synth/wav)', group.map((r) => (r.brightness ? Math.log2(r.brightness) : NaN)))
  col('attack (log2 synth/wav)', group.map((r) => ratio(r.adsr.wav.attackS, r.adsr.synth.attackS)))
  col('decay (log2 synth/wav)', group.map((r) => ratio(r.adsr.wav.decayS, r.adsr.synth.decayS)))
  col('sustain (synth - wav)', group.map((r) => r.adsr.synth.sustain - r.adsr.wav.sustain))
  const released = group.filter((r) => !r.held)
  // A synth take is recorded 0.9 s past note-off: a longer release reads as held (0.3 s), so those are left out.
  col('release (log2, measurable only)', released.filter((r) => r.adsr.synth.releaseS !== 0.3).map((r) => ratio(r.adsr.wav.releaseS, r.adsr.synth.releaseS)))
  col('pitch (cents)', group.map((r) => 1200 * Math.log2(r.f0.synth / r.f0.wav)))
  col('drift (c, synth - wav)', group.map((r) => r.dirt.synth.drift - r.dirt.wav.drift))
  const noise = (d: Dirt) => d.noise?.db ?? -70
  col('noise (dB, synth - wav)', group.map((r) => noise(r.dirt.synth) - noise(r.dirt.wav)))
  const presence = (label: string, get: (r: Record) => { wav: unknown; synth: unknown }) => {
    const [w, s, both] = [group.filter((r) => get(r).wav).length, group.filter((r) => get(r).synth).length, group.filter((r) => get(r).wav && get(r).synth).length]
    if (w || s) console.log(`  ${label.padEnd(32)} wav ${w}, synth ${s}, both ${both}`)
  }
  presence('vibrato', (r) => r.vibrato)
  presence('tremolo', (r) => r.tremolo)
  presence('slow swings', (r) => r.movement)
  presence('second oscillator', (r) => r.second)
  presence('voices', (r) => r.voices)
  presence('glide', (r) => r.glide)
  presence('chorus', (r) => ({ wav: r.dirt.wav.chorus, synth: r.dirt.synth.chorus }))
  presence('detune', (r) => ({ wav: r.dirt.wav.detune, synth: r.dirt.synth.detune }))
  // The timbre difference per third octave: a band too loud or too quiet everywhere.
  const bands = Array.from({ length: 26 }, (_, b) => median(group.map((r) => r.spec.bands[b] ?? NaN)))
  console.log(`  per third octave (synth - wav, dB, 50 Hz..16 kHz):\n    ${bands.map((v) => f(v, 0)).join(' ')}`)
}

console.log(`${rs.length} scored, ${failed.length} failed`)
for (const r of failed) console.log(`  ${r.name}: ${r.error}`)
report('all', rs)
for (const [c] of [...CATEGORIES, ['other']]) report(c, rs.filter((r) => category(r.name) === c))

const worst = (label: string, key: (r: Record) => number, k = 8) => {
  console.log(`\nworst ${label}:`)
  for (const r of [...rs].sort((a, b) => key(b) - key(a)).slice(0, k)) console.log(`  ${f(key(r))}  ${r.name}  [${category(r.name)}]  ${r.status}`)
}
worst('timbre (dB)', (r) => r.spec.timbre)
worst('evolution (dB)', (r) => r.spec.evolution)
worst('level shape (dB)', (r) => r.spec.envelope)
worst('|tilt| (dB/oct)', (r) => Math.abs(r.spec.tilt))
const warned = rs.filter((r) => r.warnings.length)
if (warned.length) console.log(`\nanalysis warnings: ${warned.map((r) => `${r.name} (${r.warnings.join(', ')})`).join('; ')}`)
