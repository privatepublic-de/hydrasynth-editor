import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runRestore, type RestoreItem } from '../src/library/restore'
import { decodeMessage } from '../src/sysex/codec'
import { CMD } from '../src/sysex/protocol'
import { HydrasynthSession } from '../src/sysex/session'
import { FakeHydrasynth, fixtureBytes } from './fakeSynth'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false
  const out = p.finally(() => (done = true))
  while (!done) await vi.advanceTimersByTimeAsync(50)
  return out
}

/** A patch whose name says where it came from. */
function named(name: string): Uint8Array {
  const b = fixtureBytes()
  for (let i = 0; i < 16; i++) b[9 + i] = i < name.length ? name.charCodeAt(i) : 0
  return b
}
const nameIn = (bytes: Uint8Array | undefined) => (bytes ? String.fromCharCode(...bytes.subarray(9, 25)).split('\0')[0] : undefined)

/** A synth that stops answering patch chunks after `answer` of them in the first upload batch. */
class DroppingSynth extends FakeHydrasynth {
  private chunks = 0
  constructor(private answer: number) {
    super()
  }
  override send(raw: Uint8Array) {
    if (raw[0] === 0xf0 && decodeMessage(raw).info[0] === CMD.chunk && this.answer >= 0) {
      if (this.chunks++ >= this.answer) {
        this.answer = -1 // dead for the rest of this batch, fine afterwards
        return
      }
    }
    super.send(raw)
  }
}

const bankOf = (bank: number, label: string): RestoreItem[] =>
  Array.from({ length: 128 }, (_, patch) => ({ bank, patch, bytes: named(`${label}${patch + 1}`) }))

