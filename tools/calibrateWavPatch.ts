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
//   tremolo    a Sine LFO 2 at 4 Hz through Amp LFO 2 Amount +16: dB to either side
// Usage: npx vite-node tools/calibrateWavPatch.ts <experiment>
import { analyse } from '../src/audio/analyse'
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
        `drift ${d.drift.toFixed(1)} c, detune ${d.detune ? `${d.detune.cents.toFixed(1)} c ${d.detune.depth.toFixed(1)} dB` : '-'}, ensemble ${d.ensemble ? `${d.ensemble.rateHz.toFixed(1)} Hz ${d.ensemble.depth.toFixed(1)} dB` : '-'}, noise ${d.noise ? `${d.noise.db.toFixed(1)} dB ${d.noise.slope.toFixed(1)}/oct` : '-'}`
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
