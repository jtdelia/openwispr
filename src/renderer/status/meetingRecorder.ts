import type { MeetingChunk } from '../../shared/api'
import type { TranscriptSource } from '../../shared/types'
import { encodeWav, SAMPLE_RATE, workletUrl } from './recorder'
import { SpeechChunker, type SpeechChunk } from './speechChunker'

const FLUSH_TIMEOUT_MS = 300

interface Capture {
  session: number
  source: TranscriptSource
  stream: MediaStream
  context: AudioContext
  node: AudioWorkletNode
  chunker: SpeechChunker
  /** Ms after the session started that this capture's first sample was recorded. */
  offsetMs: number
}

/**
 * Records the microphone and system audio as two separate 16 kHz streams, so the transcript can tell
 * the user apart from everyone else, and hands back speech chunks as they complete.
 */
export class MeetingRecorder {
  private captures: Capture[] = []
  private session: number | null = null
  private startedAt = 0

  constructor(private readonly onChunk: (chunk: MeetingChunk) => void) {}

  /** Throws if the microphone fails; system audio is optional and its failure is returned. */
  async start(session: number, deviceId: string): Promise<{ systemAudioError: string | null }> {
    await this.stop()
    this.session = session
    this.startedAt = Date.now()
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    await this.add('mic', mic, session)

    let systemAudioError: string | null = null
    try {
      await this.add('system', await systemAudioStream(), session)
    } catch (error) {
      systemAudioError = error instanceof Error ? error.message : String(error)
    }
    return { systemAudioError }
  }

  /** Emits the final partial chunks, then releases both streams. */
  async stop(): Promise<void> {
    this.session = null
    const captures = this.captures
    this.captures = []
    await Promise.all(captures.map((capture) => this.finish(capture)))
  }

  cut(session: number, source: TranscriptSource): void {
    if (session !== this.session) return
    this.captures.find((c) => c.source === source)?.chunker.requestCut()
  }

  private async add(source: TranscriptSource, stream: MediaStream, session: number): Promise<void> {
    if (this.session !== session) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    const context = new AudioContext({ sampleRate: SAMPLE_RATE })
    await context.audioWorklet.addModule(workletUrl)
    const node = new AudioWorkletNode(context, 'openwispr-capture')
    const capture: Capture = {
      session,
      source,
      stream,
      context,
      node,
      chunker: new SpeechChunker({ sampleRate: SAMPLE_RATE }),
      offsetMs: Date.now() - this.startedAt,
    }
    node.port.onmessage = (event: MessageEvent<Float32Array | string>) => {
      if (typeof event.data === 'string') return
      const chunk = capture.chunker.push(event.data)
      if (chunk) this.emit(capture, chunk)
    }
    context.createMediaStreamSource(stream).connect(node)
    node.connect(context.destination)
    // Stopped while the worklet was loading.
    if (this.session !== session) await this.finish(capture)
    else this.captures.push(capture)
  }

  private async finish(capture: Capture): Promise<void> {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, FLUSH_TIMEOUT_MS)
      capture.node.port.addEventListener('message', (event) => {
        if (event.data === 'flushed') {
          clearTimeout(timeout)
          resolve()
        }
      })
      capture.node.port.postMessage('flush')
    })
    const chunk = capture.chunker.flush()
    if (chunk) this.emit(capture, chunk)
    capture.node.port.onmessage = null
    capture.stream.getTracks().forEach((t) => t.stop())
    void capture.context.close()
  }

  private emit(capture: Capture, chunk: SpeechChunk): void {
    const startMs = capture.offsetMs + capture.chunker.msAt(chunk.startSample)
    this.onChunk({
      session: capture.session,
      source: capture.source,
      startMs,
      endMs: capture.offsetMs + capture.chunker.msAt(chunk.endSample),
      wallClockMs: this.startedAt + startMs,
      wav: encodeWav(chunk.samples),
    })
  }
}

/** The main process answers `getDisplayMedia` with a system-audio loopback device (see systemAudio.ts). */
async function systemAudioStream(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false })
  for (const track of stream.getVideoTracks()) {
    track.stop()
    stream.removeTrack(track)
  }
  const [track] = stream.getAudioTracks()
  if (!track || track.readyState === 'ended') {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error(
      'System audio is unavailable. Allow it in System Settings → Privacy & Security → Screen & System Audio Recording.',
    )
  }
  return stream
}
