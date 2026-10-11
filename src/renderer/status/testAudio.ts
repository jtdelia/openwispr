export const RATE = 16_000

/** Mulberry32 white noise; a plain LCG's low bits correlate with shifted copies of themselves. */
export function noise(seconds: number, amplitude: number, seed: number): Float32Array {
  let state = seed
  const out = new Float32Array(Math.round(seconds * RATE))
  for (let i = 0; i < out.length; i++) {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    out[i] = ((((t ^ (t >>> 14)) >>> 0) / 2 ** 32) * 2 - 1) * amplitude
  }
  return out
}

export function delayed(source: Float32Array, delayMs: number, gain: number): Float32Array {
  const shift = Math.round((delayMs / 1000) * RATE)
  const out = new Float32Array(source.length)
  for (let i = shift; i < source.length; i++) out[i] = source[i - shift]! * gain
  return out
}

export function mix(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts[0]!.length)
  for (const part of parts) for (let i = 0; i < out.length; i++) out[i] = out[i]! + part[i]!
  return out
}
