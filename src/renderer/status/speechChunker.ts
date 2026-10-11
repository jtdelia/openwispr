export interface SpeechChunk {
  samples: Float32Array
  startSample: number
  endSample: number
}

export const SPEECH_THRESHOLD = 0.01
export const MIN_SPEECH_MS = 400
const SPEECH_FRAME = 1024

export interface ChunkerOptions {
  sampleRate: number
  /** RMS above which a frame counts as speech. */
  speechThreshold?: number
  /** Cut at the first pause after this much audio. */
  minChunkMs?: number
  /** Cut regardless of pauses after this much audio, to keep the live transcript moving. */
  maxChunkMs?: number
  /** Silence that counts as a pause. */
  pauseMs?: number
  /** Silence kept before the first speech frame of a chunk. */
  prerollMs?: number
  /** Chunks with less speech than this are dropped; they make Whisper hallucinate. */
  minSpeechMs?: number
  /** After `requestCut`: the shortest chunk and pause to cut at, since turn-taking leaves short gaps. */
  requestedCutMinMs?: number
  requestedCutPauseMs?: number
}

/**
 * Splits a continuous audio stream into utterance-sized chunks at pauses, so each one can be sent to a
 * batch transcription endpoint while the meeting is still going.
 */
export class SpeechChunker {
  private readonly sampleRate: number
  private readonly speechThreshold: number
  private readonly minChunkSamples: number
  private readonly maxChunkSamples: number
  private readonly pauseSamples: number
  private readonly prerollSamples: number
  private readonly minSpeechSamples: number
  private readonly requestedCutMinSamples: number
  private readonly requestedCutPauseSamples: number

  private frames: Float32Array[] = []
  private length = 0
  private startSample = 0
  private speechSamples = 0
  private trailingSilence = 0
  private totalSamples = 0
  private cutRequested = false

  constructor(options: ChunkerOptions) {
    const ms = (value: number) => msToSamples(value, options.sampleRate)
    this.sampleRate = options.sampleRate
    this.speechThreshold = options.speechThreshold ?? SPEECH_THRESHOLD
    this.minChunkSamples = ms(options.minChunkMs ?? 6000)
    this.maxChunkSamples = ms(options.maxChunkMs ?? 25_000)
    this.pauseSamples = ms(options.pauseMs ?? 600)
    this.prerollSamples = ms(options.prerollMs ?? 300)
    this.minSpeechSamples = ms(options.minSpeechMs ?? MIN_SPEECH_MS)
    this.requestedCutMinSamples = ms(options.requestedCutMinMs ?? 1000)
    this.requestedCutPauseSamples = ms(options.requestedCutPauseMs ?? 250)
  }

  /** Feeds one frame of audio; returns a chunk when this frame completes one. */
  push(frame: Float32Array): SpeechChunk | null {
    const speech = rms(frame) >= this.speechThreshold
    this.frames.push(frame)
    this.length += frame.length
    this.totalSamples += frame.length

    if (speech) {
      this.speechSamples += frame.length
      this.trailingSilence = 0
    } else {
      this.trailingSilence += frame.length
    }

    if (this.speechSamples === 0) {
      this.trimPreroll()
      return null
    }
    const paused = this.cutRequested
      ? this.length >= this.requestedCutMinSamples && this.trailingSilence >= this.requestedCutPauseSamples
      : this.length >= this.minChunkSamples && this.trailingSilence >= this.pauseSamples
    return paused || this.length >= this.maxChunkSamples ? this.cut() : null
  }

  /** Ends the current chunk at the next short pause, e.g. when someone else starts talking. */
  requestCut(): void {
    if (this.speechSamples > 0) this.cutRequested = true
  }

  /** Returns whatever speech is buffered, e.g. when recording stops. */
  flush(): SpeechChunk | null {
    return this.cut()
  }

  msAt(sample: number): number {
    return Math.round((sample / this.sampleRate) * 1000)
  }

  private trimPreroll(): void {
    while (this.frames.length > 1 && this.length - this.frames[0]!.length >= this.prerollSamples) {
      const dropped = this.frames.shift()!
      this.length -= dropped.length
      this.startSample += dropped.length
    }
  }

  private cut(): SpeechChunk | null {
    const enoughSpeech = this.speechSamples >= this.minSpeechSamples
    const chunk = enoughSpeech
      ? { samples: concat(this.frames, this.length), startSample: this.startSample, endSample: this.totalSamples }
      : null
    this.frames = []
    this.length = 0
    this.startSample = this.totalSamples
    this.speechSamples = 0
    this.trailingSilence = 0
    this.cutRequested = false
    return chunk
  }
}

/** Milliseconds of `samples` whose frames are loud enough to count as speech. */
export function speechMs(samples: Float32Array, sampleRate: number, threshold = SPEECH_THRESHOLD): number {
  let speech = 0
  for (let at = 0; at < samples.length; at += SPEECH_FRAME) {
    const frame = samples.subarray(at, at + SPEECH_FRAME)
    if (rms(frame) >= threshold) speech += frame.length
  }
  return (speech / sampleRate) * 1000
}

export function msToSamples(ms: number, sampleRate: number): number {
  return Math.round((ms / 1000) * sampleRate)
}

export function rms(frame: Float32Array): number {
  let sum = 0
  for (const sample of frame) sum += sample * sample
  return frame.length ? Math.sqrt(sum / frame.length) : 0
}

function concat(frames: Float32Array[], length: number): Float32Array {
  const out = new Float32Array(length)
  let offset = 0
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}
