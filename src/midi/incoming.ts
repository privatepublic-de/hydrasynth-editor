// What the synth sends on its channel when it's played or edited from its panel (Param TX =
// NRPN): every knob as CC 99/98/6/38, the value complete with CC 38; a patch change as bank
// select (CC 0 / 32) and program change (seen 2026-10-08).

export interface IncomingHandlers {
  nrpn(param: number, value: number): void
  program(bank: number, patch: number): void
}

/** Feeds channel messages in, calls back with whole NRPNs and program changes on `channel`. */
export function incomingParser(channel: () => number, on: IncomingHandlers) {
  const cc: Record<number, number> = {}
  return (m: Uint8Array) => {
    const status = m[0] & 0xf0
    if ((m[0] & 0x0f) !== channel() - 1) return
    if (status === 0xb0) {
      cc[m[1]] = m[2]
      if (m[1] === 38 && cc[99] !== undefined && cc[98] !== undefined && cc[6] !== undefined) {
        on.nrpn((cc[99] << 7) | cc[98], (cc[6] << 7) | m[2])
      }
    } else if (status === 0xc0) {
      on.program(cc[32] ?? 0, m[1])
    }
  }
}
