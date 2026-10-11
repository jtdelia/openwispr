import type { TranscriptSource } from '../../shared/types'
import { msToSamples, rms } from './speechChunker'

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
  /** How many counted windows the lock is judged over. */
  lagWindow: number
  lagStabilityMin: number
  /** Our two capture clocks are only roughly aligned, so the mic may lead or trail by up to this much. */
  maxAbsLagMs: number
  attackUpdates: number
  hangoverMs: number
  /** Locked updates required after a quiet freeze before the lock is trusted again. */
  corroborations: number
  slowAnalysisMs: number
  slowAnalysisLimit: number
}

const ECHO_DEFAULTS: EchoDetectorConfig = {
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
  corroborations: 2,
  slowAnalysisMs: 10,
  slowAnalysisLimit: 5,
}

/** Must cover the longest mic chunk plus how long it can be held for a decision. */
const SEGMENT_RETENTION_MS = 60_000
const LOWPASS_TAPS = 31

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
  /** Mic delay behind the call at the most recent lock. */
  lagMs: number | null
  disabled: boolean
}

/**
 * When the call plays through speakers, the microphone hears it again a moment later. GCC-PHAT
 * cross-correlation finds that delay; once it stays stable, the echoed mic audio is marked so it isn't
 * transcribed a second time as the user.
 *
 * All positions are session samples at `sampleRate`, shared by both streams, so the two captures
 * line up regardless of how their audio contexts batch frames.
 */
export class EchoDetector {
  private readonly config: EchoDetectorConfig
  private readonly windowSamples: number
  private readonly cadenceSamples: number
  private readonly maxLagSamples: number
  private readonly hangoverSamples: number
  private readonly retentionSamples: number
  private readonly rings: Record<TranscriptSource, SampleRing>
  private readonly fft: Fft
  private readonly lowpass: Float64Array
  private readonly scratch: { micWindow: Float32Array; systemWindow: Float32Array; x: Float64Array; y: Float64Array }

  private nextAnalysisEnd: number | null = null
  private lastAnalysisEnd = Number.NEGATIVE_INFINITY
  private segments: Segment[] = []
  private prunedSuppressed = 0
  private recentLagsMs: number[] = []
  private lockedLagMs: number | null = null
  private suppressing = false
  private consecutiveLocked = 0
  private corroborationsNeeded = 0
  /** Mic audio before this is from before a quiet freeze and is left out of new windows. */
  private freshFrom = Number.NEGATIVE_INFINITY
  private belowSince: number | null = null
  private quietStreak = 0
  private slowStreak = 0
  private disabled = false
  private analyzed = 0
  private correlated = 0

  constructor(options: Partial<EchoDetectorConfig> = {}) {
    this.config = { ...ECHO_DEFAULTS, ...options }
    const { sampleRate, decimation, fftSize, cadenceMs, maxAbsLagMs, hangoverMs } = this.config
    if (fftSize <= 0 || (fftSize & (fftSize - 1)) !== 0) throw new Error(`fftSize must be a power of two, got ${fftSize}`)
    this.windowSamples = fftSize * decimation
    this.cadenceSamples = msToSamples(cadenceMs, sampleRate)
    this.maxLagSamples = msToSamples(maxAbsLagMs, sampleRate)
    this.hangoverSamples = msToSamples(hangoverMs, sampleRate)
    this.retentionSamples = msToSamples(SEGMENT_RETENTION_MS, sampleRate)
    const capacity = this.windowSamples + this.maxLagSamples + 4 * this.cadenceSamples + sampleRate
    this.rings = { mic: new SampleRing(capacity), system: new SampleRing(capacity) }
    this.fft = new Fft(fftSize)
    this.lowpass = lowpassTaps(LOWPASS_TAPS, 0.45 / decimation)
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
    const suppressed = this.segments.reduce((n, s) => n + (s.suppressed ? s.end - s.start : 0), this.prunedSuppressed)
    return {
      analyzed: this.analyzed,
      correlated: this.correlated,
      suppressedMs: Math.round((suppressed / this.config.sampleRate) * 1000),
      lagMs: this.lockedLagMs,
      disabled: this.disabled,
    }
  }

