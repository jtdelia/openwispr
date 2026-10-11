export const SAMPLE_RATE = 16000
const BATCH = 1024

const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(${BATCH})
    this.length = 0
    this.port.onmessage = (event) => {
      if (event.data !== 'flush') return
      if (this.length > 0) this.port.postMessage(this.buffer.slice(0, this.length))
      this.length = 0
      this.port.postMessage('flushed')
    }
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    let offset = 0
    while (offset < channel.length) {
      const count = Math.min(channel.length - offset, ${BATCH} - this.length)
      this.buffer.set(channel.subarray(offset, offset + count), this.length)
      this.length += count
      offset += count
      if (this.length === ${BATCH}) {
        this.port.postMessage(this.buffer.slice(0))
        this.length = 0
      }
    }
    return true
  }
}
registerProcessor('openwispr-capture', CaptureProcessor)
`

export const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))

interface Session {
  stream: MediaStream
  context: AudioContext
  node: AudioWorkletNode
  chunks: Float32Array[]
}

/** Captures 16 kHz mono audio from the selected microphone and hands back a WAV file. */
export class Recorder {
  private session: Session | null = null
  private starting: Promise<void> | null = null
  private generation = 0

  constructor(private readonly onLevel: (level: number) => void) {}

  start(deviceId: string): Promise<void> {
    const generation = ++this.generation
    this.starting = this.open(deviceId, generation)
    return this.starting
  }

  private async open(deviceId: string, generation: number): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    const context = new AudioContext({ sampleRate: SAMPLE_RATE })
    await context.audioWorklet.addModule(workletUrl)
    if (generation !== this.generation) {
      stream.getTracks().forEach((t) => t.stop())
      void context.close()
      return
    }
    const node = new AudioWorkletNode(context, 'openwispr-capture')
    const chunks: Float32Array[] = []
    node.port.onmessage = (event: MessageEvent<Float32Array | string>) => {
      if (typeof event.data === 'string') return
      chunks.push(event.data)
      let sum = 0
      for (const sample of event.data) sum += sample * sample
      this.onLevel(Math.min(1, Math.sqrt(sum / event.data.length) * 6))
    }
    context.createMediaStreamSource(stream).connect(node)
    node.connect(context.destination)
    this.session = { stream, context, node, chunks }
  }

  async stop(): Promise<ArrayBuffer> {
    await this.starting?.catch(() => undefined)
    const session = this.session
    if (!session) return encodeWav(new Float32Array(0))
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 300)
      session.node.port.addEventListener('message', (event) => {
        if (event.data === 'flushed') {
          clearTimeout(timeout)
          resolve()
        }
      })
      session.node.port.postMessage('flush')
    })
    this.teardown()
    return encodeWav(concat(session.chunks))
  }

  cancel(): void {
    this.generation++
    this.teardown()
  }

  private teardown(): void {
    const session = this.session
    this.session = null
    if (!session) return
    session.node.port.onmessage = null
    session.stream.getTracks().forEach((t) => t.stop())
    void session.context.close()
    this.onLevel(0)
  }
}

function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export function encodeWav(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  samples.forEach((sample, i) => {
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  })
  return buffer
}
