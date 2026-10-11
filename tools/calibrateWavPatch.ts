// Measures on the synth what src/ui/wavPatch.ts relies on (its CALIBRATION): per experiment, a
// patch from Init into H128's working memory (no flash write), one held note, recorded from the
// default audio input (the synth on inputs 1/2 of an X18) with sox, analysed by src/audio.
//   cutoff     a Saw through LP Ladder 12 (keytrack 100 %, resonance 0) at Cutoffs 256..768 and
//              notes C2, C3, C4: the cutoff (Hz) that fits each, against the Saw unfiltered
//   envamount  the same at Cutoff 256 with ENV 1 held full (Sustain 128), Env 1 Amount 0..+64:
//              cutoff raw moved per raw of amount
//   filterenv  ENV 1 decaying from full (Sustain 0) at Env 1 Amount +32 from Cutoff 256, and ENV 3
//              through a mod matrix route to Filt 1 Cutoff: the cutoff over time (octaves above
//              where it ends), against the Decay shown
//   amp        ENV 2's Attack, Decay (to -40 dB, and to a Sustain), Sustain (level) and Release (to -40 dB) at a few
//              raw values, against what they show
//   vibrato    the Voice's vibrato (Amount 0.5 and 2, 5 Hz) with the Mod Wheel down and up; a Sine LFO 1
//              into Osc 1 Pitch at route depth 8: cents to either side
//   velocity   Amp Vel Env +32 and Note-On Vel on Filt 1 Cutoff (route depth 8) at velocities
//              30, 64, 100 and 127: level (dB) and cutoff, against velocity 127
//   macro      a macro (depth 32) at knobs 0..128 on Filt 1 Cutoff, and on Matrix 1 Depth with ENV 3
//              (held full) routed to Filt 1 Cutoff at depth 0: where the cutoff goes, in raw
//   mixer      a Sine on OSC 2 alone at Osc 2 Vol 128..16: its level (dB) against 128
//   dirt       through src/audio/dirt.ts, on a Saw at C3: Analog Feel 0..127 (drift), the noise at
//              Noise Vol 128..32 and each Noise Type (level under the Saw, slope), Pre-FX Chorus at
//              rates and depths (ensemble), OSC 3 a Saw some cents up at two volumes (detune)
//   drift      a Random LFO 3 (1.5 Hz, Smooth 127) on All Osc Pitch and Osc 1 Pitch at route depths 4..16, on a Saw at C3: drift (cents)
//   chorus     Pre-FX Chorus on a Saw at C3, at rates 0.5..6 Hz, depths 16..64 and wet 50/100 %: what
//              src/audio/dirt.ts reads (cents apart, rate, beating); a single chorus reads unevenly
//   ensemble   Pre-FX Chorus at 0.6 Hz and Post-FX Chorus at 6 Hz (half the depth), as a string
//              machine's two sweeps, at depths 64/96 and wet 50..87 %: the table src/ui/wavPatch.ts
//              matches a recording's chorus against
//   pitchenv   ENV 4 on All Osc Pitch (mod matrix route 1), a Sine at C3: semitones per route depth with
//              ENV 4 held full, and the pitch over time as it decays from full (Decay 896 ms, Sustain 0)
//   resonance  a Saw through LP Ladder 12 at Cutoff 448 and 576, Resonance 0..896 (C3): the cutoff and
//              the Q of a two-pole low-pass that fit each
//   ladder     white noise through LP Ladder 12 at Cutoff 512 (C3, keytrack 100 %: 1288 Hz) at Resonance 0..832:
//              its response (dB against the noise unfiltered) every 1/12 octave, as a multiple of 1288 Hz;
//              written to src/ui/ladderResponse.generated.ts. Also at Cutoff 384 and 640, to check the
//              shape moves with the cutoff
//   resonanceset  Saw and Square through LP Ladder 12 at Resonance 0, 512, 704 and 832, the filter still
//              at Cutoff 448 and 576 or swept by ENV 1 (from 832, Decay 448 ms), at C2 and C3, long
//              (1.5 s) and the sweep short (0.25 s): WAVs with known resonance in local/wav-tests/rig-res,
//              for testing a detector
//   tremolo    a Sine LFO 2 at 4 Hz through Amp LFO 2 Amount +16: dB to either side
// Usage: npx vite-node tools/calibrateWavPatch.ts <experiment>
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { analyse } from '../src/audio/analyse'
import { fft } from '../src/audio/fft'
import { detectPeriod } from '../src/audio/pitch'
import { harmonicsAt } from '../src/audio/spectrum'
import { formatValue } from '../src/params/display'
import { initPatchBytes } from '../src/params/initPatch'
import { Patch, param } from '../src/params/patch'
import { destinationOf } from '../src/ui/modDestinations'
import { labelNumber, rawFor } from '../src/ui/timeTables'
import { lpDb } from '../src/ui/wavPatch'
import { openSynth } from './synthTake'
import { RATE } from './waveAudio'

