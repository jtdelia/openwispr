#!/usr/bin/env node
// Manual smoke test: transcribes a clip through the model process's Apple speech-to-text and prints latency.
// Usage: npm run models:smoke -- [clip.wav] [--language en]
// Set OPENWISPR_MODELS to test another build, e.g. dist/mac-arm64/OpenWispr.app/Contents/Resources/openwispr-models.
// The clip must be a 16 kHz mono 16-bit WAV, e.g. `say -o clip.wav --file-format=WAVE --data-format=LEI16@16000 "…"`.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const languageFlag = args.indexOf('--language')
const language = languageFlag >= 0 ? args.splice(languageFlag, 2)[1] : 'en'
const clip = args[0] ?? 'scripts/fixtures/dictation-en.wav'
const executable = process.env.OPENWISPR_MODELS ?? 'native/models/.build/release/openwispr-models'

const audio = readFileSync(clip)
const audioSeconds = (audio.byteLength - 44) / 32_000

const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'inherit'] })
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
  pending.delete(message.id)
  if (message.error) entry.reject(new Error(`${message.error.code}: ${message.error.message}`))
  else entry.resolve(message.result)
})

function request(body) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
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

const transcribe = { type: 'transcribe', model: 'apple', audio: audio.toString('base64'), language, prompt: '', segments: true }

try {
  console.log(`Clip: ${clip} (${audioSeconds.toFixed(1)} s), language "${language}"`)
  const status = await timed('Status (process start)', { type: 'status', language })
  console.log(`  available: ${status.appleSpeech.available}${status.appleSpeech.reason ? ` (${status.appleSpeech.reason})` : ''}`)
  console.log(`  locale: ${status.appleSpeech.locale ?? 'unsupported'}; ${status.appleSpeech.locales.length} supported locales`)
  await timed('Warm-up (load)', { type: 'load', models: [{ role: 'speechToText', id: 'apple', language }] })
  const first = await timed('First transcription', transcribe)
  const warm = await timed('Warm transcription', transcribe)
  console.log(`Text: ${first.text.trim()}`)
  for (const s of warm.segments) console.log(`  ${s.start.toFixed(2)}–${s.end.toFixed(2)} s ${s.text.trim()}`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  child.stdin.end()
}
