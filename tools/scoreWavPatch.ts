// Plays the patch generated from a WAV (src/ui/wavPatch.ts) on the synth and compares the recording
// with the WAV, both through the same analysis (src/audio/analyse.ts): the harmonics at the peak
// (plain dB RMS of the first 32, floored at -60: fixed, whatever weighting the fit uses), octave bands
// (for noise, where harmonics mean nothing), brightness over time, the level's shape, pitch and wobble. The
// recordings go to local/wav-patches/<name>-<envelope>.wav, and the WAV then the synth in one file
// to local/wav-patches/ab/, for listening. Up to 8 s of a held note; a pad's slow swings and second
// oscillator compared too.
// --json <file> appends a record per sample (signed errors, the band spectrogram's distances) for
// tools/summariseScores.ts; --pictures writes a sox spectrogram of each A/B file next to it.
// Usage: npx vite-node tools/scoreWavPatch.ts <file.wav>... [--source waves|fm|auto] [--envelope detect|pluck|keys|pad] [--steady] [--json <file>] [--pictures]
import { execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { fft } from '../src/audio/fft'
import { basename } from 'node:path'
import { analyse, type SoundAnalysis } from '../src/audio/analyse'
import { parseWav } from '../src/audio/wav'
import { decodeCycle } from '../src/ui/waveCycles'
import { harmonicAmps, harmonicLevels } from '../src/ui/waveSpeech'
import { harmonicsAt } from '../src/audio/spectrum'
import { buildWavPatch, type Envelope, type Source, wavStatus } from '../src/ui/wavPatch'
import { openSynth } from './synthTake'
import { RATE } from './waveAudio'

const FILE = 'local/wave-recordings/score-wav.wav'
const OUT = 'local/wav-patches'

const data = JSON.parse(readFileSync('public/wave-cycles.json', 'utf8'))
const levels: (number[] | null)[] = data.waves.map((w: { cycle: string } | null) => w && harmonicLevels(decodeCycle(w.cycle)))
const peaks: (number | null)[] = data.waves.map((w: { cycle: string; level: number } | null) => w && w.level * Math.max(...harmonicAmps(decodeCycle(w.cycle))))

/** Brightness (centroid, in harmonics) every 0.1 s of the first `seconds`. */
function brightness(a: SoundAnalysis, seconds: number): number[] {
  const out: number[] = []
  for (let t = 0; t < seconds; t += 0.1) {
    const f = a.frames.find((fr) => fr.t - a.onsetS >= t)
    if (f) out.push(f.harmonics.centroid)
  }
  return out
}

/** Third-octave band centres (Hz), 50 Hz to 16 kHz. */
const THIRD_HZ = Array.from({ length: 26 }, (_, i) => 50 * 2 ** (i / 3))
const HOP_S = 0.05

/**
 * Power (dB) per third-octave band every HOP_S from `from` (2048-sample Hann windows) for `seconds`:
 * a spectrogram coarse enough that a few cents' pitch or a detune doesn't move it.
 */
function bandSpectrogram(x: Float32Array, sampleRate: number, from: number, seconds: number): number[][] {
  const n = 2048
  const bin = sampleRate / n
  const out: number[][] = []
  for (let t = Math.round(from * sampleRate); out.length < seconds / HOP_S && t + n <= x.length; t += Math.round(HOP_S * sampleRate)) {
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    for (let i = 0; i < n; i++) re[i] = x[t + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)))
    fft(re, im)
    out.push(
      THIRD_HZ.map((hz) => {
        const lo = Math.max(1, Math.round(hz / 2 ** (1 / 6) / bin))
        const hi = Math.max(lo, Math.round((hz * 2 ** (1 / 6)) / bin) - 1)
        let sum = 0
        for (let b = lo; b <= hi; b++) sum += re[b] * re[b] + im[b] * im[b]
        return 10 * Math.log10(sum + 1e-12)
      }),
    )
  }
  return out
}

