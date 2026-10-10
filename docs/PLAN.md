# Plan

1. **Parameter model** (done): `src/params/`, generated from Edisyn's driver
   (`tools/edisyn-extract/run.sh`, then `tools/generateParams.ts`).
2. **Patch state + MIDI sync** (done, `src/sync/`, checked on the device 2026-10-08):
   `PatchSync` opens a slot (download + program change), sends edits as NRPN (`NrpnQueue`:
   coalesced, mode params first, 2-4 ms apart, paused during SysEx; the synth's echoes are
   ignored), sends what NRPN can't carry as a whole patch to H128 1 s after the last such
   edit, writes slots to flash (then 3.5 s quiet). Mode switches keep each mode's values
   apart, as the synth does (below).
3. **Main view** (first version 2026-10-08, `src/app/`, `src/ui/`): React + TypeScript, one screen. **Mirror the Desktop's own module-select
   buttons** (user, 2026-10-08): the panel's signal-flow row of buttons (OSC 1, OSC 2, OSC 3,
   MUTANT 1-4, MIXER, FILTER 1/2, AMP, ...) selects the section shown, as on the hardware.
   Take the exact button list and order from the Desktop's manual or a photo, not from memory,
   and keep that grouping as a small hand-written table (not in the generated data).
   On-screen keyboard and note trigger for auditioning; bank browser from the names dump.
4. **Library**: bank backup/restore, .syx import/export.

## Facts found so far

