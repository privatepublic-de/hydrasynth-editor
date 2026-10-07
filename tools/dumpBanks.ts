// Reads every patch of the given banks (default all) from the synth into local/patches/<bank>.bin
// (128 x 2790 bytes, as decoded). Read-only. Usage: npx vite-node tools/dumpBanks.ts [A-H...]
import { mkdirSync, writeFileSync } from 'node:fs'
import { BANK_LETTERS, PATCH_BYTES, patchMeta } from '../src/sysex/protocol'
import { HydrasynthSession } from '../src/sysex/session'
import { connectHelper } from './coremidiTransport'

const banks = (process.argv.slice(2).join('') || BANK_LETTERS).toUpperCase()
const transport = await connectHelper()
const session = new HydrasynthSession(transport, { timeoutMs: 3000 })
mkdirSync('local/patches', { recursive: true })
try {
  for (const letter of banks) {
    const bank = BANK_LETTERS.indexOf(letter)
    const out = new Uint8Array(128 * PATCH_BYTES)
    const t0 = Date.now()
    for (let n = 0; n < 128; n++) {
      const p = await session.downloadPatch(bank, n)
      if (p.length !== PATCH_BYTES) throw new Error(`${letter}${n + 1}: ${p.length} bytes`)
      out.set(p, n * PATCH_BYTES)
      if (n % 32 === 0) process.stdout.write(`${letter}${n + 1} "${patchMeta(p).name}" `)
    }
    writeFileSync(`local/patches/${letter}.bin`, out)
    console.log(`\nbank ${letter}: 128 patches in ${Date.now() - t0} ms`)
  }
} finally {
  session.dispose()
  transport.close()
}
