// Turns the CMU Pronouncing Dictionary (cmudict.dict from github.com/cmusphinx/cmudict, BSD
// licence, see NOTICE) into public/pronunciations.txt for the speech patch: one word per line, its
// first pronunciation as one character per sound (src/ui/waveSpeech.ts PRONUNCIATION_CODES),
// stressed vowels (CMU stress 1 or 2) in capitals. Lines are sorted and front-coded: a leading
// digit says how many letters the word shares with the one before.
// Usage: npx vite-node tools/buildPronunciations.ts [path to cmudict.dict]
import { readFileSync, writeFileSync } from 'node:fs'
import { PRONUNCIATION_CODES } from '../src/ui/waveSpeech'

const source = process.argv[2] ?? 'local/downloads/cmudict/cmudict.dict'
const words = new Map<string, string>()
let skipped = 0
for (const line of readFileSync(source, 'utf8').split('\n')) {
  const [entry, ...rest] = line.split(' # ')[0].trim().split(/\s+/)
  if (!entry || !rest.length) continue
  // Alternative pronunciations are "word(2)"; the first is the common one.
  if (!/^[a-z']+$/.test(entry) || words.has(entry)) continue
  let code = ''
  for (const phone of rest) {
    const [, name, stress] = /^([A-Z]+)([012]?)$/.exec(phone) ?? []
    const c = PRONUNCIATION_CODES[name?.toLowerCase().replace(/^hh$/, 'h')]
    if (!c) {
      code = ''
      break
    }
    code += stress === '1' || stress === '2' ? c.toUpperCase() : c
  }
  if (code) words.set(entry, code)
  else skipped++
}

const sorted = [...words.keys()].sort()
let previous = ''
const lines = sorted.map((w) => {
  let shared = 0
  while (shared < 9 && shared < previous.length && w[shared] === previous[shared]) shared++
  previous = w
  return `${shared}${w.slice(shared)} ${words.get(w)}`
})
writeFileSync('public/pronunciations.txt', lines.join('\n') + '\n')
console.log(`${sorted.length} words (${skipped} skipped), ${(lines.join('\n').length / 1e6).toFixed(2)} MB`)