  /** Session sample just past the latest audio received from `source`. */
  receivedThrough(source: TranscriptSource): number {
    const ring = this.rings[source]
    return ring.empty ? Number.NEGATIVE_INFINITY : ring.end
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

  /** Carries the current decision over audio received since the last analysis, e.g. when recording stops. */
  finish(): void {
    const end = Math.min(this.receivedThrough('mic'), this.receivedThrough('system'))
    if (!Number.isFinite(this.lastAnalysisEnd) || end <= this.lastAnalysisEnd) return
    const segment = this.segment(this.lastAnalysisEnd, end)
    segment.suppressed = this.suppressing && segment.systemActive
    this.record(segment)
  }

  /** Merged echo spans overlapping `[from, to)`; gaps of up to one analysis step are filled. */
  spans(from: number, to: number): EchoSpan[] {
    const out: EchoSpan[] = []
    for (const segment of this.segments) {
      if (!segment.suppressed || segment.end <= from || segment.start >= to) continue
      const last = out[out.length - 1]
      if (last && segment.start - last.end <= this.cadenceSamples) last.end = Math.max(last.end, segment.end)
      else out.push({ start: segment.start, end: segment.end })
    }
    return out
  }

  private segment(start: number, end: number): Segment {
    const systemActive = this.rings.system.rms(start - this.maxLagSamples, end) >= this.config.energyFloor
    return { start, end, systemActive, suppressed: false }
  }

  private record(segment: Segment): void {
    this.segments.push(segment)
    this.lastAnalysisEnd = segment.end
    while (this.segments[0] && this.segments[0].end < segment.end - this.retentionSamples) {
      const old = this.segments.shift()!
      if (old.suppressed) this.prunedSuppressed += old.end - old.start
    }
  }

  private analyze(end: number): void {
    const { energyFloor, scoreFloor, lagWindow } = this.config
    const start = end - this.cadenceSamples
    const segment = this.segment(start, end)

    if (this.disabled) {
      this.record(segment)
      return
    }

    if (this.rings.mic.rms(start, end) < energyFloor) {
      this.quietStreak += 1
      // A short dip is analyzed normally; a longer quiet freezes the decision until the mic is busy again.
      if (this.quietStreak >= 2) {
        this.consecutiveLocked = 0
        this.corroborationsNeeded = this.config.corroborations
        this.recentLagsMs = []
        this.freshFrom = end
        segment.suppressed = this.suppressing && segment.systemActive
        this.record(segment)
        return
      }
    } else {
      this.quietStreak = 0
    }

    this.analyzed += 1
    const { micWindow, systemWindow } = this.scratch
    this.rings.mic.read(end - this.windowSamples, micWindow)
    this.rings.system.read(end - this.windowSamples, systemWindow)
    if (this.freshFrom > end - this.windowSamples) micWindow.fill(0, 0, this.freshFrom - (end - this.windowSamples))
    let counted = false
    if (rms(micWindow) >= energyFloor && rms(systemWindow) >= energyFloor) {
      const began = performance.now()
      const { score, lagMs } = this.correlate(micWindow, systemWindow)
      this.noteAnalysisTime(performance.now() - began)
      if (score >= scoreFloor) {
        counted = true
        this.correlated += 1
        this.recentLagsMs.push(lagMs)
        if (this.recentLagsMs.length > lagWindow) this.recentLagsMs.shift()
      }
    }

    let locked = counted && this.locked()
    if (locked && this.corroborationsNeeded > 0) {
      this.corroborationsNeeded -= 1
      locked = false
    }
    if (locked) {
      this.consecutiveLocked += 1
      this.belowSince = null
      this.lockedLagMs = median(this.recentLagsMs)
      if (!this.suppressing && this.consecutiveLocked >= this.config.attackUpdates) {
        this.suppressing = true
        // The lock needs a few windows of evidence, so the echo began up to a window earlier.
        const reach = end - this.windowSamples
        for (let i = this.segments.length - 1; i >= 0 && this.segments[i]!.start >= reach; i--) {
          const earlier = this.segments[i]!
          if (earlier.systemActive) earlier.suppressed = true
        }
      }
    } else {
      this.consecutiveLocked = 0
      if (this.suppressing) {
        this.belowSince ??= start
        if (end - this.belowSince >= this.hangoverSamples) {
          this.suppressing = false
          for (let i = this.segments.length - 1; i >= 0 && this.segments[i]!.start >= this.belowSince; i--) {
            this.segments[i]!.suppressed = false
          }
          this.belowSince = null
        }
      }
    }
    segment.suppressed = this.suppressing && segment.systemActive
    this.record(segment)
  }

  private locked(): boolean {
    const { lagStabilityMin, lagToleranceMs, maxAbsLagMs } = this.config
    const lags = this.recentLagsMs
    if (lags.length < lagStabilityMin) return false
    const center = median(lags)
    const within = lags.filter((lag) => Math.abs(lag - center) <= lagToleranceMs).length
    return within >= lagStabilityMin && Math.abs(center) <= maxAbsLagMs
  }

  private correlate(mic: Float32Array, system: Float32Array): { score: number; lagMs: number } {
    const { x, y } = this.scratch
    const { decimation, sampleRate } = this.config
    decimate(mic, this.lowpass, decimation, x)
    decimate(system, this.lowpass, decimation, y)
    const { score, lag } = gccPhat(this.fft, x, y)
    return { score, lagMs: (lag / (sampleRate / decimation)) * 1000 }
  }

  private noteAnalysisTime(ms: number): void {
    this.slowStreak = ms > this.config.slowAnalysisMs ? this.slowStreak + 1 : 0
    if (this.slowStreak < this.config.slowAnalysisLimit) return
    this.disabled = true
    this.suppressing = false
    console.warn(`Echo detector disabled: analysis took ${ms.toFixed(1)} ms`)
  }
}

/** Zeroes the samples of `samples` (starting at session sample `start`) covered by `spans`. */
export function silenceSpans(samples: Float32Array, start: number, spans: EchoSpan[]): void {
  for (const span of spans) {
    const from = Math.max(0, span.start - start)
    const to = Math.min(samples.length, span.end - start)
    if (to > from) samples.fill(0, from, to)
  }
}

/** Normalized cross-correlation peak and lag of `x` against `y`; a positive lag means `x` trails `y`. */
export function gccPhat(fft: Fft, x: Float64Array, y: Float64Array): { score: number; lag: number } {
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
  let score = -1
  let index = 0
  for (let k = 0; k < n; k++) {
    const magnitude = Math.hypot(xr[k]!, xi[k]!)
    if (magnitude > score) {
      score = magnitude
      index = k
    }
  }
  return { score, lag: index <= n / 2 ? index : index - n }
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

/** Blackman-windowed sinc low-pass with unit DC gain; `cutoff` is in cycles per input sample. */
function lowpassTaps(count: number, cutoff: number): Float64Array {
  const taps = new Float64Array(count)
  const middle = (count - 1) / 2
  let sum = 0
  for (let i = 0; i < count; i++) {
    const t = i - middle
    const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t)
    const window = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (count - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (count - 1))
    taps[i] = sinc * window
    sum += taps[i]!
  }
  for (let i = 0; i < count; i++) taps[i] = taps[i]! / sum
  return taps
}

/** Low-pass filters and downsamples `input` by `factor` into `out`, removing the mean. */
function decimate(input: Float32Array, taps: Float64Array, factor: number, out: Float64Array): void {
  const middle = (taps.length - 1) >> 1
  let mean = 0
  for (let i = 0; i < out.length; i++) {
    const center = i * factor
    const first = Math.max(0, middle - center)
    const last = Math.min(taps.length, input.length - center + middle)
    let sum = 0
    for (let k = first; k < last; k++) sum += taps[k]! * input[center + k - middle]!
    out[i] = sum
    mean += sum
  }
  mean /= out.length
  for (let i = 0; i < out.length; i++) out[i] = out[i]! - mean
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
