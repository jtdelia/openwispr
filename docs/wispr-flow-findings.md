# Wispr Flow 1.6.1102 — reverse-engineering notes

Source artifact: `/Volumes/Flow-v1.6.1102/Wispr Flow.app` (Electron app, bundle id
`com.electron.wispr-flow`, ASAR integrity SHA-256 `9d5de587…1b8e`). All findings are
from static inspection of the shipped bundle; nothing here was observed at runtime.
No Wispr code or assets are copied into OpenWispr. The notes document behavior,
and OpenWispr re-implements that behavior from scratch.

## Process layout (observed)

| Piece | Location | Role |
| --- | --- | --- |
| Electron main | `app.asar/.webpack/main/index.js` | Shortcut state machine, dictation orchestration, SQLite (`flow.sqlite`, Sequelize migrations in `Resources/migrations`), network |
| Renderer windows | `.webpack/renderer/{hub,status,overlay,contextMenu,scratchpad,…}` | `hub` = main app window, `status` = floating "Flow Status Indicator" panel |
| Recorder | `.webpack/renderer/dist/recorderWorklet.js` | `AudioWorkletProcessor` that buffers 640-sample chunks per input and posts them to the page on `start`/`stop` messages |
| Swift helper | `Resources/swift-helper-app-dist/Wispr Flow.app` (`LSUIElement`, bundle id `…accessibility-mac-app`) | Global key capture, Accessibility (AX) reads, paste, sounds, app/focus tracking |

## Helper IPC (observed)

- Spawned as a child process; messages are JSON over stdio, framed with `|` and
  escaped with `+` (`Xe="|"`, `Je="+"`).
- Envelope: `{"HelperAPIRequest": {...}}` or `{"HelperAPIResponse": {...}}`, generated
  from a shared JSON Schema with quicktype into TS, Swift and C#.
- Messages relevant to dictation:
  - `KeypressEvent { key: number, eventType: string, index, inputType? }`: raw key
    stream from the helper. The main process does shortcut matching, not the helper.
  - `UpdateShortcuts`: main process pushes the active bindings to the helper.
  - `GetTextBoxInfo` → `TextBoxInfo { beforeText, afterText, selectedText, contents,
    isEditable, accessibilityIsFunctioning, couldNotGetTextBoxInfo }`.
  - `AppInfoUpdate { appName, bundleId, url, windowTitle }`.
  - `PasteText { text, htmlText?, pasteId }` → `PasteOutcome { success, timeElapsedMs }`.
  - `PlayDictationStartSound` / `PlayDictationStopSound`, `RequestAccessibilityPermission`.
- Helper strings show a `CGEventTap` that handles `flagsChanged` (Fn arrives as keycode
  63), a `SecureInputMonitor`, and paste via `NSPasteboard` marked with
  `org.nspasteboard.ConcealedType`, followed by "Scheduling clipboard restoration in
  500ms".

## Shortcuts (observed defaults, macOS)

| Action | Default |
| --- | --- |
| `ptt` (push-to-talk, hold) | Fn |
| `popo` (hands-free toggle) | Fn + Space |
| `lens` | Fn + Ctrl |
| `paste_last_text` | Ctrl + Cmd + V |
| `copy_last_text` | Ctrl + Cmd + C |
| `dismiss` | Esc |

Key codes are macOS virtual key codes (`fn: 63`, synthetic `doubleFn: 179`). A PTT
release within `DICTATION_DEBOUNCE_DELAY = 500` ms of starting is discarded.

## Status indicator states (observed enum)

`hidden, resting, initializing, ready, active_ptt, active_popo, processing, error`,
plus Polish/Instruct states that OpenWispr does not implement.

## Transcription and cleanup (observed)

- Audio is streamed to Wispr's own backend over gRPC; the target host is fetched from
  `inference-info.wisprflow.com/dictation_url.txt` against an allowlist. ASR and LLM
  cleanup both run server-side.
