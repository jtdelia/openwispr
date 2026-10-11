interface Entry {
  candidateName: string | null
  candidateCount: number
  canonicalName: string | null
  conflictName: string | null
  conflictCount: number
  lastRemapAt: number | null
}

export interface IdentityConfig {
  /** Sightings of the same name before a voice takes it. */
  promoteThreshold: number
  /** Sightings of a different name before a named voice switches to it. */
  remapThreshold: number
  remapCooldownMs: number
}

const DEFAULTS: IdentityConfig = { promoteThreshold: 3, remapThreshold: 5, remapCooldownMs: 30_000 }

/**
 * Ties diarized voices to the names the meeting app shows. A voice is named once the app has shown the
 * same person talking over it a few times, and keeps that name through segments where the app showed
 * nobody, so one stale or missed indicator does not relabel a voice.
 */
export class SpeakerIdentityMap {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly config: IdentityConfig = DEFAULTS) {}

  /** The name for `voice` after this segment, given who the meeting app showed talking (if anyone). */
  resolve(voice: string, observedName: string | null, nowMs: number): string | null {
    const entry = this.entry(voice)
    const name = observedName?.trim()
    if (!name) return entry.canonicalName

    if (entry.canonicalName === name) {
      entry.conflictName = null
      entry.conflictCount = 0
      return name
    }
    if (entry.canonicalName !== null) {
      if (entry.lastRemapAt !== null && nowMs - entry.lastRemapAt < this.config.remapCooldownMs) {
        return entry.canonicalName
      }
      entry.conflictCount = entry.conflictName === name ? entry.conflictCount + 1 : 1
      entry.conflictName = name
      if (entry.conflictCount < this.config.remapThreshold) return entry.canonicalName
      Object.assign(entry, { canonicalName: name, candidateName: name, conflictName: null, conflictCount: 0, lastRemapAt: nowMs })
      return name
    }
    entry.candidateCount = entry.candidateName === name ? entry.candidateCount + 1 : 1
    entry.candidateName = name
    if (entry.candidateCount < this.config.promoteThreshold) return null
    entry.canonicalName = name
    return name
  }

  private entry(voice: string): Entry {
    let entry = this.entries.get(voice)
    if (!entry) {
      entry = {
        candidateName: null,
        candidateCount: 0,
        canonicalName: null,
        conflictName: null,
        conflictCount: 0,
        lastRemapAt: null,
      }
      this.entries.set(voice, entry)
    }
    return entry
  }
}
