import Foundation

/// A model to have ready before it's needed. `id` is `apple` or a downloaded model's id.
struct ModelRef: Decodable, Sendable {
    let role: String
    let id: String
    let language: String?
}

struct TranscribeRequest: Decodable, Sendable {
    let model: String
    /// Base64 16 kHz mono PCM16, either a WAV file or raw samples.
    let audio: String
    let language: String
    let prompt: String?
    let segments: Bool?
}

enum RequestBody: Sendable {
    case transcribe(TranscribeRequest)
    case complete(model: String)
    case load([ModelRef])
    case unload([String])
    case status(language: String)
}

struct RequestID: Decodable {
    let id: Int
}

struct Request: Decodable, Sendable {
    let id: Int
    let body: RequestBody

    private enum CodingKeys: String, CodingKey { case id, type, model, models, language }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(Int.self, forKey: .id)
        switch try container.decode(String.self, forKey: .type) {
        case "transcribe": body = .transcribe(try TranscribeRequest(from: decoder))
        case "complete": body = .complete(model: try container.decode(String.self, forKey: .model))
        case "load": body = .load(try container.decode([ModelRef].self, forKey: .models))
        case "unload": body = .unload(try container.decode([String].self, forKey: .models))
        case "status": body = .status(language: try container.decodeIfPresent(String.self, forKey: .language) ?? "")
        case let other: throw ModelError.modelFailed("Unknown request type \(other)")
        }
    }
}

enum ModelError: Error {
    case unavailable(String)
    case unsupportedLanguage(String)
    case contextExceeded(String)
    case refused(String)
    case modelFailed(String)

    var code: String {
        switch self {
        case .unavailable: "unavailable"
        case .unsupportedLanguage: "unsupportedLanguage"
        case .contextExceeded: "contextExceeded"
        case .refused: "refused"
        case .modelFailed: "modelFailed"
        }
    }

    var message: String {
        switch self {
        case let .unavailable(message), let .unsupportedLanguage(message), let .contextExceeded(message),
             let .refused(message), let .modelFailed(message):
            message
        }
    }
}

struct Success<Result: Encodable & Sendable>: Encodable, Sendable {
    let type = "response"
    let id: Int
    let result: Result
}

struct Failure: Encodable, Sendable {
    struct Body: Encodable, Sendable {
        let code: String
        let message: String
    }

    let type = "response"
    let id: Int
    let error: Body

    init(id: Int, error: ModelError) {
        self.id = id
        self.error = Body(code: error.code, message: error.message)
    }
}

/// Unsolicited: an Apple language-asset download is under way.
struct ProgressEvent: Encodable, Sendable {
    let type = "progress"
    let kind = "appleSpeechAssets"
    let locale: String
    let fraction: Double
}

struct Empty: Encodable, Sendable {}

struct Segment: Encodable, Sendable {
    /// Seconds from the start of the audio.
    let start: Double
    let end: Double
    let text: String
}

struct TranscribeResult: Encodable, Sendable {
    let text: String
    let segments: [Segment]?
}

/// Protocol lines go only through here, so they never interleave.
actor Writer {
    private let handle: FileHandle
    private let encoder = JSONEncoder()

    init(fileDescriptor: Int32) {
        handle = FileHandle(fileDescriptor: fileDescriptor, closeOnDealloc: false)
    }

    func send(_ message: some Encodable & Sendable) {
        guard var data = try? encoder.encode(message) else { return }
        data.append(0x0A)
        do { try handle.write(contentsOf: data) } catch { exit(0) }
    }
}

func log(_ message: String) {
    FileHandle.standardError.write(Data("[models] \(message)\n".utf8))
}