describe('runRestore', () => {
  it('restores a bank with one flash write and checks every slot', async () => {
    const synth = new FakeHydrasynth()
    for (let p = 0; p < 128; p++) synth.slots.set(`2:${p}`, named(`Old ${p + 1}`))
    const phases = new Set<string>()
    const result = await settle(
      runRestore({ session: new HydrasynthSession(synth), items: bankOf(2, 'New '), onProgress: (p) => phases.add(p.phase) }),
    )
    expect(result).toMatchObject({ outcome: 'restored', mismatches: [] })
    expect(synth.flashWrites).toHaveLength(1)
    expect(nameIn(synth.slots.get('2:0'))).toBe('New 1')
    expect(nameIn(synth.slots.get('2:127'))).toBe('New 128')
    expect(result.previous.map((p) => nameIn(p.bytes)).slice(0, 2)).toEqual(['Old 1', 'Old 2'])
    expect([...phases]).toEqual(['reading', 'sending', 'flashing', 'verifying'])
  })

  it('restores a single patch into another slot', async () => {
    const synth = new FakeHydrasynth()
    const result = await settle(
      runRestore({ session: new HydrasynthSession(synth), items: [{ bank: 5, patch: 9, bytes: named('Moved') }], onProgress: () => undefined }),
    )
    expect(result.outcome).toBe('restored')
    expect(nameIn(synth.slots.get('5:9'))).toBe('Moved')
    expect(synth.flashWrites).toEqual(['5:9'])
  })

  it('writes nothing to flash when sending fails, and puts the previous patches back', async () => {
    const synth = new DroppingSynth(22 * 10 + 5) // dies inside the 11th patch
    for (let p = 0; p < 128; p++) synth.slots.set(`1:${p}`, named(`Old ${p + 1}`))
    const result = await settle(
      runRestore({ session: new HydrasynthSession(synth, { timeoutMs: 100 }), items: bankOf(1, 'New '), onProgress: () => undefined }),
    )
    expect(result.outcome).toBe('not-written')
    expect(result.reverted).toBe(true)
    expect(synth.flashWrites).toEqual([])
    for (const p of [0, 5, 9]) expect(nameIn(synth.slots.get(`1:${p}`))).toBe(`Old ${p + 1}`)
  })

  it('writes nothing when cancelled while sending, and reverts what was sent', async () => {
    const synth = new FakeHydrasynth()
    for (let p = 0; p < 128; p++) synth.slots.set(`0:${p}`, named(`Old ${p + 1}`))
    const controller = new AbortController()
    const result = await settle(
      runRestore({
        session: new HydrasynthSession(synth),
        items: bankOf(0, 'New '),
        signal: controller.signal,
        onProgress: (p) => p.phase === 'sending' && p.done === 20 && controller.abort(),
      }),
    )
    expect(result).toMatchObject({ outcome: 'not-written', reverted: true })
    expect(synth.flashWrites).toEqual([])
    expect(nameIn(synth.slots.get('0:4'))).toBe('Old 5')
  })

  it('never puts patches back once the flash write was asked for, even unconfirmed', async () => {
    // Saves to flash but its "done" reply gets lost.
    class Mute extends FakeHydrasynth {
      override send(raw: Uint8Array) {
        if (raw[0] === 0xf0 && decodeMessage(raw).info[0] === CMD.writeRequest) {
          this.flashWrites.push('silently')
          return
        }
        super.send(raw)
      }
    }
    const synth = new Mute()
    for (let p = 0; p < 128; p++) synth.slots.set(`4:${p}`, named(`Old ${p + 1}`))
    const result = await settle(
      runRestore({ session: new HydrasynthSession(synth, { timeoutMs: 100 }), items: bankOf(4, 'New '), onProgress: () => undefined }),
    )
    expect(result.outcome).toBe('unconfirmed')
    expect(result.mismatches).toEqual([])
    expect(result.reason).toMatch(/every slot reads back as restored/)
    expect(nameIn(synth.slots.get('4:0'))).toBe('New 1') // not reverted
  })

  it('stops checking once stopped after the flash write, and says what went unchecked', async () => {
    const synth = new FakeHydrasynth()
    const controller = new AbortController()
    const result = await settle(
      runRestore({
        session: new HydrasynthSession(synth),
        items: bankOf(2, 'New '),
        signal: controller.signal,
        onProgress: (p) => p.phase === 'verifying' && p.done === 3 && controller.abort(),
      }),
    )
    expect(result.outcome).toBe('restored')
    expect(synth.flashWrites.length).toBeGreaterThan(0)
    expect(result.mismatches).toHaveLength(125)
    expect(result.mismatches[0]).toMatch(/not checked/)
  })

  it('reports slots that read back different', async () => {
    // Stores what it's sent, then (once, at the flash) gets one byte wrong.
    class Garbling extends FakeHydrasynth {
      override send(raw: Uint8Array) {
        super.send(raw)
        if (raw[0] === 0xf0 && decodeMessage(raw).info[0] === CMD.writeRequest) this.slots.get('3:7')![9] ^= 0x20
      }
    }
    const synth = new Garbling()
    const result = await settle(
      runRestore({ session: new HydrasynthSession(synth), items: [{ bank: 3, patch: 7, bytes: named('Kept') }], onProgress: () => undefined }),
    )
    expect(result.mismatches).toEqual(['D8'])
    expect(result.differences?.D8).toEqual([expect.stringMatching(/other byte/)])
  })
  it('counts settings the synth fills in where the patch had zeros as restored', async () => {
    // Puts a default where the patch has an empty LFO step, like the real synth does.
    class Filling extends FakeHydrasynth {
      override send(raw: Uint8Array) {
        super.send(raw)
        if (raw[0] === 0xf0 && decodeMessage(raw).info[0] === CMD.writeRequest) this.slots.get('7:26')![1771] = 2
      }
    }
    const synth = new Filling()
    const bytes = named('Half init')
    bytes[1770] = bytes[1771] = 0
    const result = await settle(runRestore({ session: new HydrasynthSession(synth), items: [{ bank: 7, patch: 26, bytes }], onProgress: () => undefined }))
    expect(result).toMatchObject({ outcome: 'restored', mismatches: [] })
    expect(result.filled?.H27).toEqual([expect.stringMatching(/lfo1step9\) 0 → 512/)])
  })
})
