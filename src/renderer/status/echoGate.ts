import { silenceSpans, type EchoDetector } from './echoDetector'
import { MIN_SPEECH_MS, msToSamples, speechMs } from './speechChunker'

/** Must exceed the detector's hangover, since a restore can un-mark up to that much earlier audio. */
export const ECHO_HOLD_MS = 3000
/** A stalled call stream must not hold the user's speech forever. */
export const ECHO_MAX_HOLD_MS = 2 * ECHO_HOLD_MS

/** A mic chunk positioned on the detector's session sample clock. */
export interface HeldChunk {
  start: number
  end: number
  samples: Float32Array
  send: () => void
}

/** Holds mic chunks until the echo detector has decided on them, then sends what isn't echo, in order. */
export class EchoGate {
  private readonly holdSamples: number
  private readonly maxHoldSamples: number
  private held: HeldChunk[] = []

  constructor(
    private readonly detector: EchoDetector,
    private readonly sampleRate: number,
  ) {
    this.holdSamples = msToSamples(ECHO_HOLD_MS, sampleRate)
    this.maxHoldSamples = msToSamples(ECHO_MAX_HOLD_MS, sampleRate)
  }

  hold(chunk: HeldChunk): void {
    this.held.push(chunk)
  }

  /** Sends every held chunk the detector has decided on; without call audio there is nothing to wait for. */
  releaseDecided(systemLive: boolean): void {
    while (this.held[0]) {
      const { end } = this.held[0]
      const decided = this.detector.analyzedThrough >= end + this.holdSamples
      const overdue = this.detector.receivedThrough('mic') >= end + this.maxHoldSamples
      if (systemLive && !decided && !overdue) return
      this.release(this.held.shift()!)
    }
  }

  /** Sends everything still held, e.g. when recording stops. */
  flush(): void {
    this.detector.finish()
    for (const chunk of this.held.splice(0)) this.release(chunk)
  }

  private release(chunk: HeldChunk): void {
    const spans = this.detector.spans(chunk.start, chunk.end)
    if (spans.length > 0) {
      silenceSpans(chunk.samples, chunk.start, spans)
      if (speechMs(chunk.samples, this.sampleRate) < MIN_SPEECH_MS) return
    }
    chunk.send()
  }
}