- Per-dictation request context: dictionary words (personal + team, capped), user first
  and last name, focused textbox contents, nearby on-screen text, personalization style,
  selected languages, app category, previous ASR/LLM text.
- App categories: `email`, `ai`, `terminal`, `other`. Style contexts: `personal`,
  `work`, `email`, `other`. Style values: `formal`, `casual`, `veryCasual`, `excited`.
- History rows record `asrText`, `formattedText`, app, url, duration, numWords,
  language, `transcriptCommand` (`ptt | popo | lens | command`).

## Notetaker (observed)

Wispr has two note features: plain **Notes** (`notes` table, `scratchpad` window) and the meeting
**Notetaker** ("Take notes", "Wispr Flow can now take meeting notes for you"). OpenWispr implements
the Notetaker.

- **System audio.** On macOS the main process appends Chromium features before ready:
  `MacCatapSystemAudioLoopbackCapture` (Core Audio process tap, macOS ≥ 14.4) or
  `MacSckSystemAudioLoopbackOverride` (ScreenCaptureKit, 13.0–14.3), each with
  `MacLoopbackAudioForScreenShare`. `session.setDisplayMediaRequestHandler` answers with
  `{ audio: { id: "loopbackAllDevices", name: "All loopback devices" } }` for process taps, or
  `{ video: <first screen>, audio: "loopback" }` for ScreenCaptureKit. The renderer calls
  `getDisplayMedia({ audio: true, video: false })` and drops any video track. The helper requests
  `kTCCServiceAudioCapture`; `Info.plist` carries `NSAudioCaptureUsageDescription`.
- **Two channels.** Microphone (`getUserMedia`) and system audio are captured as separate 16 kHz
  streams, tagged `mic` / `system`; mic speech is attributed to the user (`self`).
