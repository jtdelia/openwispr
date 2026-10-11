# Model engines: Apple first, MLX and Core ML for downloads, in a separate process

Built-in models run on native Apple engines in a separate Swift process that the app starts on demand and stops when idle, so a large model can never stall the helper that captures the keyboard. Apple's on-device models (`SpeechTranscriber`, Foundation Models) are the zero-download defaults. Downloaded chat and vision models must be MLX (`mlx-swift-lm`), and downloaded speech-to-text models are Whisper via WhisperKit or Parakeet via FluidAudio (both Core ML); FluidAudio also supplies on-device speaker diarization.

## Considered Options

- **llama.cpp / GGUF for chat.** GGUF is the most common format on Hugging Face, but in 2026 benchmarks MLX generated text 1.4–1.8× faster on Apple Silicon, and `mlx-community` covers the models we'd recommend. Revisit only if a model we want exists solely as GGUF.
- **MLX for speech-to-text.** `mlx-whisper` measured a 12.6% word error rate on Whisper large-v3 where whisper.cpp measured 0.87% on the same audio; the Core ML engines are the reliable Swift options.
- **Models inside the helper.** Simpler, but the helper owns the `Fn` key event tap, and a multi-gigabyte model crashing or paging would freeze dictation.

## Consequences

- Apple's chat model has an 8K-token context on macOS 27, so long inputs such as meeting summaries are processed in pieces or offered to a larger downloaded model.
- Apple's speech-to-text covers about ten languages, so other languages need a downloaded Whisper model.