- Desktop on firmware 2.2.0; dump: 903 patches at 2.0.0, 121 at 2.2.0, none at 1.5.5.
- Web MIDI with SysEx works in Firefox (the user's browser): ~45 ms a patch, ~41 ms a bank's names.
- Sending a patch to H128 (working memory) and reloading it round-trips byte-identically,
  except bytes 2390-2399, which the synth normalizes to five -100s (we write them that way).
- Reading all eight banks over CoreMIDI back to back (~170 ms a patch), the synth's USB MIDI
  port vanished once after ~645 patches; one bank at a time with a pause was fine. Bulk
  transfers need retries and a reconnect path.

## Where we differ from Edisyn (and why)

- **Voice Modulation 1-8** are 2-byte values (real patches hold 256 = +128); Edisyn reads 1 byte.
- **Macro names** are 16 characters (+NUL, stride 17); Edisyn cuts them to 8. Whether the
  Desktop's screen shows more than 8 is unchecked.
- **Names** are written NUL-terminated, leaving leftover bytes after the NUL alone (Edisyn
  space-pads and rewrites characters it considers filename-unsafe, like `;`).
- **Out-of-range raw values** are kept, not clamped, and shown as `? (n)`: filter 1 type 16
  (28 patches), FX sidechain 5/6, unset LFO steps (0), ribbon key lock 0, a few stray bytes.
- **FX parameter NRPN** (`prefxNparamM`): Edisyn never sends them live. We use the generic
  per-slot numbers x8, which its code implies -- confirmed on the device.
- **Env/LFO Quantize NRPN** is sent x8. Edisyn sends the bare index (its note: firmware 2.0.0
  sent it x8 but didn't divide on receive); 2.2.0 divides, so only "3" landed, as "257"
  (user, 2026-10-10).
- **Arp tempo** is stored twice (bytes 28 and 808, differing in ~1/5 of patches); Edisyn
  writes both but reads one. We write both.

- **Arp Tempo and Filter 1 Vowel Order** have NRPN numbers but the synth ignores them on
  receive (Edisyn's notes): no live NRPN, whole-patch send only. Neither do name, category,
  colour, macro names/button states, scales, ribbon scale/lock/hold, arp clock lock/latch/step
  offset (no NRPN at all).
- **1-byte fields** write their high byte (sign or 0) unless the next byte is a neighbour's
  (category, panel button states): a stray -100 in a mutant source left 0xFF there.

## Answers from the device (user, 2026-10-08)

- Filter 1 type 16 (A36 "My1stSampler GD") shows **Vowel**, and so does 10 (A60 "Mixologist GD"):
  two codes for Vowel. Shown as Vowel and kept as stored (`src/params/overrides.ts`).
- A38's Pre-FX matches the model exactly: EQ, Low/High Gain -36.0 dB, Mid 0.0 dB, Xover
  394/1376 Hz, Dry/Wet 0.0 % (the screen also names a preset, "Lo-Fi"). FX sidechain isn't
  shown for EQ: the stored 5 there is the preset, see below.
- Macro names: the Desktop shows 8 characters (A5's "FiltAtckMixer" reads "FiltAtck").
  The UI shows and edits 8; longer stored names are kept unless edited.

- A34 "Ancient Log KFP" matches the model too: Pre-FX Tremolo; Post-FX EQ (preset "Warm"),
  1.5 / -4.2 / 1.0 dB, 768 / 7600 Hz, 100 %.
- The screen names an FX preset ("Lo-Fi", "Warm"): it's knob 2's byte (354 Pre, 402 Post), which
  Edisyn calls Sidechain and which is Sidechain only on the Compressor. A38 stores 5 (EQ "Lo-Fi"),
  A34's Post-FX 6 ("Warm"); every FX slot with presets in all banks holds a valid number. The
  name stays after its values are edited (A34's High Gain). `src/params/fxPresets.ts`.

- Live NRPN (filter cutoff), FX params by NRPN (Pre-FX EQ Low Gain -0.7 dB, Xover Lo 600 Hz),
  a BPM sync switch, and a whole-patch send to H128 (Arp Latch, Macro 1 name) all showed the
  expected values on the screen.
- **Mode switches**: the synth keeps sync-on and sync-off values apart while editing. A4
  "Twilight ET" (Env 1 attack 1.15 s, decay 2.30 s, sync off): sync on showed 0 / 0, sync
  off again restored 1.15 s / 2.30 s; its NRPN echo reported 5000 / 5016 (625 x 8). A patch
  stores only the active mode's value; the other starts at 0 when loaded. `PatchSync` does
  the same (`inactiveValues`). Mutant mode is assumed to work alike (unchecked).
- **FX type switches** (captured 2026-10-11, Init): a Pre-/Post-FX type switch loads the type's
  first preset every time (Chorus edited, Flanger, back to Chorus = Chorus 1 again); the
  Compressor starts at Ratio 20.0:1, Threshold -32.0 dB, Attack 1 ms, Release 285 ms, Output 128.
  Dry/Wet stays. Delay and Reverb type switches change none of their other params.
  `fxTypeValues` in `src/params/fxPresets.ts`.
- **Reverb and Delay Time display** match the synth (2026-10-11, sent by NRPN): Reverb Time
  0 = 120 ms, 128 = 400 ms, 161 (Init) = 480 ms, as Edisyn's table; Delay Time 424 = 250 ms.
- **Arp tempo**: with System "Tempo Lock" on and the clock source USB (the user's settings),
  the synth keeps its own tempo (85.0) whatever the patch says. The UI should say so next to
  the tempo instead of looking broken.

- **System Setup isn't remotely editable** (2026-10-08). ASM's MIDI spec 1.5.0 lists only
  Master Volume (CC 7), CV source, aftertouch delay / fade-in / release and "OverFlow" as
  global NRPN, its System section is empty. Changing System Setup items on the synth emits
  no NRPN for them, only arp tempo (0x3F 0x38) and all-notes-off (0x3F 0x4E, 0x3F 0x57).
  The user decided to leave system settings to the panel.

- The panel sends what it changes (Param TX = NRPN; captured 2026-10-08 with tools/listenMidi.ts):
  every knob as a full CC 99/98/6/38, values as Edisyn encodes them. Shared numbers are split by
  value range (Env 1's 8064: loop, legato, delay, BPM sync... at their own bases) or by mode.
  Switching BPM sync sends the synced Delay first, then the switch; an FX type change sends only
  the type, not its five params. A patch change sends CC 0 / 32 and a program change, with
  "all notes off", "sustain off" and NRPN 8151 = 0 (not in Edisyn's list). The editor follows
  knobs (`src/midi/incoming.ts`, `PatchSync.received`); after a mode switch from the panel it
  sends its values for the new mode, so both agree.

## Open questions for the device

- Switching mutant mode: does the synth keep the other mode's values apart too (as for BPM
  sync), or load defaults? Today a mode never used since loading starts at its minimums.