const dbSum = (xs: number[]) => 10 * Math.log10(xs.reduce((s, v) => s + 10 ** (v / 10), 0) + 1e-12)
const rms = (xs: number[]) => (xs.length ? Math.sqrt(xs.reduce((s, v) => s + v * v, 0) / xs.length) : NaN)

/**
 * The WAV's and the synth's band spectrograms compared from their onsets, overall level taken out:
 * timbre (the time-averaged spectrum, per band synth - wav, its RMS and tilt in dB/octave over the
 * bands the WAV fills), evolution (each frame's shape against its own average), the level's shape.
 */
function compareSpectrograms(w: number[][], s: number[][]) {
  const n = Math.min(w.length, s.length)
  const [wf, sf] = [w.slice(0, n), s.slice(0, n)]
  const mean = (frames: number[][]) => THIRD_HZ.map((_, b) => dbSum(frames.map((f) => f[b])) - 10 * Math.log10(frames.length))
  const [wm, sm] = [mean(wf), mean(sf)]
  const [wt, st] = [dbSum(wm), dbSum(sm)]
  const top = Math.max(...wm)
  const used = THIRD_HZ.map((_, b) => wm[b] > top - 50)
  const diff = THIRD_HZ.map((_, b) => sm[b] - st - (wm[b] - wt))
  const usedDiff = diff.filter((_, b) => used[b])
  const offset = usedDiff.reduce((a, v) => a + v, 0) / usedDiff.length
  const timbre = rms(usedDiff.map((v) => v - offset))
  // Tilt: the least-squares slope of the difference against octaves.
  const xs = THIRD_HZ.map((_, b) => b / 3).filter((_, b) => used[b])
  const xm = xs.reduce((a, v) => a + v, 0) / xs.length
  const tilt = xs.reduce((a, x, i) => a + (x - xm) * (usedDiff[i] - offset), 0) / xs.reduce((a, x) => a + (x - xm) ** 2, 0)
  // Levels per frame against each's own peak.
  const [wl, sl] = [wf.map(dbSum), sf.map(dbSum)]
  const [wp, sp] = [Math.max(...wl), Math.max(...sl)]
  const level = wl.map((v, i) => [v - wp, sl[i] - sp])
  const envelope = rms(level.filter(([a, b]) => a > -50 || b > -50).map(([a, b]) => Math.max(b, -50) - Math.max(a, -50)))
  // Evolution: each frame's shape (its level out) against the average shape, where both sound.
  const shape = (f: number[], l: number, m: number[], t: number) => f.map((v, b) => v - l - (m[b] - t))
  const evo: number[] = []
  for (let i = 0; i < n; i++) {
    if (level[i][0] < -30 || level[i][1] < -30) continue
    const [a, b] = [shape(wf[i], wl[i], wm, wt), shape(sf[i], sl[i], sm, st)]
    for (let k = 0; k < THIRD_HZ.length; k++) if (used[k]) evo.push(b[k] - a[k])
  }
  return { frames: n, timbre, tilt, evolution: rms(evo), envelope, bands: diff.map((v, b) => (used[b] ? v - offset : null)) }
}

const ms = (s: number) => `${Math.round(s * 1000)} ms`

/** RMS dB difference of the first 32 harmonics, floored at -60, an overall level difference taken out. */
function rmsDb(a: number[], b: number[]): number {
  const d = Array.from({ length: Math.min(32, a.length, b.length) }, (_, k) => Math.max(a[k], -60) - Math.max(b[k], -60))
  const mean = d.reduce((s, v) => s + v, 0) / d.length
  return Math.sqrt(d.reduce((s, v) => s + (v - mean) ** 2, 0) / d.length)
}

