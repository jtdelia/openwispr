export interface SpeakerObservation {
  /** Epoch ms. Each observation holds until the next one. */
  at: number
  speaking: string[]
}

/** Share of a segment someone must be shown talking for to be credited with it. */
const MIN_COVERAGE = 0.3
/** The runner-up must be well behind, or the segment is a mix of voices. */
const MAX_RUNNER_UP = 0.5

export interface CallCredit {
  name: string
  /** False when the segment was a mix of voices and a tie-break picked the name. */
  clear: boolean
}

export interface OverlapHints {
  /** Never credited, e.g. the user, whose voice doesn't come back through the call audio. */
  ignore: readonly string[]
  /** Who the call audio was last credited to; people talking over them rarely take the call audio. */
  previous: string | null
  isRemote: (name: string) => boolean
}

/** Who the meeting app showed as talking over time, to credit call-audio segments to people. */
export class SpeakerTimeline {
  private observations: SpeakerObservation[] = []

  push(observation: SpeakerObservation): void {
    const last = this.observations.at(-1)
    if (last && observation.at < last.at) return
    this.observations.push(observation)
  }

  /** The person shown talking for most of `[from, to)`, or null if nobody clearly was. */
  dominant(from: number, to: number, ignore: readonly string[] = []): string | null {
    const [first, second] = this.coverage(from, to, ignore)
    if (!first || first[1] < MIN_COVERAGE * (to - from)) return null
    if (second && second[1] > MAX_RUNNER_UP * first[1]) return null
    return first[0]
  }

  /**
   * Credits a call-audio segment. When several people were shown talking through it, the one the call
   * audio already belonged to keeps it, else the only one already confirmed as a remote voice.
   */
  credit(from: number, to: number, hints: OverlapHints): CallCredit | null {
    const clear = this.dominant(from, to, hints.ignore)
    if (clear) return { name: clear, clear: true }
    const candidates = this.coverage(from, to, hints.ignore)
      .filter(([, ms]) => ms >= MIN_COVERAGE * (to - from))
      .map(([name]) => name)
    if (hints.previous && candidates.includes(hints.previous)) return { name: hints.previous, clear: false }
    const remote = candidates.filter(hints.isRemote)
    return remote.length === 1 ? { name: remote[0]!, clear: false } : null
  }

  /** Ms each person was shown talking within `[from, to)`, most first. */
  private coverage(from: number, to: number, ignore: readonly string[]): [string, number][] {
    if (to <= from) return []
    const talking = new Map<string, number>()
    this.observations.forEach((observation, i) => {
      const end = this.observations[i + 1]?.at ?? Infinity
      const overlap = Math.min(end, to) - Math.max(observation.at, from)
      if (overlap <= 0) return
      for (const name of observation.speaking) {
        if (!ignore.includes(name)) talking.set(name, (talking.get(name) ?? 0) + overlap)
      }
    })
    return [...talking.entries()].sort((a, b) => b[1] - a[1])
  }
}

/** Microphone segments a name must be shown talking through before it is taken to be the user. */
const SELF_MIN_VOTES = 2
/** Call-audio segments a name must clearly own, and at least match its mic votes, to be ruled out as the user. */
const REMOTE_MIN_CREDITS = 2

/**
 * Learns which participant the user is: the one the meeting app shows talking while the microphone
 * picks up speech. Meeting apps show the user's own tile under their account name, and their voice
 * never comes back through the call audio, so that name must not be credited with call-audio segments.
 */
export class SelfName {
  private readonly votes = new Map<string, number>()
  private readonly credits = new Map<string, number>()

  vote(name: string | null): void {
    if (name) this.votes.set(name, (this.votes.get(name) ?? 0) + 1)
  }

  /** Records that the call audio clearly belonged to `name`. */
  heardOnCall(name: string): void {
    this.credits.set(name, (this.credits.get(name) ?? 0) + 1)
  }

  isRemote(name: string): boolean {
    const credits = this.credits.get(name) ?? 0
    return credits >= REMOTE_MIN_CREDITS && credits >= (this.votes.get(name) ?? 0)
  }

  /** People heard through the call audio, so a mic segment they were shown talking in is still the user's. */
  get remoteNames(): string[] {
    return [...this.credits.keys()].filter((name) => this.isRemote(name))
  }

  get current(): string | null {
    const [first, second] = [...this.votes.entries()]
      .filter(([name]) => !this.isRemote(name))
      .sort((a, b) => b[1] - a[1])
    if (!first || first[1] < SELF_MIN_VOTES || (second && second[1] * 2 > first[1])) return null
    return first[0]
  }
}
