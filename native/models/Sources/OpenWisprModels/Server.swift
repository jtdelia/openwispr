import Foundation
import Synchronization

protocol SpeechToTextEngine: Sendable {
    /// ISO language codes it transcribes, or nil when it isn't limited to a known set.
    var languages: [String]? { get }
    /// Gets the model ready for `language`, downloading what it needs.
    func load(language: String) async throws
    func transcribe(_ samples: [Int16], language: String, prompt: String) async throws -> [Segment]
    func unload() async
}

protocol ChatEngine: Sendable {
    /// Gets the model ready so the next request answers quickly.
    func load() async throws
    func complete(_ request: CompleteRequest) async throws -> CompleteResult
    func unload() async
}

/// Below this many tokens left for the answer, a chat request is treated as too long.
private let minimumAnswerTokens = 16

/// Tokens left for the answer once the prompt uses `used` of `contextSize`, at most `wanted`. Fails
/// rather than letting the model truncate the answer.
func answerBudget(used: Int, contextSize: Int, wanted: Int, modelName: String) throws -> Int {
    let left = contextSize - used
    if left < minimumAnswerTokens {
        throw ModelError.contextExceeded("Too long for \(modelName) (\(used) of \(contextSize) tokens)")
    }
    return min(wanted, left)
}

/// One engine per downloaded model folder, so every request for a model shares one load.
final class EnginesByFolder<Engine: Sendable>: Sendable {
    private let engines = Mutex<[URL: Engine]>([:])

    func engine(for model: DownloadedModel, create: (DownloadedModel) -> Engine) -> Engine {
        engines.withLock { engines in
            if let engine = engines[model.folder] { return engine }
            let engine = create(model)
            engines[model.folder] = engine
            return engine
        }
    }

    /// Forgets the folder's engine, which holds what its manifest said when it was created; returns it to unload.
    func evict(_ folder: URL) -> Engine? {
        engines.withLock { $0.removeValue(forKey: folder) }
    }
}

extension SpeechToTextEngine {
    var languages: [String]? { nil }

    /// An empty setting means the engine picks the language.
    func supports(language: String) -> Bool {
        guard let code = languageCode(language), let languages else { return true }
        return languages.contains(code)
    }
}

/// The language part of a setting like `de` or `pt-BR`, or nil when it's empty.
func languageCode(_ language: String) -> String? {
    let code = language.trimmingCharacters(in: .whitespaces).split(whereSeparator: { $0 == "-" || $0 == "_" }).first
    return code.map { $0.lowercased() }
}

struct StatusResult: Encodable, Sendable {
    let appleSpeech: AppleSpeechStatus
    let appleChat: AppleChatStatus
    let speechToText: DownloadedSpeechStatus?
    let chat: DownloadedChatStatus?
}

struct DownloadedSpeechStatus: Encodable, Sendable {
    let model: String
    let name: String
    let supported: Bool
    let languages: [String]?

    private enum CodingKeys: String, CodingKey { case model, name, supported, languages }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(model, forKey: .model)
        try container.encode(name, forKey: .name)
        try container.encode(supported, forKey: .supported)
        try container.encode(languages, forKey: .languages)
    }
}

/// Sends a download's progress, skipping updates of less than a percent.
actor ProgressReporter {
    private let writer: Writer
    private var reported: [String: Double] = [:]

    init(writer: Writer) {
        self.writer = writer
    }

    func report(locale: String, fraction: Double) async {
        if let last = reported[locale], fraction <= last || (fraction < 1 && fraction - last < 0.01) { return }
        reported[locale] = fraction
        await writer.send(ProgressEvent(locale: locale, fraction: fraction))
    }
}

/// Routes each request to the engine for its model and answers with its result or a typed error.
struct Server: Sendable {
    let writer: Writer
    let appleSpeech: AppleSpeech
    let appleChat: AppleChat
    /// Where the app keeps downloaded models, one folder per model id.
    let modelsDir: URL?
    let parakeet: Parakeet
    let whisper: Whisper
    let mlxChat: MLXChat

