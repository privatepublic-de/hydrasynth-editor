// Read-only round-trip test: is Web MIDI reliable enough for the Hydrasynth's chunked SysEx?
import { findHydrasynth, requestWebMidi, webMidiTransport } from './midi/transport'
import { BANK_LETTERS, firmwareLabel, patchMeta, slotLabel } from './sysex/protocol'
import { HydrasynthSession, type SessionEvent } from './sysex/session'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T
const logEl = $<HTMLDivElement>('#log')
const statusEl = $<HTMLSpanElement>('#status')
const bankEl = $<HTMLSelectElement>('#bank')
const patchEl = $<HTMLInputElement>('#patch')
const rawEl = $<HTMLInputElement>('#raw')
const channelEl = $<HTMLInputElement>('#channel')

for (const [i, letter] of [...BANK_LETTERS].entries()) bankEl.add(new Option(`Bank ${letter}`, String(i)))

let session: HydrasynthSession | null = null
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

function onEvent(e: SessionEvent) {
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

const ops: Record<string, () => Promise<void>> = {
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
    statusEl.textContent = `connected: in "${ports.input.name}", out "${ports.output.name}"`
    setButtons(true)
  } catch (err) {
    statusEl.textContent = `Web MIDI failed: ${(err as Error).message}`
  }
})