const FILE = 'local/wave-recordings/calibrate-wav.wav'
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12)
const show = (key: string, v: number) => formatValue(param(key), v)

/** Init with a Saw through LP Ladder 12 at keytrack 100 %, resonance 0. */
function sawPatch(cutoff = 1024): Patch {
  const p = new Patch(initPatchBytes())
  p.set('osc1type', 3)
  p.set('filter1type', 0)
  p.set('filter1resonance', 0)
  p.set('filter1keytrack', 768)
  p.set('filter1cutoff', cutoff)
  p.set('voicevibratoamount', 0)
  return p
}

const f32 = (x: Float64Array) => Float32Array.from(x)

/** dB per harmonic of `x` from 0.3 s to 0.9 s, unnormalised. */
function harmonicDb(x: Float64Array, f0: number, count: number): number[] {
  const h = harmonicsAt(f32(x), RATE, f0, 0.3 * RATE, 0.9 * RATE, count)
  return h.amps.map((a) => 20 * Math.log10(a + 1e-9))
}

/** The cutoff (x pitch) whose two-pole response best explains `filtered` - `open` (harmonics above -50 dB). */
function fitCutoffRatio(filtered: number[], open: number[]): { ratio: number; rms: number } {
  const top = Math.max(...open)
  let best = { ratio: 1, rms: Infinity }
  for (let o = 0; o <= 8; o += 1 / 64) {
    const ratio = 2 ** o
    let sum = 0
    let n = 0
    let offset = 0
    const diffs: number[] = []
    open.forEach((v, k) => {
      if (v < top - 50 || filtered[k] < top - 70) return
      diffs.push(filtered[k] - v - lpDb((k + 1) / ratio))
    })
    if (diffs.length < 3) continue
    offset = diffs.reduce((s, d) => s + d, 0) / diffs.length
    for (const d of diffs) (sum += (d - offset) ** 2), n++
    const rms = Math.sqrt(sum / n)
    if (rms < best.rms) best = { ratio, rms }
  }
  return best
}

