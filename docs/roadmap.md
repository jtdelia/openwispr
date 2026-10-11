# Roadmap

What OpenWispr still lacks compared with Wispr Flow 1.6.1102, in the order we plan to build it. Terms follow [`GLOSSARY.md`](../GLOSSARY.md); the ground rules are in [ADR 0001](adr/0001-local-first-single-user.md) (local-first, single user), [ADR 0002](adr/0002-local-models-are-the-design-target.md) (local models are the design target) and [ADR 0003](adr/0003-model-engines.md) (model engines). Each milestone gets its own spec before work starts.

## Milestone 0: Foundation

- A packaged `.app` signed with an Apple Development certificate, so macOS keeps the Accessibility and Microphone grants across rebuilds.
- A separate Swift process that runs Built-in models, started on demand and stopped when idle.
- Apple's on-device speech-to-text (`SpeechTranscriber`) and chat model (Foundation Models) as the defaults, with nothing to download.
- Recommended models per task, downloaded from Hugging Face: MLX for chat and vision, WhisperKit and Parakeet for speech-to-text. Any compatible Hugging Face repo can be added too.
- The OpenAI-compatible Endpoint stays as an optional alternative for either role.
- Cleanup prompts retuned for Apple's chat model.

## Milestone 1: Dictation

- Command: a spoken instruction applied to the selection, or answered at the cursor.
- Transform: saved instructions on shortcuts.
- Learning from edits: words corrected after a paste are added to the Dictionary, with undo.
- Multiple languages.
- History search, and undo AI to go back to the raw transcript.
- Small items: mute other audio while dictating, a movable Flow bar, hide the Flow bar from screen sharing, per-app stats, Show in Dock.

## Milestone 2: Notes

- Plain notes with versions, images, pinning and search.
- Todos.

## Milestone 3: Notetaker gaps

- Calendar through macOS Calendar (covers Apple and Google accounts added to macOS), and the next meeting in the menu bar.
- Automatic call detection.
- Chat over notes and transcripts.
- Local folders.
- Docs and Tasks tabs.
- Pre-meeting briefs.
- A "View summary" notification when a meeting ends.
- On-device speaker voices (diarization) through FluidAudio.

## Milestone 4: Local MCP server

- Read-only access to meetings, notes and transcripts for MCP clients such as Claude Desktop and Cursor, served only on this Mac.

## Later, in no particular order

- Live text while speaking (local streaming models only).
- Live translation of meeting transcripts.
- Automations.
- Whisper mode (very quiet dictation).
- Sound themes.
- Public distribution: Developer ID signing, notarization, updates.
- Lens (last).

## Not planned

Accounts, cloud sync, teams, sharing, HIPAA mode, mobile apps, Windows, streaks and other growth mechanics, cloud streaming transcription, web search, Granola import.
