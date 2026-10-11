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
  dominant(from: number, to: number, ignore: string | null = null): string | null {
    if (to <= from) return null
    const talking = new Map<string, number>()
    this.observations.forEach((observation, i) => {
      const end = this.observations[i + 1]?.at ?? Infinity
      const overlap = Math.min(end, to) - Math.max(observation.at, from)
      if (overlap <= 0) return
      for (const name of observation.speaking) {
        if (name !== ignore) talking.set(name, (talking.get(name) ?? 0) + overlap)
      }
    })
    const [first, second] = [...talking.entries()].sort((a, b) => b[1] - a[1])
    if (!first || first[1] < MIN_COVERAGE * (to - from)) return null
    if (second && second[1] > MAX_RUNNER_UP * first[1]) return null
    return first[0]
  }
}

/** Microphone segments a name must be shown talking through before it is taken to be the user. */
const SELF_MIN_VOTES = 2

/**
 * Learns which participant the user is: the one the meeting app shows talking while the microphone
 * picks up speech. Meeting apps show the user's own tile under their account name, and their voice
 * never comes back through the call audio, so that name must not be credited with call-audio segments.
 */
export class SelfName {
  private readonly votes = new Map<string, number>()

  vote(name: string | null): void {
    if (name) this.votes.set(name, (this.votes.get(name) ?? 0) + 1)
  }

  get current(): string | null {
    const [first, second] = [...this.votes.entries()].sort((a, b) => b[1] - a[1])
    if (!first || first[1] < SELF_MIN_VOTES || (second && second[1] * 2 > first[1])) return null
    return first[0]
  }
}
