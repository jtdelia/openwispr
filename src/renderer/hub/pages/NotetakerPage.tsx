import { useEffect, useRef, useState } from 'react'
import { summaryState, type SummaryState } from '../../../shared/summaryState'
import { PLATFORM_LABEL, speakerLabel, transcriptTurns, YOU, type TranscriptTurn } from '../../../shared/speakers'
import { formatClock } from '../../../shared/time'
import type { LiveSpeakers, Meeting, MeetingDetail, NotetakerState } from '../../../shared/types'
import { groupByDay, timeLabel } from '../format'
import { Markdown } from '../Markdown'
import { useData } from '../useData'

const api = window.openwispr
const SAVE_DELAY_MS = 400

/** `ipcRenderer.invoke` prefixes errors thrown in the main process with the channel name. */
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function recordingMeetingId(state: NotetakerState | null): string | null {
  return state && state.kind !== 'idle' ? state.meetingId : null
}

export function NotetakerPage() {
  const [openId, setOpenId] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)

  const newNote = async () => {
    const meeting = await api.createMeeting()
    setOpenId(meeting.id)
    setStartError(null)
    await api.startMeetingRecording(meeting.id).catch((error: unknown) => setStartError(errorMessage(error)))
  }

  if (openId) {
    return (
      <MeetingView
        key={openId}
        id={openId}
        startError={startError}
        onStartError={setStartError}
        onBack={() => {
          setOpenId(null)
          setStartError(null)
        }}
      />
    )
  }
  return <MeetingList onOpen={setOpenId} onNew={() => void newNote()} />
}

