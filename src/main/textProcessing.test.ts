import { describe, expect, it } from 'vitest'
import {
  appCategory,
  applyReplacements,
  applySnippets,
  joinWithContext,
  sanitizeCleanup,
  styleContext,
  transcriptionPrompt,
  wholeSnippet,
} from './textProcessing'

describe('appCategory / styleContext', () => {
  it('classifies native apps by bundle id', () => {
    expect(appCategory('com.apple.mail')).toBe('email')
    expect(appCategory('com.googlecode.iterm2')).toBe('terminal')
    expect(appCategory('com.tinyspeck.slackmacgap')).toBe('messaging')
    expect(appCategory('com.apple.TextEdit')).toBe('other')
  })

  it('classifies browser tabs by window title', () => {
    expect(appCategory('com.google.Chrome', 'Inbox (3) - Gmail')).toBe('email')
    expect(appCategory('com.google.Chrome', 'GitHub')).toBe('other')
  })

  it('splits messaging into work and personal', () => {
    expect(styleContext('messaging', 'com.tinyspeck.slackmacgap')).toBe('work')
    expect(styleContext('messaging', 'com.apple.MobileSMS')).toBe('personal')
  })
})

describe('applyReplacements', () => {
  it('replaces whole phrases case-insensitively', () => {
    const dict = [{ id: '1', word: 'OpenWispr', replaces: 'open whisper' }]
    expect(applyReplacements('I love Open Whisper a lot', dict)).toBe('I love OpenWispr a lot')
    expect(applyReplacements('reopen whispers', dict)).toBe('reopen whispers')
  })
})

describe('applySnippets', () => {
  const snippets = [{ id: '1', trigger: 'my calendar link', expansion: 'https://cal.com/me' }]

  it('expands a bare trigger', () => {
    expect(wholeSnippet('My calendar link.', snippets)).toBe('https://cal.com/me')
    expect(wholeSnippet('Here is my calendar link', snippets)).toBeNull()
  })

  it('expands an inline trigger', () => {
    expect(applySnippets('Book here: my calendar link, thanks', snippets)).toBe('Book here: https://cal.com/me, thanks')
  })
})

describe('transcriptionPrompt', () => {
  it('lists vocabulary', () => {
    expect(transcriptionPrompt([{ id: '1', word: 'Kubernetes' }], 'Tai')).toBe('Vocabulary: Tai, Kubernetes.')
    expect(transcriptionPrompt([], '')).toBe('')
  })
})

describe('sanitizeCleanup', () => {
  it('strips quotes the model added', () => {
    expect(sanitizeCleanup('"Hello there."', 'hello there')).toBe('Hello there.')
  })

  it('falls back when the model answered instead of formatting', () => {
    const transcript = 'what is the capital of france'
    expect(sanitizeCleanup('The capital of France is Paris. '.repeat(10), transcript)).toBe(transcript)
  })
})

describe('joinWithContext', () => {
  it('inserts a space after a word', () => {
    expect(joinWithContext('world', 'hello')).toBe(' world')
  })

  it('does not double spaces or space before punctuation', () => {
    expect(joinWithContext('world', 'hello ')).toBe('world')
    expect(joinWithContext('.', 'hello')).toBe('.')
    expect(joinWithContext('hi', '')).toBe('hi')
  })
})