    func handle(_ request: Request) async {
        do {
            await respond(request.id, try await perform(request.body))
        } catch let error as ModelError {
            await writer.send(Failure(id: request.id, error: error))
        } catch {
            let nsError = error as NSError
            // SFSpeechError.noModel: the locale isn't supported after all.
            let modelError: ModelError = nsError.domain == "SFSpeechErrorDomain" && nsError.code == 4
                ? .unsupportedLanguage("Apple's speech-to-text doesn't support this language")
                : .modelFailed(nsError.localizedDescription)
            await writer.send(Failure(id: request.id, error: modelError))
        }
    }

    private func respond(_ id: Int, _ result: some Encodable & Sendable) async {
        await writer.send(Success(id: id, result: result))
    }

    private func perform(_ body: RequestBody) async throws -> any Encodable & Sendable {
        switch body {
        case let .transcribe(request):
            let engine = try speechToText(request.model)
            guard let audio = Data(base64Encoded: request.audio) else { throw ModelError.modelFailed("The audio isn't valid base64") }
            let segments = try await engine.transcribe(try PCM16.samples(from: audio), language: request.language, prompt: request.prompt ?? "")
            return TranscribeResult(text: segments.map(\.text).joined(), segments: request.segments == true ? segments : nil)
        case let .complete(request):
            return try await chat(request.model).complete(request)
        case let .load(models):
            for model in models {
                switch model.role {
                case "speechToText": try await speechToText(model.id).load(language: model.language ?? "")
                case "chat": try await chat(model.id).load()
                default: throw ModelError.unavailable("Built-in \(model.role) models are not available yet")
                }
            }
            return Empty()
        case let .unload(ids):
            for id in ids {
                if id == "apple" {
                    await appleSpeech.unload()
                    await appleChat.unload()
                    continue
                }
                // By folder, not manifest: a model being replaced or removed may no longer count as installed.
                guard let folder = try? DownloadedModel.folder(id, in: modelsDir) else { continue }
                await whisper.evict(folder)?.unload()
                await mlxChat.evict(folder)?.unload()
                await parakeet.unload(folder)
            }
            return Empty()
        case let .status(language, speechToTextModel, chatModel):
            return StatusResult(
                appleSpeech: await appleSpeech.status(language: language),
                appleChat: appleChat.status(),
                speechToText: speechToTextModel.flatMap { try? downloadedStatus($0, language: language) },
                chat: chatModel.flatMap { try? downloadedChatStatus($0) }
            )
        }
    }

    private func chat(_ model: String) throws -> any ChatEngine {
        switch model {
        case "apple": appleChat
        default: try chat(try DownloadedModel.installed(model, in: modelsDir))
        }
    }

    private func chat(_ model: DownloadedModel) throws -> any ChatEngine {
        guard model.task == "chat" else { throw ModelError.unavailable("\(model.name) isn't a chat model") }
        switch model.engine {
        case "mlx": return try mlxChat.engine(for: model)
        default: throw ModelError.unavailable("\(model.name) can't be used for chat yet")
        }
    }

    private func downloadedChatStatus(_ id: String) throws -> DownloadedChatStatus {
        let model = try DownloadedModel.installed(id, in: modelsDir)
        guard model.task == "chat", model.engine == "mlx" else { throw ModelError.unavailable("\(model.name) can't be used for chat yet") }
        return try mlxChat.status(for: model)
    }

    private func downloadedStatus(_ id: String, language: String) throws -> DownloadedSpeechStatus {
        let model = try DownloadedModel.installed(id, in: modelsDir)
        let engine = try speechToText(model)
        return DownloadedSpeechStatus(model: id, name: model.name, supported: engine.supports(language: language), languages: engine.languages)
    }

    private func speechToText(_ model: String) throws -> any SpeechToTextEngine {
        switch model {
        case "apple": appleSpeech
        default: try speechToText(try DownloadedModel.installed(model, in: modelsDir))
        }
    }

    private func speechToText(_ model: DownloadedModel) throws -> any SpeechToTextEngine {
        guard model.task == "speechToText" else { throw ModelError.unavailable("\(model.name) isn't a speech-to-text model") }
        switch model.engine {
        case "fluidAudio": return ParakeetEngine(model: model, parakeet: parakeet)
        case "whisperKit": return whisper.engine(for: model)
        default: throw ModelError.unavailable("\(model.name) can't be used for speech-to-text yet")
        }
    }
}
