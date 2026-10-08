// Read-only round-trip test: is Web MIDI reliable enough for the Hydrasynth's chunked SysEx?
import { findHydrasynth, requestWebMidi, webMidiTransport } from './midi/transport'
import { BANK_LETTERS, firmwareLabel, patchMeta, slotLabel } from './sysex/protocol'
import { HydrasynthSession, type SessionEvent } from './sysex/session'
import { formatValue } from './params/display'
import { param } from './params/patch'
import { encodeNrpn, nrpnBytes } from './params/nrpn'
import { PARAMS } from './params/generated'
import { PatchSync, slotName } from './sync/patchSync'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T
const logEl = $<HTMLDivElement>('#log')
const statusEl = $<HTMLSpanElement>('#status')
const bankEl = $<HTMLSelectElement>('#bank')
const patchEl = $<HTMLInputElement>('#patch')
const rawEl = $<HTMLInputElement>('#raw')
const channelEl = $<HTMLInputElement>('#channel')

for (const [i, letter] of [...BANK_LETTERS].entries()) bankEl.add(new Option(`Bank ${letter}`, String(i)))

let session: HydrasynthSession | null = null
let sync: PatchSync | null = null
let stats = { in: 0, out: 0, badChecksum: 0, foreign: 0 }

function log(text: string, cls = '') {
  const line = document.createElement('div')
  line.textContent = text
  if (cls) line.className = cls
  logEl.append(line)
  logEl.scrollTop = logEl.scrollHeight
}

const hex = (b: Uint8Array, max = 24) =>
  [...b.subarray(0, max)].map((x) => x.toString(16).padStart(2, '0')).join(' ') + (b.length > max ? ` … (${b.length} B)` : '')

/** NRPN the synth sends back (99/98/6/38 runs), with the params that use that number. */
const incomingCc: Record<number, number> = {}
function logIncomingNrpn(raw: Uint8Array) {
  if ((raw[0] & 0xf0) !== 0xb0 || raw.length < 3) return
  incomingCc[raw[1]] = raw[2]
  if (raw[1] !== 38) return
  const p = (incomingCc[99] << 7) | incomingCc[98]
  const v = (incomingCc[6] << 7) | incomingCc[38]
  const keys = PARAMS.filter((d) => d.nrpn?.param === p).map((d) => d.key)
  const where = keys.length > 4 ? `${keys.slice(0, 4).join(', ')} +${keys.length - 4}` : keys.join(', ') || '?'
  log(`  <- synth NRPN ${p} (0x${(p >> 7).toString(16)} 0x${(p & 127).toString(16)}) = ${v} (MSB ${v >> 7}, LSB ${v & 127})  [${where}]`, 'dim')
}

function onEvent(e: SessionEvent) {
  if (e.dir === 'in' && !e.info) logIncomingNrpn(e.raw)
  stats[e.dir]++
  if (e.dir === 'in' && e.checksumOk === false) stats.badChecksum++
  if (e.dir === 'in' && !e.info && e.checksumOk === undefined) stats.foreign++
  if (!rawEl.checked) return
  const what = e.info ? `info ${hex(e.info)}` : `raw ${hex(e.raw)}`
  const flag = e.checksumOk === false ? '  CHECKSUM BAD' : ''
  log(`${String(e.t).padStart(7)} ms ${e.dir === 'in' ? '<-' : '->'} ${what}${flag}`, e.checksumOk === false ? 'bad' : 'dim')
}

async function timed<T>(label: string, op: () => Promise<T>): Promise<T | undefined> {
  stats = { in: 0, out: 0, badChecksum: 0, foreign: 0 }
  const t0 = performance.now()
  try {
    const result = await op()
    const ms = Math.round(performance.now() - t0)
    log(`✓ ${label}: ${ms} ms, ${stats.out} out / ${stats.in} in, bad checksums ${stats.badChecksum}, non-SysEx in ${stats.foreign}`, 'ok')
    return result
  } catch (err) {
    log(`✗ ${label}: ${(err as Error).message} (after ${Math.round(performance.now() - t0)} ms, ${stats.in} msgs in)`, 'bad')
    return undefined
  }
}

/** Sets params through PatchSync and says what the synth's screen should now show. */
function expectOnScreen(page: string, keys: string[]) {
  const p = sync!.get().patch!
  for (const key of keys) {
    const def = param(key)
    log(`  expect on ${page}: ${def.labels.join(' ')} = ${formatValue(def, p.get(key))}`)
  }
}

