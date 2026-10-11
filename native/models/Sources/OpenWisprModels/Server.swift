import Foundation

protocol SpeechToTextEngine: Sendable {
    /// Gets the model ready for `language`, downloading what it needs.
    func load(language: String) async throws
    func transcribe(_ samples: [Int16], language: String, prompt: String) async throws -> [Segment]
    func unload() async
}

struct StatusResult: Encodable, Sendable {
    let appleSpeech: AppleSpeechStatus
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
        case .complete:
            throw ModelError.unavailable("Built-in chat models are not available yet")
        case let .load(models):
            for model in models {
                guard model.role == "speechToText" else { throw ModelError.unavailable("Built-in \(model.role) models are not available yet") }
                try await speechToText(model.id).load(language: model.language ?? "")
            }
            return Empty()
        case let .unload(ids):
            for id in ids {
                if let engine = try? speechToText(id) { await engine.unload() }
            }
            return Empty()
        case let .status(language):
            return StatusResult(appleSpeech: await appleSpeech.status(language: language))
        }
    }

    private func speechToText(_ model: String) throws -> any SpeechToTextEngine {
        switch model {
        case "apple": appleSpeech
        default: throw ModelError.unavailable("Unknown speech-to-text model \(model)")
        }
    }
}
