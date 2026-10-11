import { describe, expect, it } from 'vitest'
import { SpeechChunker } from './speechChunker'

const RATE = 1000
const FRAME = 100

const speech = () => new Float32Array(FRAME).fill(0.2)
const silence = () => new Float32Array(FRAME)

function feed(chunker: SpeechChunker, pattern: string) {
  const chunks = []
  for (const c of pattern) {
    const chunk = chunker.push(c === 's' ? speech() : silence())
    if (chunk) chunks.push(chunk)
  }
  return chunks
}

const options = { sampleRate: RATE, minChunkMs: 1000, maxChunkMs: 3000, pauseMs: 300, prerollMs: 200, minSpeechMs: 300 }

describe('SpeechChunker', () => {
  it('never emits pure silence', () => {
    const chunker = new SpeechChunker(options)
    expect(feed(chunker, '.'.repeat(80))).toEqual([])
    expect(chunker.flush()).toBeNull()
  })

  it('cuts at the first pause after the minimum length, keeping a short preroll', () => {
    const chunker = new SpeechChunker(options)
    const [chunk, ...rest] = feed(chunker, '.....ssssssss...')
    expect(rest).toEqual([])
    expect(chunk).toBeDefined()
    expect(chunk!.startSample).toBe(300)
    expect(chunk!.endSample).toBe(1600)
    expect(chunk!.samples.length).toBe(1300)
  })

  it('does not cut at pauses before the minimum length', () => {
    const chunker = new SpeechChunker(options)
    expect(feed(chunker, 'sss...s')).toEqual([])
  })

  it('forces a cut at the maximum length during continuous speech', () => {
    const chunker = new SpeechChunker(options)
    const chunks = feed(chunker, 's'.repeat(31))
    expect(chunks.map((c) => [c.startSample, c.endSample])).toEqual([[0, 3000]])
  })

  it('drops chunks with too little speech, such as a cough', () => {
    const chunker = new SpeechChunker(options)
    expect(feed(chunker, 'ss' + '.'.repeat(15))).toEqual([])
    expect(chunker.flush()).toBeNull()
  })

  it('cuts at a short pause before the minimum length when asked to, e.g. on a speaker change', () => {
    const chunker = new SpeechChunker({ ...options, requestedCutMinMs: 300, requestedCutPauseMs: 100 })
    expect(feed(chunker, 'ssss')).toEqual([])
    chunker.requestCut()
    const chunks = feed(chunker, '.sss')
    expect(chunks.map((c) => [c.startSample, c.endSample])).toEqual([[0, 500]])
    expect(feed(chunker, '.sss.')).toEqual([])
  })

  it('flushes buffered speech when recording stops', () => {
    const chunker = new SpeechChunker(options)
    feed(chunker, 'ssss')
    const chunk = chunker.flush()
    expect(chunk && [chunk.startSample, chunk.endSample]).toEqual([0, 400])
    expect(chunker.msAt(400)).toBe(400)
  })
})
