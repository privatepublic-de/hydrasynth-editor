// Writes the 219 wave pictures (public/waves, Thierry Rochebois Zic, CC BY 4.0) without the
// wave's name to public/waves-plain: the editor shows the name next to the picture anyway.
// The name is white text, anti-aliased in pure greys, in the bottom-left corner; the waves and
// bars are coloured, even at their faintest anti-aliased edge. So in the name's corner every
// grey pixel goes black; where a letter crossed the line, the line's colour is put back from
// the line pixels around it.
// Usage: npx vite-node tools/stripWaveNames.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const WAVES = 219
// Where the names are (measured over all pictures: x 12..155, y 71..95), with a margin but
// inside the picture's grey frame (which starts at y = 96).
const NAME = { x0: 8, y0: 68, x1: 160, y1: 95 }
/** The frame's grey. */
const FRAME = 15
/** Grey: channels within this of each other. */
const GREY = 8

mkdirSync('public/waves-plain', { recursive: true })
let touched = 0
for (let w = 0; w < WAVES; w++) {
  const img = PNG.sync.read(readFileSync(`public/waves/${w}.png`))
  const px = (x: number, y: number) => (y * img.width + x) * 4
  const chroma = (i: number) => Math.max(img.data[i], img.data[i + 1], img.data[i + 2]) - Math.min(img.data[i], img.data[i + 1], img.data[i + 2])
  const text: [number, number][] = []
  for (let y = NAME.y0; y <= NAME.y1; y++) {
    for (let x = NAME.x0; x <= NAME.x1; x++) {
      const i = px(x, y)
      if (chroma(i) <= GREY && Math.max(img.data[i], img.data[i + 1], img.data[i + 2]) > 0) text.push([x, y])
    }
  }
  const isText = new Set(text.map(([x, y]) => y * img.width + x))
  for (const [x, y] of text) {
    const i = px(x, y)
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 0
  }
  // Pixels where a letter's edge blended into the line: paler than the line, but not grey.
  // Give them the strongest line colour among their non-text neighbours, at their own brightness.
  for (let y = NAME.y0; y <= NAME.y1; y++) {
    for (let x = NAME.x0; x <= NAME.x1; x++) {
      const i = px(x, y)
      if (isText.has(y * img.width + x) || chroma(i) === 0) continue
      const nextToText = [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => isText.has((y + dy) * img.width + x + dx)))
      if (!nextToText) continue
      let best = -1
      let colour: number[] = []
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const j = px(x + dx, y + dy)
          if (isText.has((y + dy) * img.width + x + dx)) continue
          const c = chroma(j)
          const pale = Math.min(img.data[j], img.data[j + 1], img.data[j + 2])
          if (c > best && pale < Math.max(img.data[j], img.data[j + 1], img.data[j + 2]) * 0.6) {
            best = c
            colour = [img.data[j], img.data[j + 1], img.data[j + 2]]
          }
        }
      }
      if (best <= chroma(i)) continue
      const level = Math.max(img.data[i], img.data[i + 1], img.data[i + 2]) / Math.max(...colour)
      for (let k = 0; k < 3; k++) img.data[i + k] = Math.round(colour[k] * Math.min(1, level))
    }
  }
  // Descenders (the q in "Sqarbel") reach into the frame: back to the frame's grey.
  for (let y = NAME.y1 + 1; y <= NAME.y1 + 2; y++) {
    for (let x = NAME.x0; x <= NAME.x1; x++) {
      const i = px(x, y)
      if (chroma(i) <= GREY && img.data[i] > FRAME) img.data[i] = img.data[i + 1] = img.data[i + 2] = FRAME
    }
  }
  if (text.length) touched++
  writeFileSync(`public/waves-plain/${w}.png`, PNG.sync.write(img))
}
console.log(`${touched} of ${WAVES} pictures had a name removed`)