function requireOpen(): boolean {
  if (sync?.get().patch) return true
  log('Open a patch first (Live sync test: Open).', 'bad')
  return false
}

const syncOps: Record<string, () => Promise<void>> = {
  async open() {
    const slot = { bank: Number(bankEl.value), patch: Math.min(128, Math.max(1, Number(patchEl.value))) - 1 }
    await timed(`open ${slotName(slot)}`, () => sync!.open(slot))
    log(`  "${sync!.get().patch?.name}" -- the synth should now show ${slotName(slot)}`)
  },
  async cutoffLow() {
    if (!requireOpen()) return
    sync!.set('filter1cutoff', 150)
    await timed('filter 1 cutoff by NRPN', () => sync!.settled())
    expectOnScreen('FILTER 1', ['filter1cutoff'])
  },
  async cutoffHigh() {
    if (!requireOpen()) return
    sync!.set('filter1cutoff', 900)
    await timed('filter 1 cutoff by NRPN', () => sync!.settled())
    expectOnScreen('FILTER 1', ['filter1cutoff'])
  },
  async fx() {
    if (!requireOpen()) return
    sync!.set('prefxtype', 7)
    sync!.set('prefx7param1', 600)
    sync!.set('prefx7param4', 300)
    await timed('pre-FX type EQ + two EQ params by NRPN (unconfirmed encoding)', () => sync!.settled())
    expectOnScreen('PRE-FX', ['prefxtype', 'prefx7param1', 'prefx7param4'])
  },
  async bpm() {
    if (!requireOpen()) return
    const p = sync!.get().patch!
    const before = p.get('env1bpmsync')
    sync!.set('env1bpmsync', before ? 0 : 1)
    await timed(`env 1 BPM sync ${before ? 'off' : 'on'} by NRPN`, () => sync!.settled())
    const time = before ? 'env1attacksyncoff' : 'env1attacksyncon'
    expectOnScreen('ENV 1', ['env1bpmsync', time])
  },
  async modeOnly() {
    if (!requireOpen()) return
    // Only the mode NRPN, model untouched: the synth's echo shows what it does to the times itself.
    const p = sync!.get().patch!
    const next = p.get('env1bpmsync') ? 0 : 1
    p.set('env1bpmsync', next)
    log(`  model: attack raw ${p.get('env1attacksyncoff')}, decay raw ${p.get('env1decaysyncoff')} (shared bytes)`)
    const msg = encodeNrpn(param('env1bpmsync'), next)!
    await timed(`env 1 BPM sync ${next ? 'on' : 'off'}, mode NRPN only`, async () => {
      session!.sendRaw(nrpnBytes(Number(channelEl.value), msg))
      await new Promise((r) => setTimeout(r, 300))
    })
    log('  what does ENV 1 show for Attack and Decay now? (the synth NRPN lines above are its own report)')
  },
  async full() {
    if (!requireOpen()) return
    const p = sync!.get().patch!
    sync!.set('arplatch', p.get('arplatch') ? 0 : 1)
    sync!.setMacroName(1, `Probe ${Math.floor(Math.random() * 90 + 10)}`)
    log('  arp latch and macro names have no NRPN: whole-patch send to H128 in 1 s ...')
    await timed('whole-patch send to H128 + reload', () => sync!.settled())
    expectOnScreen('ARP', ['arplatch'])
    log(`  expect on MACRO 1: name = ${p.macroName(1)}`)
    log('  the synth is now on H128 (its patch name there only updates after a flash write)', 'dim')
  },
}

