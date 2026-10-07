/** What the session needs from MIDI: whole messages out, whole messages in. */
export interface MidiTransport {
  send(message: Uint8Array): void
  subscribe(listener: (message: Uint8Array) => void): () => void
}

export interface MidiPortPair {
  input: MIDIInput
  output: MIDIOutput
}

export async function requestWebMidi(): Promise<MIDIAccess> {
  if (!navigator.requestMIDIAccess) throw new Error('This browser has no Web MIDI')
  return navigator.requestMIDIAccess({ sysex: true })
}

export function findHydrasynth(access: MIDIAccess): MidiPortPair | null {
  const isHydra = (p: MIDIPort) => /hydrasynth/i.test(p.name ?? '')
  const input = [...access.inputs.values()].find(isHydra)
  const output = [...access.outputs.values()].find(isHydra)
  return input && output ? { input, output } : null
}

export function webMidiTransport({ input, output }: MidiPortPair): MidiTransport {
  const listeners = new Set<(message: Uint8Array) => void>()
  input.onmidimessage = (e) => {
    if (!e.data || e.data[0] >= 0xf8) return
    for (const l of listeners) l(e.data)
  }
  return {
    send: (message) => output.send(message),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
