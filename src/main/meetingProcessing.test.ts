import { describe, expect, it } from 'vitest'
import { MIN_SUMMARY_WORDS, summaryState } from '../shared/summaryState'
import { formatClock } from '../shared/time'
import type { Meeting, TranscriptEntry } from '../shared/types'
import {
  chunkPrompt,
  formatTranscript,
  isLikelyHallucination,
  relabelSummary,
  sanitizeSummary,
  sanitizeTitle,
  summaryMessages,
} from './meetingProcessing'

const entry = (source: TranscriptEntry['source'], startMs: number, text: string, speaker?: string): TranscriptEntry => ({
  id: `${source}-${startMs}`,
  source,
  text,
  startMs,
  endMs: startMs + 1000,
  ...(speaker ? { speaker } : {}),
})

describe('formatTranscript', () => {
  it('merges consecutive entries from the same speaker into one turn', () => {
    const text = formatTranscript(
      [entry('mic', 0, 'Hi all.'), entry('mic', 4000, 'Shall we start?'), entry('system', 9000, 'Sure.')],
      {},
      '',
    )
    expect(text).toBe('[0:00] Me: Hi all. Shall we start?\n[0:09] Others: Sure.')
  })

  it("labels the user's turns with their name when set", () => {
    expect(formatTranscript([entry('mic', 65_000, 'Hello')], {}, 'Ada Lovelace')).toBe('[1:05] Ada Lovelace (me): Hello')
  })

  it('splits call audio by speaker and applies the names the user gave', () => {
    const text = formatTranscript(
      [
        entry('system', 0, 'Morning.', 'app:Alice Smith'),
        entry('system', 2000, 'Hi.', 'voice:2'),
        entry('system', 4000, 'Let us begin.', 'voice:2'),
      ],
      { 'voice:2': 'Dana' },
      '',
    )
    expect(text).toBe('[0:00] Alice Smith: Morning.\n[0:02] Dana: Hi. Let us begin.')
  })
})

describe('relabelSummary', () => {
  it('renames whole labels only', () => {
    const summary = '- [ ] **Speaker 1**: send the deck\n- Speaker 10 agreed. Others joined late.'
    expect(
      relabelSummary(summary, [
        { from: 'Speaker 1', to: 'Dana' },
        { from: 'Others', to: 'Sam' },
      ]),
    ).toBe('- [ ] **Dana**: send the deck\n- Speaker 10 agreed. Sam joined late.')
  })
})

describe('formatClock', () => {
  it('formats minutes and hours', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(61_500)).toBe('1:01')
    expect(formatClock(3_725_000)).toBe('1:02:05')
  })
})

describe('isLikelyHallucination', () => {
  it('drops subtitle artifacts and empty output, but keeps real short replies', () => {
    expect(isLikelyHallucination('Thanks for watching!')).toBe(true)
    expect(isLikelyHallucination(' you ')).toBe(true)
    expect(isLikelyHallucination('...')).toBe(true)
    expect(isLikelyHallucination('Thank you.')).toBe(false)
    expect(isLikelyHallucination('Thanks for watching the demo, everyone.')).toBe(false)
  })
})

describe('chunkPrompt', () => {
  it('combines vocabulary with the tail of the previous text', () => {
    expect(chunkPrompt('Vocabulary: Kubernetes.', 'x'.repeat(500) + ' end')).toMatch(/^Vocabulary: Kubernetes\. x+ end$/)
    expect(chunkPrompt('', '')).toBe('')
  })
})

describe('sanitizeTitle', () => {
  it('strips quotes, prefixes and trailing punctuation', () => {
    expect(sanitizeTitle('"Q3 Roadmap Review."')).toBe('Q3 Roadmap Review')
    expect(sanitizeTitle('Title: Hiring Sync\nBecause they discussed hiring')).toBe('Hiring Sync')
    expect(sanitizeTitle('**Launch Planning**')).toBe('Launch Planning')
  })
})

describe('sanitizeSummary', () => {
  it('unwraps a fenced Markdown answer', () => {
    expect(sanitizeSummary('```markdown\n### Summary\nShipped.\n```')).toBe('### Summary\nShipped.')
    expect(sanitizeSummary('### Summary\nShipped.')).toBe('### Summary\nShipped.')
  })
})

describe('summaryMessages', () => {
  it('passes notes and transcript separately and explains the speaker labels', () => {
    const [system, user] = summaryMessages({
      title: 'Sync',
      transcript: '[0:00] Me: Hi',
      notes: 'ask about budget',
      userName: '',
      dictionary: [{ id: '1', word: 'Wispr' }],
      recordedAt: Date.UTC(2026, 0, 5, 15),
    })
    expect(system!.content).toContain('"Me" is the user')
    expect(system!.content).toContain('### Action Items')
    expect(system!.content).toContain('Wispr')
    expect(user!.content).toContain('<notes>\nask about budget\n</notes>')
    expect(user!.content).toContain('<transcript>\n[0:00] Me: Hi\n</transcript>')
  })
})

describe('summaryState', () => {
  const meeting: Meeting = {
    id: 'm',
    title: '',
    createdAt: 0,
    modifiedAt: 0,
    notes: '',
    summary: null,
    summaryRecordedMs: 0,
    summaryError: null,
    summaryGenerating: false,
    recordedMs: 60_000,
    transcriptWords: MIN_SUMMARY_WORDS,
    speakerNames: {},
  }

  it('waits for the meeting to end before offering a summary', () => {
    expect(summaryState(meeting, true).kind).toBe('not-yet-generatable')
    expect(summaryState(meeting, false).kind).toBe('ready-to-generate')
  })

  it('reports short and empty meetings', () => {
    expect(summaryState({ ...meeting, transcriptWords: 3 }, false)).toEqual({ kind: 'too-short', noAudio: false })
    expect(summaryState({ ...meeting, recordedMs: 0, transcriptWords: 0 }, false)).toEqual({
      kind: 'too-short',
      noAudio: true,
    })
  })

  it('offers an update when audio was recorded after the summary', () => {
    const summarized = { ...meeting, summary: 'S', summaryRecordedMs: 60_000 }
    expect(summaryState(summarized, false).kind).toBe('generated')
    expect(summaryState({ ...summarized, recordedMs: 90_000 }, false).kind).toBe('update-available')
    expect(summaryState({ ...summarized, recordedMs: 90_000 }, true).kind).toBe('generated')
    expect(summaryState({ ...summarized, summaryGenerating: true }, false).kind).toBe('updating')
  })

  it('keeps the previous summary visible when regeneration fails', () => {
    expect(summaryState({ ...meeting, summary: 'S', summaryError: 'boom' }, false)).toEqual({
      kind: 'failed',
      summary: 'S',
      error: 'boom',
    })
  })
})
