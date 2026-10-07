# hydrasynth-editor

A patch editor for the ASM Hydrasynth (Desktop first), over USB MIDI.

Status: protocol groundwork. `npm run dev` serves a probe page that tests
Web MIDI against a connected Hydrasynth (handshake, version, bank names,
patch downloads). It only reads from the synth.

- `src/sysex/codec.ts`: the SysEx envelope (base64 + CRC-32 checksum)
- `src/sysex/protocol.ts`: command bytes, chunking, patch metadata
- `src/sysex/session.ts`: request/ack/timeout flow over any `MidiTransport`
- `npm test`: codec and session tests, incl. a real dump from Edisyn

Synth settings: MIDI channel as you like, Param TX/RX = NRPN,
Program Change RX on.

See NOTICE for the reverse-engineering work this builds on (Edisyn).
