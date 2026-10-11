import { describe, expect, it } from 'vitest'
import { EchoDetector, Fft, gccPhat, silenceSpans, type EchoDetectorConfig } from './echoDetector'
import { delayed, mix, noise, RATE } from './testAudio'

const FRAME = 1024

function run(mic: Float32Array, system: Float32Array, options: Partial<EchoDetectorConfig> = {}): EchoDetector {
  const detector = new EchoDetector(options)
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
    const { score, lag } = gccPhat(fft, x, y)
    expect(lag).toBe(40)
    expect(score).toBeGreaterThan(0.5)
  })
})

describe('EchoDetector', () => {
  it('marks mic audio that repeats the call a moment later', () => {
    const system = noise(10, 0.1, 1)
    const mic = mix(delayed(system, 120, 0.3), noise(10, 0.001, 2))
    const detector = run(mic, system)
    expect(seconds(detector, 2, 9)).toBeGreaterThan(6)
    expect(detector.stats.lagMs).toBeCloseTo(120, 0)
  })

  it('keeps marking through short pauses in the call', () => {
    const system = noise(10, 0.1, 9)
    for (let at = 2; at < 10; at += 1.5) system.fill(0, Math.round(at * RATE), Math.round((at + 0.3) * RATE))
    const mic = mix(delayed(system, 120, 0.3), noise(10, 0.001, 10))
    const detector = run(mic, system)
    expect(seconds(detector, 3, 9)).toBeGreaterThan(5)
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

  it('lets go after a quiet freeze when the mic stops hearing the call', () => {
    const call = noise(10, 0.1, 11)
    const echo = delayed(call, 120, 0.3)
    echo.fill(0, 4 * RATE)
    const reply = noise(10, 0.1, 12)
    reply.fill(0, 0, 5 * RATE)
    const detector = run(mix(echo, reply), call)
    expect(seconds(detector, 2, 4)).toBeGreaterThan(1.5)
    expect(seconds(detector, 5.5, 10)).toBe(0)
  })

  it('picks the echo back up after the call pauses', () => {
    const call = noise(12, 0.1, 15)
    call.fill(0, 4 * RATE, 5 * RATE)
    const mic = mix(delayed(call, 120, 0.3), noise(12, 0.001, 16))
    const detector = run(mic, call)
    expect(seconds(detector, 6.5, 11)).toBeGreaterThan(4)
  })

  it('stops deciding once analysis is too slow', () => {
    const system = noise(10, 0.1, 13)
    const detector = run(delayed(system, 120, 0.3), system, { slowAnalysisMs: -1 })
    expect(detector.stats.disabled).toBe(true)
    expect(detector.spans(0, 10 * RATE)).toEqual([])
  })

  it('carries an ongoing echo over the unanalyzed tail', () => {
    const system = noise(6.1, 0.1, 14)
    const detector = run(delayed(system, 120, 0.3), system)
    const before = detector.analyzedThrough
    detector.finish()
    expect(detector.analyzedThrough).toBeGreaterThan(before)
    expect(seconds(detector, before / RATE, detector.analyzedThrough / RATE)).toBeCloseTo((detector.analyzedThrough - before) / RATE, 3)
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
    silenceSpans(samples, 100, [{ start: 98, end: 102 }, { start: 108, end: 120 }])
    expect(Array.from(samples)).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 0, 0])
  })
})
