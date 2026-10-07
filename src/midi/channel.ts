/** Channel messages; `channel` is 1-16 as shown on the synth. */
export const controlChange = (channel: number, cc: number, value: number) => [0xb0 | (channel - 1), cc, value]
export const programChange = (channel: number, program: number) => [0xc0 | (channel - 1), program]

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