const ops: Record<string, () => Promise<void>> = {
  ...Object.fromEntries(Object.entries(syncOps).map(([k, f]) => [`sync-${k}`, f])),
  async handshake() {
    const r = await timed('handshake', () => session!.handshake())
    if (r) log(`  reply: ${hex(r)}  "${String.fromCharCode(...r.subarray(2).filter((c) => c >= 32))}"`)
  },
  async version() {
    const r = await timed('version', () => session!.version())
    if (r) log(`  reply: ${hex(r)}  → firmware byte ${firmwareLabel(r[2])}`)
  },
  async names() {
    const bank = Number(bankEl.value)
    const r = await timed(`names of bank ${BANK_LETTERS[bank]}`, () => session!.downloadBankNames(bank))
    if (r) r.names.forEach((n, i) => i < 16 && log(`  ${slotLabel(r.bank, i).padEnd(5)} ${n}`))
    if (r) log(`  … ${r.names.length} names`)
  },
  async patch() {
    const bank = Number(bankEl.value)
    const num = Math.min(128, Math.max(1, Number(patchEl.value))) - 1
    const p = await timed(`patch ${slotLabel(bank, num)}`, () => session!.downloadPatch(bank, num))
    if (p) {
      const m = patchMeta(p)
      log(`  "${m.name}"  ${p.length} B  slot ${slotLabel(m.bank, m.patch)}  firmware ${firmwareLabel(m.version)}  category ${m.category}`)
    }
  },
  async h128() {
    const [bank, num] = [7, 127]
    const channel = Math.min(16, Math.max(1, Number(channelEl.value)))
    const before = await timed('1. read H128', () => session!.downloadPatch(bank, num))
    if (!before) return
    log(`  "${patchMeta(before).name}"  firmware ${firmwareLabel(before[4])}  header ${hex(before, 8)}`)
    const up = await timed('2. send the same bytes to H128 (RAM only)', () => session!.uploadToRam(bank, num, before))
    if (!up) return
    log(`  "patch saved" ack (07 00 07 7F) ${up.savedAck ? 'received' : 'NOT seen'}`, up.savedAck ? '' : 'bad')
    await timed(`3. reload H128 (bank select + program change on channel ${channel})`, () =>
      session!.reloadSlot(channel, bank, num),
    )
    const after = await timed('4. read H128 again', () => session!.downloadPatch(bank, num))
    if (!after) return
    const diffs: number[] = []
    for (let i = 4; i < Math.max(before.length, after.length); i++) if (before[i] !== after[i]) diffs.push(i)
    if (before.length === after.length && diffs.length === 0)
      log(`✓ identical from byte 4 on (${after.length} B); header now ${hex(after, 8)}`, 'ok')
    else {
      log(`✗ ${diffs.length} bytes differ (lengths ${before.length}/${after.length})`, 'bad')
      for (const i of diffs.slice(0, 24))
        log(`  byte ${i}: before ${before[i]?.toString(16).padStart(2, '0')}  after ${after[i]?.toString(16).padStart(2, '0')}`)
      const start = Math.max(0, diffs[0] - 4)
      log(`  before ${start}…: ${hex(before.subarray(start), 20)}`)
      log(`  after  ${start}…: ${hex(after.subarray(start), 20)}`)
    }
    log('  The synth should now be on H128. Play a note: it should sound as before.', 'dim')
  },
  async stress() {
    const bank = Number(bankEl.value)
    let ok = 0
    const t0 = performance.now()
    for (let i = 0; i < 16; i++) {
      const p = await timed(`patch ${slotLabel(bank, i)}`, () => session!.downloadPatch(bank, i))
      if (p) {
        ok++
        log(`  "${patchMeta(p).name}"`)
      }
    }
    log(`${ok}/16 patches in ${Math.round(performance.now() - t0)} ms`, ok === 16 ? 'ok' : 'bad')
  },
}

let running = false
document.querySelectorAll<HTMLButtonElement>('[data-op]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!session || running) return
    running = true
    setButtons(false)
    try {
      await ops[btn.dataset.op!]()
    } finally {
      running = false
      setButtons(true)
    }
  })
})

function setButtons(enabled: boolean) {
  document.querySelectorAll<HTMLButtonElement>('[data-op]').forEach((b) => (b.disabled = !enabled))
}

$('#clear').addEventListener('click', () => (logEl.textContent = ''))

$('#connect').addEventListener('click', async () => {
  try {
    const access = await requestWebMidi()
    const ports = findHydrasynth(access)
    if (!ports) {
      const names = [...access.outputs.values()].map((p) => p.name).join(', ')
      statusEl.textContent = `no Hydrasynth port found (outputs: ${names || 'none'})`
      return
    }
    session?.dispose()
    session = new HydrasynthSession(webMidiTransport(ports), { onEvent, timeoutMs: 3000 })
    sync?.dispose()
    sync = new PatchSync({ session, channel: Number(channelEl.value) })
    channelEl.onchange = () => sync?.setChannel(Number(channelEl.value))
    statusEl.textContent = `connected: in "${ports.input.name}", out "${ports.output.name}"`
    setButtons(true)
  } catch (err) {
    statusEl.textContent = `Web MIDI failed: ${(err as Error).message}`
  }
})
