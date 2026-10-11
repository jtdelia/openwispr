export interface SpeakerObservation {
  /** Epoch ms. Each observation holds until the next one. */
  at: number
  speaking: string[]
}

/** Share of a segment someone must be shown talking for to be credited with it. */
const MIN_COVERAGE = 0.3
/** The runner-up must be well behind, or the segment is a mix of voices. */
const MAX_RUNNER_UP = 0.5

/** Who the meeting app showed as talking over time, to credit call-audio segments to people. */
export class SpeakerTimeline {
  private observations: SpeakerObservation[] = []

  push(observation: SpeakerObservation): void {
    const last = this.observations.at(-1)
    if (last && observation.at < last.at) return
    this.observations.push(observation)
  }

  /** The person shown talking for most of `[from, to)`, or null if nobody clearly was. */
  dominant(from: number, to: number): string | null {
    if (to <= from) return null
    const talking = new Map<string, number>()
    this.observations.forEach((observation, i) => {
      const end = this.observations[i + 1]?.at ?? Infinity
      const overlap = Math.min(end, to) - Math.max(observation.at, from)
      if (overlap <= 0) return
      for (const name of observation.speaking) talking.set(name, (talking.get(name) ?? 0) + overlap)
    })
    const [first, second] = [...talking.entries()].sort((a, b) => b[1] - a[1])
    if (!first || first[1] < MIN_COVERAGE * (to - from)) return null
    if (second && second[1] > MAX_RUNNER_UP * first[1]) return null
    return first[0]
  }
}
