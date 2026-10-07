/**
 * Stored values the synth knows but Edisyn's tables don't, confirmed on the device.
 * Kept as stored (not rewritten to the table's code) unless the user picks another value.
 */
export const EXTRA_VALUE_LABELS: Record<string, Record<number, string>> = {
  // A36 "My1stSampler GD" stores 16 and shows Vowel; A60 stores 10 and shows Vowel too (user, 2026-10-08).
  filter1type: { 16: 'Vowel' },
}
