import type { TranscriptSource } from '../../shared/types'

/**
 * Port of Wispr Flow's meeting echo detector: when the call plays through speakers, the microphone
 * hears it again a few hundred ms later. GCC-PHAT cross-correlation finds that delay; once it stays
 * stable, the echoed mic audio is marked so it isn't transcribed a second time as the user.
 *
 * All positions are session samples at `sampleRate`, shared by both streams, so the two captures
 * line up regardless of how their audio contexts batch frames.
 */
export interface EchoDetectorConfig {
  sampleRate: number
  /** Analysis runs at `sampleRate / decimation`. */
  decimation: number
  /** Analysis window in decimated samples (power of two). */
  fftSize: number
  cadenceMs: number
  /** RMS below which a stream counts as silent. */
  energyFloor: number
  /** Minimum normalized correlation peak for a window to count. */
  scoreFloor: number
  lagToleranceMs: number
  lagWindow: number
  lagStabilityMin: number
  /** Wispr requires the mic to trail; our two capture clocks are only roughly aligned, so allow either side. */
  maxAbsLagMs: number
  attackUpdates: number
  hangoverMs: number
  slowAnalysisMs: number
  slowAnalysisLimit: number
}

export const ECHO_DEFAULTS: EchoDetectorConfig = {
  sampleRate: 16_000,
  decimation: 2,
  fftSize: 16_384,
  cadenceMs: 320,
  energyFloor: 0.003,
  scoreFloor: 0.03,
  lagToleranceMs: 35,
  lagWindow: 8,
  lagStabilityMin: 5,
  maxAbsLagMs: 500,
  attackUpdates: 3,
  hangoverMs: 2000,
  slowAnalysisMs: 10,
  slowAnalysisLimit: 5,
}

export interface EchoSpan {
  start: number
  end: number
}

interface Segment extends EchoSpan {
  systemActive: boolean
  suppressed: boolean
}

export interface EchoStats {
  analyzed: number
  correlated: number
  suppressedMs: number
  disabled: boolean
}

export class EchoDetector {
  private readonly config: EchoDetectorConfig
  private readonly windowSamples: number
  private readonly cadenceSamples: number
  private readonly maxLagSamples: number
  private readonly rings: Record<TranscriptSource, SampleRing>
  private readonly fft: Fft
  private readonly scratch: { micWindow: Float32Array; systemWindow: Float32Array; x: Float64Array; y: Float64Array }

  private nextAnalysisEnd: number | null = null
  private lastAnalysisEnd = Number.NEGATIVE_INFINITY
  private segments: Segment[] = []
  private recent: { lagMs: number; score: number }[] = []
  private suppressing = false
  private consecutiveLocked = 0
  private belowSince: number | null = null
  private quietStreak = 0
  private slowStreak = 0
  private disabled = false
  private analyzed = 0
  private correlated = 0

  constructor(options: Partial<EchoDetectorConfig> = {}) {
    this.config = { ...ECHO_DEFAULTS, ...options }
    const { sampleRate, decimation, fftSize, cadenceMs, maxAbsLagMs } = this.config
    if (fftSize <= 0 || (fftSize & (fftSize - 1)) !== 0) throw new Error(`fftSize must be a power of two, got ${fftSize}`)
    this.windowSamples = fftSize * decimation
    this.cadenceSamples = Math.round((cadenceMs / 1000) * sampleRate)
    this.maxLagSamples = Math.round((maxAbsLagMs / 1000) * sampleRate)
    const capacity = this.windowSamples + this.maxLagSamples + 4 * this.cadenceSamples + sampleRate
    this.rings = { mic: new SampleRing(capacity), system: new SampleRing(capacity) }
    this.fft = new Fft(fftSize)
    this.scratch = {
      micWindow: new Float32Array(this.windowSamples),
      systemWindow: new Float32Array(this.windowSamples),
      x: new Float64Array(fftSize),
      y: new Float64Array(fftSize),
    }
  }

  /** Session sample through which echo decisions are final, apart from walk-back and hangover trimming. */
  get analyzedThrough(): number {
    return this.lastAnalysisEnd
  }

  get stats(): EchoStats {
    const suppressed = this.segments.reduce((n, s) => n + (s.suppressed ? s.end - s.start : 0), 0)
    return {
      analyzed: this.analyzed,
      correlated: this.correlated,
      suppressedMs: Math.round((suppressed / this.config.sampleRate) * 1000),
      disabled: this.disabled,
    }
  }

  push(source: TranscriptSource, frame: Float32Array, start: number): void {
    this.rings[source].write(frame, start)
    const mic = this.rings.mic
    const system = this.rings.system
    if (mic.empty || system.empty) return
    this.nextAnalysisEnd ??= Math.max(mic.start, system.start) + this.windowSamples
    const ready = Math.min(mic.end, system.end)
    while (this.nextAnalysisEnd <= ready) {
      this.analyze(this.nextAnalysisEnd)
      this.nextAnalysisEnd += this.cadenceSamples
    }
  }

