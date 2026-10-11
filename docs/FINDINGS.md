# Findings

What the editor knows about the Hydrasynth Desktop beyond Edisyn's driver (which `src/params/`
is generated from: `tools/edisyn-extract/run.sh`, then `tools/generateParams.ts`), checked on a
Desktop with firmware 2.2.0 unless noted. The code points here where it relies on one of them.

## Protocol and transfers

- A full dump of the synth: 903 patches saved by firmware 2.0.0, 121 by 2.2.0, none by 1.5.5.
- Web MIDI with SysEx (Firefox): ~45 ms a patch, ~41 ms a bank's names.
- Sending a patch to H128 (working memory) and reloading it round-trips byte-identically,
  except bytes 2390-2399, which the synth normalizes to five -100s (the editor writes them that
  way).
- LFO steps 9-64 only play when a patch carries `ETCD` at bytes 1766-1769, which marks the
  extended block from 1770 on. The Init patch has zeros there and banks B/C of a factory dump
  `XXXX`; the editor sets the marker on every patch it sends (`normalizePatch`).
- Reading all eight banks over CoreMIDI back to back (~170 ms a patch), the synth's USB MIDI
  port vanished once after ~645 patches; one bank at a time with a pause was fine. Hence the
  backup's retries, pauses between banks and reconnect-and-continue.
- **System Setup isn't remotely editable.** ASM's MIDI spec 1.5.0 lists only Master Volume
  (CC 7), CV source, aftertouch delay / fade-in / release and "OverFlow" as global NRPN, its
  System section is empty, and changing System Setup items on the synth emits no NRPN for them,
  only arp tempo (0x3F 0x38) and all-notes-off (0x3F 0x4E, 0x3F 0x57). The editor leaves system
  settings to the panel.

## What the panel sends

With Param TX = NRPN (captured with `tools/listenMidi.ts`): every knob as a full CC 99/98/6/38,
values as Edisyn encodes them. Shared numbers are split by value range (Env 1's 8064: loop,
legato, delay, BPM sync... at their own bases) or by mode. Switching BPM sync sends the synced
Delay first, then the switch; an FX type change sends only the type, not its five params. A
patch change sends CC 0 / 32 and a program change, with "all notes off", "sustain off" and NRPN
8151 = 0 (not in Edisyn's list). The editor follows the knobs (`src/midi/incoming.ts`,
`PatchSync.received`); after a mode switch from the panel it sends its values for the new mode,
so both agree.

## How the synth behaves

- **Mode switches:** the synth keeps sync-on and sync-off values apart while editing. A4
  "Twilight ET" (Env 1 attack 1.15 s, decay 2.30 s, sync off): sync on showed 0 / 0, sync off
  again restored 1.15 s / 2.30 s; its NRPN echo reported 5000 / 5016 (625 x 8). A patch stores
  only the active mode's value; the other starts at 0 when loaded. `PatchSync` does the same
  (`inactiveValues`).
- **FX type switches** load the type's first preset every time (Chorus edited, Flanger, back to
  Chorus = Chorus 1 again); the Compressor starts at Ratio 20.0:1, Threshold -32.0 dB, Attack
  1 ms, Release 285 ms, Output 128. Dry/Wet stays. Delay and Reverb type switches change none of
  their other params. `fxTypeValues` in `src/params/fxPresets.ts`.
- **FX presets:** the screen names one ("Lo-Fi", "Warm"): it's knob 2's byte (354 Pre, 402
  Post), which Edisyn calls Sidechain and which is Sidechain only on the Compressor. A38 stores
  5 (EQ "Lo-Fi"), A34's Post-FX 6 ("Warm"); every FX slot with presets in all banks holds a
  valid number. The name stays after its values are edited. `src/params/fxPresets.ts`.
- **Filter 1 type 16** (A36 "My1stSampler GD") shows Vowel, and so does 10 (A60 "Mixologist
  GD"): two codes for Vowel. Shown as Vowel and kept as stored (`src/params/overrides.ts`).
- **Macro names:** stored with 16 characters, but the Desktop shows 8 (A5's "FiltAtckMixer"
  reads "FiltAtck"). The editor shows and edits 8; longer stored names are kept unless edited.
- **Arp tempo:** with System "Tempo Lock" on and the clock source USB, the synth keeps its own
  tempo whatever the patch says.
- **Displays checked against the screen:** A38's and A34's FX (EQ gains, crossovers, Dry/Wet),
  Reverb Time (0 = 120 ms, 128 = 400 ms, 161 = 480 ms, as Edisyn's table), Delay Time (424 =
  250 ms), and live edits (filter cutoff by NRPN, FX params by NRPN, a BPM sync switch, a
  whole-patch send to H128) all match.

## Where the editor differs from Edisyn

- **Voice Modulation 1-8** are 2-byte values (real patches hold 256 = +128); Edisyn reads 1 byte.
- **Macro names** are 16 characters (+NUL, stride 17); Edisyn cuts them to 8.
- **Names** are written NUL-terminated, leaving leftover bytes after the NUL alone (Edisyn
  space-pads and rewrites characters it considers filename-unsafe, like `;`).
- **Out-of-range raw values** are kept, not clamped, and shown as `? (n)`: filter 1 type 16
  (28 patches), FX sidechain 5/6, unset LFO steps (0), ribbon key lock 0, a few stray bytes.
- **FX parameter NRPN** (`prefxNparamM`): Edisyn never sends them live. The editor uses the
  generic per-slot numbers x8, which its code implies, confirmed on the synth.
- **Env/LFO Quantize NRPN** is sent x8. Edisyn sends the bare index (its note: firmware 2.0.0
  sent it x8 but didn't divide on receive); 2.2.0 divides, so only "3" landed, as "257".
- **Arp tempo** is stored twice (bytes 28 and 808, differing in ~1/5 of patches); Edisyn writes
  both but reads one. The editor writes both.
- **No live NRPN** for Arp Tempo and Filter 1 Vowel Order (they have numbers, but the synth
  ignores them on receive, Edisyn's notes), nor for name, category, colour, macro names and
  button states, scales, ribbon scale/lock/hold, arp clock lock/latch/step offset (no NRPN at
  all): these go out as a whole-patch send.
- **1-byte fields** write their high byte (sign or 0) unless the next byte is a neighbour's
  (category, panel button states): a stray -100 in a mutant source left 0xFF there.

## Design decisions

- **Module select mirrors the Desktop's panel:** its signal-flow row of buttons (OSC 1-3,
  MUTANT 1-4, MIXER, FILTER 1/2, AMP, ...) selects the section shown, as on the hardware. The
  button list and order come from the Desktop's panel, and the grouping is a small hand-written
  table (`src/ui/layout.ts`), not part of the generated data.

## Open

- **Mutant mode switches:** does the synth keep the other mode's values apart too, as for BPM
  sync, or load defaults? The editor assumes the former; a mode not used since loading starts
  at its minimums.
- **Arp tempo hint:** with Tempo Lock on, the editor could say next to the tempo that the
  synth ignores it, instead of looking broken. Not done yet.
