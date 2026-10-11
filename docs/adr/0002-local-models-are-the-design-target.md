# Local models are the design target

Every feature needs at most two kinds of model: a speech-to-text model and a chat model. OpenWispr runs these itself, on the user's Mac, and defaults, prompts and features are designed and tuned for those on-device models. Cloud providers such as OpenAI and Groq stay available as an optional OpenAI-compatible endpoint, but nothing is optimized for them. We chose this over adding new kinds of service (cloud realtime streaming, web search) because each would only work on some setups and has no local equivalent, and over relying on separate local servers (Speaches, Ollama) because setting those up is the main barrier to using local models at all.

## Consequences

- A fresh install uses Apple's on-device models, so it works with nothing to download. Downloaded models are upgrades (see ADR 0003).
- Cloud streaming and "ask Perplexity"-style search are out of scope. Live text while speaking is possible only with local models that stream.
- Features that need a capable chat model (Lens needs one that accepts images) turn themselves off when the selected model can't support them.
