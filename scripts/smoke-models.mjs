#!/usr/bin/env node
// Manual smoke test of the model process, printing latency.
// Usage: npm run models:smoke -- [clip.wav] [--language en] [--prompt "OpenWispr"] [--model apple] [--models-dir dir]
//        npm run models:smoke -- --cleanup [fixtures.json]
// The first transcribes a clip. --model is `apple` or a downloaded model's id, looked up in --models-dir
// (defaults to the app's). The first load of a downloaded Core ML model (like `whisper-small`) compiles it
// for this Mac and can take minutes. The clip must be a 16 kHz mono 16-bit WAV, e.g.
// `say -o clip.wav --file-format=WAVE --data-format=LEI16@16000 "…"`.
// `--cleanup` runs the Cleanup fixtures through a chat model (--model: `apple` or a downloaded MLX model's id,
// like `qwen3-4b-instruct-2507`) with the app's prompt and prints Markdown.
// With OPENAI_API_KEY set it also runs them through the cloud default (OPENWISPR_CLOUD_MODEL, default
// gpt-4.1-mini, at OPENWISPR_CLOUD_BASE_URL) for a side-by-side comparison.
// Set OPENWISPR_MODELS to test another build, e.g. dist/mac-arm64/OpenWispr.app/Contents/Resources/openwispr-models.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { cleanupMaxTokens, cleanupMessages, sanitizeCleanup } from '../src/main/textProcessing.ts'

const args = process.argv.slice(2)
function option(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 ? args.splice(index, 2)[1] : fallback
}
function flag(name) {
  const index = args.indexOf(name)
  return index >= 0 && args.splice(index, 1).length > 0
}
const language = option('--language', 'en')
const prompt = option('--prompt', '')
const model = option('--model', 'apple')
const modelsDir = option('--models-dir', join(homedir(), 'Library/Application Support/OpenWispr/models'))
const cleanup = flag('--cleanup')
const executable = process.env.OPENWISPR_MODELS ?? 'native/models/.build/release/openwispr-models'
const REQUEST_TIMEOUT_MS = 120_000

const child = spawn(executable, ['--models-dir', modelsDir], { stdio: ['pipe', 'pipe', 'inherit'] })
child.on('error', (error) => {
  console.error(`Couldn't start ${executable} (${error.message}). Run "npm run models:build" first.`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  for (const { reject } of pending.values()) reject(new Error(`The model process exited (code ${code}, signal ${signal})`))
})

const pending = new Map()
let nextId = 1
createInterface({ input: child.stdout }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'progress') {
    console.log(`  downloading ${message.locale} assets: ${Math.round(message.fraction * 100)}%`)
    return
  }
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id)
  clearTimeout(entry.timer)
  if (message.error) entry.reject(Object.assign(new Error(`${message.error.code}: ${message.error.message}`), { code: message.error.code }))
  else entry.resolve(message.result)
})

function request(body) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`No answer to ${body.type} within ${REQUEST_TIMEOUT_MS / 1000} s`))
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(`${JSON.stringify({ ...body, id })}\n`)
  })
}

async function timed(label, body) {
  const started = performance.now()
  const result = await request(body)
  const ms = Math.round(performance.now() - started)
  console.log(`${label}: ${ms} ms`)
  return result
}

