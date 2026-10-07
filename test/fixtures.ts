import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** "Sawpressive GD" (A1, firmware 1.5.5) as the synth sends it: 22 messages, one per line, hex. From Edisyn's Decode.java. */
export function loadFixtureMessages(): Uint8Array[] {
  const text = readFileSync(fileURLToPath(new URL('./fixtures/sawexpressive.syx.hex', import.meta.url)), 'utf8')
  return text
    .trim()
    .split('\n')
    .map((line) => Uint8Array.from(line.trim().split(/\s+/).map((h) => parseInt(h, 16))))
}
