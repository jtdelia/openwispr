// Manual smoke test of meeting summaries with Apple's chat model, printing each request and latency.
// Usage: npm run models:smoke-summary -- [--turns 360] [--timeout-s 900]
// Summarizes a synthetic meeting (360 turns is about an hour) through `Models` and the model process, the
// way the Notetaker does, so a meeting longer than the context is summarized in pieces. Also asks the model
// how many tokens the whole transcript is, to compare its tokenizer with the summary's estimate.
// Set OPENWISPR_MODELS to test another build of the model process.
import { tmpdir } from 'node:os'
import { summarizeMeeting, titleMeeting, type MeetingChat } from '../src/main/meetingSummary'
import { summaryMessages } from '../src/main/meetingProcessing'
import { spawnTransport } from '../src/main/modelProcess'
import { Models } from '../src/main/models'

const args = process.argv.slice(2)
function option(name: string, fallback: string): string {
  const index = args.indexOf(name)
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback
}
const turns = Number(option('--turns', '360'))
const timeoutS = Number(option('--timeout-s', '900'))
const executable = process.env.OPENWISPR_MODELS ?? 'native/models/.build/release/openwispr-models'

const deadline = setTimeout(() => {
  console.error(`No summary within ${timeoutS} s`)
  process.exit(1)
}, timeoutS * 1000)

const PEOPLE = ['Me', 'Dana Kim', 'Sam Ortiz', 'Priya Shah']
const TOPICS = [
  ['launch', 'The launch moves from March 3 to March 14 because the payments review is not done.', 'Sam will tell the support team about the new launch date by Wednesday.'],
  ['budget', 'The marketing budget stays at 40,000 dollars for the quarter, with 5,000 held back for events.', 'Priya will send the updated budget sheet to finance on Friday.'],
  ['hiring', 'The team keeps the hiring freeze for engineers but opens one designer role in April.', 'Dana will write the designer job description and share it next Monday.'],
  ['onboarding', 'New customers get a guided setup call in their first week instead of the long email course.', 'I will draft the setup call script and ask Sam to review it.'],
  ['incident', 'Last Tuesday the sync service was down for 40 minutes after a certificate expired.', 'Sam will add certificate expiry alerts to the on-call dashboard this week.'],
  ['pricing', 'The team agrees to keep the 12 dollar plan and drop the annual discount from 20 to 15 percent.', 'Priya will update the pricing page copy before the launch.'],
]
const FILLER = [
  'Yeah, that makes sense to me.',
  'Can you say a bit more about how that affects the timeline?',
  'I talked to a couple of customers about this last week and they mentioned the same thing.',
  "Let's not go too deep on that, we can take it offline.",
  'Right, and we should double-check that with legal before anything goes out.',
  'One thing I would add is that the documentation still points to the old flow.',
  'Okay, so to summarize where we are on this one before we move on.',
]

function syntheticTranscript(count: number): string {
  const lines: string[] = []
  for (let i = 0; i < count; i++) {
    const topic = TOPICS[Math.floor((i / count) * TOPICS.length)]!
    const step = i % 12
    const text = step === 0 ? `Next up is ${topic[0]}.` : step === 5 ? topic[1] : step === 9 ? topic[2] : FILLER[i % FILLER.length]
    const seconds = i * 10
    const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    lines.push(`[${clock}] ${PEOPLE[i % PEOPLE.length]}: ${text}`)
  }
  return lines.join('\n')
}

const models = new Models({
  fetch: globalThis.fetch,
  settings: () => ({ speechToText: { kind: 'builtIn', modelId: 'apple' }, chat: { kind: 'builtIn', modelId: 'apple' }, language: 'en' }),
  transport: spawnTransport(executable, { requestSpeechAuthorization: false, modelsDir: tmpdir() }),
  modelsDir: tmpdir(),
})

let requests = 0
const logged: MeetingChat = {
  chatContextSize: () => models.chatContextSize(),
  async complete(messages, options) {
    const n = ++requests
    const chars = messages.reduce((sum, m) => sum + m.content.length, 0)
    const started = performance.now()
    try {
      const text = await models.complete(messages, options)
      console.log(`  #${n}: ${chars} chars, maxTokens ${options?.maxTokens} → ${text.length} chars in ${Math.round(performance.now() - started)} ms`)
      return text
    } catch (error) {
      console.log(`  #${n}: ${chars} chars, maxTokens ${options?.maxTokens} → ${String(error)} in ${Math.round(performance.now() - started)} ms`)
      throw error
    }
  },
}

const input = {
  title: '',
  transcript: syntheticTranscript(turns),
  notes: 'ask about the hiring freeze\npricing: annual discount?',
  userName: '',
  dictionary: [],
  recordedAt: Date.now(),
}

try {
  const contextSize = await models.chatContextSize()
  console.log(`Apple chat context: ${contextSize} tokens; transcript ${turns} turns, ${input.transcript.length} chars`)
  const whole = summaryMessages(input)
  const wholeChars = whole.reduce((sum, m) => sum + m.content.length, 0)
  await models.complete(whole, { maxTokens: 16 }).catch((error: unknown) => {
    const tokens = /\((\d+) of \d+ tokens\)/.exec(String(error))?.[1]
    if (tokens) console.log(`Whole request: ${wholeChars} chars = ${tokens} tokens (${(wholeChars / Number(tokens)).toFixed(2)} chars per token)`)
  })

  let started = performance.now()
  console.log('Title:')
  const title = await titleMeeting(logged, input)
  console.log(`  "${title}" in ${Math.round(performance.now() - started)} ms`)

  requests = 0
  started = performance.now()
  console.log('Summary:')
  const summary = await summarizeMeeting(logged, input)
  console.log(`Summary from ${requests} requests in ${Math.round(performance.now() - started)} ms:\n`)
  console.log(summary)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  clearTimeout(deadline)
  models.stop()
}