function MeetingList({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) {
  const [meetings] = useData(api.getMeetings, ['meetings'])
  const [notetaker] = useData(api.getNotetakerState, ['notetaker'])
  const [query, setQuery] = useState('')
  const recordingId = recordingMeetingId(notetaker)

  const needle = query.trim().toLowerCase()
  const visible = (meetings ?? []).filter(
    (m) => !needle || [m.title, m.notes, m.summary ?? ''].some((text) => text.toLowerCase().includes(needle)),
  )

  return (
    <div className="page">
      <header className="page-header notetaker-header">
        <div>
          <h1>Notetaker</h1>
          <p className="muted">
            Takes notes in your meetings. It transcribes your microphone and the call audio, and writes a summary
            with action items when the meeting ends.
          </p>
        </div>
        <button className="button primary" onClick={onNew} disabled={recordingId !== null}>
          New note
        </button>
      </header>

      {meetings && meetings.length > 0 && (
        <input placeholder="Search notes…" value={query} onChange={(e) => setQuery(e.target.value)} />
      )}
      {meetings?.length === 0 && (
        <p className="muted empty">
          Start a note when a meeting begins. Always get consent before transcribing others.
        </p>
      )}
      {meetings && meetings.length > 0 && visible.length === 0 && <p className="muted empty">No matching notes.</p>}

      {groupByDay(visible, (m) => m.createdAt).map(([label, group]) => (
        <div key={label} className="history-group">
          <h3>{label}</h3>
          <div className="card list">
            {group.map((meeting) => (
              <MeetingRow
                key={meeting.id}
                meeting={meeting}
                recording={meeting.id === recordingId}
                onOpen={() => onOpen(meeting.id)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function preview(meeting: Meeting): string {
  const summaryLine = meeting.summary
    ?.split('\n')
    .map((line) =>
      line
        .replace(/^[#\-*\s[\]x]+/i, '')
        .replace(/\*\*|__|`/g, '')
        .trim(),
    )
    .find((line) => line && !/^(summary|key points)$/i.test(line))
  return summaryLine || meeting.notes.trim().split('\n')[0] || ''
}

function MeetingRow({ meeting, recording, onOpen }: { meeting: Meeting; recording: boolean; onOpen: () => void }) {
  const text = preview(meeting)
  return (
    <button className="meeting-row" onClick={onOpen}>
      <span className="history-time">{timeLabel(meeting.createdAt)}</span>
      <span className="meeting-row-body">
        <strong>{meeting.title || 'Untitled meeting'}</strong>
        {text && <span className="meeting-preview">{text}</span>}
      </span>
      <span className="meeting-row-meta">
        {recording ? <span className="badge recording">● Recording</span> : formatClock(meeting.recordedMs)}
      </span>
    </button>
  )
}

interface MeetingViewProps {
  id: string
  startError: string | null
  onStartError: (error: string | null) => void
  onBack: () => void
}

function MeetingView({ id, startError, onStartError, onBack }: MeetingViewProps) {
  const [meeting] = useData(() => api.getMeeting(id), ['meetings'])
  const [notetaker] = useData(api.getNotetakerState, ['notetaker'])
  const [title, setTitle] = useState<string | null>(null)
  const [notes, setNotes] = useState<string | null>(null)
  const [showTranscript, setShowTranscript] = useState(true)
  const [editingSpeakers, setEditingSpeakers] = useState(false)
  const titleEdited = useRef(false)

  // Seed the editors once; afterwards they are the source of truth, except for the auto-generated title.
  useEffect(() => {
    if (!meeting) return
    setNotes((current) => current ?? meeting.notes)
    if (!titleEdited.current) setTitle(meeting.title)
  }, [meeting])

  useDebouncedSave(notes, meeting?.notes, (value) => void api.updateMeeting(id, { notes: value }))
  useDebouncedSave(title, meeting?.title, (value) => void api.updateMeeting(id, { title: value }))

  if (meeting === null) return null
  const recordingHere = recordingMeetingId(notetaker) === id
  const turns = transcriptTurns(meeting.transcript)
  const speakers = [...new Set(turns.map((t) => t.speaker))].filter((key) => key !== YOU)

  return (
    <div className="page meeting-page">
      <button className="link back" onClick={onBack}>
        ← Notetaker
      </button>

      <header className="meeting-header">
        <input
          className="meeting-title"
          placeholder="Untitled meeting"
          value={title ?? ''}
          onChange={(e) => {
            titleEdited.current = true
            setTitle(e.target.value)
          }}
        />
        <p className="muted small">
          {new Date(meeting.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
        </p>
      </header>

      <RecordBar meeting={meeting} notetaker={notetaker} startError={startError} onStartError={onStartError} />

      <section className="meeting-section">
        <h3>My notes</h3>
        <textarea
          className="meeting-notes"
          placeholder="Write your notes here. We'll make a separate summary at the end."
          rows={6}
          value={notes ?? ''}
          onChange={(e) => setNotes(e.target.value)}
        />
      </section>

      <SummarySection meetingId={id} state={summaryState(meeting, recordingHere)} />

      <section className="meeting-section">
        <div className="section-title">
          <h3>Transcript</h3>
          <div className="section-actions">
            {speakers.length > 0 && !editingSpeakers && (
              <button className="link" onClick={() => setEditingSpeakers(true)}>
                Assign speakers
              </button>
            )}
            <button className="link" onClick={() => setShowTranscript((v) => !v)}>
              {showTranscript ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        {editingSpeakers && (
          <SpeakerEditor
            speakers={speakers}
            names={meeting.speakerNames}
            onSave={(names) => {
              setEditingSpeakers(false)
              void api.updateMeeting(id, { speakerNames: names })
            }}
            onCancel={() => setEditingSpeakers(false)}
          />
        )}
        {showTranscript && (
          <Transcript
            turns={turns}
            speakers={speakers}
            names={meeting.speakerNames}
            recording={recordingHere}
            onRename={() => setEditingSpeakers(true)}
          />
        )}
      </section>

      <div>
        <button
          className="link danger"
          onClick={() => {
            if (!confirm('Delete this meeting, its notes and transcript?')) return
            void api.deleteMeeting(id).then(onBack)
          }}
        >
          Delete meeting
        </button>
      </div>
    </div>
  )
}

/**
 * Saves `value` shortly after the user stops typing, unless it already matches what is stored, and
 * saves any pending edit when the view closes.
 */
function useDebouncedSave(value: string | null, stored: string | undefined, save: (value: string) => void): void {
  const saveRef = useRef(save)
  saveRef.current = save
  const pending = useRef<string | null>(null)
  // Keyed on `value` only: the stored copy catching up must not schedule another save.
  useEffect(() => {
    if (value === null || value === stored) return
    pending.current = value
    const timer = setTimeout(() => {
      pending.current = null
      saveRef.current(value)
    }, SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [value])
  useEffect(
    () => () => {
      if (pending.current !== null) saveRef.current(pending.current)
    },
    [],
  )
}

interface RecordBarProps {
  meeting: MeetingDetail
  notetaker: NotetakerState | null
  startError: string | null
  onStartError: (error: string | null) => void
}

function RecordBar({ meeting, notetaker, startError, onStartError }: RecordBarProps) {
  const now = useNow(notetaker?.kind === 'recording')
  const start = () => {
    onStartError(null)
    api.startMeetingRecording(meeting.id).catch((error: unknown) => onStartError(errorMessage(error)))
  }

  if (!notetaker) return null
  const busyElsewhere = notetaker.kind !== 'idle' && notetaker.meetingId !== meeting.id
  const error = startError ?? (notetaker.kind === 'idle' ? notetaker.error : undefined)

  if (notetaker.kind === 'recording' && notetaker.meetingId === meeting.id) {
    const { systemAudio } = notetaker
    return (
      <div className="card record-bar recording">
        <span className="record-dot" />
        <div className="record-status">
          <strong>Listening · {formatClock(notetaker.baseRecordedMs + now - notetaker.startedAt)}</strong>
          <span className="muted small">
            {systemAudio.kind === 'capturing' && 'Your microphone and the call audio'}
            {systemAudio.kind === 'starting' && 'Starting…'}
            {systemAudio.kind === 'unavailable' && 'Microphone only: the other participants are not being recorded'}
          </span>
          {systemAudio.kind === 'capturing' && <span className="muted small">{liveSpeakersText(notetaker.speakers)}</span>}
          {systemAudio.kind === 'unavailable' && <span className="error-text">{systemAudio.reason}</span>}
          {notetaker.error && <span className="error-text">Transcription failed: {notetaker.error}</span>}
        </div>
        <button className="button" onClick={() => void api.stopMeetingRecording()}>
          Stop
        </button>
      </div>
    )
  }

  if (notetaker.kind === 'finishing' && notetaker.meetingId === meeting.id) {
    return (
      <div className="card record-bar">
        <div className="record-status">
          <strong>Finishing up…</strong>
          <span className="muted small">Transcribing the last few seconds</span>
        </div>
      </div>
    )
  }

  return (
    <div className="card record-bar">
      <div className="record-status">
        <strong>{meeting.recordedMs > 0 ? `Recorded ${formatClock(meeting.recordedMs)}` : 'Not recording'}</strong>
        <span className="muted small">
          {busyElsewhere
            ? 'Another meeting is being recorded.'
            : 'Always get consent when transcribing others.'}
        </span>
        {error && <span className="error-text">{error}</span>}
      </div>
      <button className="button primary" onClick={start} disabled={busyElsewhere}>
        {meeting.recordedMs > 0 ? 'Resume' : 'Start'}
      </button>
    </div>
  )
}

function liveSpeakersText({ platform, speaking }: LiveSpeakers): string {
  if (platform === null) {
    return 'Speakers are named when the call is open in Zoom, Google Meet, Microsoft Teams or a Slack huddle'
  }
  if (speaking.length === 0) return `${PLATFORM_LABEL[platform]}: naming speakers as they talk`
  return `${PLATFORM_LABEL[platform]}: ${speaking.join(', ')} talking`
}

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

function SummarySection({ meetingId, state }: { meetingId: string; state: SummaryState }) {
  const generate = () => void api.generateMeetingSummary(meetingId)
  const body = (() => {
    switch (state.kind) {
      case 'not-yet-generatable':
        return <p className="muted">Summaries appear when a meeting ends.</p>
      case 'too-short':
        return (
          <p className="muted">
            {state.noAudio ? 'No transcript yet. Start recording to get a summary.' : 'The meeting was too short to summarize.'}
          </p>
        )
      case 'ready-to-generate':
        return (
          <button className="button" onClick={generate}>
            Generate summary
          </button>
        )
      case 'generating':
        return <p className="muted">Generating summary…</p>
      case 'generated':
        return <Markdown text={state.summary} />
      case 'update-available':
        return (
          <>
            <div className="summary-notice">
              <span className="muted small">New recording since this summary.</span>
              <button className="link" onClick={generate}>
                Update summary
              </button>
            </div>
            <Markdown text={state.summary} />
          </>
        )
      case 'updating':
        return (
          <>
            <p className="muted small">Updating summary…</p>
            <Markdown text={state.summary} />
          </>
        )
      case 'failed':
        return (
          <>
            <div className="summary-notice">
              <span className="error-text">{state.error}</span>
              <button className="link" onClick={generate}>
                Try again
              </button>
            </div>
            {state.summary !== null && <Markdown text={state.summary} />}
          </>
        )
      default: {
        const unreachable: never = state
        throw new Error(`unhandled summary state ${JSON.stringify(unreachable)}`)
      }
    }
  })()
  const summary = 'summary' in state ? state.summary : null

  return (
    <section className="meeting-section">
      <div className="section-title">
        <h3>Summary</h3>
        {summary && (
          <button className="link" onClick={() => void api.copyText(summary)}>
            Copy
          </button>
        )}
      </div>
      <div className="card summary-card">{body}</div>
    </section>
  )
}

const SPEAKER_COLORS = 6

interface SpeakerEditorProps {
  speakers: string[]
  names: Record<string, string>
  onSave: (names: Record<string, string>) => void
  onCancel: () => void
}

function SpeakerEditor({ speakers, names, onSave, onCancel }: SpeakerEditorProps) {
  const [draft, setDraft] = useState<Record<string, string>>(names)
  return (
    <form
      className="card speaker-editor"
      onSubmit={(e) => {
        e.preventDefault()
        onSave(draft)
      }}
    >
      <p className="muted small">Name each voice and we'll relabel the whole transcript and summary.</p>
      {speakers.map((key) => (
        <label key={key} className="speaker-row">
          <span className={`speaker-chip speaker-color-${speakers.indexOf(key) % SPEAKER_COLORS}`}>
            {speakerLabel(key, {}, '')}
          </span>
          <input
            aria-label={`Name for ${speakerLabel(key, {}, '')}`}
            placeholder="Type a name"
            value={draft[key] ?? ''}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
          />
        </label>
      ))}
      <div className="speaker-editor-actions">
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button primary">
          Save names
        </button>
      </div>
    </form>
  )
}

interface TranscriptProps {
  turns: TranscriptTurn[]
  /** Speaker keys other than the user, in order of first appearance; sets each one's color. */
  speakers: string[]
  names: Record<string, string>
  recording: boolean
  onRename: () => void
}

function Transcript({ turns, speakers, names, recording, onRename }: TranscriptProps) {
  if (turns.length === 0) {
    return (
      <p className="muted empty">
        {recording ? 'Listening… text appears a few seconds after each pause.' : 'No transcript.'}
      </p>
    )
  }
  return (
    <div className="card list transcript">
      {turns.map((turn) => (
        <div key={turn.id} className="transcript-turn">
          <span className="history-time">{formatClock(turn.startMs)}</span>
          <div>
            {turn.speaker === YOU ? (
              <span className="transcript-speaker speaker-you">You</span>
            ) : (
              <button
                className={`transcript-speaker speaker-color-${speakers.indexOf(turn.speaker) % SPEAKER_COLORS}`}
                title="Rename speakers"
                onClick={onRename}
              >
                {speakerLabel(turn.speaker, names, '')}
              </button>
            )}
            <p>{turn.text}</p>
          </div>
        </div>
      ))}
    </div>
  )
}