  /** Merged echo spans overlapping `[from, to)`. */
  spans(from: number, to: number): EchoSpan[] {
    const out: EchoSpan[] = []
    for (const segment of this.segments) {
      if (!segment.suppressed || segment.end <= from || segment.start >= to) continue
      const last = out[out.length - 1]
      if (last && last.end >= segment.start) last.end = Math.max(last.end, segment.end)
      else out.push({ start: segment.start, end: segment.end })
    }
    return out
  }

  private analyze(end: number): void {
    const { energyFloor, scoreFloor } = this.config
    const start = end - this.cadenceSamples
    const segment: Segment = {
      start,
      end,
      systemActive: this.rms('system', start - this.maxLagSamples, end) >= energyFloor,
      suppressed: false,
    }
    this.lastAnalysisEnd = end

    if (this.disabled) {
      this.segments.push(segment)
      return
    }

    if (this.rms('mic', start, end) < energyFloor) {
      this.quietStreak += 1
      // A short dip is analyzed normally; a longer quiet freezes the decision until the mic is busy again.
      if (this.quietStreak >= 2) {
        segment.suppressed = this.suppressing && segment.systemActive
        this.segments.push(segment)
        return
      }
    } else {
      this.quietStreak = 0
    }

    this.analyzed += 1
    const { micWindow, systemWindow } = this.scratch
    this.rings.mic.read(end - this.windowSamples, micWindow)
    this.rings.system.read(end - this.windowSamples, systemWindow)
    let score = 0
    let lagMs = 0
    if (rms(micWindow) >= energyFloor && rms(systemWindow) >= energyFloor) {
      const began = performance.now()
      ;({ score, lagMs } = this.correlate(micWindow, systemWindow))
      this.noteAnalysisTime(performance.now() - began)
    }
    if (score >= scoreFloor) this.correlated += 1
    this.recent.push({ lagMs, score })
    if (this.recent.length > this.config.lagWindow) this.recent.shift()

    if (this.locked()) {
      this.consecutiveLocked += 1
      this.belowSince = null
      if (!this.suppressing && this.consecutiveLocked >= this.config.attackUpdates) {
        this.suppressing = true
        // The lock needs a few windows of evidence, so the echo began up to a window earlier.
        for (const earlier of this.segments) {
          if (earlier.start >= end - this.windowSamples && earlier.systemActive) earlier.suppressed = true
        }
      }
    } else {
      this.consecutiveLocked = 0
      if (this.suppressing) {
        this.belowSince ??= start
        if (end - this.belowSince >= this.config.hangoverMs * (this.config.sampleRate / 1000)) {
          this.suppressing = false
          for (const later of this.segments) if (later.start >= this.belowSince) later.suppressed = false
          this.belowSince = null
        }
      }
    }
    segment.suppressed = this.suppressing && segment.systemActive
    this.segments.push(segment)
  }

  private locked(): boolean {
    const { scoreFloor, lagStabilityMin, lagToleranceMs, maxAbsLagMs } = this.config
    const lags = this.recent.filter((r) => r.score >= scoreFloor).map((r) => r.lagMs)
    if (lags.length < lagStabilityMin) return false
    const center = median(lags)
    const within = lags.filter((lag) => Math.abs(lag - center) <= lagToleranceMs).length
    return within >= lagStabilityMin && Math.abs(center) <= maxAbsLagMs
  }

  private correlate(mic: Float32Array, system: Float32Array): { score: number; lagMs: number } {
    const { x, y } = this.scratch
    decimate(mic, this.config.decimation, x)
    decimate(system, this.config.decimation, y)
    const { peak, lag } = gccPhat(this.fft, x, y)
    return { score: peak, lagMs: (lag / (this.config.sampleRate / this.config.decimation)) * 1000 }
  }

  private noteAnalysisTime(ms: number): void {
    this.slowStreak = ms > this.config.slowAnalysisMs ? this.slowStreak + 1 : 0
    if (this.slowStreak < this.config.slowAnalysisLimit) return
    this.disabled = true
    this.suppressing = false
    console.warn(`Echo detector disabled: analysis took ${ms.toFixed(1)} ms`)
  }

  private rms(source: TranscriptSource, from: number, to: number): number {
    return this.rings[source].rms(from, to)
  }
}

/** Zeroes the samples of `samples` (starting at session sample `start`) covered by `spans`. */
export function silenceSpans(samples: Float32Array, start: number, spans: EchoSpan[]): number {
  let silenced = 0
  for (const span of spans) {
    const from = Math.max(0, span.start - start)
    const to = Math.min(samples.length, span.end - start)
    if (to <= from) continue
    samples.fill(0, from, to)
    silenced += to - from
  }
  return silenced
}