- **Live transcript.** Streamed to Wispr's backend; entries `{ id, timestamp, text, speaker,
  startRecordingMs, endRecordingMs, … }` are appended to `meetings/<id>/live.ndjson`. After the
  meeting the server refines the transcript (Soniox) and labels speakers.
- **Notes vs. summary.** `Meetings.notes` holds the user's own notes ("Write your notes here. We'll
  make a separate summary at the end."); `Meetings.summary` holds the Markdown summary from the
  server-side refine pipeline, with managed sections such as "Flow Summary" and "Action Items".
- **Summary states** rendered by the meeting view: `not-yet-generatable`, `too-short`,
  `ready-to-generate`, `generating`, `generated`, `update-available` ("New recording since this
  summary."), `updating`, `update-failed`.
- **Title.** Generated on the client after stop when the title is empty: transcript as primary
  grounding, notes as secondary context, "a concise 3-6 word title"; up to 3 attempts.
- **Recording controls.** Start / Stop / Resume; resuming appends to the same meeting
  (`recordedMs` accumulates). Consent reminder: "Always get consent when transcribing others."

Not reproduced: calendar integration and meeting auto-detection, server-side refine and diarization,
LLM speaker guesses, contact matching, pre-meeting briefs, chat over notes, folders, sharing,
Granola/Otter import.

## Speaker identification (observed)

Wispr names speakers from three sources and records which one each name came from: the user's
microphone (`self`), the meeting app's UI (`platform`, read through Accessibility), the server's
diarization, and an LLM guess (`llm`); a user choice (`user`) overrides all of them.

- **Helper polling.** `StartSpeakerPolling { platform, targetProcessId, markerClasses, tileRootClasses,
  collectSpeakerNames, anchoredDiscovery }` starts a `MeetingSpeakerPoller` with one strategy per
  platform (`ZoomSpeakerStrategy`, `TeamsSpeakerStrategy`, `GoogleMeetSpeakerStrategy`,
  `SlackSpeakerStrategy`). It emits `MeetingSpeakerChange { speakerName, speakingNames, mutedNames,
  selfName, attributionState: matched | ambiguous | unknown, evidenceKind: active_speaker_indicator |
  displayed_participant, discoveryTier: anchored | broad | cached, source, reason, timestamp }` and
  `MeetingSpeakerSourceReport { platform, source, readStatus, availableSources }`.
- **Platform anchors** (helper strings). Meet: room URL `^[a-z]{3}-[a-z]{4}-[a-z]{3}$` on
  `meet.google.com`, speaking-indicator DOM class `kssMZb` (classes are pushed from the main process,
  so they can change without a helper update), name noise words `muted, unmuted, talking, video,
  presenting, camera, microphone`. Zoom (`us.zoom.xos`): `active speaker`, `you are speaking`,
  `Show/Hide video render`, a compact-window monitor. Teams: DOM ids `roster-button`,
  `hangup-button`, `microphone-button`, prefix `In this meeting, `, role suffix
  `, (Organizer|Co-organizer|Meeting guest|Presenter|Attendee)(,.*)?$`. Slack: `calling-roster-item-`,
  `roster-title-section-`. Overflow tiles `^\+?\d+\s+(more|others?|participants?)$` are rejected.
  Browsers get `AXManualAccessibility` and `AXEnhancedUserInterface` set so Chromium builds its tree.
- **Live attribution.** Each final system-audio token batch looks up the latest speaker event at or
  before its start; an event older than 1500 ms is `stale_ttl`, and only `matched` events stamp a
  name. Mic tokens are always `{ source: "mic" }`.
- **Identity map** (`systemSpeakerIdentityMap`). Per streaming-ASR speaker id it tracks a candidate
  and a canonical name: 3 matching sightings promote a name (`promoteThreshold`, 2-20), 5 conflicting
  ones remap it (`remapThreshold`), at most once per 30 s (`remapCooldownMs`); segments with no
  evidence keep the canonical name (`held`).
- **Observation log.** `speakers.observations.ndjson` (8 MB cap): a `meta` line, `participant
  { pid, name, self }` lines (≤ 200, NFC-normalized names), `obs { tMs, speaking, muted,
  evidenceKind, source, reason }` written only on change, and `rec { tMs, state: paused | resumed }`.
  It is uploaded so the server can fold it into the refined, diarized transcript.
- **Speaker map.** `Meetings.speakerMap = { people, assignments }`: for each refined speaker id
  `{ user, dom, mic, llm, consensus }` pointing at people; text refers to them with
  `<@speaker:N>` / `<@person:id>` tokens rendered as the current name ("Speaker N", "Unknown person").
  The "Assign speakers" dialog ("Name each voice and we'll relabel the whole transcript.") queues
  `speakerAssignmentEdits` until the server acknowledges them.

## What OpenWispr does differently (design choices)

- The proprietary backend is replaced by user-configured OpenAI-compatible endpoints
  (OpenAI, Groq, or a local whisper server) for ASR, plus an optional chat-completions
  model for cleanup.
- IPC uses newline-delimited JSON with the same request/response split.
- History, dictionary, snippets and settings live in a JSON store, not SQLite.
- Notetaker transcribes each channel in voice-activity chunks (cut at the first pause after 6 s, or at
  25 s) against the configured `/audio/transcriptions` endpoint, and writes titles and summaries with
  the configured cleanup model. Summaries are only auto-generated once; later recordings offer
  "Update summary".
- Speakers are identified on the device. The helper reads the meeting app every 300 ms and reports
  changes; each call-audio segment goes to whoever was shown talking for most of it (at least 30% of
  the segment, with any runner-up under half as much), instead of looking up the single latest event.
  A speaker change also asks the recorder to end the chunk at the next 250 ms pause, so chunks hold
  one voice. With `gpt-4o-transcribe-diarize`, the first long segment of each new voice is kept as a
  `known_speaker_references[]` clip (up to four) so voice labels stay stable across chunks, and Wispr's
  identity-map thresholds tie those voices to names. Microphone entries that repeat the call audio
  (speaker echo) are hidden. User names are stored per speaker key and relabel the summary in place
  rather than through tokens.
- Plain notes, todos, Polish, Lens, Command mode, teams, sync and BLE are out of scope.
