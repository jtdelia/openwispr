# OpenWispr

Open-source voice dictation for macOS, modeled on [Wispr Flow](https://wisprflow.ai). Hold a key, speak
in any app, and the cleaned-up text is pasted at your cursor.

Behavior was reverse-engineered from the shipped Wispr Flow 1.6.1102 bundle (see
[`docs/wispr-flow-findings.md`](docs/wispr-flow-findings.md)). No Wispr code or assets are included;
transcription runs against any OpenAI-compatible endpoint you configure.

## Features

- **Push-to-talk**: hold `fn`, speak, release. Holds shorter than 500 ms are ignored as accidental taps.
- **Hands-free**: `fn + Space` (or press Space while holding `fn`) locks recording; press `fn` again to
  finish. `Esc` cancels at any time.
- **Flow bar**: a small pill at the bottom of the screen with a live waveform. Click it to start hands-free.
- **AI cleanup**: removes filler words, applies self-corrections ("at three, no, at four"), fixes
  punctuation, formats lists, and adapts tone per app (personal messages, work messages, email, other).
- **Context-aware**: reads the text before your cursor via Accessibility so insertions continue
  naturally, and classifies the frontmost app (email, AI chat, terminal, messaging).
- **Dictionary**: custom spellings, plus "replaces" rules for words the ASR keeps mishearing.
- **Snippets**: say a trigger phrase, get the full text.
- **History and stats**: every dictation with raw and formatted text, words dictated, and WPM.
- **Notetaker**: click *New note* when a meeting starts. OpenWispr records your microphone and the
  call audio (system audio) as separate channels, shows a live transcript, and when you stop it titles
  the meeting and writes a Markdown summary with key points, decisions and action items. Your own
  notes stay separate and steer the summary. Resume to keep recording into the same meeting.
- **Speaker identification**: your microphone is *You*. Call audio is credited to whoever the meeting
  app shows talking (Google Meet in a browser, Zoom, Microsoft Teams, Slack huddles), read through
  Accessibility. With a diarizing model (`gpt-4o-transcribe-diarize`) voices nobody was shown for
  become *Speaker 1*, *Speaker 2*, … and keep their number for the whole meeting. *Assign speakers*
  renames any of them across the transcript and summary.
- `⌃⌘V` pastes the last transcript, `⌃⌘C` copies it. All shortcuts can be rebound.
- The clipboard is restored 500 ms after pasting, and the pasted item is marked
  `org.nspasteboard.ConcealedType` so clipboard managers skip it.

## Architecture

```
src/main/        Electron main: shortcut gestures, dictation state machine, Models (the model seam), JSON store
src/preload/     Typed context bridge (window.openwispr)
src/renderer/    hub/   main window (Home, Notetaker, Dictionary, Snippets, Style, Settings)
                 status/ Flow bar, dictation capture, meeting capture (mic + system audio → speech chunks)
src/shared/      Types, IPC channels, macOS key codes
native/helper/   Swift helper: CGEventTap, Accessibility reads, paste + clipboard restore
native/models/   Swift model process: runs Built-in models (Apple's SpeechTranscriber today)
```

`Models` starts the model process when a dictation starts (so the model loads while you speak), talks to
it over newline-delimited JSON on stdio with the audio passed in memory, and stops it after 10 minutes
without requests. If it crashes, that one dictation fails and the next one starts it again.

The helper streams raw key transitions to the main process over newline-delimited JSON on stdio.
`ShortcutEngine` turns them into gestures, and the helper swallows a key only when it completes a
registered shortcut, so `fn + Space` never types a space.

## Getting started

Requirements: macOS 13+ (macOS 26+ for Apple's speech-to-text), Node 22.12+, Xcode 26+ (Swift 6.2+), and an *Apple Development*
signing certificate in your keychain (Xcode → Settings → Accounts → Manage Certificates → + → Apple
Development; a free Apple account is enough).

```bash
npm install
npm run setup     # downloads the Electron binary (needed if npm runs with ignore-scripts) and builds the native processes
npm run package   # builds and signs dist/mac-arm64/OpenWispr.app
ditto dist/mac-arm64/OpenWispr.app /Applications/OpenWispr.app
open /Applications/OpenWispr.app
```

`npm run package` signs with the first *Apple Development* identity it finds (set
`OPENWISPR_SIGNING_IDENTITY` to pick another) and stops with an error if there is none. macOS ties
permission grants to the signing certificate and the bundle id (`io.github.jtdelia.openwispr`), so
grants survive rebuilding and reinstalling: quit OpenWispr, run the last three commands again.

Then in **Settings**:

1. **Accessibility**: click *Grant access* and enable *OpenWispr* in System Settings → Privacy &
   Security → Accessibility. OpenWispr picks up the grant without a restart.
2. **Microphone**: click *Allow*.
3. **Speech-to-text**: choose *Apple (on this Mac)* to transcribe on-device with nothing to set up
   (the first dictation in a new language downloads Apple's language files), or pick an Endpoint
   preset, paste an API key, and use *Test* to check it answers. Settings explains when Apple doesn't
   support your language.
4. **Notetaker** (optional): the first recording asks for *System Audio Recording* permission
   (System Settings → Privacy & Security → Screen & System Audio Recording). Without it, only your
   microphone is recorded. Meeting titles and summaries use the chat model. Requires macOS 13+, and
   macOS 14.4+ for audio-only capture without screen recording. Speaker names need the Accessibility
   grant; in a browser, keep the Meet tab visible (background tabs aren't readable).

| Preset | Transcription model | Cleanup model |
| --- | --- | --- |
| OpenAI | `gpt-4o-mini-transcribe` | `gpt-4.1-mini` |
| Groq | `whisper-large-v3-turbo` | `llama-3.3-70b-versatile` |
| Local ([Speaches](https://github.com/speaches-ai/speaches)) | `Systran/faster-distil-whisper-large-v3` | off |

Any server that implements `POST /audio/transcriptions` and `POST /chat/completions` works. Local
speech-to-text endpoints (`localhost`, `127.0.0.1`) don't need a key, and a chat endpoint never
requires one. API keys are encrypted with Electron
`safeStorage` (macOS Keychain) and never reach the renderer.

If `fn` opens the emoji picker, set System Settings → Keyboard → "Press 🌐 key to" → "Do Nothing".

### Development

`npm run dev` runs OpenWispr unpackaged with hot reload. macOS then attributes permissions to the app
that launched Electron (Terminal, your IDE), not to OpenWispr, and may not prompt for the microphone
at all. `npm run start:standalone` starts the built app as `Electron`, which gets its own entries.
Use the packaged app when you need permissions to behave as they will for users. Only the packaged
app asks for Speech Recognition (macOS kills a process that asks on behalf of an app without a usage
description); unpackaged, Apple's speech-to-text runs without asking.

The same entry points used by CI are available locally:

| Command | What it does |
| --- | --- |
| `make lint` | Type-check the TypeScript app |
| `make test` | Run the Vitest suite |
| `make build` | Build the Electron app and Swift executables |
| `make check` | Run all three checks |

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Build the native processes and start Electron with hot reload |
| `npm run build` | Production build into `out/` |
| `npm run package` | Build and sign `OpenWispr.app` into `dist/` |
| `npm run start:standalone` | Build, then launch outside the terminal so macOS permission prompts appear |
| `npm run typecheck` | Type-check main, preload and renderer |
| `npm test` | Unit tests for the shortcut engine and text processing |
| `npm run helper:build` | Build the Swift helper only |
| `npm run models:build` | Build the Swift model process only |
| `npm run models:smoke -- [clip.wav] [--language en] [--prompt text] [--model apple] [--models-dir dir]` | Transcribe a 16 kHz mono WAV through Apple’s model or a downloaded one (like `whisper-small` or `parakeet-tdt-0.6b-v3`) and print latency |

## Not implemented (yet)

See [`docs/roadmap.md`](docs/roadmap.md): built-in local models come first, then Command and
the other dictation features, plain notes, the remaining Notetaker features, and a local MCP server.
Accounts, sync, teams and Windows are out of scope ([ADR 0001](docs/adr/0001-local-first-single-user.md)).

## Data

Settings, dictionary and snippets live in `~/Library/Application Support/OpenWispr/openwispr.json`,
and history (last 2000 dictations) in `history.json` next to it. Meetings live in `meetings.json` (titles,
notes, summaries) plus one `meetings/<id>/live.ndjson` transcript per meeting. Audio is never written to disk.

Downloaded Built-in models live in `models/<id>/` next to them, each with a `manifest.json` recording the
Hugging Face repo, pinned revision, files, sizes and hashes. Settings → *Built-in models* downloads the
Recommended models (shipped with the app, not fetched), resumes interrupted downloads, and verifies every
file before marking the model installed: SHA-256 for Git LFS files, the Git blob hash for small files,
which is all Hugging Face publishes for them. Downloaded models can't be selected until their engine ships.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately as described
in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
