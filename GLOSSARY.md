# OpenWispr

Voice dictation for macOS: speak in any app and text lands at the cursor, plus a meeting notetaker.

## Language

### Acting on text

**Dictation**:
Speaking so that new text is inserted at the cursor.
_Avoid_: Transcription (that is the speech-to-text step, not the feature)

**Cleanup**:
The automatic tidy-up applied to every Dictation before it is inserted: filler words, self-corrections, punctuation, tone.
_Avoid_: Auto Cleanup, auto polish, formatting

**Command**:
A spoken instruction applied to the selected text, or answered at the cursor when nothing is selected.
_Avoid_: Command mode, Instruct, Hey Flow

**Transform**:
A saved instruction, bound to a shortcut, that rewrites the selected text without speaking.
_Avoid_: Polish, polish prompt

**Lens**:
A Command that also sends a screenshot of the screen as context.

### Models

**Built-in model**:
A model OpenWispr runs on the Mac itself, either one of Apple's on-device models or one downloaded from Hugging Face.
_Avoid_: Local provider, local server

**Endpoint**:
An OpenAI-compatible server the user configures instead of a Built-in model, usually a cloud provider.
_Avoid_: Provider, preset

**Recommended models**:
OpenWispr's curated list of Built-in models for each task, showing size, speed and languages.
_Avoid_: Catalog, model store
