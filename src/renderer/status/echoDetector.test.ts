import { describe, expect, it } from 'vitest'
import { EchoDetector, Fft, gccPhat, silenceSpans } from './echoDetector'

const RATE = 16_000
const FRAME = 1024

/** Mulberry32 white noise; a plain LCG's low bits correlate with shifted copies of themselves. */
function noise(seconds: number, amplitude: number, seed: number): Float32Array {
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

function delayed(source: Float32Array, delayMs: number, gain: number): Float32Array {
  const shift = Math.round((delayMs / 1000) * RATE)
  const out = new Float32Array(source.length)
  for (let i = shift; i < source.length; i++) out[i] = source[i - shift]! * gain
  return out
}

function mix(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts[0]!.length)
  for (const part of parts) for (let i = 0; i < out.length; i++) out[i] = out[i]! + part[i]!
  return out
}

function run(mic: Float32Array, system: Float32Array): EchoDetector {
  const detector = new EchoDetector()
  for (let at = 0; at < mic.length; at += FRAME) {
    detector.push('system', system.subarray(at, at + FRAME), at)
    detector.push('mic', mic.subarray(at, at + FRAME), at)
  }
  return detector
}

function seconds(detector: EchoDetector, from: number, to: number): number {
  return detector.spans(from * RATE, to * RATE).reduce((n, s) => n + Math.min(s.end, to * RATE) - Math.max(s.start, from * RATE), 0) / RATE
}

describe('gccPhat', () => {
  it('finds how far one signal trails the other', () => {
    const fft = new Fft(1024)
    const y = Float64Array.from(noise(1024 / RATE, 1, 7))
    const x = new Float64Array(1024)
    for (let i = 40; i < 1024; i++) x[i] = y[i - 40]! * 0.5
    const { peak, lag } = gccPhat(fft, x, y)
    expect(lag).toBe(40)
    expect(peak).toBeGreaterThan(0.5)
  })
})

describe('EchoDetector', () => {
  it('marks mic audio that repeats the call a moment later', () => {
    const system = noise(10, 0.1, 1)
    const mic = mix(delayed(system, 120, 0.3), noise(10, 0.001, 2))
    const detector = run(mic, system)
    expect(seconds(detector, 2, 9)).toBeGreaterThan(6)
  })

  it('leaves independent speech on both sides alone', () => {
    const detector = run(noise(10, 0.1, 3), noise(10, 0.1, 4))
    expect(detector.spans(0, 10 * RATE)).toEqual([])
  })

  it('stops marking as soon as the call goes quiet and the user answers', () => {
    const call = noise(10, 0.1, 5)
    call.fill(0, 6 * RATE)
    const reply = noise(10, 0.1, 6)
    reply.fill(0, 0, Math.round(6.5 * RATE))
    const mic = mix(delayed(call, 120, 0.3), reply)
    const detector = run(mic, call)
    expect(seconds(detector, 2, 6)).toBeGreaterThan(3)
    expect(seconds(detector, 7, 10)).toBe(0)
  })

  it('does nothing until both streams are present', () => {
    const detector = new EchoDetector()
    detector.push('mic', noise(3, 0.1, 8), 0)
    expect(detector.analyzedThrough).toBe(Number.NEGATIVE_INFINITY)
  })
})

describe('silenceSpans', () => {
  it('zeroes only the covered samples', () => {
    const samples = new Float32Array(10).fill(1)
    expect(silenceSpans(samples, 100, [{ start: 98, end: 102 }, { start: 108, end: 120 }])).toBe(4)
    expect(Array.from(samples)).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 0, 0])
  })
})
