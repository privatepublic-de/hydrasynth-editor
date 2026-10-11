# hydrasynth-editor

A patch editor for the ASM Hydrasynth (Desktop first), over USB MIDI.

[![The editor on the Filter 1 page of its demo patch: the module map like the Desktop's panel, a
filter response curve, knobs with their modulation badges, and pads to play
notes](docs/screenshot.png)](https://privatepublic-de.github.io/hydrasynth-editor/?demo)
<sub>Click the picture to open the editor in demo mode: a built-in patch, no synth needed.</sub>

## How it was made

This editor is vibe-coded with [Claude](https://claude.com/claude-code) by Anthropic: Peter
Witzel designed it and tested it on the synth, Claude wrote the code. Every commit says so in a
`Co-Authored-By: Claude` line. What it knows about the Hydrasynth comes from Sean Luke's reverse
engineering for [Edisyn](https://github.com/eclab/edisyn) (see [NOTICE](NOTICE)) and from checks
on a Hydrasynth Desktop ([docs/FINDINGS.md](docs/FINDINGS.md)).

## Running it

**Open the editor: https://privatepublic-de.github.io/hydrasynth-editor/**
(or [try the demo](https://privatepublic-de.github.io/hydrasynth-editor/?demo), without a synth)

Use Chrome, Edge or Firefox (Safari has no Web MIDI), allow MIDI access, click Connect.
Nothing to install; everything runs in the browser, see the
[privacy statement](https://privatepublic-de.github.io/hydrasynth-editor/privacy.html).

### Offline, from your own computer

Web MIDI only works on a served page, not on a file opened from disk, so offline the editor
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

## A patch from a recording

The patch bar's menu (☰) → Generate patch from WAV… makes a patch from the note in a WAV
file: a starting point to shape further, not a copy of the recording. It reads the note's
pitch, its harmonics and how they change, its envelope, vibrato and tremolo, and its noise,
drift, detune and chorus, and builds the patch from the synth's own waves or Mutant FM (or
whichever comes closer). Macros (Bright, Timbre, Attack, Release, Dirt, Movement) start where
the patch is, velocity and aftertouch open the filter.

- **Good starting points:** a single note of a synth, keys, bass, lead, pad, organ, flute or
  string machine; sung vowels; tonal drums (kicks with their pitch drop, toms, snare bodies).
- **Rough, but usable:** noise-based percussion and textures (hi-hats, claps, crashes, found
  sounds): the noise source in the nearest colour through the filter, any key plays it.
- **A single-note stand-in:** chords, bells and other inharmonic sounds, drum loops, and slides
  over more than an octave or so.

Best with one note, dry, at least a quarter second long, from about 20 Hz to 2 kHz. The status
line under the choices says what the patch is made of and the note to play, and when the
recording isn't one clear note (a rough start).

## A patch that speaks

The patch bar's menu (☰) → Generate speech patch… replaces the patch with one that says a few
English words (up to 60 characters) on every note, the way a formant synthesiser does: a voice
through Filter 1's Vowel filter and noise through Filter 2 for breath and hiss, run by five
one-shot Step LFOs that the note starts (vowel, voicing, hiss, hiss colour, melody). Words come
from the CMU Pronouncing Dictionary, others from spelling rules. The end mark sets the melody:
a statement or "!" peaks on its main stress and falls, a yes/no "?" rises, a question starting
with a question word ("how", "what", …) falls.

- **Voice:** a Saw with melody; one of the synth's waves for the whole phrase, with melody; a
  wave per sound (its pitch only falls or rises over the phrase); or a wave per sound without the
  Vowel filter. The waves are picked for harmonics that already show each sound's formants at
  the note they're tuned for (C2, C3 or C4): clearest near that note.
- **Speed:** slow, normal or fast; Macro 1 changes it later.
- **Sing:** Mono, and the keys give the pitch. Played legato the phrase goes on at the new note;
  let go, and the next note starts it again.
- **Macros:** Speed, Fundamental (a Saw at the played note, for melodic speech and chords),
  Voice (smaller or larger, through Formant Control; not without the Vowel filter), Whisper
  (breath instead of voice) and Freeze (also on the Mod Wheel: stops on the current sound, to
  sing on it).

The status line says how long to hold a note and the sounds it makes, e.g. "Hold a note 1.3 s:
h ah l ow uw · w er l d". A phrase with more sounds than the Step LFOs have steps loses its
end ("2 sounds left out"). Connected to the synth, generating replaces the patch with no undo,
so write what you want to keep first.

The wavelist does a smaller version: on an oscillator page in WaveScan mode, choose Speech in
the wavelist's fill menu and click Fill. It puts eight waves in the wavelist that say the
words, talk-box style, as WaveScan sweeps from 1 to 8.

## Publishing

Every push to `main` runs the tests, builds the editor and publishes `dist/` with GitHub
Pages (`.github/workflows/pages.yml`). Once per repository: Settings → Pages → Source:
GitHub Actions. The build uses relative paths (`base: './'`), so it works at any address.

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
- `src/audio/`: reading a WAV and analysing the note in it (pitch, harmonics over time,
  envelope, vibrato); `src/ui/wavPatch.ts` builds a patch from that, on the synth's waves or
  its Mutant FM (`src/ui/fmModel.ts`), measured on the synth with `tools/calibrateWavPatch.ts`
  and `tools/calibrateMutant.ts`, and compared with the WAV by `tools/scoreWavPatch.ts`.
- `npm test`: codec, session, schema, speech and audio-analysis tests. With `local/patches`
  (`tools/dumpBanks.ts`) and `local/extract` (`tools/edisyn-extract/run.sh`) present, also
  checks every param of every dumped patch and every NRPN value against Edisyn itself; with
  `local/wave-recordings` (`tools/recordWaves.ts`), that the WAV analysis finds the synth's
  own waves in them.

See `docs/FINDINGS.md` for what the editor knows about the synth beyond Edisyn, and what is still open.

Synth settings: MIDI channel as you like, Param TX/RX = NRPN,
Program Change RX on.

See [NOTICE](NOTICE) for the reverse-engineering work this builds on:
[Edisyn](https://github.com/eclab/edisyn) by Sean Luke.
