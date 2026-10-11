import type { KnownSpeakers, TranscriptSegment } from './providers'

const WAV_HEADER_BYTES = 44
/** OpenAI accepts 2-10 s reference clips and up to four known speakers per request. */
const MIN_REFERENCE_MS = 2000
const MAX_REFERENCE_MS = 10_000
const MAX_VOICES = 4

interface Voice {
  id: number
  /** What the model calls this voice in `diarized_json` once it is a known speaker. */
  label: string
  reference: string
}

/**
 * Keeps diarized voices consistent across chunks. Each chunk is diarized on its own, so the model's
 * `A`/`B` labels restart every time; a clip of each new voice is sent back as a known speaker reference
 * with later chunks, which then come back labelled with that voice.
 */
export class VoiceBank {
  private readonly voices: Voice[] = []

  constructor(private nextId: number) {}

  knownSpeakers(): KnownSpeakers | undefined {
    if (this.voices.length === 0) return undefined
    return { names: this.voices.map((v) => v.label), references: this.voices.map((v) => v.reference) }
  }

  /**
   * Maps each segment's label to a voice id. New labels become voices when there is room and a long
   * enough segment to keep as their reference; otherwise they stay unattributed.
   */
  assign(segments: TranscriptSegment[], wav: Buffer): Map<string, number> {
    const ids = new Map<string, number>()
    for (const voice of this.voices) ids.set(voice.label, voice.id)
    for (const label of new Set(segments.map((s) => s.speaker).filter((s) => s !== null))) {
      if (ids.has(label) || this.voices.length >= MAX_VOICES) continue
      const longest = segments
        .filter((s) => s.speaker === label)
        .reduce<TranscriptSegment | null>((a, b) => (!a || b.endMs - b.startMs > a.endMs - a.startMs ? b : a), null)
      if (!longest || longest.endMs - longest.startMs < MIN_REFERENCE_MS) continue
      const id = this.nextId++
      const end = Math.min(longest.endMs, longest.startMs + MAX_REFERENCE_MS)
      const reference = `data:audio/wav;base64,${sliceWav(wav, longest.startMs, end).toString('base64')}`
      this.voices.push({ id, label: `speaker_${id}`, reference })
      ids.set(label, id)
    }
    return ids
  }
}

/** Cuts `[startMs, endMs)` out of a 16-bit mono PCM WAV. */
export function sliceWav(wav: Buffer, startMs: number, endMs: number): Buffer {
  const sampleRate = wav.readUInt32LE(24)
  const data = wav.subarray(WAV_HEADER_BYTES)
  const at = (ms: number) => Math.max(0, Math.min(data.length, Math.round((ms / 1000) * sampleRate) * 2))
  const pcm = data.subarray(at(startMs), at(endMs))
  const header = Buffer.from(wav.subarray(0, WAV_HEADER_BYTES))
  header.writeUInt32LE(36 + pcm.length, 4)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
