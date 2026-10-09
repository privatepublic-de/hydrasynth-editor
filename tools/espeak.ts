// eSpeak NG as a reference for the speech patch (src/ui/speechPatch.ts): how it says words, in
// the patch's sound codes, and how long it gives each sound. Runs tools/espeakTimings.c (built on
// first use into local/; needs `brew install espeak-ng`).
//   compare [file]   per word: our spelling (spellSounds; with DICT=1 using public/pronunciations.txt) against eSpeak's, then the words that
//                    differ and the mean length of each sound in eSpeak
//   durations [file] mean length per sound, vowels split into stressed and unstressed
// Usage: npx vite-node tools/espeak.ts compare [local/words.txt]
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { parsePronunciations, spellSounds } from '../src/ui/waveSpeech'

const HELPER = 'local/espeak-timings'

/** eSpeak's US English phoneme names (as its events give them, stress marks removed) in the patch's codes. */
const SOUNDS: Record<string, string[]> = {
  '0': ['aa'], '3': ['er'], '3:': ['er'], '@': ['ah'], '@2': ['ah'], '@L': ['ah', 'l'], 'A@': ['aa', 'r'], 'A:': ['aa'],
  E: ['eh'], I: ['ih'], 'I2': ['ih'], 'i': ['iy'], 'i:': ['iy'], 'i@': ['ih', 'r'], 'O2': ['ao'], 'O:': ['ao'], 'O@': ['ao', 'r'],
  OI: ['oy'], U: ['uh'], 'U@': ['uh', 'r'], V: ['ah'], a: ['ae'], aa: ['ae'], aI: ['ay'], aI3: ['ay', 'er'], aU: ['aw'],
  'e@': ['eh', 'r'], eI: ['ey'], 'o@': ['ao', 'r'], oU: ['ow'], 'u:': ['uw'],
  D: ['dh'], N: ['ng'], S: ['sh'], T: ['th'], Z: ['zh'], dZ: ['jh'], tS: ['ch'], j: ['y'], 't#': ['t'], t2: ['t'], 'n-': ['n'], 'l-': ['l'],
}
const SAME = new Set(['b', 'd', 'f', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'w', 'z'])

export interface Said {
  ms: number
  /** Sound codes with their eSpeak lengths (ms) and stress (vowels marked ' or , by eSpeak); '' is a word gap. */
  sounds: { sound: string; ms: number; stressed: boolean }[]
  /** eSpeak names it had no code for. */
  unknown: string[]
}

function helper(): string {
  if (!existsSync(HELPER)) {
    execFileSync('clang', ['-O2', '-I/opt/homebrew/include', '-L/opt/homebrew/lib', '-lespeak-ng', 'tools/espeakTimings.c', '-o', HELPER], { stdio: 'inherit' })
  }
  return HELPER
}

/** How eSpeak says each line. */
export function espeak(lines: string[]): Said[] {
  const run = spawnSync(helper(), { input: lines.join('\n') + '\n', encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`espeak-timings failed: ${run.stderr}`)
  return run.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const { ms, phonemes } = JSON.parse(line) as { ms: number; phonemes: [string, number, number][] }
      const sounds: Said['sounds'] = []
      const unknown: string[] = []
      for (const [name, , length] of phonemes) {
        const bare = name.replace(/^[',]+/, '')
        if (bare.startsWith('_')) {
          if (sounds.length && sounds.at(-1)!.sound !== '' && length > 0) sounds.push({ sound: '', ms: length, stressed: false })
          continue
        }
        const codes = SOUNDS[bare] ?? (SAME.has(bare) ? [bare] : null)
        if (!codes) {
          unknown.push(bare)
          continue
        }
        for (const c of codes) sounds.push({ sound: c, ms: length / codes.length, stressed: /^[',]/.test(name) })
      }
      while (sounds.at(-1)?.sound === '') sounds.pop()
      return { ms, sounds, unknown }
    })
}

const [command, file] = process.argv.slice(2)
if (command === 'compare') {
  const words = readFileSync(file ?? 'local/words.txt', 'utf8').split('\n').map((w) => w.trim()).filter(Boolean)
  const said = espeak(words)
  const dictionary = process.env.DICT ? parsePronunciations(readFileSync('public/pronunciations.txt', 'utf8')) : null
  let same = 0
  const lengths = new Map<string, number[]>()
  const unknown = new Set<string>()
  words.forEach((w, i) => {
    const theirs = said[i].sounds.map((s) => s.sound)
    const ours = spellSounds(w, dictionary)
    said[i].unknown.forEach((u) => unknown.add(u))
    for (const s of said[i].sounds) if (s.sound) lengths.set(s.sound, [...(lengths.get(s.sound) ?? []), s.ms])
    if (theirs.join(' ') === ours.join(' ')) same++
    else console.log(`${w.padEnd(14)} ours ${ours.join(' ').padEnd(26)} eSpeak ${theirs.join(' ')}`)
  })
  console.log(`\n${same} of ${words.length} words spelled the same.${unknown.size ? ` No code for: ${[...unknown].join(' ')}` : ''}`)
  console.log('\nMean length per sound in eSpeak (ms):')
  console.log(
    [...lengths]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([s, l]) => `${s} ${Math.round(l.reduce((a, b) => a + b, 0) / l.length)}`)
      .join('  '),
  )
} else if (command === 'durations') {
  const words = readFileSync(file ?? 'local/words.txt', 'utf8').split('\n').map((w) => w.trim()).filter(Boolean)
  const lengths = new Map<string, number[]>()
  for (const said of espeak(words))
    for (const s of said.sounds) {
      if (!s.sound) continue
      const key = /^[aeiou]/.test(s.sound) ? `${s.sound}${s.stressed ? "'" : ''}` : s.sound
      lengths.set(key, [...(lengths.get(key) ?? []), s.ms])
    }
  const mean = (l: number[]) => Math.round(l.reduce((a, b) => a + b, 0) / l.length)
  console.log(JSON.stringify(Object.fromEntries([...lengths].sort((a, b) => a[0].localeCompare(b[0])).map(([k, l]) => [k, [mean(l), l.length]]))))
} else {
  console.log('Usage: npx vite-node tools/espeak.ts compare|durations [words file]')
}
