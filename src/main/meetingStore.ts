import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { Meeting, MeetingDetail, TranscriptEntry } from '../shared/types'
import { countWords } from './textProcessing'

type StoredMeeting = Omit<Meeting, 'summaryGenerating'>

const TRANSCRIPT_FILE = 'live.ndjson'

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, path)
}

/**
 * Meeting metadata, notes and summaries live in `meetings.json`; each transcript is an append-only
 * NDJSON file in `meetings/<id>/`, so a crash mid-meeting loses at most the chunk being transcribed.
 */
export class MeetingStore {
  private readonly indexPath = join(app.getPath('userData'), 'meetings.json')
  private readonly baseDir = join(app.getPath('userData'), 'meetings')
  private meetings: StoredMeeting[]
  private readonly generating = new Set<string>()
  private indexWrite: NodeJS.Timeout | null = null

  constructor() {
    try {
      this.meetings = JSON.parse(readFileSync(this.indexPath, 'utf8')) as StoredMeeting[]
    } catch {
      this.meetings = []
    }
  }

  list(): Meeting[] {
    return this.meetings.map((m) => this.withRuntimeState(m))
  }

  get(id: string): Meeting | null {
    const meeting = this.find(id)
    return meeting ? this.withRuntimeState(meeting) : null
  }

  detail(id: string): MeetingDetail | null {
    const meeting = this.get(id)
    return meeting ? { ...meeting, transcript: this.transcript(id) } : null
  }

  create(): Meeting {
    const now = Date.now()
    const meeting: StoredMeeting = {
      id: randomUUID(),
      title: '',
      createdAt: now,
      modifiedAt: now,
      notes: '',
      summary: null,
      summaryRecordedMs: 0,
      summaryError: null,
      recordedMs: 0,
      transcriptWords: 0,
      speakerNames: {},
    }
    this.meetings = [meeting, ...this.meetings]
    this.saveIndex()
    return this.withRuntimeState(meeting)
  }

  update(id: string, patch: Partial<StoredMeeting>): void {
    const meeting = this.find(id)
    if (!meeting) return
    Object.assign(meeting, patch, { modifiedAt: Date.now() })
    this.saveIndex()
  }

  delete(id: string): void {
    this.meetings = this.meetings.filter((m) => m.id !== id)
    this.generating.delete(id)
    rmSync(join(this.baseDir, id), { recursive: true, force: true })
    this.saveIndex()
  }

  setGenerating(id: string, generating: boolean): void {
    if (generating) this.generating.add(id)
    else this.generating.delete(id)
  }

  appendTranscript(id: string, entry: Omit<TranscriptEntry, 'id'>): TranscriptEntry | null {
    const meeting = this.find(id)
    if (!meeting) return null
    const full = { ...entry, id: randomUUID() }
    const dir = join(this.baseDir, id)
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, TRANSCRIPT_FILE), `${JSON.stringify(full)}\n`)
    this.update(id, { transcriptWords: meeting.transcriptWords + countWords(entry.text) })
    return full
  }

  transcript(id: string): TranscriptEntry[] {
    let raw: string
    try {
      raw = readFileSync(join(this.baseDir, id, TRANSCRIPT_FILE), 'utf8')
    } catch {
      return []
    }
    const entries: TranscriptEntry[] = []
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        entries.push(JSON.parse(line) as TranscriptEntry)
      } catch {
        // A torn final line from a crash mid-append; the rest of the file is still valid.
      }
    }
    return entries.sort((a, b) => a.startMs - b.startMs)
  }

  private find(id: string): StoredMeeting | undefined {
    return this.meetings.find((m) => m.id === id)
  }

  private withRuntimeState(meeting: StoredMeeting): Meeting {
    // Meetings saved before speaker naming existed have no `speakerNames`.
    return { ...meeting, speakerNames: meeting.speakerNames ?? {}, summaryGenerating: this.generating.has(meeting.id) }
  }

  private saveIndex(): void {
    if (this.indexWrite) clearTimeout(this.indexWrite)
    this.indexWrite = setTimeout(() => this.flush(), 250)
  }

  flush(): void {
    if (this.indexWrite) clearTimeout(this.indexWrite)
    this.indexWrite = null
    writeJsonAtomic(this.indexPath, this.meetings)
  }
}
