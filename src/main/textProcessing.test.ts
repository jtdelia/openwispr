import { describe, expect, it } from 'vitest'
import {
  appCategory,
  applyReplacements,
  applySnippets,
  cleanupMessages,
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

describe('cleanupMessages', () => {
  const input = {
    transcript: 'once i finish the draft',
    style: 'casual' as const,
    category: 'other' as const,
    appName: 'Notes',
    beforeText: "I'll send it over",
    dictionary: [{ id: '1', word: 'OpenWispr' }],
    userName: 'Jane',
  }

  it('passes the app and the text before the cursor as context, and says when it continues a sentence', () => {
    const [system, user] = cleanupMessages(input)
    expect(user).toEqual({
      role: 'user',
      content: '<context>\nApp: Notes\nText before the cursor: "I\'ll send it over"\n</context>\n<transcript>\nonce i finish the draft\n</transcript>',
    })
    expect(system.content).toMatch(/continues a sentence/)
    expect(system.content).toContain('OpenWispr')
  })

  it('quotes only the end of a long text before the cursor, and leaves out context it has none of', () => {
    const [, long] = cleanupMessages({ ...input, beforeText: `${'x'.repeat(1000)} the end` })
    expect(long.content).toContain('the end"')
    expect(long.content.length).toBeLessThan(600)
    const [, bare] = cleanupMessages({ ...input, appName: '', beforeText: '' })
    expect(bare.content).toBe('<transcript>\nonce i finish the draft\n</transcript>')
  })

  it("forbids greetings and sign-offs the speaker didn't say", () => {
    expect(cleanupMessages(input)[0].content).toMatch(/greeting or sign-off that wasn't spoken/)
  })

  it('leaves out the continuation rule after a finished sentence or with nothing before the cursor', () => {
    expect(cleanupMessages({ ...input, beforeText: 'Done.' })[0].content).not.toMatch(/continues a sentence/)
    expect(cleanupMessages({ ...input, beforeText: '' })[0].content).not.toMatch(/continues a sentence/)
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
