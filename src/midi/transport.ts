/** What the session needs from MIDI: whole messages out, whole messages in. */
export interface MidiTransport {
  send(message: Uint8Array): void
  subscribe(listener: (message: Uint8Array) => void): () => void
}

export interface MidiPortPair {
  input: MIDIInput
  output: MIDIOutput
}

/** Why this page can't use Web MIDI at all, or null when it can (permission is asked later, on Connect). */
export function webMidiUnavailable(): string | null {
  if ('requestMIDIAccess' in navigator) return null
  // Browsers only offer Web MIDI on secure pages: a file opened from disk or a plain-http host has none.
  if (!window.isSecureContext) return 'Web MIDI needs the served page: open the editor with the start script, not from disk.'
  return "This browser doesn't support Web MIDI. Use Firefox, Chrome or Edge."
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
    // A port that has gone throws on send; its replies time out instead (the store says it's gone).
    send: (message) => {
      if (output.state === 'connected') output.send(message)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