async function main() {
  const experiment = process.argv[2]
  const synth = await openSynth(FILE)
  try {
    if (experiment === 'cutoff' || experiment === 'envamount') {
      const notes = experiment === 'cutoff' ? [36, 48, 60] : [48]
      const raws = experiment === 'cutoff' ? [256, 384, 512, 640, 768] : [576, 640, 768, 896, 1024]
      for (const note of notes) {
        const f0 = hz(note)
        const count = Math.min(128, Math.floor(16000 / f0))
        const open = harmonicDb(await synth.take(sawPatch(), note, 1), f0, count)
        const rows: string[] = []
        for (const raw of raws) {
          const p = sawPatch(experiment === 'cutoff' ? raw : 256)
          if (experiment === 'envamount') {
            p.set('env1attacksyncoff', 0)
            p.set('env1decaysyncoff', 0)
            p.set('env1sustain', 1024)
            p.set('filter1env1amount', raw)
          }
          const fit = fitCutoffRatio(harmonicDb(await synth.take(p, note, 1), f0, count), open)
          rows.push(`${experiment === 'cutoff' ? 'cutoff' : 'amount'} ${raw} (${show(experiment === 'cutoff' ? 'filter1cutoff' : 'filter1env1amount', raw)}): ${(fit.ratio * f0).toFixed(0)} Hz, ${fit.ratio.toFixed(2)}x, fit ${fit.rms.toFixed(1)} dB`)
        }
        console.log(`note ${note} (${f0.toFixed(1)} Hz)\n  ${rows.join('\n  ')}`)
      }
    } else if (experiment === 'filterenv') {
      const note = 48
      const f0 = hz(note)
      const count = Math.min(128, Math.floor(16000 / f0))
      const open = harmonicDb(await synth.take(sawPatch(), note, 1), f0, count)
      // ENV 1 on its own Env 1 Amount, then ENV 3 through mod matrix route 1 (depth +48: 384 raw).
      for (const [env, raw] of [[1, 384], [1, 512], [3, 512]]) {
        const p = sawPatch(256)
        p.set(`env${env}attacksyncoff`, 0)
        p.set(`env${env}decaysyncoff`, raw)
        p.set(`env${env}sustain`, 0)
        if (env === 1) p.set('filter1env1amount', 768)
        else {
          p.set('modmatrix1modsource', env)
          p.set('modmatrix1modtarget', destinationOf('filter1cutoff')!)
          p.set('modmatrix1depth', 512 + 4 * 48)
        }
        const x = f32(await synth.take(p, note, 3))
        const track: string[] = []
        const shown = labelNumber(show(`env${env}decaysyncoff`, raw))
        for (let t = 0.02; t < 2.6; t += shown / 8000) {
          const h = harmonicsAt(x, RATE, f0, t * RATE, t * RATE + 8 * (RATE / f0), count).amps.map((a) => 20 * Math.log10(a + 1e-9))
          const fit = fitCutoffRatio(h, open)
          track.push(`${(t * 1000).toFixed(0)}ms ${(Math.log2(fit.ratio * f0) - Math.log2(175)).toFixed(2)}`)
        }
        console.log(`ENV ${env} decay ${raw} shows ${shown} ms; octaves over 175 Hz:\n  ${track.join('  ')}`)
      }
    } else if (experiment === 'amp') {
      const note = 48
      const level = (x: Float64Array, from: number, to: number) => {
        let s = 0
        for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) s += x[i] * x[i]
        return 10 * Math.log10(s / ((to - from) * RATE))
      }
      const full = level(await synth.take(sawPatch(), note, 1.5), 0.5, 1.2)
      for (const raw of [256, 384, 512, 576]) {
        const p = sawPatch()
        p.set('env2attacksyncoff', raw)
        const a = analyse({ samples: f32(await synth.take(p, note, 3.5)), sampleRate: RATE })
        console.log(`attack ${raw} shows ${show('env2attacksyncoff', raw)}: rise ${(a.adsr.attackS * 1000).toFixed(0)} ms`)
      }
      for (const raw of [256, 384, 512, 576]) {
        const p = sawPatch()
        p.set('env2decaysyncoff', raw)
        p.set('env2sustain', 0)
        const a = analyse({ samples: f32(await synth.take(p, note, 4)), sampleRate: RATE })
        const shown = labelNumber(show('env2decaysyncoff', raw))
        console.log(`decay ${raw} shows ${shown} ms: to -40 dB ${(a.adsr.decayS * 1000).toFixed(0)} ms (x${((a.adsr.decayS * 1000) / shown).toFixed(2)})`)
      }
      for (const sustain of [128, 512])
        for (const raw of [384, 512]) {
          const p = sawPatch()
          p.set('env2decaysyncoff', raw)
          p.set('env2sustain', sustain)
          const a = analyse({ samples: f32(await synth.take(p, note, 3)), sampleRate: RATE })
          const shown = labelNumber(show('env2decaysyncoff', raw))
          console.log(`decay ${raw} shows ${shown} ms, sustain ${show('env2sustain', sustain)}: to the sustain ${(a.adsr.decayS * 1000).toFixed(0)} ms (x${((a.adsr.decayS * 1000) / shown).toFixed(2)})`)
        }
      for (const raw of [128, 256, 512, 768]) {
        const p = sawPatch()
        p.set('env2decaysyncoff', 64)
        p.set('env2sustain', raw)
        const db = level(await synth.take(p, note, 1.5), 0.5, 1.2) - full
        console.log(`sustain ${raw} (${show('env2sustain', raw)}): ${db.toFixed(1)} dB (linear ${(20 * Math.log10(raw / 1024)).toFixed(1)} dB)`)
      }
      for (const raw of [256, 384, 512]) {
        const p = sawPatch()
        p.set('env2releasesyncoff', raw)
        const shown = labelNumber(show('env2releasesyncoff', raw))
        const x = await synth.take(p, note, 1, [], [])
        // From note-off (1 s) to 40 dB under the held level.
        const held = level(x, 0.5, 0.95)
        let t = 1
        while (t < x.length / RATE - 0.02 && level(x, t, t + 0.01) > held - 40) t += 0.005
        console.log(`release ${raw} shows ${shown} ms: to -40 dB ${((t - 1) * 1000).toFixed(0)} ms (x${(((t - 1) * 1000) / shown).toFixed(2)})`)
      }
    } else if (experiment === 'vibrato') {
      const note = 48
      for (const amount of [5, 20])
        for (const wheel of [0, 127]) {
          const p = sawPatch()
          p.set('voicevibratoamount', amount)
          p.set('voicevibratoratesyncoff', 102) // 5.00 Hz
          const a = analyse({ samples: f32(await synth.take(p, note, 2, [[0, 'cc1', wheel]])), sampleRate: RATE })
          console.log(`voice vibrato ${show('voicevibratoamount', amount)}, wheel ${wheel}: ${JSON.stringify(a.vibrato)}`)
        }
      const p = sawPatch()
      p.set('lfo1wave', 0)
      p.set('lfo1ratesyncoff', 640) // ~5.3 Hz
      p.set('lfo1level', 1024)
      p.set('modmatrix1modsource', 6)
      p.set('modmatrix1modtarget', 11) // Osc 1 Pitch
      p.set('modmatrix1depth', 512 + 4 * 8)
      const a = analyse({ samples: f32(await synth.take(p, note, 2)), sampleRate: RATE })
      console.log(`LFO 1 into Osc 1 Pitch at depth 8: ${JSON.stringify(a.vibrato)} -> at 128: ${((a.vibrato?.depth ?? 0) * 16).toFixed(0)} cents`)
    } else if (experiment === 'velocity') {
      const note = 48
      const f0 = hz(note)
      const count = Math.min(128, Math.floor(16000 / f0))
      const open = harmonicDb(await synth.take(sawPatch(), note, 1), f0, count)
      const level = (x: Float64Array) => {
        let s = 0
        for (let i = Math.round(0.3 * RATE); i < Math.round(0.9 * RATE); i++) s += x[i] * x[i]
        return 10 * Math.log10(s / (0.6 * RATE))
      }
      const rows: [number, number, number][] = []
      for (const velocity of [30, 64, 100, 127]) {
        const p = sawPatch(384)
        p.set('ampvelenv', 512 + 32 * 8)
        p.set('modmatrix1modsource', 19) // Note-On Vel
        p.set('modmatrix1modtarget', destinationOf('filter1cutoff')!)
        p.set('modmatrix1depth', 512 + 4 * 8)
        const x = await synth.take(p, note, 1, [], [], velocity)
        rows.push([velocity, level(x), fitCutoffRatio(harmonicDb(x, f0, count), open).ratio * f0])
      }
      const top = rows[rows.length - 1]
      for (const [velocity, db, cutoff] of rows)
        console.log(`velocity ${velocity}: ${(db - top[1]).toFixed(1)} dB, cutoff ${cutoff.toFixed(0)} Hz (${Math.log2(cutoff / top[2]).toFixed(2)} octaves)`)
    } else if (experiment === 'macro') {
      const note = 48
      const f0 = hz(note)
      const count = Math.min(128, Math.floor(16000 / f0))
      const open = harmonicDb(await synth.take(sawPatch(), note, 1), f0, count)
      // Cutoff raw from Hz at C3 (keytrack 100 %): 1288 Hz at 512, 89.5 raw an octave (cutoff).
      const raw = (cutoffHz: number) => Math.round(512 + 89.5 * Math.log2(cutoffHz / 1288))
      for (const target of ['filter1cutoff', 'modmatrix1depth']) {
        const rows: string[] = []
        for (const knob of [0, 256, 512, 768, 1024]) {
          const p = sawPatch(256)
          if (target === 'modmatrix1depth') {
            p.set('env3attacksyncoff', 0)
            p.set('env3sustain', 1024)
            p.set('modmatrix1modsource', 3)
            p.set('modmatrix1modtarget', destinationOf('filter1cutoff')!)
            p.set('modmatrix1depth', 512)
          }
          p.set('macro1target1', destinationOf(target)!)
          p.set('macro1depth1', 512 + 32 * 4)
          p.set('macro1panelvalue', knob)
          const fit = fitCutoffRatio(harmonicDb(await synth.take(p, note, 1), f0, count), open)
          rows.push(`knob ${knob / 8}: +${raw(fit.ratio * f0) - 256}`)
        }
        console.log(`macro depth 32 on ${target} (cutoff raw over 256): ${rows.join(', ')}`)
      }
    } else if (experiment === 'mixer') {
      const level = (x: Float64Array) => {
        let s = 0
        for (let i = Math.round(0.3 * RATE); i < Math.round(0.9 * RATE); i++) s += x[i] * x[i]
        return 10 * Math.log10(s / (0.6 * RATE))
      }
      let full = 0
      for (const vol of [1024, 768, 512, 256, 128]) {
        const p = sawPatch()
        p.set('mixerosc1vol', 0)
        p.set('osc2type', 0) // Sine
        p.set('mixerosc2vol', vol)
        const db = level(await synth.take(p, 48, 1))
        if (vol === 1024) full = db
        console.log(`Osc 2 Vol ${show('mixerosc2vol', vol)}: ${(db - full).toFixed(1)} dB (linear ${(20 * Math.log10(vol / 1024)).toFixed(1)})`)
      }
    } else if (experiment === 'dirt') {
      const note = 48
      const read = async (p: Patch, hold = 2.5) => analyse({ samples: f32(await synth.take(p, note, hold)), sampleRate: RATE }).dirt
      const fmt = (d: Awaited<ReturnType<typeof read>>) =>
        `drift ${d.drift.toFixed(1)} c, detune ${d.detune ? `${d.detune.cents.toFixed(1)} c ${d.detune.depth.toFixed(1)} dB` : '-'}, chorus ${d.chorus ? `${d.chorus.cents.toFixed(1)} c ${d.chorus.rateHz?.toFixed(1) ?? '?'} Hz beat ${d.chorus.beat.toFixed(1)} dB` : '-'}, noise ${d.noise ? `${d.noise.db.toFixed(1)} dB ${d.noise.slope.toFixed(1)}/oct` : '-'}`
      for (const feel of [0, 32, 64, 127]) {
        const p = sawPatch()
        p.set('voiceanalogfeel', feel)
        console.log(`Analog Feel ${feel}: ${fmt(await read(p))}`)
      }
      for (const vol of [1024, 512, 256]) {
        const p = sawPatch()
        p.set('mixernoisevol', vol)
        console.log(`Noise Vol ${show('mixernoisevol', vol)} (White): ${fmt(await read(p))}`)
      }
      for (let type = 1; type <= 6; type++) {
        const p = sawPatch()
        p.set('mixernoisevol', 1024)
        p.set('noisetype', type)
        console.log(`Noise Type ${show('noisetype', type)} at 128: ${fmt(await read(p))}`)
      }
      for (const [rate, depth] of [[1, 512], [5, 512], [5, 256], [5, 1024]]) {
        const p = sawPatch()
        p.set('prefxtype', 1) // Chorus
        p.set('prefx1param1', rawFor('prefx1param1', rate))
        p.set('prefx1param2', depth)
        p.set('prefxwet', 512)
        console.log(`Chorus ${show('prefx1param1', p.get('prefx1param1'))} Hz, depth ${show('prefx1param2', depth)}, wet 50 %: ${fmt(await read(p))}`)
      }
      for (const vol of [1024, 512]) {
        const p = sawPatch()
        p.set('osc3type', 3)
        p.set('osc3cent', 6)
        p.set('mixerosc3vol', vol)
        console.log(`OSC 3 Saw +6 cents at Vol ${show('mixerosc3vol', vol)}: ${fmt(await read(p))}`)
      }
    } else if (experiment === 'drift') {
      for (const [target, quarter] of [[19, 16], [19, 32], [19, 64], [11, 16], [11, 32]]) {
        const p = sawPatch()
        p.set('lfo3wave', 9) // Random
        p.set('lfo3bpmsync', 0)
        p.set('lfo3ratesyncoff', rawFor('lfo3ratesyncoff', 1.5))
        p.set('lfo3smooth', 127)
        p.set('lfo3level', 1024)
        p.set('modmatrix1modsource', 8) // LFO 3
        p.set('modmatrix1modtarget', target)
        p.set('modmatrix1depth', 512 + quarter)
        const d = analyse({ samples: f32(await synth.take(p, 48, 3)), sampleRate: RATE }).dirt
        console.log(`${show('modmatrix1modtarget', target)} at depth ${quarter / 4}: drift ${d.drift.toFixed(1)} c`)
      }
    } else if (experiment === 'chorus') {
      const rows: string[] = []
      for (const wet of [512, 1024])
        for (const depth of [128, 256, 512])
          for (const rate of [0.5, 1.5, 3, 6]) {
            const p = sawPatch()
            p.set('prefxtype', 1) // Chorus
            p.set('prefx1param1', rawFor('prefx1param1', rate))
            p.set('prefx1param2', depth)
            p.set('prefx1param4', 64) // Feedback 0
            p.set('prefxwet', wet)
            const d = analyse({ samples: f32(await synth.take(p, 48, 3)), sampleRate: RATE }).dirt
            const c = d.chorus
            const row = `{ rate: ${rate}, depth: ${depth}, wet: ${wet}, cents: ${c ? c.cents.toFixed(1) : 0}, beat: ${c ? c.beat.toFixed(1) : 0}, read: ${c?.rateHz?.toFixed(1) ?? 'null'} }, // drift ${d.drift.toFixed(1)}`
            console.log(row)
            rows.push(row)
          }
    } else if (experiment === 'ensemble') {
      for (const depth of [512, 768])
        for (const wet of [512, 640, 768, 896]) {
          const p = sawPatch()
          p.set('prefxtype', 1) // Chorus
          p.set('prefx1param1', rawFor('prefx1param1', 0.6))
          p.set('prefx1param2', depth)
          p.set('prefx1param4', 64) // Feedback 0
          p.set('prefxwet', wet)
          p.set('postfxtype', 1)
          p.set('postfx1param1', rawFor('postfx1param1', 6))
          p.set('postfx1param2', depth / 2)
          p.set('postfx1param4', 64)
          p.set('postfxwet', wet)
          for (let take = 0; take < 2; take++) {
            const d = analyse({ samples: f32(await synth.take(p, 48, 3)), sampleRate: RATE }).dirt
            const c = d.chorus
            console.log(`{ depth: ${depth}, wet: ${wet}, cents: ${c ? c.cents.toFixed(1) : 0}, beat: ${c ? c.beat.toFixed(1) : 0} }, // detune ${d.detune ? d.detune.cents.toFixed(1) : '-'}, drift ${d.drift.toFixed(1)}`)
          }
        }
    } else if (experiment === 'pitchenv') {
      const note = 48
      const sine = () => {
        const p = sawPatch()
        p.set('osc1type', 0)
        p.set('env4bpmsync', 0)
        p.set('env4attacksyncoff', 0)
        p.set('modmatrix1modsource', 4) // Env 4
        p.set('modmatrix1modtarget', 19) // All Osc Pitch
        return p
      }
      /** The pitch (semitones from C3) every 40 ms, each window 30 ms, from its own period search. */
      const pitchTrack = (x: Float32Array) => {
        const out: number[] = []
        for (let t = 0; t + 0.03 * RATE < x.length; t += 0.04 * RATE) {
          const { period, clarity } = detectPeriod(x, RATE, t, t + Math.round(0.03 * RATE))
          out.push(period && clarity > 0.8 ? 12 * Math.log2(RATE / period / hz(note)) : NaN)
        }
        return out
      }
      for (const depth of [8, 16, 32]) {
        const p = sine()
        p.set('env4sustain', 1024)
        p.set('modmatrix1depth', 512 + 4 * depth)
        const track = pitchTrack(f32(await synth.take(p, note, 1))).filter(Number.isFinite)
        const held = track.slice(Math.floor(track.length / 2))
        console.log(`depth ${depth}, held: ${(held.reduce((s, v) => s + v, 0) / held.length).toFixed(2)} semitones`)
      }
      for (const curve of [64, 0, 96, 128]) {
        const p = sine()
        p.set('env4sustain', 0)
        p.set('env4decaysyncoff', 512) // 896 ms
        p.set('env4deccurve', curve)
        p.set('modmatrix1depth', 512 + 4 * 64)
        const track = pitchTrack(f32(await synth.take(p, note, 2)))
        console.log(`decay 896 ms, curve ${show('env4deccurve', curve)}: ${track.slice(0, 30).map((v, i) => (i % 2 ? '' : `${i * 40}ms ${v.toFixed(1)}`)).filter(Boolean).join('  ')}`)
      }
    } else if (experiment === 'resonance') {
      const note = 48
      const f0 = hz(note)
      const count = Math.min(128, Math.floor(16000 / f0))
      const open = harmonicDb(await synth.take(sawPatch(), note, 1), f0, count)
      const top = Math.max(...open)
      for (const cutoff of [448, 576])
        for (const resonance of [0, 256, 512, 640, 768, 896]) {
          const p = sawPatch(cutoff)
          p.set('filter1resonance', resonance)
          const got = harmonicDb(await synth.take(p, note, 1), f0, count)
          let best = { ratio: 1, q: 0.5, rms: Infinity }
          for (let o = 0; o <= 7; o += 1 / 32)
            for (let q = 0.4; q <= 12; q *= 1.06) {
              const d = open.flatMap((v, k) => (v < top - 50 || got[k] < top - 70 ? [] : [got[k] - v - lpDb((k + 1) / 2 ** o, q)]))
              if (d.length < 3) continue
              const mean = d.reduce((s, v) => s + v, 0) / d.length
              const rms = Math.sqrt(d.reduce((s, v) => s + (v - mean) ** 2, 0) / d.length)
              if (rms < best.rms) best = { ratio: 2 ** o, q, rms }
            }
          console.log(`cutoff ${cutoff}, resonance ${show('filter1resonance', resonance)}: ${(best.ratio * f0).toFixed(0)} Hz, Q ${best.q.toFixed(2)}, fit ${best.rms.toFixed(1)} dB`)
        }
    } else if (experiment === 'ladder') {
      const note = 48
      const nominal = 1288 // Hz at Cutoff 512, C3 (CALIBRATION.cutoff)
      const grid = Array.from({ length: 97 }, (_, i) => 62.5 * 2 ** (i / 12)) // 62.5 Hz .. 16 kHz
      /** Power density (dB) at each grid frequency (1/12 octave wide), Welch over 0.3..1.5 s. */
      const spectrum = (x: Float64Array) => {
        const n = 8192
        const acc = new Float64Array(n / 2)
        let windows = 0
        for (let s = Math.round(0.3 * RATE); s + n < Math.round(1.5 * RATE); s += n / 2, windows++) {
          const re = new Float64Array(n)
          const im = new Float64Array(n)
          for (let i = 0; i < n; i++) re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)))
          fft(re, im)
          for (let b = 0; b < n / 2; b++) acc[b] += re[b] ** 2 + im[b] ** 2
        }
        return grid.map((hz) => {
          const lo = Math.floor(hz / 2 ** (1 / 24) / (RATE / n))
          const hi = Math.max(lo, Math.ceil((hz * 2 ** (1 / 24)) / (RATE / n)))
          let sum = 0
          for (let b = lo; b <= hi; b++) sum += acc[b]
          return 10 * Math.log10(sum / (hi - lo + 1) / windows + 1e-30)
        })
      }
      const noisePatch = (cutoff: number, resonance: number) => {
        const p = sawPatch(cutoff)
        p.set('mixerosc1vol', 0)
        p.set('mixernoisevol', 1024)
        p.set('noisetype', 0)
        p.set('filter1resonance', resonance)
        return p
      }
      const open = spectrum(await synth.take(noisePatch(1024, 0), note, 1.6))
      const resonances = [0, 256, 384, 512, 640, 704, 768, 832]
      const table: number[][] = []
      for (const resonance of resonances) {
        const response = spectrum(await synth.take(noisePatch(512, resonance), note, 1.6)).map((v, i) => Math.round((v - open[i]) * 10) / 10)
        table.push(response)
        const peak = Math.max(...response)
        console.log(`resonance ${show('filter1resonance', resonance)}: peak ${peak.toFixed(1)} dB at ${(grid[response.indexOf(peak)] / nominal).toFixed(2)}x, at 0.25x ${response[grid.findIndex((hz) => hz >= nominal / 4)].toFixed(1)} dB`)
      }
      for (const cutoff of [384, 640]) {
        const response = spectrum(await synth.take(noisePatch(cutoff, 768), note, 1.6)).map((v, i) => v - open[i])
        const peak = Math.max(...response)
        const ratio = grid[response.indexOf(peak)] / (nominal * 2 ** ((cutoff - 512) / 89.5))
        console.log(`cutoff ${cutoff}, resonance 96: peak ${peak.toFixed(1)} dB at ${ratio.toFixed(2)}x its cutoff (at 512: ${(grid[table[6].indexOf(Math.max(...table[6]))] / nominal).toFixed(2)}x)`)
      }
      writeFileSync(
        'src/ui/ladderResponse.generated.ts',
        `// Generated by tools/calibrateWavPatch.ts ladder: LP Ladder 12's response, measured on the synth with its white
// noise at Cutoff 512 (C3, keytrack 100 %: ${nominal} Hz), per Resonance (raw): dB against the noise unfiltered, every
// 1/12 octave from ${(grid[0] / nominal).toFixed(4)} times the cutoff.
export const LADDER_RESPONSE = ${JSON.stringify({ firstRatio: grid[0] / nominal, perOctave: 12, resonances, db: table })}
`,
      )
    } else if (experiment === 'resonanceset') {
      const dir = 'local/wav-tests/rig-res'
      mkdirSync(dir, { recursive: true })
      for (const [source, type] of [['saw', 3], ['square', 4]] as const)
        for (const resonance of [0, 512, 704, 832])
          for (const filter of ['448', '576', 'sweep', 'sweep-short'])
            for (const note of [36, 48]) {
              const p = sawPatch(filter === '448' ? 448 : filter === '576' ? 576 : 320)
              p.set('osc1type', type)
              p.set('filter1resonance', resonance)
              if (filter.startsWith('sweep')) {
                p.set('env1attacksyncoff', 0)
                p.set('env1decaysyncoff', 448)
                p.set('env1sustain', 0)
                p.set('filter1env1amount', 512 + 336) // up to ~832 at the top
              }
              await synth.take(p, note, filter === 'sweep-short' ? 0.25 : 1.5)
              const name = `${source}-res${resonance}-${filter}-${note === 36 ? 'C2' : 'C3'}.wav`
              copyFileSync(FILE, `${dir}/${name}`)
              console.log(name)
            }
    } else if (experiment === 'tremolo') {
      for (const amount of [576, 640, 768, 1024]) {
        const p = sawPatch()
        p.set('lfo2wave', 0)
        p.set('lfo2ratesyncoff', 600) // ~4 Hz
        p.set('lfo2level', 1024)
        p.set('amplfo2amount', amount)
        const a = analyse({ samples: f32(await synth.take(p, 48, 2)), sampleRate: RATE })
        console.log(`LFO 2 ${show('lfo2ratesyncoff', 600)} Hz, Amp LFO 2 Amount ${show('amplfo2amount', amount)}: ${JSON.stringify(a.tremolo)}`)
      }
    } else {
      console.log('Usage: npx vite-node tools/calibrateWavPatch.ts cutoff|envamount|filterenv|amp|vibrato|velocity|tremolo')
    }
  } finally {
    synth.close()
  }
}

void main()
