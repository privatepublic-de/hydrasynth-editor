/** In-place radix-2 FFT of `re` + i `im` (length a power of two). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const step = (-2 * Math.PI) / len
    for (let k = 0; k < len / 2; k++) {
      const c = Math.cos(step * k)
      const s = Math.sin(step * k)
      for (let i = k; i < n; i += len) {
        const j = i + len / 2
        const tr = re[j] * c - im[j] * s
        const ti = re[j] * s + im[j] * c
        re[j] = re[i] - tr
        im[j] = im[i] - ti
        re[i] += tr
        im[i] += ti
      }
    }
  }
}
