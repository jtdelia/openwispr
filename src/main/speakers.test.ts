import { describe, expect, it } from 'vitest'
import { transcriptTurns, withoutEchoes } from '../shared/speakers'
import type { TranscriptEntry } from '../shared/types'
import { parseSegments, segmentFormat } from './providers'
import { SpeakerIdentityMap } from './speakerIdentity'
import { SpeakerTimeline } from './speakerTimeline'
import { sliceWav, VoiceBank } from './voices'

const entry = (source: TranscriptEntry['source'], startMs: number, text: string, speaker?: string): TranscriptEntry => ({
  id: `${source}-${startMs}`,
  source,
  text,
  startMs,
  endMs: startMs + 2000,
  ...(speaker ? { speaker } : {}),
})

function wav(durationMs: number, sampleRate = 16_000): Buffer {
  const samples = Math.round((durationMs / 1000) * sampleRate)
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples * 2, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples * 2, 40)
  return buffer
}

describe('SpeakerTimeline', () => {
  const timeline = new SpeakerTimeline()
  timeline.push({ at: 1000, speaking: ['Alice'] })
  timeline.push({ at: 5000, speaking: [] })
  timeline.push({ at: 6000, speaking: ['Bob'] })
  timeline.push({ at: 8000, speaking: ['Alice', 'Bob'] })

  it('credits a segment to whoever was shown talking through most of it', () => {
    expect(timeline.dominant(1000, 5500)).toBe('Alice')
    expect(timeline.dominant(4500, 7900)).toBe('Bob')
  })

  it('leaves mixed, uncovered or unobserved segments unattributed', () => {
    expect(timeline.dominant(3500, 7500)).toBeNull()
    expect(timeline.dominant(0, 900)).toBeNull()
    expect(timeline.dominant(4800, 6100)).toBeNull()
  })
})

describe('SpeakerIdentityMap', () => {
  it('names a voice after repeated sightings and keeps the name through gaps', () => {
    const map = new SpeakerIdentityMap()
    expect(map.resolve('voice:1', 'Alice', 0)).toBeNull()
    expect(map.resolve('voice:1', 'Alice', 1000)).toBeNull()
    expect(map.resolve('voice:1', 'Alice', 2000)).toBe('Alice')
    expect(map.resolve('voice:1', null, 3000)).toBe('Alice')
  })

  it('needs sustained conflicting evidence to rename, and not again within the cooldown', () => {
    const map = new SpeakerIdentityMap({ promoteThreshold: 1, remapThreshold: 2, remapCooldownMs: 10_000 })
    map.resolve('voice:1', 'Alice', 0)
    expect(map.resolve('voice:1', 'Bob', 1000)).toBe('Alice')
    expect(map.resolve('voice:1', 'Bob', 2000)).toBe('Bob')
    expect(map.resolve('voice:1', 'Carol', 3000)).toBe('Bob')
    expect(map.resolve('voice:1', 'Carol', 4000)).toBe('Bob')
  })
})

describe('VoiceBank', () => {
  it('turns new labels into numbered voices with a reference clip, then recognizes them', () => {
    const bank = new VoiceBank(3)
    const ids = bank.assign(
      [
        { startMs: 0, endMs: 2500, text: 'Hello', speaker: 'A' },
        { startMs: 2500, endMs: 3000, text: 'Hi', speaker: 'B' },
      ],
      wav(3000),
    )
    expect([...ids]).toEqual([['A', 3]])
    const known = bank.knownSpeakers()!
    expect(known.names).toEqual(['speaker_3'])
    expect(known.references[0]).toMatch(/^data:audio\/wav;base64,/)
    expect(bank.assign([{ startMs: 0, endMs: 1000, text: 'Yes', speaker: 'speaker_3' }], wav(1000)).get('speaker_3')).toBe(3)
  })

  it('slices WAV audio by time', () => {
    const clip = sliceWav(wav(3000), 1000, 2500)
    expect(clip.length).toBe(44 + 1.5 * 16_000 * 2)
    expect(clip.readUInt32LE(40)).toBe(1.5 * 16_000 * 2)
  })
})

describe('transcription segments', () => {
  it('picks the response format the model supports', () => {
    expect(segmentFormat('gpt-4o-transcribe-diarize')).toBe('diarized_json')
    expect(segmentFormat('whisper-large-v3-turbo')).toBe('verbose_json')
    expect(segmentFormat('gpt-4o-mini-transcribe')).toBe('json')
  })

  it('reads timed and diarized segments, falling back to the whole text', () => {
    expect(parseSegments({ segments: [{ start: 0.5, end: 2, text: ' Hi ', speaker: 'A' }] }, 5000)).toEqual([
      { startMs: 500, endMs: 2000, text: 'Hi', speaker: 'A' },
    ])
    expect(parseSegments({ text: 'Hello there' }, 5000)).toEqual([
      { startMs: 0, endMs: 5000, text: 'Hello there', speaker: null },
    ])
    expect(parseSegments({ text: '' }, 5000)).toEqual([])
  })
})

describe('transcript turns', () => {
  it('drops microphone echoes of the call audio', () => {
    const entries = [
      entry('system', 0, 'We should ship the release on Friday', 'app:Alice'),
      entry('mic', 500, 'we should ship the release on friday'),
      entry('mic', 9000, 'Sounds good to me, thanks'),
    ]
    expect(withoutEchoes(entries).map((e) => e.startMs)).toEqual([0, 9000])
  })

  it('starts a new turn when the speaker changes within the call audio', () => {
    const turns = transcriptTurns([
      entry('system', 0, 'One.', 'app:Alice'),
      entry('system', 2000, 'Two.', 'app:Alice'),
      entry('system', 4000, 'Three.', 'voice:1'),
      entry('system', 6000, 'Four.'),
    ])
    expect(turns.map((t) => [t.speaker, t.text])).toEqual([
      ['app:Alice', 'One. Two.'],
      ['voice:1', 'Three.'],
      ['others', 'Four.'],
    ])
  })
})