async function smokeSpeech() {
  const clip = args[0] ?? 'scripts/fixtures/dictation-en.wav'
  const audio = readFileSync(clip)
  const audioSeconds = (audio.byteLength - 44) / 32_000
  const transcribe = { type: 'transcribe', model, audio: audio.toString('base64'), language, prompt, segments: true }
  console.log(`Clip: ${clip} (${audioSeconds.toFixed(1)} s), model "${model}", language "${language}"`)
  const status = await timed('Status (process start)', { type: 'status', language, ...(model !== 'apple' && { speechToText: model }) })
  if (model === 'apple') {
    console.log(`  available: ${status.appleSpeech.available}${status.appleSpeech.reason ? ` (${status.appleSpeech.reason})` : ''}`)
    console.log(`  locale: ${status.appleSpeech.locale ?? 'unsupported'}; ${status.appleSpeech.locales.length} supported locales`)
  } else if (status.speechToText) {
    const { name, supported, languages } = status.speechToText
    console.log(`  ${name}: ${supported ? 'supports' : "doesn't support"} "${language}"; languages: ${languages?.join(' ') ?? 'any'}`)
  } else {
    console.log(`  ${model} isn't installed in ${modelsDir}`)
  }
  await timed('Warm-up (load)', { type: 'load', models: [{ role: 'speechToText', id: model, language }] })
  const first = await timed('First transcription', transcribe)
  const warm = await timed('Warm transcription', transcribe)
  console.log(`Text: ${first.text.trim()}`)
  for (const s of warm.segments) console.log(`  ${s.start.toFixed(2)}–${s.end.toFixed(2)} s ${s.text.trim()}`)
}

/** Runs one Cleanup like `Models.cleanup`: the transcript is kept when the model fails or refuses. */
async function cleanUp(complete, fixture) {
  const input = {
    transcript: fixture.transcript,
    style: fixture.style ?? 'casual',
    category: fixture.category ?? 'other',
    beforeText: fixture.beforeText ?? '',
    dictionary: [],
    userName: '',
  }
  const started = performance.now()
  try {
    const output = await complete(cleanupMessages(input), cleanupMaxTokens(input.transcript))
    const text = sanitizeCleanup(output, input.transcript)
    const note = text === input.transcript && output.trim() !== input.transcript ? ` (kept transcript; model said ${JSON.stringify(output.trim())})` : ''
    return { text: `${text}${note}`, ms: Math.round(performance.now() - started) }
  } catch (error) {
    return { text: `(kept transcript: ${error.message})`, ms: Math.round(performance.now() - started) }
  }
}

async function completeCloud(messages) {
  const baseUrl = process.env.OPENWISPR_CLOUD_BASE_URL ?? 'https://api.openai.com/v1'
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.OPENWISPR_CLOUD_MODEL ?? 'gpt-4.1-mini', messages }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Chat failed (${response.status}): ${await response.text()}`)
  return (await response.json()).choices?.[0]?.message?.content ?? ''
}

const cell = (text) => text.replace(/\|/g, '\\|').replace(/\n/g, '<br>')

async function smokeCleanup() {
  const fixtures = JSON.parse(readFileSync(args[0] ?? 'scripts/fixtures/cleanup.json', 'utf8'))
  const status = await timed('Status (process start)', { type: 'status', language, ...(model !== 'apple' && { chat: model }) })
  let label = 'Apple'
  if (model === 'apple') {
    const { appleChat } = status
    console.log(`  Apple chat available: ${appleChat.available}${appleChat.reason ? ` (${appleChat.reason})` : ''}; context ${appleChat.contextSize} tokens`)
  } else if (status.chat) {
    label = status.chat.name
    console.log(`  ${status.chat.name}: context ${status.chat.contextSize} tokens`)
  } else {
    console.log(`  ${model} isn't an installed chat model in ${modelsDir}`)
  }
  await timed('Warm-up (load)', { type: 'load', models: [{ role: 'chat', id: model, language }] })
  const cloud = Boolean(process.env.OPENAI_API_KEY)
  const local = (messages, maxTokens) => request({ type: 'complete', model, messages, maxTokens }).then((r) => r.text)

  console.log('')
  console.log(cloud ? `| Fixture | Transcript | ${label} | Cloud |` : `| Fixture | Transcript | ${label} |`)
  console.log(cloud ? '|---|---|---|---|' : '|---|---|---|')
  for (const fixture of fixtures) {
    const a = await cleanUp(local, fixture)
    const row = [fixture.name, fixture.transcript, `${a.text} _(${a.ms} ms)_`]
    if (cloud) {
      const c = await cleanUp(completeCloud, fixture)
      row.push(`${c.text} _(${c.ms} ms)_`)
    }
    console.log(`| ${row.map(cell).join(' | ')} |`)
  }
}

try {
  await (cleanup ? smokeCleanup() : smokeSpeech())
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  child.stdin.end()
}
