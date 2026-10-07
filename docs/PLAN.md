# Plan

1. **Parameter model** (done): `src/params/`, generated from Edisyn's driver
   (`tools/edisyn-extract/run.sh`, then `tools/generateParams.ts`).
2. **Patch state + MIDI sync**: a store holding the open `Patch`; edits send their NRPN
   (rate-limited, mode params before the values that depend on them, the synth's echoes
   ignored); params without NRPN go out as a whole-patch send to H128 after a pause.
   Load/write slots; write = 3.5 s pause afterwards.
   Open: a mode switch (BPM sync on/off, mutant mode, FX type) reinterprets a shared byte with a
   different range, which can leave an out-of-range value. Clamp, reset, or do what the synth
   does -- check on the device before deciding.
3. **Main view**: React + TypeScript, one screen. **Mirror the Desktop's own module-select
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
  per-slot numbers x8, which its code implies; **unverified on hardware** -- until checked,
  a whole-patch send is the fallback.

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
  shown for EQ, so the stored 5 there is presumably a leftover the synth ignores.
- Macro names: the Desktop shows 8 characters (A5's "FiltAtckMixer" reads "FiltAtck").
  The UI shows and edits 8; longer stored names are kept unless edited.

- A34 "Ancient Log KFP" matches the model too: Pre-FX Tremolo; Post-FX EQ (preset "Warm"),
  1.5 / -4.2 / 1.0 dB, 768 / 7600 Hz, 100 %.
- The screen names an FX preset ("Lo-Fi", "Warm"); where the patch stores it is not mapped yet.

## Open questions for the device

- Live FX parameter NRPN (see above).
