import Foundation

// Protocol lines own the original stdout; fd 1 points at stderr so stray print()s from libraries can't corrupt it.
let protocolFD = dup(STDOUT_FILENO)
dup2(STDERR_FILENO, STDOUT_FILENO)
signal(SIGPIPE, SIG_IGN)

let writer = Writer(fileDescriptor: protocolFD)
let progress = ProgressReporter(writer: writer)
let arguments = CommandLine.arguments
let modelsDir = arguments.firstIndex(of: "--models-dir").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
let server = Server(
    writer: writer,
    appleSpeech: AppleSpeech(requestsAuthorization: arguments.contains("--request-speech-authorization")) { locale, fraction in
        await progress.report(locale: locale, fraction: fraction)
    },
    appleChat: AppleChat(),
    modelsDir: modelsDir.map { URL(fileURLWithPath: $0, isDirectory: true) },
    parakeet: Parakeet(),
    whisper: Whisper()
)

for try await line in FileHandle.standardInput.bytes.lines {
    let data = Data(line.utf8)
    do {
        let request = try JSONDecoder().decode(Request.self, from: data)
        Task(priority: .userInitiated) { await server.handle(request) }
    } catch {
        log("bad request: \(error)")
        if let id = try? JSONDecoder().decode(RequestID.self, from: data).id {
            await writer.send(Failure(id: id, error: .modelFailed("Bad request: \(error)")))
        }
    }
}
// stdin closed: the app quit or stopped us for being idle.
exit(0)
