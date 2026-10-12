// Picks a random, seeded set of pitched samples from the Samples From Mars library for a test run of
// "Generate patch from WAV": no drum packs, kits, loops or drum hits; one file per patch folder, packs
// taken in turn so the big multisample packs don't dominate, a mid-range note (C2..C5) where the file
// name says one. Copies them to local/wav-tests/random-<seed>/<pack>-<patch>-<n>.wav with a manifest.
// Usage: npx vite-node tools/pickMarsSamples.ts [count] [seed]
import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'

const LIBRARY = '/Volumes/Peter/Sound-Archive/_Samplebank/from mars'
const DRUM_PACKS = /^(505|606|626|707|727|808|909|909 Loops|CR78|DMX|LM1|Linn60|Lindrum|Drumtrax|Drumulator|MPC60|SP1200|SDSV|SDS800|Synare|Modular Drums|Rhythm|Grooves|Found Sounds) From Mars$/
const DRUMS = /drum|loop|kick|snare|clap|cymbal|perc|cowbell|conga|shaker|cabasa|tambourin|bpm|bongo|clave|groove|\b(kits?|hits?|hats?|[oc]h|toms?|rim|crash|ride|break|bd|sd|hh)\b/i
const FORMATS = /^(Kontakt|Logic EXS|Ableton.*|Maschine|MPC.*|Docs|Battery|Reason.*|NN-XT|Ableton Live)$/i

const count = Number(process.argv[2] ?? 100)
const seed = Number(process.argv[3] ?? 1)
let state = seed
/** mulberry32: the same set for the same seed. */
function random(): number {
  state = (state + 0x6d2b79f5) | 0
  let t = Math.imul(state ^ (state >>> 15), 1 | state)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name
    if (name.startsWith('.')) continue
    const path = join(dir, name)
    if (entry.isDirectory()) {
      if (!FORMATS.test(name)) walk(path, out)
    } else if (/\.wav$/i.test(name)) out.push(path)
  }
  return out
}

const NOTES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
/** The note a file name gives (C3 = 60), or a leading MIDI number, or null. */
function noteOf(file: string): number | null {
  const name = basename(file, '.wav').replace(/\.wav$/i, '')
  const m = name.match(/(?:^|[_\s-])([A-G])(#|b)?(-?\d)(?=$|[_\s-])/)
  if (m) return 60 + (Number(m[3]) - 3) * 12 + NOTES[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0)
  const n = name.match(/^(\d{2,3})_/)
  return n ? Number(n[1]) : null
}

const slug = (s: string) => s.replace(/ From Mars.*$/, '').replace(/^\d+\.\s*/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const packs = readdirSync(LIBRARY)
  .filter((p) => !p.startsWith('.') && !DRUM_PACKS.test(p) && statSync(join(LIBRARY, p)).isDirectory())
  .map((pack) => {
    const root = readdirSync(join(LIBRARY, pack)).includes('WAV') ? join(LIBRARY, pack, 'WAV') : join(LIBRARY, pack)
    const folders = new Map<string, string[]>()
    for (const file of walk(root)) {
      if (DRUMS.test(relative(root, file))) continue
      const folder = dirname(file)
      folders.set(folder, [...(folders.get(folder) ?? []), file])
    }
    return { pack, folders: [...folders.entries()] }
  })
  .filter((p) => p.folders.length)

const out = `local/wav-tests/random-${seed}`
mkdirSync(out, { recursive: true })
const manifest: { file: string; source: string; pack: string; folder: string; note: number | null }[] = []
const used = new Set<string>()
while (manifest.length < count && packs.some((p) => p.folders.length)) {
  for (const p of packs) {
    if (manifest.length >= count || !p.folders.length) continue
    const i = Math.floor(random() * p.folders.length)
    const [folder, files] = p.folders.splice(i, 1)[0]
    const named = files.map((f) => ({ f, n: noteOf(f) }))
    const mid = named.filter(({ n }) => n !== null && n >= 48 && n <= 84)
    // Files numbered by note but none mid-range: a folder of extremes, skipped; unnamed ones taken as they come.
    if (!mid.length && named.some(({ n }) => n !== null)) continue
    const chosen = mid.length ? pick(mid) : pick(named)
    let name = `${slug(p.pack)}-${slug(basename(folder))}-${chosen.n ?? 'x'}`
    while (used.has(name)) name += '-b'
    used.add(name)
    copyFileSync(chosen.f, `${out}/${name}.wav`)
    manifest.push({ file: `${name}.wav`, source: relative(LIBRARY, chosen.f), pack: p.pack, folder: relative(LIBRARY, folder), note: chosen.n })
  }
}
writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2))
console.log(`${manifest.length} samples from ${new Set(manifest.map((m) => m.pack)).size} packs -> ${out}`)
for (const m of manifest) console.log(`  ${m.file}  <- ${m.source}`)
