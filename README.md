# hydrasynth-editor

A patch editor for the ASM Hydrasynth (Desktop first), over USB MIDI.

## Running it

Web MIDI only works on a served page, not on a file opened from disk, so the editor
runs from a small local server. It needs [Node.js](https://nodejs.org).

Double-click the launcher for your system in `start/`:

- macOS: `start-macos.command` (the first time: right-click, Open)
- Windows: `start-windows.bat`
- Linux: `start.sh` (or `sh start/start.sh` in a terminal)

It installs what's needed the first time, builds the editor and opens
http://localhost:5179 in the default browser (Chrome, Edge or Firefox; Safari has no
Web MIDI); click Connect.
Close the terminal window to stop it. The same thing from a terminal: `npm start`.

The port is fixed because the browser remembers the MIDI permission per address.
`?demo` opens a built-in patch offline.

## Developing

`npm run dev` serves the editor with live reload at the same address.
`/probe.html` (dev server only) is the protocol test page used during development.


- `src/sysex/codec.ts`: the SysEx envelope (base64 + CRC-32 checksum)
- `src/sysex/protocol.ts`: command bytes, chunking, patch metadata
- `src/sysex/session.ts`: request/ack/timeout flow over any `MidiTransport`
- `src/params/`: the parameter model. A `Patch` is the synth's 2790 bytes; each of
  ~1,140 params is a view onto them (offset, size, mode condition, range, display, NRPN).
  `generated.ts` is built from Edisyn's driver, see `tools/edisyn-extract/`.
- `src/app/`: the React editor (Module Select map, module pages, pads, patch bar).
- `src/ui/`: which params each module shows, in the synth's page and knob order
  (`layout.ts`), and which ones its pages hide in some modes (`visibility.ts`).
- `npm test`: codec, session and schema tests. With `local/patches` (`tools/dumpBanks.ts`)
  and `local/extract` (`tools/edisyn-extract/run.sh`) present, also checks every param of
  every dumped patch and every NRPN value against Edisyn itself.

See `docs/PLAN.md` for the plan, findings and open questions.

Synth settings: MIDI channel as you like, Param TX/RX = NRPN,
Program Change RX on.

See NOTICE for the reverse-engineering work this builds on (Edisyn).