/** Normalized cross-correlation peak and lag of `x` against `y`; a positive lag means `x` trails `y`. */
export function gccPhat(fft: Fft, x: Float64Array, y: Float64Array): { peak: number; lag: number } {
  const n = fft.size
  const xr = Float64Array.from(x)
  const xi = new Float64Array(n)
  const yr = Float64Array.from(y)
  const yi = new Float64Array(n)
  fft.transform(xr, xi, false)
  fft.transform(yr, yi, false)
  for (let k = 0; k < n; k++) {
    const re = xr[k]! * yr[k]! + xi[k]! * yi[k]!
    const im = xi[k]! * yr[k]! - xr[k]! * yi[k]!
    const magnitude = Math.hypot(re, im) + 1e-12
    xr[k] = re / magnitude
    xi[k] = im / magnitude
  }
  fft.transform(xr, xi, true)
  let peak = -1
  let index = 0
  for (let k = 0; k < n; k++) {
    const magnitude = Math.hypot(xr[k]!, xi[k]!)
    if (magnitude > peak) {
      peak = magnitude
      index = k
    }
  }
  return { peak, lag: index <= n / 2 ? index : index - n }
}

/** In-place iterative radix-2 complex FFT; the inverse is scaled by 1/n. */
export class Fft {
  private readonly reversed: Uint32Array
  private readonly cos: Float64Array
  private readonly sin: Float64Array

  constructor(readonly size: number) {
    const bits = Math.log2(size)
    this.reversed = new Uint32Array(size)
    for (let i = 0; i < size; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.reversed[i] = r
    }
    this.cos = new Float64Array(size / 2)
    this.sin = new Float64Array(size / 2)
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size)
      this.sin[i] = Math.sin((2 * Math.PI * i) / size)
    }
  }

  transform(re: Float64Array, im: Float64Array, inverse: boolean): void {
    const n = this.size
    for (let i = 0; i < n; i++) {
      const j = this.reversed[i]!
      if (j > i) {
        ;[re[i], re[j]] = [re[j]!, re[i]!]
        ;[im[i], im[j]] = [im[j]!, im[i]!]
      }
    }
    const sign = inverse ? 1 : -1
    for (let half = 1; half < n; half *= 2) {
      const step = n / (half * 2)
      for (let start = 0; start < n; start += half * 2) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step]!
          const wi = sign * this.sin[k * step]!
          const a = start + k
          const b = a + half
          const tr = re[b]! * wr - im[b]! * wi
          const ti = re[b]! * wi + im[b]! * wr
          re[b] = re[a]! - tr
          im[b] = im[a]! - ti
          re[a] = re[a]! + tr
          im[a] = im[a]! + ti
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] = re[i]! / n
        im[i] = im[i]! / n
      }
    }
  }
}

/** Holds the latest samples of one stream, addressed by session sample. */
class SampleRing {
  private readonly buffer: Float32Array
  start = 0
  end = 0
  empty = true

  constructor(private readonly capacity: number) {
    this.buffer = new Float32Array(capacity)
  }

  write(frame: Float32Array, at: number): void {
    if (this.empty) {
      this.start = at
      this.end = at
      this.empty = false
    }
    // Gaps (a capture that started late or stalled) read back as silence.
    for (let i = this.end; i < at; i++) this.buffer[i % this.capacity] = 0
    for (let i = 0; i < frame.length; i++) this.buffer[(at + i) % this.capacity] = frame[i]!
    this.end = Math.max(this.end, at + frame.length)
  }

  read(from: number, out: Float32Array): void {
    for (let i = 0; i < out.length; i++) out[i] = this.sampleAt(from + i)
  }

  rms(from: number, to: number): number {
    let sum = 0
    for (let i = from; i < to; i++) {
      const sample = this.sampleAt(i)
      sum += sample * sample
    }
    return to > from ? Math.sqrt(sum / (to - from)) : 0
  }

  private sampleAt(index: number): number {
    if (index < this.start || index >= this.end || index < this.end - this.capacity) return 0
    return this.buffer[index % this.capacity]!
  }
}

function decimate(input: Float32Array, factor: number, out: Float64Array): void {
  let mean = 0
  for (let i = 0; i < out.length; i++) {
    let sum = 0
    for (let j = 0; j < factor; j++) sum += input[i * factor + j]!
    out[i] = sum / factor
    mean += out[i]!
  }
  mean /= out.length
  for (let i = 0; i < out.length; i++) out[i] = out[i]! - mean
}

function rms(samples: Float32Array): number {
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return samples.length ? Math.sqrt(sum / samples.length) : 0
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