async function main() {
  const args = process.argv.slice(2)
  const option = (name: string, fallback: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
  const envelope = option('--envelope', 'detect') as Envelope
  const source = option('--source', 'waves') as Source
  const files = args.filter((a) => a.endsWith('.wav'))
  const json = args.includes('--json') ? args[args.indexOf('--json') + 1] : null
  mkdirSync(`${OUT}/ab`, { recursive: true })
  const synth = await openSynth(FILE)
  try {
    for (const file of files) {
      try {
        await score(file)
      } catch (e) {
        console.log(`${basename(file, '.wav')}: ${(e as Error).message}`)
        if (json) appendFileSync(json, `${JSON.stringify({ name: basename(file, '.wav'), error: (e as Error).message })}\n`)
      }
    }
    async function score(file: string) {
      const wav = parseWav(readFileSync(file))
      const target = analyse(wav)
      const name = basename(file, '.wav')
      const built = buildWavPatch(target, { levels, peaks, source, envelope, overTime: !args.includes('--steady'), name })
      const hold = Math.min(8, Math.max(1, (target.held ? target.endS : target.endS - target.adsr.releaseS) - target.onsetS))
      // The Mod Wheel down (the synth keeps where it was last sent): it brings in the vibrato.
      const x = await synth.take(built.patch, target.midi, hold, [[0, 'cc1', 0]])
      const out = `${OUT}/${name}-${source}-${envelope}${args.includes('--steady') ? '-steady' : ''}.wav`
      copyFileSync(FILE, out)
      // The WAV, half a second's silence, the synth: at the recording's rate, stereo, 24-bit.
      const ab = `${OUT}/ab/${basename(out)}`
      const tmp = `${OUT}/ab/.wav-${basename(out)}`
      execFileSync('sox', ['-q', file, '-r', String(RATE), '-c', '2', '-b', '24', tmp, 'pad', '0', '0.5'])
      execFileSync('sox', ['-q', tmp, out, ab])
      unlinkSync(tmp)
      const got = analyse({ samples: Float32Array.from(x), sampleRate: RATE })
      const span = Math.min(2, target.endS - target.onsetS)
      const [tb, gb] = [brightness(target, span), brightness(got, span)]
      const n = Math.min(tb.length, gb.length)
      console.log(`${name}: ${wavStatus(built)}`)
      // Compared at the WAV's pitch, so a take that reads an octave off is still compared as played.
      const gotLevels = harmonicsAt(Float32Array.from(x), RATE, target.f0, got.peakS * RATE, got.peakS * RATE + Math.max(8 * (RATE / target.f0), 0.1 * RATE), 32).levels
      console.log(`  harmonics at the peak: ${rmsDb(target.spectrum.levels, gotLevels).toFixed(1)} dB from the WAV`)
      // Octave bands, for noise as for notes: the same measure of both, any overall level taken out.
      const used = target.bands.map((v, i) => [v, got.bands[i]]).filter(([v]) => v > -40)
      const offset = used.reduce((s, [v, g]) => s + v - g, 0) / used.length
      const bandRms = Math.sqrt(used.reduce((s, [v, g]) => s + (v - g - offset) ** 2, 0) / used.length)
      console.log(`  octave bands: ${bandRms.toFixed(1)} dB from the WAV (wav ${target.bands.map((v) => v.toFixed(0)).join(' ')} / synth ${got.bands.map((v) => v.toFixed(0)).join(' ')})`)
      console.log(`  brightness / 0.1 s: wav ${tb.slice(0, n).map((v) => v.toFixed(1)).join(' ')}`)
      console.log(`                      synth ${gb.slice(0, n).map((v) => v.toFixed(1)).join(' ')}`)
      const [ta, ga] = [target.adsr, got.adsr]
      console.log(`  attack ${ms(ta.attackS)} / ${ms(ga.attackS)}, decay ${ms(ta.decayS)} / ${ms(ga.decayS)}, sustain ${ta.sustain.toFixed(2)} / ${ga.sustain.toFixed(2)}, release ${ms(ta.releaseS)} / ${ms(ga.releaseS)}`)
      const dirt = (d: SoundAnalysis['dirt']) =>
        `drift ${d.drift.toFixed(1)} c, detune ${d.detune ? `${d.detune.cents.toFixed(1)} c` : '-'}, chorus ${d.chorus ? `${d.chorus.cents.toFixed(1)} c ${d.chorus.beat.toFixed(1)} dB` : '-'}, noise ${d.noise ? `${d.noise.db.toFixed(0)} dB ${d.noise.slope.toFixed(1)}/oct` : '-'}`
      console.log(`  dirt: wav ${dirt(target.dirt)} / synth ${dirt(got.dirt)}`)
      console.log(`  pitch ${target.f0.toFixed(1)} / ${got.f0.toFixed(1)} Hz, vibrato ${JSON.stringify(target.vibrato)} / ${JSON.stringify(got.vibrato)}, tremolo ${JSON.stringify(target.tremolo)} / ${JSON.stringify(got.tremolo)}`)
      const swing = (m: SoundAnalysis['movement']) =>
        m
          ? [
              m.pitch && `pitch ${m.pitch.depth.toFixed(0)} c ${m.pitch.rateHz.toFixed(2)} Hz`,
              m.beat && `beat ${m.beat.rateHz.toFixed(2)} Hz`,
              m.level && `level ${m.level.depth.toFixed(1)} dB ${m.level.rateHz.toFixed(2)} Hz`,
              m.timbre && `timbre ${m.timbre.rateHz.toFixed(2)} Hz`,
            ]
              .filter(Boolean)
              .join(', ')
          : '-'
      console.log(`  slow swings: wav ${swing(target.movement)} / synth ${swing(got.movement)}`)
      const other = (o: SoundAnalysis['second']) => (o ? `${o.kind} ${o.semitones.toFixed(2)} st ${o.db.toFixed(1)} dB` : '-')
      if (target.second || got.second) console.log(`  second oscillator: wav ${other(target.second)} / synth ${other(got.second)}`)
      if (target.voices || got.voices) console.log(`  voices: wav ${target.voices?.map((v) => v.cents.toFixed(1)).join(' ') ?? '-'} / synth ${got.voices?.map((v) => v.cents.toFixed(1)).join(' ') ?? '-'} cents`)
      // The band spectrograms, from each onset, over the held note and up to a second of release.
      const seconds = Math.min(hold + 1, target.endS - target.onsetS, x.length / RATE - got.onsetS)
      const spec = compareSpectrograms(
        bandSpectrogram(wav.samples, wav.sampleRate, target.onsetS, seconds),
        bandSpectrogram(Float32Array.from(x), RATE, got.onsetS, seconds),
      )
      console.log(`  band spectrogram: timbre ${spec.timbre.toFixed(1)} dB, tilt ${spec.tilt >= 0 ? '+' : ''}${spec.tilt.toFixed(1)} dB/oct, evolution ${spec.evolution.toFixed(1)} dB, level shape ${spec.envelope.toFixed(1)} dB`)
      if (args.includes('--pictures')) execFileSync('sox', [ab, '-n', 'remix', '1', 'rate', '16k', 'spectrogram', '-x', '1200', '-y', '400', '-z', '90', '-t', name, '-o', ab.replace(/\.wav$/, '.png')])
      if (json) {
        const mean = (xs: number[]) => (xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : NaN)
        const record = {
          name,
          status: wavStatus(built),
          warnings: target.warnings,
          harmonics: rmsDb(target.spectrum.levels, gotLevels),
          octaveBands: bandRms,
          spec,
          brightness: n ? mean(gb.slice(0, n)) / mean(tb.slice(0, n)) : null,
          adsr: { wav: ta, synth: ga },
          f0: { wav: target.f0, synth: got.f0 },
          dirt: { wav: target.dirt, synth: got.dirt },
          vibrato: { wav: target.vibrato, synth: got.vibrato },
          tremolo: { wav: target.tremolo, synth: got.tremolo },
          movement: { wav: target.movement, synth: got.movement },
          second: { wav: target.second && { kind: target.second.kind, semitones: target.second.semitones, db: target.second.db }, synth: got.second && { kind: got.second.kind, semitones: got.second.semitones, db: got.second.db } },
          voices: { wav: target.voices, synth: got.voices },
          glide: { wav: target.glide, synth: got.glide },
          held: target.held,
          ab,
        }
        appendFileSync(json, `${JSON.stringify(record)}\n`)
      }
      console.log(`  -> ${out}`)
    }
  } finally {
    synth.close()
  }
}

void main()
