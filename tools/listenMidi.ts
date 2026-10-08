// Listens to the synth's MIDI output and logs what arrives, decoding NRPN (CC 99/98/6/38) and
// naming the params each one could be. Sends nothing. Usage: npx vite-node tools/listenMidi.ts [seconds]
import { writeFileSync } from 'node:fs'
import { PARAM_BY_KEY } from '../src/params/patch'
import { connectHelper } from './coremidiTransport'

const seconds = Number(process.argv[2] ?? 60)
const transport = await connectHelper()
const t0 = Date.now()
const log: string[] = []
const cc: Record<number, number> = {}
const out = (line: string) => {
  log.push(line)
  console.log(line)
}
const candidates = (param: number, value: number) =>
  [...PARAM_BY_KEY.values()]
    .filter((d) => d.nrpn?.param === param)
    .map((d) => {
      const s = d.nrpn!
      if ('table' in s) return d.key
      const v = (value - s.base) / s.mul
      return v >= d.min && v <= d.max ? `${d.key}=${v}` : null
    })
    .filter(Boolean)
    .slice(0, 6)
    .join(' ')
transport.subscribe((m) => {
  const t = ((Date.now() - t0) / 1000).toFixed(3)
  const hex = [...m].map((b) => b.toString(16).padStart(2, '0')).join(' ')
  if ((m[0] & 0xf0) === 0xb0) {
    cc[m[1]] = m[2]
    if (m[1] === 38 || m[1] === 6) {
      const param = (cc[99] << 7) | cc[98]
      const value = (cc[6] << 7) | (m[1] === 38 ? m[2] : (cc[38] ?? 0))
      out(`${t} ch${(m[0] & 15) + 1} CC${m[1]} -> NRPN ${param} = ${value}  [${candidates(param, value)}]`)
      return
    }
  }
  out(`${t} ${hex}`)
})
await new Promise((r) => setTimeout(r, seconds * 1000))
writeFileSync('local/midi-listen.log', log.join('\n') + '\n')
console.log(`${log.length} messages, saved to local/midi-listen.log`)
transport.close()
