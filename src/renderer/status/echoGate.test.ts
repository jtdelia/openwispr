import { describe, expect, it } from 'vitest'
import { EchoDetector } from './echoDetector'
import { ECHO_HOLD_MS, ECHO_MAX_HOLD_MS, EchoGate } from './echoGate'
import { delayed, mix, noise, RATE } from './testAudio'

const FRAME = 1024

function feed(detector: EchoDetector, source: 'mic' | 'system', from: number, to: number): void {
  for (let at = Math.round(from * RATE); at < Math.round(to * RATE); at += FRAME) {
    detector.push(source, new Float32Array(FRAME), at)
  }
}

function setup() {
  const detector = new EchoDetector()
  const gate = new EchoGate(detector, RATE)
  const sent: number[] = []
  const hold = (start: number, end: number) =>
    gate.hold({ start: start * RATE, end: end * RATE, samples: noise(end - start, 0.1, 1), send: () => sent.push(start) })
  return { detector, gate, sent, hold }
}

describe('EchoGate', () => {
  it('holds a chunk until the detector has decided past it', () => {
    const { detector, gate, sent, hold } = setup()
    hold(0, 1)
    feed(detector, 'system', 0, 3)
    feed(detector, 'mic', 0, 3)
    gate.releaseDecided(true)
    expect(sent).toEqual([])
    const decided = 1 + ECHO_HOLD_MS / 1000 + 0.4
    feed(detector, 'system', 3, decided)
    feed(detector, 'mic', 3, decided)
    gate.releaseDecided(true)
    expect(sent).toEqual([0])
  })

  it('sends right away without call audio', () => {
    const { gate, sent, hold } = setup()
    hold(0, 1)
    gate.releaseDecided(false)
    expect(sent).toEqual([0])
  })

  it('stops waiting on a stalled call stream', () => {
    const { detector, gate, sent, hold } = setup()
    hold(0, 1)
    feed(detector, 'system', 0, 1)
    feed(detector, 'mic', 0, 1 + ECHO_MAX_HOLD_MS / 1000)
    gate.releaseDecided(true)
    expect(sent).toEqual([0])
  })

  it('drops a chunk that is all echo and keeps the user speaking after the call', () => {
    const { detector, gate, sent } = setup()
    const call = noise(15, 0.1, 2)
    call.fill(0, 8 * RATE)
    const reply = noise(15, 0.1, 3)
    reply.fill(0, 0, 9 * RATE)
    const mic = mix(delayed(call, 120, 0.3), reply)
    for (let at = 0; at < mic.length; at += FRAME) {
      detector.push('system', call.subarray(at, at + FRAME), at)
      detector.push('mic', mic.subarray(at, at + FRAME), at)
    }
    for (const [start, end] of [[3, 7], [9.5, 11]] as const) {
      const samples = mic.slice(start * RATE, end * RATE)
      gate.hold({ start: start * RATE, end: end * RATE, samples, send: () => sent.push(start) })
    }
    gate.releaseDecided(true)
    expect(sent).toEqual([9.5])
  })

  it('sends everything in order on flush', () => {
    const { gate, sent, hold } = setup()
    hold(0, 1)
    hold(1, 2)
    gate.flush()
    expect(sent).toEqual([0, 1])
  })
})
