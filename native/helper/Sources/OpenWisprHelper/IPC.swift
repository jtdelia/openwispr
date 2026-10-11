import Foundation

/// Newline-delimited JSON over stdio. Every outgoing message is a single-line JSON object.
enum IPC {
    private static let writeQueue = DispatchQueue(label: "openwispr.helper.stdout")

    static func send(_ message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message, options: []) else { return }
        writeQueue.async {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0A]))
        }
    }

    static func respond(id: Any?, result: [String: Any]) {
        guard let id else { return }
        send(["type": "response", "id": id, "result": result])
    }

    static func respondError(id: Any?, message: String) {
        guard let id else { return }
        send(["type": "response", "id": id, "error": message])
    }

    static func log(_ message: String) {
        FileHandle.standardError.write(Data("[helper] \(message)\n".utf8))
    }

    /// Reads stdin lines on a background thread and hands parsed objects to `handler` on the main queue.
    /// Exits the process when stdin closes so the helper never outlives the app.
    static func startReading(_ handler: @escaping ([String: Any]) -> Void) {
        Thread.detachNewThread {
            while let line = readLine(strippingNewline: true) {
                guard !line.isEmpty,
                      let data = line.data(using: .utf8),
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else { continue }
                DispatchQueue.main.async { handler(object) }
            }
            exit(0)
        }
    }
}
