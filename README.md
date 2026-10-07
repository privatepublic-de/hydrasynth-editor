# hydrasynth-editor

A patch editor for the ASM Hydrasynth (Desktop first), over USB MIDI.

Status: protocol groundwork. `npm run dev` serves a probe page that tests
Web MIDI against a connected Hydrasynth (handshake, version, bank names,
patch downloads). It only reads from the synth.

- `src/sysex/codec.ts`: the SysEx envelope (base64 + CRC-32 checksum)
- `src/sysex/protocol.ts`: command bytes, chunking, patch metadata
- `src/sysex/session.ts`: request/ack/timeout flow over any `MidiTransport`
- `src/params/`: the parameter model. A `Patch` is the synth's 2790 bytes; each of
  ~1,140 params is a view onto them (offset, size, mode condition, range, display, NRPN).
  `generated.ts` is built from Edisyn's driver, see `tools/edisyn-extract/`.
- `npm test`: codec, session and schema tests. With `local/patches` (`tools/dumpBanks.ts`)
  and `local/extract` (`tools/edisyn-extract/run.sh`) present, also checks every param of
  every dumped patch and every NRPN value against Edisyn itself.

See `docs/PLAN.md` for the plan, findings and open questions.

Synth settings: MIDI channel as you like, Param TX/RX = NRPN,
Program Change RX on.

See NOTICE for the reverse-engineering work this builds on (Edisyn).
